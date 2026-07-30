import crypto from 'crypto';
import Razorpay from 'razorpay';
import { decryptIntegrationConfig } from '../platform/phase5Database.js';
import { httpError, parseJson, writeTenantAudit } from '../platform/phase5Http.js';
import { invalidateOrganizationCache, publishOrganizationEvent } from '../platform/phase5Runtime.js';
import { calculateInvoicePaymentState } from './invoicePaymentService.js';
import { fromMinor, toMinor } from './moneyService.js';

export async function createRazorpayOrder(db, input, req, sdkFactory = defaultSdkFactory) {
  const config = await loadRazorpayConfig(db);
  const amountPaise = Math.round(Number(input.amount) * 100);
  const sdk = sdkFactory(config);
  let order;
  try {
    order = await sdk.orders.create({
      amount: amountPaise,
      currency: input.currency || 'INR',
      receipt: input.receipt || `inventia-${Date.now()}`,
      notes: {
        organization_id: req.user.organization_id,
        trade_document_id: input.trade_document_id ? String(input.trade_document_id) : '',
        customer_id: input.customer_id ? String(input.customer_id) : ''
      }
    });
  } catch (error) {
    throw integrationError(error);
  }
  await db.run(
    `INSERT INTO payment_gateway_transactions
      (provider, provider_order_id, direction, amount, currency, status,
       trade_document_id, customer_id, idempotency_key, raw_response, created_at, updated_at)
     VALUES ('razorpay', ?, 'payment', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      order.id, Number(order.amount) / 100, order.currency, order.status || 'created',
      input.trade_document_id || null, input.customer_id || null,
      String(req.headers['idempotency-key']), JSON.stringify(order), now(), now()
    ]
  );
  await db.run(
    `INSERT INTO payment_attempts
      (provider, provider_order_id, amount_minor, currency, status, request_payload,
       response_payload, idempotency_key, created_at, updated_at)
     VALUES ('razorpay', ?, ?, ?, 'CREATED', ?, ?, ?, ?, ?)
     ON CONFLICT (idempotency_key) DO UPDATE SET
       provider_order_id = excluded.provider_order_id,
       response_payload = excluded.response_payload, updated_at = excluded.updated_at`,
    [
      order.id, Number(order.amount), order.currency,
      JSON.stringify({
        amount_minor: amountPaise,
        currency: input.currency || 'INR',
        receipt: input.receipt || null,
        trade_document_id: input.trade_document_id || null,
        customer_id: input.customer_id || null
      }),
      JSON.stringify(sanitizeProviderPayload(order)),
      `razorpay-order:${String(req.headers['idempotency-key'])}`, now(), now()
    ]
  );
  await writeTenantAudit(db, req, {
    eventType: 'payment.razorpay_order_created',
    entityType: 'payment',
    entityId: order.id,
    after: { provider_order_id: order.id, amount: Number(order.amount) / 100, currency: order.currency, status: order.status }
  });
  return {
    provider: 'razorpay',
    key_id: config.key_id,
    order: {
      id: order.id,
      amount: order.amount,
      amount_due: order.amount_due,
      currency: order.currency,
      receipt: order.receipt,
      status: order.status
    }
  };
}

export async function verifyRazorpayPayment(db, input, req) {
  const config = await loadRazorpayConfig(db);
  const expected = hmac(`${input.razorpay_order_id}|${input.razorpay_payment_id}`, config.key_secret);
  if (!safeEqual(expected, input.razorpay_signature)) {
    throw httpError(400, 'invalid_payment_signature', 'Razorpay payment signature verification failed.');
  }
  const existing = await db.one(
    `SELECT * FROM payment_gateway_transactions
      WHERE provider = 'razorpay' AND provider_order_id = ? AND direction = 'payment'`,
    [input.razorpay_order_id]
  );
  if (!existing) throw httpError(404, 'payment_order_not_found', 'The Razorpay order is not recorded for this organization.');
  if (existing.provider_payment_id && existing.provider_payment_id !== input.razorpay_payment_id) {
    throw httpError(409, 'payment_already_allocated', 'This order is already associated with a different payment.');
  }
  await db.transaction(async tx => {
    const signatureHash = crypto.createHash('sha256').update(input.razorpay_signature).digest('hex');
    await tx.run(
      `UPDATE payment_gateway_transactions SET provider_payment_id = ?, status = 'captured',
        raw_response = ?, updated_at = ? WHERE id = ?`,
      [
        input.razorpay_payment_id,
        JSON.stringify({
          razorpay_order_id: input.razorpay_order_id,
          razorpay_payment_id: input.razorpay_payment_id,
          signature_verified: true
        }),
        now(), existing.id
      ]
    );
    await tx.run(
      `UPDATE payment_attempts
          SET provider_payment_id = ?, status = 'CAPTURED', signature_hash = ?,
              response_payload = ?, updated_at = ?
        WHERE provider = 'razorpay' AND provider_order_id = ?`,
      [
        input.razorpay_payment_id, signatureHash,
        JSON.stringify({
          provider_order_id: input.razorpay_order_id,
          provider_payment_id: input.razorpay_payment_id,
          signature_verified: true
        }),
        now(), input.razorpay_order_id
      ]
    );
    if (existing.trade_document_id) {
      const document = await tx.one('SELECT * FROM trade_documents WHERE id = ?', [existing.trade_document_id]);
      if (!document) throw httpError(409, 'payment_document_missing', 'The allocated trade document no longer exists.');
      await tx.run(
        `INSERT INTO entity_timeline
          (entity_type, entity_id, event_type, actor_user_id, message, metadata, created_at)
         VALUES (?, ?, 'payment.captured', ?, ?, ?, ?)`,
        [
          document.document_type, String(document.id), req.user.id,
          `Razorpay payment ${input.razorpay_payment_id} was verified.`,
          JSON.stringify({ amount: existing.amount, provider_order_id: input.razorpay_order_id }),
          now()
        ]
      );
    }
  });
  await writeTenantAudit(db, req, {
    eventType: 'payment.verified',
    entityType: 'payment',
    entityId: input.razorpay_payment_id,
    after: { order_id: input.razorpay_order_id, payment_id: input.razorpay_payment_id, status: 'captured' }
  });
  await notify(req, 'payments.changed', { payment_id: input.razorpay_payment_id, status: 'captured' });
  return { provider: 'razorpay', verified: true, payment_id: input.razorpay_payment_id, status: 'captured' };
}

export async function refundRazorpayPayment(db, input, req, sdkFactory = defaultSdkFactory) {
  const config = await loadRazorpayConfig(db);
  const payment = await db.one(
    `SELECT * FROM payment_gateway_transactions
      WHERE provider = 'razorpay' AND provider_payment_id = ? AND direction = 'payment' AND status IN ('captured', 'partially_refunded')`,
    [input.payment_id]
  );
  if (!payment) throw httpError(404, 'captured_payment_not_found', 'A captured payment was not found.');
  if (Number(input.amount) > Number(payment.amount)) throw httpError(409, 'refund_exceeds_payment', 'Refund amount exceeds the captured payment.');
  let refund;
  try {
    refund = await sdkFactory(config).payments.refund(input.payment_id, {
      amount: Math.round(Number(input.amount) * 100),
      speed: input.speed || 'normal',
      notes: { reason: input.reason || 'Inventia refund' }
    });
  } catch (error) {
    throw integrationError(error);
  }
  await db.run(
    `INSERT INTO payment_gateway_transactions
      (provider, provider_order_id, provider_payment_id, provider_refund_id, direction,
       amount, currency, status, trade_document_id, customer_id, idempotency_key,
       raw_response, created_at, updated_at)
     VALUES ('razorpay', ?, ?, ?, 'refund', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payment.provider_order_id, input.payment_id, refund.id, Number(refund.amount) / 100,
      refund.currency || payment.currency, refund.status || 'processed', payment.trade_document_id,
      payment.customer_id, String(req.headers['idempotency-key']), JSON.stringify(refund), now(), now()
    ]
  );
  const canonicalAttempt = await db.one(
    `SELECT pa.*, a.id AS allocation_id, a.invoice_id, a.payment_id, a.amount_minor,
            i.customer_id, i.invoice_number
       FROM payment_attempts pa
       LEFT JOIN payment_allocations a ON a.id = pa.allocation_id
       LEFT JOIN invoices i ON i.id = a.invoice_id
      WHERE pa.provider = 'razorpay' AND pa.provider_payment_id = ?`,
    [input.payment_id]
  );
  if (canonicalAttempt?.allocation_id) {
    const refundMinor = Number(refund.amount);
    await db.transaction(async tx => {
      const refunded = await tx.one(
        `SELECT COALESCE(SUM(amount_minor), 0) AS amount
           FROM refunds WHERE allocation_id = ? AND status = 'SUCCESS'`,
        [canonicalAttempt.allocation_id]
      );
      if (Number(refunded?.amount || 0) + refundMinor > Number(canonicalAttempt.amount_minor)) {
        throw httpError(409, 'refund_exceeds_allocation', 'Refund total cannot exceed the linked allocation.');
      }
      const refundInsert = await tx.run(
        `INSERT INTO refunds
          (refund_number, allocation_id, payment_id, invoice_id, amount_minor, status,
           method, provider_refund_id, reason, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'SUCCESS', 'RAZORPAY', ?, ?, ?, ?)
         ${tx.dialect === 'postgres' ? 'RETURNING id' : ''}`,
        [
          `RZP-RFN-${refund.id}`, canonicalAttempt.allocation_id, canonicalAttempt.payment_id,
          canonicalAttempt.invoice_id, refundMinor, refund.id, input.reason || null,
          req.user.tenant_user_id || req.user.id, now()
        ]
      );
      const refundId = refundInsert.id || refundInsert.rows?.[0]?.id;
      await tx.run(
        `INSERT INTO payment_attempts
          (allocation_id, invoice_id, provider, provider_payment_id, provider_refund_id,
           amount_minor, currency, status, response_payload, idempotency_key, created_at, updated_at)
         VALUES (?, ?, 'razorpay', NULL, ?, ?, ?, 'REFUNDED', ?, ?, ?, ?)`,
        [
          canonicalAttempt.allocation_id, canonicalAttempt.invoice_id, refund.id,
          refundMinor, refund.currency || payment.currency,
          JSON.stringify({ ...sanitizeProviderPayload(refund), provider_payment_id: input.payment_id }),
          `razorpay-refund:${String(req.headers['idempotency-key'])}`, now(), now()
        ]
      );
      if (canonicalAttempt.customer_id) {
        const balance = await tx.one(
          `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE -amount_minor END), 0) AS balance
             FROM customer_ledger_entries WHERE customer_id = ?`,
          [canonicalAttempt.customer_id]
        );
        const runningBalance = Number(balance?.balance || 0) + refundMinor;
        await tx.run(
          `INSERT INTO customer_ledger_entries
            (customer_id, invoice_id, payment_id, refund_id, entry_type, direction,
             amount_minor, running_balance_minor, reference_number, description,
             created_by, occurred_at, created_at)
           VALUES (?, ?, ?, ?, 'REFUND', 'DEBIT', ?, ?, ?, ?, ?, ?, ?)`,
          [
            canonicalAttempt.customer_id, canonicalAttempt.invoice_id, canonicalAttempt.payment_id,
            refundId, refundMinor, runningBalance, refund.id,
            `Razorpay refund against ${canonicalAttempt.invoice_number}.`,
            req.user.tenant_user_id || req.user.id, now(), now()
          ]
        );
        await tx.run(
          'UPDATE customers SET balance = ? WHERE id = ?',
          [fromMinor(runningBalance), canonicalAttempt.customer_id]
        );
      }
    });
    await calculateInvoicePaymentState(db, canonicalAttempt.invoice_id);
  }
  const refunds = await db.one(
    `SELECT COALESCE(SUM(amount), 0) AS amount FROM payment_gateway_transactions
      WHERE provider = 'razorpay' AND provider_payment_id = ? AND direction = 'refund'`,
    [input.payment_id]
  );
  const parentStatus = Number(refunds.amount) >= Number(payment.amount) ? 'refunded' : 'partially_refunded';
  await db.run('UPDATE payment_gateway_transactions SET status = ?, updated_at = ? WHERE id = ?', [parentStatus, now(), payment.id]);
  await writeTenantAudit(db, req, {
    eventType: 'payment.refunded',
    entityType: 'refund',
    entityId: refund.id,
    after: { payment_id: input.payment_id, amount: Number(refund.amount) / 100, status: refund.status }
  });
  await notify(req, 'payments.changed', { payment_id: input.payment_id, refund_id: refund.id, status: parentStatus });
  return { provider: 'razorpay', refund };
}

export async function processRazorpayWebhook(db, rawBody, signature, eventId, organizationId) {
  const config = await loadRazorpayConfig(db);
  if (!config.webhook_secret) throw httpError(503, 'integration_not_configured', 'Razorpay webhook secret is not configured.');
  const expected = hmac(rawBody, config.webhook_secret);
  const signatureValid = safeEqual(expected, signature);
  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch { throw httpError(400, 'invalid_webhook_payload', 'Webhook payload is not valid JSON.'); }
  const uniqueId = String(eventId || payload.id || crypto.createHash('sha256').update(rawBody).digest('hex'));
  const existing = await db.one(
    `SELECT * FROM webhook_events WHERE provider = 'razorpay' AND provider_event_id = ?`,
    [uniqueId]
  );
  if (existing) return { duplicate: true, status: existing.status };
  await db.run(
    `INSERT INTO webhook_events
      (provider, provider_event_id, event_type, signature_valid, payload, status, created_at)
     VALUES ('razorpay', ?, ?, ?, ?, 'received', ?)`,
    [uniqueId, payload.event || 'unknown', signatureValid ? 1 : 0, JSON.stringify(payload), now()]
  );
  if (!signatureValid) {
    await db.run(
      `UPDATE webhook_events SET status = 'rejected', processed_at = ?, error_message = ?
        WHERE provider = 'razorpay' AND provider_event_id = ?`,
      [now(), 'Invalid signature', uniqueId]
    );
    throw httpError(400, 'invalid_webhook_signature', 'Razorpay webhook signature verification failed.');
  }
  try {
    await applyWebhook(db, payload);
    await db.run(
      `UPDATE webhook_events SET status = 'processed', processed_at = ?
        WHERE provider = 'razorpay' AND provider_event_id = ?`,
      [now(), uniqueId]
    );
    await invalidateOrganizationCache(organizationId);
    await publishOrganizationEvent(organizationId, 'payments.changed', { webhook_event: payload.event, event_id: uniqueId });
    return { duplicate: false, status: 'processed' };
  } catch (error) {
    await db.run(
      `UPDATE webhook_events SET status = 'failed', processed_at = ?, error_message = ?
        WHERE provider = 'razorpay' AND provider_event_id = ?`,
      [now(), String(error.message).slice(0, 1000), uniqueId]
    );
    throw error;
  }
}

export async function paymentReconciliation(db, query = {}) {
  const params = [];
  const where = [`provider = 'razorpay'`];
  if (query.status) { where.push('status = ?'); params.push(query.status); }
  if (query.from) { where.push('created_at >= ?'); params.push(query.from); }
  if (query.to) { where.push('created_at <= ?'); params.push(query.to); }
  const transactions = await db.all(
    `SELECT * FROM payment_gateway_transactions WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC LIMIT 500`,
    params
  );
  const summary = await db.all(
    `SELECT direction, status, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
       FROM payment_gateway_transactions WHERE ${where.join(' AND ')}
       GROUP BY direction, status ORDER BY direction, status`,
    params
  );
  return { summary, transactions: transactions.map(row => ({ ...row, raw_response: parseJson(row.raw_response, {}) })) };
}

export async function loadRazorpayConfig(db) {
  const record = await db.one(
    `SELECT encrypted_config FROM integration_credentials WHERE provider = 'razorpay' AND status = 'active'`
  );
  const config = record ? decryptIntegrationConfig(record.encrypted_config) : {
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
    webhook_secret: process.env.RAZORPAY_WEBHOOK_SECRET
  };
  if (!config.key_id || !config.key_secret) {
    throw httpError(503, 'integration_not_configured', 'Razorpay credentials are not configured for this organization.');
  }
  return config;
}

async function applyWebhook(db, payload) {
  const payment = payload.payload?.payment?.entity;
  const refund = payload.payload?.refund?.entity;
  const settlement = payload.payload?.settlement?.entity;
  if (payment?.order_id) {
    await db.run(
      `UPDATE payment_gateway_transactions
          SET provider_payment_id = COALESCE(?, provider_payment_id), status = ?,
              raw_response = ?, updated_at = ?
        WHERE provider = 'razorpay' AND provider_order_id = ? AND direction = 'payment'`,
      [payment.id, payment.status || webhookPaymentStatus(payload.event), JSON.stringify(payment), now(), payment.order_id]
    );
    await db.run(
      `UPDATE payment_attempts
          SET provider_payment_id = COALESCE(?, provider_payment_id), status = ?,
              response_payload = ?, updated_at = ?
        WHERE provider = 'razorpay' AND provider_order_id = ?`,
      [
        payment.id,
        String(payment.status || webhookPaymentStatus(payload.event)).toUpperCase(),
        JSON.stringify(sanitizeProviderPayload(payment)),
        now(),
        payment.order_id
      ]
    );
  }
  if (refund?.id) {
    const exists = await db.one(
      `SELECT id FROM payment_gateway_transactions WHERE provider = 'razorpay' AND provider_refund_id = ?`,
      [refund.id]
    );
    if (!exists) {
      await db.run(
        `INSERT INTO payment_gateway_transactions
          (provider, provider_payment_id, provider_refund_id, direction, amount, currency,
           status, raw_response, created_at, updated_at)
         VALUES ('razorpay', ?, ?, 'refund', ?, ?, ?, ?, ?, ?)`,
        [refund.payment_id, refund.id, Number(refund.amount) / 100, refund.currency || 'INR',
          refund.status || 'processed', JSON.stringify(refund), now(), now()]
      );
    }
  }
  if (settlement?.id) {
    await db.run(
      `INSERT INTO settlements
        (provider, provider_settlement_id, amount, fees, tax, status, settled_at, raw_response, created_at)
       VALUES ('razorpay', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider_settlement_id) DO UPDATE SET
         amount = excluded.amount, fees = excluded.fees, tax = excluded.tax,
         status = excluded.status, settled_at = excluded.settled_at, raw_response = excluded.raw_response`,
      [
        settlement.id, Number(settlement.amount || 0) / 100, Number(settlement.fees || 0) / 100,
        Number(settlement.tax || 0) / 100, settlement.status || 'processed',
        settlement.settled_at ? new Date(settlement.settled_at * 1000).toISOString() : null,
        JSON.stringify(settlement), now()
      ]
    );
  }
}

function defaultSdkFactory(config) {
  return new Razorpay({ key_id: config.key_id, key_secret: config.key_secret });
}

function hmac(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function integrationError(error) {
  const result = httpError(502, 'payment_provider_error', 'Razorpay could not complete the request.');
  result.details = { provider_message: error?.error?.description || error?.message || 'Unknown provider error' };
  return result;
}

function sanitizeProviderPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const sanitized = { ...payload };
  for (const key of ['card', 'cvv', 'key_secret', 'secret', 'razorpay_signature']) delete sanitized[key];
  return sanitized;
}

function webhookPaymentStatus(event) {
  if (event === 'payment.captured') return 'captured';
  if (event === 'payment.failed') return 'failed';
  return 'authorized';
}

async function notify(req, event, payload) {
  await invalidateOrganizationCache(req.user.organization_id);
  await publishOrganizationEvent(req.user.organization_id, event, payload);
}

function now() {
  return new Date().toISOString();
}
