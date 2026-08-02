import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { hasPermission } from '../platform/phase5Auth.js';
import { getControlDatabase } from '../platform/phase5Database.js';
import { httpError, parseJson, writeTenantAudit } from '../platform/phase5Http.js';
import { enqueueDomainJob, invalidateOrganizationCache, publishOrganizationEvent } from '../platform/phase5Runtime.js';
import { createInvoiceStorageAdapter } from '../platform/storageAdapter.js';
import { fromMinor, minorToFixed, positiveDecimal, toMinor } from './moneyService.js';
import { numberToWords } from './numberToWords.js';
import { generatePDFBuffer } from './pdfService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const invoiceStorage = createInvoiceStorageAdapter();
const SUCCESS_STATUSES = new Set(['SUCCESS']);
const MANUAL_SUCCESS = new Set(['CASH', 'CARD', 'UPI', 'BANK_TRANSFER', 'STORE_CREDIT']);

export async function resolveInvoiceSnapshots(tx, input, req, customer) {
  const organization = await getControlDatabase().one(
    'SELECT id, name, settings FROM organizations WHERE id = ?',
    [req.user.organization_id]
  );
  const controlSettings = parseJson(organization?.settings, {});
  const tenantSettingsRows = await tx.all('SELECT setting_key, setting_value FROM organization_settings');
  const tenantSettings = Object.fromEntries(
    tenantSettingsRows.map(row => [row.setting_key, parseJson(row.setting_value, row.setting_value)])
  );
  const organizationSettings = tenantSettings['settings.organization'] || {};
  const documentSettings = tenantSettings['settings.documents'] || {};
  const settings = { ...controlSettings, ...organizationSettings, ...tenantSettings };
  const customerProfile = customer
    ? await tx.one(`SELECT * FROM party_profiles WHERE party_type = 'customer' AND party_id = ?`, [customer.id])
    : null;
  const customerAddress = customer
    ? await tx.one(
      `SELECT * FROM party_addresses
        WHERE party_type = 'customer' AND party_id = ?
        ORDER BY is_primary DESC, id ASC LIMIT 1`,
      [customer.id]
    )
    : null;
  const sellerStateCode = String(settings.state_code || settings.company_state_code || '').trim();
  const suppliedCustomerStateCode = String(
    input.invoice_details?.customer_state_code
      || input.invoice_details?.supply_state_code
      || customerAddress?.state_code
      || ''
  ).trim();
  const customerStateCode = suppliedCustomerStateCode || sellerStateCode;

  return {
    seller: {
      organization_id: req.user.organization_id,
      name: settings.company_name || organization?.name || 'Inventia',
      logo: settings.company_logo || null,
      address: settings.company_address || settings.address || '',
      gstin: settings.company_gstin || settings.gstin || '',
      pan: settings.company_pan || settings.pan || '',
      phone: settings.company_phone || settings.phone || '',
      email: settings.company_email || settings.email || '',
      state: settings.company_state || settings.state || '',
      state_code: sellerStateCode
    },
    customer: {
      id: customer?.id || null,
      name: customer?.name || 'Walk-in Customer',
      address: input.invoice_details?.customer_address || customerAddress?.line1 || customer?.address || '',
      phone: customer?.phone || '',
      email: customer?.email || '',
      gstin: input.invoice_details?.customer_gstin || customerProfile?.gstin || '',
      state: input.invoice_details?.customer_state || customerAddress?.state || '',
      state_code: customerStateCode
    },
    delivery: {
      challan_number: input.invoice_details?.challan_number || '',
      transport: input.invoice_details?.transport || '',
      vehicle_number: input.invoice_details?.vehicle_number || '',
      eway_bill_number: input.invoice_details?.eway_bill_number || '',
      supply_state: input.invoice_details?.supply_state || '',
      supply_state_code: input.invoice_details?.supply_state_code || customerStateCode
    },
    bank: {
      bank_name: settings.bank_name || '',
      account_number: settings.bank_account_number || '',
      ifsc: settings.bank_ifsc || '',
      upi_id: settings.upi_id || ''
    },
    terms: String(documentSettings.terms_by_type?.invoice || documentSettings.default_terms || settings.invoice_terms || settings.terms_conditions || 'Goods once sold are subject to the stated return policy.'),
    document: documentSettings,
    is_interstate: Boolean(sellerStateCode && customerStateCode && sellerStateCode !== customerStateCode),
    default_credit_days: Number(settings.default_credit_days || 30)
  };
}

export async function createCheckoutPaymentsTx(tx, {
  invoice,
  input,
  customer,
  actorId,
  req,
  existingOutstanding = false
}) {
  const paymentInputs = normalizeSubmittedPayments(input, invoice.grand_total_minor);
  const settings = await getPaymentMethodSettings(tx);
  const allocations = [];
  let submittedMinor = 0;
  let successfulMinor = 0;

  for (const submitted of paymentInputs) {
    const method = String(submitted.method || '').toUpperCase();
    const methodSetting = settings.get(method);
    if (!methodSetting?.enabled) {
      throw httpError(409, 'payment_method_disabled', `${method || 'Payment method'} is not enabled.`);
    }
    const amountMinor = toMinor(submitted.amount, `${method} amount`);
    if (amountMinor <= 0) throw httpError(422, 'positive_payment_required', 'Payment allocations must be greater than zero.');
    submittedMinor += amountMinor;
    if (submittedMinor > invoice.grand_total_minor) {
      throw httpError(409, 'overpayment_not_allowed', 'Payment allocations cannot exceed the invoice total.');
    }
    const reference = String(submitted.reference || submitted.reference_number || '').trim();
    if (methodSetting.requires_reference && !reference) {
      throw httpError(422, 'payment_reference_required', `${methodSetting.label} requires a reference number.`);
    }

    let status = methodSetting.initial_status;
    if (method === 'RAZORPAY') {
      const attempt = await tx.one(
        `SELECT * FROM payment_gateway_transactions
          WHERE provider = 'razorpay' AND provider_payment_id = ? AND status = 'captured'`,
        [submitted.provider_transaction_id || reference]
      );
      if (!attempt) {
        throw httpError(409, 'razorpay_payment_not_verified', 'A signature-verified Razorpay capture is required.');
      }
      if (toMinor(attempt.amount) !== amountMinor) {
        throw httpError(409, 'payment_amount_mismatch', 'The verified Razorpay capture amount does not match its allocation.');
      }
      status = 'SUCCESS';
    } else if (methodSetting.initial_status === 'CREDIT') {
      status = 'PENDING';
    } else if (MANUAL_SUCCESS.has(method)) {
      status = 'SUCCESS';
    }

    if (method === 'STORE_CREDIT') {
      if (!customer) throw httpError(422, 'customer_required', 'Store credit requires a customer.');
      const credit = await tx.one(
        `SELECT balance_minor FROM customer_store_credit_accounts WHERE customer_id = ?`,
        [customer.id]
      );
      if (Number(credit?.balance_minor || 0) < amountMinor) {
        throw httpError(409, 'store_credit_insufficient', 'The customer does not have enough store credit.');
      }
      await tx.run(
        `UPDATE customer_store_credit_accounts
            SET balance_minor = balance_minor - ?, updated_at = ?
          WHERE customer_id = ?`,
        [amountMinor, now(), customer.id]
      );
    }

    const paymentNumber = await nextFinancialNumber(tx, 'payment', 'PAY');
    const paymentInsert = await insertWithId(tx,
      `INSERT INTO payments
        (payment_number, customer_id, direction, amount_minor, currency, status,
         received_at, notes, created_by, idempotency_key, created_at, updated_at)
       VALUES (?, ?, 'IN', ?, 'INR', ?, ?, ?, ?, ?, ?, ?)`,
      [
        paymentNumber, customer?.id || null, amountMinor, status,
        status === 'SUCCESS' ? now() : null, submitted.notes || null, actorId,
        `${String(req.headers?.['idempotency-key'] || crypto.randomUUID())}:${allocations.length}`,
        now(), now()
      ]
    );
    const paymentId = insertedId(paymentInsert);
    const allocationInsert = await insertWithId(tx,
      `INSERT INTO payment_allocations
        (payment_id, invoice_id, method, amount_minor, reference_number, provider,
         provider_transaction_id, status, metadata, created_by, confirmed_by,
         confirmed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        paymentId, invoice.id, method, amountMinor, reference || null,
        method === 'RAZORPAY' ? 'razorpay' : null,
        method === 'RAZORPAY' ? (submitted.provider_transaction_id || reference) : null,
        status, JSON.stringify({ source: 'pos', cashier_confirmed: status === 'SUCCESS' }),
        actorId, status === 'SUCCESS' ? actorId : null, status === 'SUCCESS' ? now() : null,
        now(), now()
      ]
    );
    const allocationId = insertedId(allocationInsert);
    if (method === 'RAZORPAY') {
      const legacyAttempt = await tx.one(
        `SELECT * FROM payment_gateway_transactions
          WHERE provider = 'razorpay' AND provider_payment_id = ?`,
        [submitted.provider_transaction_id || reference]
      );
      await tx.run(
        `INSERT INTO payment_attempts
          (allocation_id, invoice_id, provider, provider_order_id, provider_payment_id,
           amount_minor, currency, status, signature_hash, response_payload,
           idempotency_key, created_at, updated_at)
         VALUES (?, ?, 'razorpay', ?, ?, ?, 'INR', 'CAPTURED', ?, ?, ?, ?, ?)
         ON CONFLICT (provider, provider_payment_id) DO UPDATE SET
           allocation_id = excluded.allocation_id, invoice_id = excluded.invoice_id,
           updated_at = excluded.updated_at`,
        [
          allocationId, invoice.id, legacyAttempt?.provider_order_id || null,
          submitted.provider_transaction_id || reference, amountMinor,
          legacyAttempt?.signature_hash || null,
          JSON.stringify({ imported_gateway_transaction_id: legacyAttempt?.id || null }),
          `razorpay-capture:${submitted.provider_transaction_id || reference}`, now(), now()
        ]
      );
      await tx.run(
        `UPDATE payment_gateway_transactions
            SET trade_document_id = ?, customer_id = ?, updated_at = ?
          WHERE provider = 'razorpay' AND provider_payment_id = ?`,
        [invoice.trade_document_id, customer?.id || null, now(), submitted.provider_transaction_id || reference]
      );
    }
    if (status === 'SUCCESS') successfulMinor += amountMinor;
    allocations.push({
      id: allocationId,
      payment_id: paymentId,
      payment_number: paymentNumber,
      method,
      amount_minor: amountMinor,
      amount: fromMinor(amountMinor),
      reference_number: reference || null,
      status
    });
  }

  const outstandingMinor = invoice.grand_total_minor - successfulMinor;
  const needsCreditTerms = outstandingMinor > 0;
  if (needsCreditTerms) {
    if (!customer) {
      throw httpError(422, 'customer_required_for_outstanding', 'Partial, pending, or pay-later invoices require a customer.');
    }
    if (!input.allow_partial_payment) {
      throw httpError(409, 'partial_payment_not_allowed', 'Enable partial payment to leave an outstanding balance.');
    }
    if (!hasPermission(req.user.permissions || [], 'payments.credit')) {
      throw httpError(403, 'credit_permission_required', 'Permission payments.credit is required to leave an outstanding balance.');
    }
    if (!invoice.due_date) {
      throw httpError(422, 'due_date_required', 'A due date is required when an outstanding balance remains.');
    }
    const dueTime = new Date(`${invoice.due_date}T23:59:59.999Z`).getTime();
    if (!Number.isFinite(dueTime) || dueTime < Date.now()) {
      throw httpError(422, 'invalid_due_date', 'The due date must be today or later.');
    }
    if (!existingOutstanding) await enforceCustomerCredit(tx, customer, outstandingMinor);
  }
  return { allocations, submitted_minor: submittedMinor, successful_minor: successfulMinor };
}

export async function recordInvoiceLedgerTx(tx, invoice, paymentResult, actorId) {
  if (!invoice.customer_id) return;
  await appendCustomerLedgerTx(tx, {
    customerId: invoice.customer_id,
    invoiceId: invoice.id,
    entryType: 'INVOICE',
    direction: 'DEBIT',
    amountMinor: invoice.grand_total_minor,
    referenceNumber: invoice.invoice_number,
    description: `Invoice ${invoice.invoice_number} issued.`,
    actorId
  });
  for (const allocation of paymentResult.allocations.filter(item => item.status === 'SUCCESS')) {
    await appendCustomerLedgerTx(tx, {
      customerId: invoice.customer_id,
      invoiceId: invoice.id,
      paymentId: allocation.payment_id,
      entryType: 'PAYMENT',
      direction: 'CREDIT',
      amountMinor: allocation.amount_minor,
      referenceNumber: allocation.payment_number,
      description: `${allocation.method} collected against ${invoice.invoice_number}.`,
      actorId
    });
  }
}

export async function calculateInvoicePaymentState(db, invoiceId, { persist = true } = {}) {
  const invoice = await db.one('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  if (!invoice) throw httpError(404, 'invoice_not_found', 'Invoice was not found.');
  const collected = await db.one(
    `SELECT COALESCE(SUM(amount_minor), 0) AS amount
       FROM payment_allocations WHERE invoice_id = ? AND status = 'SUCCESS'`,
    [invoiceId]
  );
  const refunded = await db.one(
    `SELECT COALESCE(SUM(amount_minor), 0) AS amount
       FROM refunds WHERE invoice_id = ? AND status = 'SUCCESS'`,
    [invoiceId]
  );
  const adjustments = await db.one(
    `SELECT
       COALESCE(SUM(CASE WHEN adjustment_type = 'CREDIT_NOTE' THEN grand_total_minor ELSE 0 END), 0) AS credits,
       COALESCE(SUM(CASE WHEN adjustment_type = 'DEBIT_NOTE' THEN grand_total_minor ELSE 0 END), 0) AS debits
       FROM fiscal_adjustments WHERE invoice_id = ? AND status = 'ISSUED'`,
    [invoiceId]
  );
  const collectedMinor = Number(collected?.amount || 0);
  const refundedMinor = Number(refunded?.amount || 0);
  const creditAdjustmentsMinor = Number(adjustments?.credits || 0);
  const debitAdjustmentsMinor = Number(adjustments?.debits || 0);
  const adjustedTotalMinor = Math.max(Number(invoice.grand_total_minor) - creditAdjustmentsMinor + debitAdjustmentsMinor, 0);
  const netCollectedMinor = collectedMinor - refundedMinor;
  const outstandingMinor = Math.max(adjustedTotalMinor - netCollectedMinor, 0);
  let status;
  if (invoice.invoice_status === 'VOID') status = 'VOID';
  else if (invoice.invoice_status === 'WRITTEN_OFF') status = 'WRITTEN_OFF';
  else if (refundedMinor > 0 && netCollectedMinor <= 0) status = 'REFUNDED';
  else if (refundedMinor > 0) status = 'PARTIALLY_REFUNDED';
  else if (netCollectedMinor > adjustedTotalMinor) status = 'OVERPAID';
  else if (outstandingMinor === 0) status = 'PAID';
  else if (netCollectedMinor > 0) status = 'PARTIALLY_PAID';
  else status = 'UNPAID';
  if (persist && invoice.payment_status !== status) {
    await db.run('UPDATE invoices SET payment_status = ?, updated_at = ? WHERE id = ?', [status, now(), invoiceId]);
    await db.run(
      `UPDATE sales SET payment_status = ? WHERE id = ?`,
      [status === 'PAID' ? 'completed' : status.toLowerCase(), invoice.sale_id]
    );
  }
  return {
    status,
    total_minor: Number(invoice.grand_total_minor),
    adjusted_total_minor: adjustedTotalMinor,
    credit_adjustments_minor: creditAdjustmentsMinor,
    debit_adjustments_minor: debitAdjustmentsMinor,
    collected_minor: collectedMinor,
    refunded_minor: refundedMinor,
    net_collected_minor: netCollectedMinor,
    outstanding_minor: outstandingMinor,
    total: fromMinor(invoice.grand_total_minor),
    adjusted_total: fromMinor(adjustedTotalMinor),
    credit_adjustments: fromMinor(creditAdjustmentsMinor),
    debit_adjustments: fromMinor(debitAdjustmentsMinor),
    collected: fromMinor(collectedMinor),
    refunded: fromMinor(refundedMinor),
    net_collected: fromMinor(netCollectedMinor),
    outstanding: fromMinor(outstandingMinor)
  };
}

export async function listInvoices(db, query = {}) {
  const where = ['1 = 1'];
  const params = [];
  if (query.q) {
    where.push(`(lower(i.invoice_number) LIKE lower(?) OR lower(COALESCE(c.name, '')) LIKE lower(?))`);
    params.push(`%${query.q}%`, `%${query.q}%`);
  }
  if (query.customer_id) {
    where.push('i.customer_id = ?');
    params.push(query.customer_id);
  }
  if (query.payment_status) {
    where.push('i.payment_status = ?');
    params.push(String(query.payment_status).toUpperCase());
  }
  if (query.date_from) {
    where.push('i.issued_at >= ?');
    params.push(`${query.date_from}T00:00:00.000Z`);
  }
  if (query.date_to) {
    where.push('i.issued_at <= ?');
    params.push(`${query.date_to}T23:59:59.999Z`);
  }
  const rows = await db.all(
    `SELECT i.id, i.sale_id, i.customer_id, i.invoice_number, i.invoice_status,
            i.payment_status, i.grand_total_minor, i.issued_at, i.due_date,
            i.pdf_status, i.latest_pdf_version, c.name AS customer_name,
            COALESCE(SUM(CASE WHEN pa.status = 'SUCCESS' THEN pa.amount_minor ELSE 0 END), 0) AS collected_minor,
            COALESCE((SELECT SUM(r.amount_minor) FROM refunds r WHERE r.invoice_id = i.id AND r.status = 'SUCCESS'), 0) AS refunded_minor,
            COALESCE((SELECT SUM(fa.grand_total_minor) FROM fiscal_adjustments fa WHERE fa.invoice_id = i.id AND fa.adjustment_type = 'CREDIT_NOTE' AND fa.status = 'ISSUED'), 0) AS credit_adjustments_minor,
            COALESCE((SELECT SUM(fa.grand_total_minor) FROM fiscal_adjustments fa WHERE fa.invoice_id = i.id AND fa.adjustment_type = 'DEBIT_NOTE' AND fa.status = 'ISSUED'), 0) AS debit_adjustments_minor
       FROM invoices i
       LEFT JOIN customers c ON c.id = i.customer_id
       LEFT JOIN payment_allocations pa ON pa.invoice_id = i.id
      WHERE ${where.join(' AND ')}
      GROUP BY i.id, i.sale_id, i.customer_id, i.invoice_number, i.invoice_status,
               i.payment_status, i.grand_total_minor, i.issued_at, i.due_date,
               i.pdf_status, i.latest_pdf_version, c.name
      ORDER BY i.issued_at DESC, i.id DESC LIMIT 500`,
    params
  );
  return rows.map(row => {
    const adjustedTotalMinor = Math.max(Number(row.grand_total_minor) - Number(row.credit_adjustments_minor || 0) + Number(row.debit_adjustments_minor || 0), 0);
    return {
      ...row,
      grand_total: fromMinor(row.grand_total_minor),
      adjusted_total: fromMinor(adjustedTotalMinor),
      collected: fromMinor(Number(row.collected_minor || 0) - Number(row.refunded_minor || 0)),
      outstanding: fromMinor(Math.max(adjustedTotalMinor - Number(row.collected_minor || 0) + Number(row.refunded_minor || 0), 0)),
      pdf: invoicePdfState(row)
    };
  });
}

export async function getInvoice(db, invoiceId) {
  const invoice = await db.one(
    `SELECT i.*, c.name AS customer_name FROM invoices i
      LEFT JOIN customers c ON c.id = i.customer_id WHERE i.id = ?`,
    [invoiceId]
  );
  if (!invoice) throw httpError(404, 'invoice_not_found', 'Invoice was not found.');
  const [items, allocations, refunds, pdfVersions, paymentSummary] = await Promise.all([
    db.all('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id', [invoiceId]),
    db.all(
      `SELECT pa.*, p.payment_number, p.received_at
         FROM payment_allocations pa LEFT JOIN payments p ON p.id = pa.payment_id
        WHERE pa.invoice_id = ? ORDER BY pa.created_at, pa.id`,
      [invoiceId]
    ),
    db.all('SELECT * FROM refunds WHERE invoice_id = ? ORDER BY created_at, id', [invoiceId]),
    db.all('SELECT * FROM invoice_pdf_versions WHERE invoice_id = ? ORDER BY version DESC', [invoiceId]),
    calculateInvoicePaymentState(db, invoiceId)
  ]);
  return {
    ...invoice,
    seller_snapshot: parseJson(invoice.seller_snapshot, {}),
    customer_snapshot: parseJson(invoice.customer_snapshot, {}),
    delivery_snapshot: parseJson(invoice.delivery_snapshot, {}),
    bank_snapshot: parseJson(invoice.bank_snapshot, {}),
    document_settings_snapshot: parseJson(invoice.document_settings_snapshot, {}),
    items: items.map(item => ({ ...item, metadata: parseJson(item.metadata, {}) })),
    allocations: allocations.map(item => ({ ...item, metadata: parseJson(item.metadata, {}) })),
    refunds,
    pdf_versions: pdfVersions,
    payment_summary: paymentSummary,
    pdf: invoicePdfState(invoice)
  };
}

export async function collectInvoicePayment(db, invoiceId, input, req) {
  const actorId = req.user.tenant_user_id || req.user.id;
  const result = await db.transaction(async tx => {
    const invoice = await lockedInvoice(tx, invoiceId);
    const state = await calculateInvoicePaymentState(tx, invoiceId, { persist: false });
    if (state.outstanding_minor <= 0) throw httpError(409, 'invoice_has_no_outstanding', 'This invoice has no outstanding balance.');
    const customer = invoice.customer_id
      ? await tx.one('SELECT * FROM customers WHERE id = ?', [invoice.customer_id])
      : null;
    const paymentResult = await createCheckoutPaymentsTx(tx, {
      invoice: { ...invoice, grand_total_minor: state.outstanding_minor },
      input: { ...input, allow_partial_payment: input.allow_partial_payment ?? true },
      customer,
      actorId,
      req,
      existingOutstanding: true
    });
    for (const allocation of paymentResult.allocations.filter(item => item.status === 'SUCCESS' && customer)) {
      await appendCustomerLedgerTx(tx, {
        customerId: customer.id,
        invoiceId: invoice.id,
        paymentId: allocation.payment_id,
        entryType: 'PAYMENT',
        direction: 'CREDIT',
        amountMinor: allocation.amount_minor,
        referenceNumber: allocation.payment_number,
        description: `${allocation.method} collected against ${invoice.invoice_number}.`,
        actorId
      });
    }
    return { invoice, allocations: paymentResult.allocations };
  });
  const paymentSummary = await calculateInvoicePaymentState(db, invoiceId);
  await writeTenantAudit(db, req, {
    eventType: 'invoice.payment_collected',
    entityType: 'invoice',
    entityId: invoiceId,
    after: { allocations: result.allocations, payment_summary: paymentSummary }
  });
  await announce(req, 'payments.changed', { invoice_id: Number(invoiceId), payment_summary: paymentSummary });
  return { success: true, allocations: result.allocations, payment_summary: paymentSummary };
}

export async function confirmPaymentAllocation(db, allocationId, req) {
  const actorId = req.user.tenant_user_id || req.user.id;
  const result = await db.transaction(async tx => {
    const allocation = await tx.one(
      `SELECT pa.*, i.customer_id, i.invoice_number, i.grand_total_minor
         FROM payment_allocations pa JOIN invoices i ON i.id = pa.invoice_id
        WHERE pa.id = ?${tx.dialect === 'postgres' ? ' FOR UPDATE' : ''}`,
      [allocationId]
    );
    if (!allocation) throw httpError(404, 'payment_allocation_not_found', 'Payment allocation was not found.');
    if (allocation.status !== 'PENDING') {
      throw httpError(409, 'allocation_not_pending', 'Only pending payment allocations can be confirmed.');
    }
    if (!['CHEQUE', 'OTHER', 'CUSTOMER_CREDIT'].includes(allocation.method)) {
      throw httpError(409, 'allocation_confirmation_not_supported', 'This payment method is not manually confirmable.');
    }
    if (allocation.method === 'CUSTOMER_CREDIT') {
      throw httpError(409, 'credit_is_not_collection', 'Customer credit must be settled with a collection payment.');
    }
    const [successful, refunded] = await Promise.all([
      tx.one(
        `SELECT COALESCE(SUM(amount_minor), 0) AS amount
           FROM payment_allocations WHERE invoice_id = ? AND status = 'SUCCESS'`,
        [allocation.invoice_id]
      ),
      tx.one(
        `SELECT COALESCE(SUM(amount_minor), 0) AS amount
           FROM refunds WHERE invoice_id = ? AND status = 'SUCCESS'`,
        [allocation.invoice_id]
      )
    ]);
    const projectedNet = Number(successful?.amount || 0)
      + Number(allocation.amount_minor)
      - Number(refunded?.amount || 0);
    if (projectedNet > Number(allocation.grand_total_minor)) {
      throw httpError(409, 'overpayment_not_allowed', 'Confirming this allocation would overpay the invoice.');
    }
    await tx.run(
      `UPDATE payment_allocations
          SET status = 'SUCCESS', confirmed_by = ?, confirmed_at = ?, updated_at = ?
        WHERE id = ?`,
      [actorId, now(), now(), allocationId]
    );
    await tx.run(
      `UPDATE payments SET status = 'SUCCESS', received_at = ?, updated_at = ? WHERE id = ?`,
      [now(), now(), allocation.payment_id]
    );
    if (allocation.customer_id) {
      const already = await tx.one(
        `SELECT id FROM customer_ledger_entries
          WHERE payment_id = ? AND invoice_id = ? AND entry_type = 'PAYMENT'`,
        [allocation.payment_id, allocation.invoice_id]
      );
      if (!already) {
        await appendCustomerLedgerTx(tx, {
          customerId: allocation.customer_id,
          invoiceId: allocation.invoice_id,
          paymentId: allocation.payment_id,
          entryType: 'PAYMENT',
          direction: 'CREDIT',
          amountMinor: Number(allocation.amount_minor),
          referenceNumber: allocation.reference_number,
          description: `${allocation.method} confirmed against ${allocation.invoice_number}.`,
          actorId
        });
      }
    }
    return allocation;
  });
  const paymentSummary = await calculateInvoicePaymentState(db, result.invoice_id);
  await writeTenantAudit(db, req, {
    eventType: 'payment.allocation_confirmed',
    entityType: 'payment_allocation',
    entityId: allocationId,
    after: { status: 'SUCCESS', payment_summary: paymentSummary }
  });
  await announce(req, 'payments.changed', { allocation_id: Number(allocationId), payment_summary: paymentSummary });
  return { success: true, allocation_id: Number(allocationId), payment_summary: paymentSummary };
}

export async function refundPaymentAllocation(db, allocationId, input, req) {
  const actorId = req.user.tenant_user_id || req.user.id;
  const result = await db.transaction(async tx => {
    const allocation = await tx.one(
      `SELECT pa.*, i.customer_id, i.invoice_number
         FROM payment_allocations pa JOIN invoices i ON i.id = pa.invoice_id
        WHERE pa.id = ?${tx.dialect === 'postgres' ? ' FOR UPDATE' : ''}`,
      [allocationId]
    );
    if (!allocation) throw httpError(404, 'payment_allocation_not_found', 'Payment allocation was not found.');
    if (allocation.status !== 'SUCCESS') throw httpError(409, 'allocation_not_refundable', 'Only successful allocations can be refunded.');
    if (allocation.method === 'RAZORPAY') {
      throw httpError(409, 'razorpay_refund_endpoint_required', 'Use the Razorpay refund endpoint for captured Razorpay allocations.');
    }
    const amountMinor = toMinor(input.amount, 'refund amount');
    if (amountMinor <= 0) throw httpError(422, 'positive_refund_required', 'Refund amount must be greater than zero.');
    const existing = await tx.one(
      `SELECT COALESCE(SUM(amount_minor), 0) AS amount
         FROM refunds WHERE allocation_id = ? AND status = 'SUCCESS'`,
      [allocationId]
    );
    if (Number(existing?.amount || 0) + amountMinor > Number(allocation.amount_minor)) {
      throw httpError(409, 'refund_exceeds_allocation', 'Refund total cannot exceed the payment allocation.');
    }
    const refundNumber = await nextFinancialNumber(tx, 'refund', 'RFN');
    const refundInsert = await insertWithId(tx,
      `INSERT INTO refunds
        (refund_number, allocation_id, payment_id, invoice_id, amount_minor, status,
         method, reason, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'SUCCESS', ?, ?, ?, ?)`,
      [
        refundNumber, allocation.id, allocation.payment_id, allocation.invoice_id,
        amountMinor, allocation.method, input.reason || null, actorId, now()
      ]
    );
    const refundId = insertedId(refundInsert);
    if (allocation.customer_id) {
      await appendCustomerLedgerTx(tx, {
        customerId: allocation.customer_id,
        invoiceId: allocation.invoice_id,
        paymentId: allocation.payment_id,
        refundId,
        entryType: 'REFUND',
        direction: 'DEBIT',
        amountMinor,
        referenceNumber: refundNumber,
        description: `Refund against ${allocation.invoice_number}.`,
        actorId
      });
    }
    return { refund_id: refundId, refund_number: refundNumber, invoice_id: allocation.invoice_id, amount_minor: amountMinor };
  });
  const paymentSummary = await calculateInvoicePaymentState(db, result.invoice_id);
  await writeTenantAudit(db, req, {
    eventType: 'payment.refunded',
    entityType: 'refund',
    entityId: result.refund_id,
    after: { ...result, payment_summary: paymentSummary }
  });
  await announce(req, 'payments.changed', { refund: result, payment_summary: paymentSummary });
  return { success: true, ...result, amount: fromMinor(result.amount_minor), payment_summary: paymentSummary };
}

export async function getPaymentMethods(db) {
  const methods = await db.all(
    `SELECT method, label, enabled, requires_reference, initial_status, display_order
       FROM payment_method_settings ORDER BY display_order, method`
  );
  return methods.map(method => ({
    ...method,
    enabled: Boolean(method.enabled),
    requires_reference: Boolean(method.requires_reference)
  }));
}

export async function updatePaymentMethods(db, methods, req) {
  await db.transaction(async tx => {
    for (const method of methods) {
      const existing = await tx.one('SELECT method FROM payment_method_settings WHERE method = ?', [method.method]);
      if (!existing) throw httpError(404, 'payment_method_not_found', `Payment method ${method.method} was not found.`);
      await tx.run(
        `UPDATE payment_method_settings
            SET label = COALESCE(?, label), enabled = COALESCE(?, enabled),
                requires_reference = COALESCE(?, requires_reference), updated_at = ?
          WHERE method = ?`,
        [
          method.label ?? null,
          method.enabled == null ? null : Number(method.enabled),
          method.requires_reference == null ? null : Number(method.requires_reference),
          now(), method.method
        ]
      );
    }
  });
  const result = await getPaymentMethods(db);
  await writeTenantAudit(db, req, {
    eventType: 'payment_methods.updated',
    entityType: 'settings',
    entityId: 'payment-methods',
    after: result
  });
  return { methods: result };
}

export async function attemptInvoicePdf(db, organizationId, invoiceId, options = {}) {
  const actorId = options.actorId || null;
  let version;
  let invoiceNumber;
  await db.transaction(async tx => {
    const invoice = await lockedInvoice(tx, invoiceId);
    if (invoice.pdf_status === 'GENERATING') {
      throw httpError(409, 'pdf_generation_in_progress', 'Invoice PDF generation is already in progress.');
    }
    version = Number(invoice.latest_pdf_version || 0) + 1;
    invoiceNumber = invoice.invoice_number;
    await tx.run(
      `UPDATE invoices SET pdf_status = 'GENERATING', pdf_error = NULL, updated_at = ? WHERE id = ?`,
      [now(), invoiceId]
    );
  });

  try {
    const invoice = await getInvoice(db, invoiceId);
    const html = await renderInvoiceHtml(invoice);
    const buffer = await (options.generateBuffer || generatePDFBuffer)(html, {
      timeoutMs: Number(process.env.INVOICE_PDF_TIMEOUT_MS || 30000)
    });
    const year = String(new Date(invoice.issued_at).getFullYear());
    const key = `invoices/${organizationId}/${year}/${invoiceNumber}-v${version}.pdf`;
    const stored = await invoiceStorage.putKey({ key, contentType: 'application/pdf', buffer });
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
    await db.transaction(async tx => {
      await tx.run(
        `INSERT INTO invoice_pdf_versions
          (invoice_id, version, storage_provider, storage_key, content_type,
           size_bytes, checksum_sha256, generated_by, created_at)
         VALUES (?, ?, ?, ?, 'application/pdf', ?, ?, ?, ?)`,
        [invoiceId, version, stored.provider, stored.key, buffer.length, checksum, actorId, now()]
      );
      await tx.run(
        `UPDATE invoices
            SET pdf_status = 'READY', pdf_error = NULL, latest_pdf_version = ?,
                latest_pdf_key = ?, updated_at = ?
          WHERE id = ?`,
        [version, stored.key, now(), invoiceId]
      );
      await tx.run(
        `UPDATE document_generation_jobs
            SET status = 'COMPLETED', completed_at = ?, updated_at = ?
          WHERE invoice_id = ? AND status IN ('PENDING', 'RUNNING', 'FAILED')`,
        [now(), now(), invoiceId]
      );
    });
    return { status: 'READY', url: `/api/v1/invoices/${invoiceId}/pdf`, version };
  } catch (error) {
    const message = String(error.message || 'Invoice PDF generation failed.').slice(0, 2000);
    await db.run(
      `UPDATE invoices SET pdf_status = 'FAILED', pdf_error = ?, updated_at = ? WHERE id = ?`,
      [message, now(), invoiceId]
    );
    const jobKey = `invoice-pdf:${invoiceId}:v${version}`;
    await db.run(
      `INSERT INTO document_generation_jobs
        (invoice_id, organization_id, job_type, status, attempt_count, last_error,
         payload, idempotency_key, available_at, created_at, updated_at)
       VALUES (?, ?, 'invoice.pdf.generate', 'PENDING', 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (idempotency_key) DO UPDATE SET
         status = 'PENDING', attempt_count = document_generation_jobs.attempt_count + 1,
         last_error = excluded.last_error, available_at = excluded.available_at,
         updated_at = excluded.updated_at`,
      [
        invoiceId, organizationId, message,
        JSON.stringify({ organization_id: organizationId, invoice_id: Number(invoiceId), version }),
        jobKey, now(), now(), now()
      ]
    );
    await enqueueDomainJob('invoice.pdf.generate', {
      organization_id: organizationId,
      invoice_id: Number(invoiceId),
      requested_version: version
    }, { jobId: jobKey });
    return { status: 'FAILED', url: null, error: message, retryable: true };
  }
}

export async function retryInvoicePdf(db, organizationId, invoiceId, req, options = {}) {
  const exists = await db.one('SELECT id FROM invoices WHERE id = ?', [invoiceId]);
  if (!exists) throw httpError(404, 'invoice_not_found', 'Invoice was not found.');
  const result = await attemptInvoicePdf(db, organizationId, invoiceId, {
    ...options,
    actorId: req.user.tenant_user_id || req.user.id
  });
  await writeTenantAudit(db, req, {
    eventType: 'invoice.pdf_retried',
    entityType: 'invoice',
    entityId: invoiceId,
    after: result
  });
  await announce(req, 'invoices.changed', { invoice_id: Number(invoiceId), pdf: result });
  return { success: true, invoice_id: Number(invoiceId), pdf: result };
}

export async function readInvoicePdf(db, invoiceId) {
  const invoice = await db.one(
    `SELECT id, invoice_number, pdf_status, latest_pdf_key FROM invoices WHERE id = ?`,
    [invoiceId]
  );
  if (!invoice) throw httpError(404, 'invoice_not_found', 'Invoice was not found.');
  if (invoice.pdf_status !== 'READY' || !invoice.latest_pdf_key) {
    throw httpError(409, 'invoice_pdf_not_ready', 'The invoice PDF is not ready.');
  }
  const buffer = await invoiceStorage.read(invoice.latest_pdf_key);
  return { buffer, filename: `${invoice.invoice_number}.pdf` };
}

export function invoicePdfState(invoice) {
  return {
    status: invoice.pdf_status,
    url: invoice.pdf_status === 'READY' ? `/api/v1/invoices/${invoice.id}/pdf` : null,
    version: Number(invoice.latest_pdf_version || 0),
    error: invoice.pdf_error || null
  };
}

async function renderInvoiceHtml(invoice) {
  const [htmlTemplate, css] = await Promise.all([
    fs.readFile(path.join(__dirname, '../templates/invoice.html'), 'utf8'),
    fs.readFile(path.join(__dirname, '../templates/invoice.css'), 'utf8')
  ]);
  const seller = invoice.seller_snapshot;
  const customer = invoice.customer_snapshot;
  const delivery = invoice.delivery_snapshot;
  const bank = invoice.bank_snapshot;
  const payment = invoice.payment_summary;
  const documentSettings = invoice.document_settings_snapshot || {};
  const upiUrl = bank.upi_id
    ? `upi://pay?pa=${encodeURIComponent(bank.upi_id)}&pn=${encodeURIComponent(seller.name)}&am=${minorToFixed(payment.outstanding_minor || invoice.grand_total_minor)}&cu=INR&tn=${encodeURIComponent(invoice.invoice_number)}`
    : null;
  const qrDataUrl = upiUrl ? await QRCode.toDataURL(upiUrl, { margin: 1, width: 180, errorCorrectionLevel: 'M' }) : null;
  const rows = invoice.items.map((item, index) => `
    <tr>
      <td class="text-center">${index + 1}</td>
      <td class="text-left"><strong>${escapeHtml(item.description)}</strong></td>
      <td class="text-center">${escapeHtml(item.hsn_sac || '')}</td>
      <td class="text-right">${escapeHtml(item.quantity)}</td>
      <td class="text-center">${escapeHtml(item.unit)}</td>
      <td class="text-right">${formatMoney(item.rate_minor)}</td>
      <td class="text-right">${formatMoney(item.discount_minor)}</td>
      <td class="text-right">${formatMoney(item.taxable_minor)}</td>
      <td class="text-center">${escapeHtml(item.gst_rate)}%</td>
      <td class="text-right">${formatMoney(item.cgst_minor)}</td>
      <td class="text-right">${formatMoney(item.sgst_minor)}</td>
      <td class="text-right">${formatMoney(item.igst_minor)}</td>
      <td class="text-right"><strong>${formatMoney(item.line_total_minor)}</strong></td>
    </tr>`).join('');
  const paymentRows = invoice.allocations.map(item => `
    <tr>
      <td>${escapeHtml(item.method.replaceAll('_', ' '))}</td>
      <td>${escapeHtml(item.reference_number || '—')}</td>
      <td>${escapeHtml(item.status)}</td>
      <td class="text-right">${formatMoney(item.amount_minor)}</td>
    </tr>`).join('') || '<tr><td colspan="4">No collection recorded.</td></tr>';
  const replacements = {
    CSS_CONTENT: css,
    WATERMARK_HTML: documentSettings.watermark ? `<div class="invoice-watermark">${escapeHtml(documentSettings.watermark)}</div>` : '',
    LOGO_HTML: seller.logo ? `<img class="company-logo" src="${escapeAttribute(seller.logo)}" alt="">` : '',
    companyName: seller.name,
    companyAddress: seller.address,
    companyPhone: seller.phone,
    companyEmail: seller.email,
    companyGSTIN: seller.gstin || '—',
    companyPAN: seller.pan || '—',
    companyState: seller.state || '—',
    companyStateCode: seller.state_code || '—',
    invoiceNumber: invoice.invoice_number,
    invoiceDate: new Date(invoice.issued_at).toLocaleDateString('en-IN'),
    dueDate: invoice.due_date ? new Date(invoice.due_date).toLocaleDateString('en-IN') : '—',
    paymentMode: invoice.allocations.map(item => item.method).join(', ') || 'PAY LATER',
    paymentStatus: invoice.payment_status,
    customerName: customer.name,
    customerAddress: customer.address || '—',
    customerPhone: customer.phone || '—',
    customerGSTIN: customer.gstin || 'URP',
    customerState: customer.state || '—',
    customerStateCode: customer.state_code || '—',
    challanNumber: delivery.challan_number || '—',
    transport: delivery.transport || '—',
    vehicle: delivery.vehicle_number || '—',
    ewayBill: delivery.eway_bill_number || '—',
    TABLE_ROWS: rows,
    amountInWords: numberToWords(fromMinor(invoice.grand_total_minor)),
    bankName: bank.bank_name || '—',
    accountNumber: bank.account_number || '—',
    ifsc: bank.ifsc || '—',
    upi: bank.upi_id || '—',
    QR_CODE_HTML: qrDataUrl ? `<img src="${qrDataUrl}" class="qr-code-img" alt="UPI payment QR code">` : '',
    termsAndConditions: escapeHtml(invoice.terms_snapshot || '').replaceAll('\n', '<br>'),
    taxableAmount: formatMoney(invoice.taxable_total_minor),
    totalCGST: formatMoney(invoice.cgst_total_minor),
    totalSGST: formatMoney(invoice.sgst_total_minor),
    totalIGST: formatMoney(invoice.igst_total_minor),
    roundOff: formatMoney(invoice.round_off_minor),
    grandTotal: formatMoney(invoice.grand_total_minor),
    PAYMENT_ROWS: paymentRows,
    receivedAmount: formatMoney(payment.net_collected_minor),
    outstandingAmount: formatMoney(payment.outstanding_minor),
    authorizedSignatory: documentSettings.signature_name || 'Authorized Signatory',
    printFooter: documentSettings.footer_text || `Computer-generated GST invoice · ${invoice.invoice_number}`
  };
  return Object.entries(replacements).reduce(
    (compiled, [key, value]) => compiled.replaceAll(`{{${key}}}`, String(value ?? '')),
    htmlTemplate
  );
}

async function getPaymentMethodSettings(tx) {
  const rows = await tx.all('SELECT * FROM payment_method_settings');
  return new Map(rows.map(row => [row.method, {
    ...row,
    enabled: Boolean(row.enabled),
    requires_reference: Boolean(row.requires_reference)
  }]));
}

function normalizeSubmittedPayments(input, totalMinor) {
  if (Array.isArray(input.payments) && input.payments.length) return input.payments;
  const legacyMethod = String(input.payment_method || '').toUpperCase();
  const map = {
    CREDIT: 'CUSTOMER_CREDIT',
    CASH: 'CASH',
    CARD: 'CARD',
    UPI: 'UPI',
    RAZORPAY: 'RAZORPAY',
    BANK_TRANSFER: 'BANK_TRANSFER',
    CHEQUE: 'CHEQUE',
    OTHER: 'OTHER'
  };
  if (!map[legacyMethod]) return [];
  return [{
    method: map[legacyMethod],
    amount: fromMinor(totalMinor),
    reference: input.razorpay_payment_id || input.payment_reference || '',
    provider_transaction_id: input.razorpay_payment_id || undefined
  }];
}

async function enforceCustomerCredit(tx, customer, outstandingMinor) {
  const limitMinor = toMinor(customer.credit_limit || 0);
  const balanceMinor = toMinor(customer.balance || 0);
  if (limitMinor > 0 && balanceMinor + outstandingMinor > limitMinor) {
    throw httpError(409, 'credit_limit_exceeded', 'This invoice would exceed the customer credit limit.');
  }
}

async function appendCustomerLedgerTx(tx, {
  customerId,
  invoiceId,
  paymentId = null,
  refundId = null,
  entryType,
  direction,
  amountMinor,
  referenceNumber,
  description,
  actorId
}) {
  const balance = await tx.one(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE -amount_minor END), 0) AS balance
       FROM customer_ledger_entries WHERE customer_id = ?`,
    [customerId]
  );
  const signed = direction === 'DEBIT' ? amountMinor : -amountMinor;
  const runningBalance = Number(balance?.balance || 0) + signed;
  await tx.run(
    `INSERT INTO customer_ledger_entries
      (customer_id, invoice_id, payment_id, refund_id, entry_type, direction,
       amount_minor, running_balance_minor, reference_number, description,
       created_by, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      customerId, invoiceId, paymentId, refundId, entryType, direction,
      amountMinor, runningBalance, referenceNumber || null, description || null,
      actorId, now(), now()
    ]
  );
  await tx.run('UPDATE customers SET balance = ? WHERE id = ?', [fromMinor(runningBalance), customerId]);
}

async function nextFinancialNumber(tx, type, prefix) {
  const year = new Date().getFullYear();
  const key = `${type}:${year}`;
  const lock = tx.dialect === 'postgres' ? ' FOR UPDATE' : '';
  let sequence = await tx.one(`SELECT * FROM number_sequences WHERE sequence_key = ?${lock}`, [key]);
  if (!sequence) {
    await tx.run(
      `INSERT INTO number_sequences (sequence_key, prefix, next_value, padding, updated_at)
       VALUES (?, ?, 2, 6, ?)`,
      [key, `${prefix}-${year}`, now()]
    );
    sequence = { prefix: `${prefix}-${year}`, next_value: 1, padding: 6 };
  } else {
    await tx.run(
      'UPDATE number_sequences SET next_value = next_value + 1, updated_at = ? WHERE sequence_key = ?',
      [now(), key]
    );
  }
  return `${sequence.prefix}-${String(sequence.next_value).padStart(Number(sequence.padding), '0')}`;
}

async function lockedInvoice(tx, invoiceId) {
  const invoice = await tx.one(
    `SELECT * FROM invoices WHERE id = ?${tx.dialect === 'postgres' ? ' FOR UPDATE' : ''}`,
    [invoiceId]
  );
  if (!invoice) throw httpError(404, 'invoice_not_found', 'Invoice was not found.');
  return invoice;
}

function insertWithId(tx, sql, params) {
  return tx.run(tx.dialect === 'postgres' ? `${sql} RETURNING id` : sql, params);
}

function insertedId(result) {
  return result.id || result.rows?.[0]?.id;
}

function formatMoney(minor) {
  return `₹${Number(minorToFixed(minor)).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('`', '&#096;');
}

async function announce(req, event, payload) {
  await invalidateOrganizationCache(req.user.organization_id);
  await publishOrganizationEvent(req.user.organization_id, event, payload);
}

function now() {
  return new Date().toISOString();
}
