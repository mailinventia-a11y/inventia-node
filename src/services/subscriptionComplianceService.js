import { checkoutPos } from './enterpriseTradeService.js';
import { httpError, writeTenantAudit } from '../platform/phase5Http.js';
import { enqueueDomainJob, publishOrganizationEvent } from '../platform/phase5Runtime.js';
import { fromMinor, toMinor } from './moneyService.js';
import { decryptIntegrationConfig } from '../platform/phase5Database.js';

const SUBSCRIPTION_TRANSITIONS = Object.freeze({
  DRAFT: new Set(['ACTIVE', 'CANCELLED']),
  ACTIVE: new Set(['PAUSED', 'CANCELLED']),
  PAUSED: new Set(['ACTIVE', 'CANCELLED']),
  COMPLETED: new Set(),
  CANCELLED: new Set()
});

export async function listSubscriptions(db, query = {}) {
  const where = [];
  const params = [];
  if (query.status) { where.push('s.status = ?'); params.push(String(query.status).toUpperCase()); }
  if (query.customer_id) { where.push('s.customer_id = ?'); params.push(query.customer_id); }
  const rows = await db.all(
    `SELECT s.*, c.name AS customer_name, w.name AS warehouse_name,
            (SELECT COUNT(*) FROM subscription_runs sr WHERE sr.subscription_id = s.id AND sr.status = 'COMPLETED') AS completed_runs,
            (SELECT COUNT(*) FROM subscription_runs sr WHERE sr.subscription_id = s.id AND sr.status = 'FAILED') AS failed_runs
       FROM subscriptions s JOIN customers c ON c.id = s.customer_id
       JOIN warehouses w ON w.id = s.warehouse_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY s.created_at DESC, s.id DESC`, params
  );
  return rows.map(subscriptionView);
}

export async function getSubscription(db, id) {
  const row = await db.one(
    `SELECT s.*, c.name AS customer_name, w.name AS warehouse_name
       FROM subscriptions s JOIN customers c ON c.id = s.customer_id
       JOIN warehouses w ON w.id = s.warehouse_id WHERE s.id = ?`, [id]
  );
  if (!row) throw httpError(404, 'subscription_not_found', 'The subscription was not found.');
  const runs = await db.all(
    `SELECT sr.*, i.invoice_number, i.payment_status, i.grand_total_minor
       FROM subscription_runs sr LEFT JOIN invoices i ON i.id = sr.invoice_id
      WHERE sr.subscription_id = ? ORDER BY sr.scheduled_at DESC, sr.id DESC`, [id]
  );
  return { ...subscriptionView(row), runs: runs.map(runView) };
}

export async function createSubscription(db, input, req) {
  const actorId = req.user.tenant_user_id || req.user.id;
  await validateSubscriptionReferences(db, input);
  const start = normalizeDate(input.start_date);
  const end = input.end_date ? normalizeDate(input.end_date) : null;
  if (end && end < start) throw httpError(422, 'invalid_subscription_dates', 'Subscription end date cannot be before its start date.');
  const items = await snapshotSubscriptionItems(db, input.items);
  const id = await db.transaction(async tx => {
    const number = await nextNumber(tx, 'subscription', 'SUB');
    const inserted = await insertWithId(tx,
      `INSERT INTO subscriptions
        (subscription_no, name, customer_id, warehouse_id, status, frequency,
         interval_count, start_date, end_date, next_run_at, due_days, price_policy,
         currency, items_snapshot, invoice_details, delivery_channels, notes,
         created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, NULL, ?, ?, 'INR', ?, ?, ?, ?, ?, ?, ?)`,
      [number, input.name, input.customer_id, input.warehouse_id, input.frequency,
        input.interval_count || 1, start, end, input.due_days || 0,
        input.price_policy || 'SNAPSHOT', JSON.stringify(items), JSON.stringify(input.invoice_details || {}),
        JSON.stringify(input.delivery_channels || ['IN_APP']), input.notes || null,
        actorId, now(), now()]
    );
    return insertedId(inserted);
  });
  const subscription = await getSubscription(db, id);
  await writeTenantAudit(db, req, { eventType: 'subscription.created', entityType: 'subscription', entityId: id, after: subscription });
  await announce(req.user.organization_id, 'subscriptions.changed', { action: 'created', subscription_id: id });
  return subscription;
}

export async function updateSubscription(db, id, input, req) {
  const before = await db.one('SELECT * FROM subscriptions WHERE id = ?', [id]);
  if (!before) throw httpError(404, 'subscription_not_found', 'The subscription was not found.');
  if (before.status !== 'DRAFT') throw httpError(409, 'subscription_not_editable', 'Only a draft subscription can be edited.');
  const merged = {
    ...before, ...input,
    items: input.items || parseJson(before.items_snapshot, []),
    invoice_details: input.invoice_details || parseJson(before.invoice_details, {}),
    delivery_channels: input.delivery_channels || parseJson(before.delivery_channels, ['IN_APP'])
  };
  await validateSubscriptionReferences(db, merged);
  const start = normalizeDate(merged.start_date);
  const end = merged.end_date ? normalizeDate(merged.end_date) : null;
  if (end && end < start) throw httpError(422, 'invalid_subscription_dates', 'Subscription end date cannot be before its start date.');
  const items = input.items ? await snapshotSubscriptionItems(db, input.items) : parseJson(before.items_snapshot, []);
  await db.run(
    `UPDATE subscriptions SET name = ?, customer_id = ?, warehouse_id = ?, frequency = ?,
      interval_count = ?, start_date = ?, end_date = ?, due_days = ?, price_policy = ?,
      items_snapshot = ?, invoice_details = ?, delivery_channels = ?, notes = ?, updated_at = ? WHERE id = ?`,
    [merged.name, merged.customer_id, merged.warehouse_id, merged.frequency,
      merged.interval_count || 1, start, end, merged.due_days || 0, merged.price_policy || 'SNAPSHOT',
      JSON.stringify(items), JSON.stringify(merged.invoice_details || {}),
      JSON.stringify(merged.delivery_channels || ['IN_APP']), merged.notes || null, now(), id]
  );
  const subscription = await getSubscription(db, id);
  await writeTenantAudit(db, req, { eventType: 'subscription.updated', entityType: 'subscription', entityId: id, before, after: subscription });
  await announce(req.user.organization_id, 'subscriptions.changed', { action: 'updated', subscription_id: Number(id) });
  return subscription;
}

export async function transitionSubscription(db, id, target, req) {
  const targetStatus = String(target).toUpperCase();
  const before = await db.one('SELECT * FROM subscriptions WHERE id = ?', [id]);
  if (!before) throw httpError(404, 'subscription_not_found', 'The subscription was not found.');
  if (!SUBSCRIPTION_TRANSITIONS[before.status]?.has(targetStatus)) {
    throw httpError(409, 'invalid_subscription_transition', `Subscription cannot move from ${before.status} to ${targetStatus}.`);
  }
  let nextRunAt = before.next_run_at;
  if (targetStatus === 'ACTIVE') nextRunAt = nextEligibleRun(before, new Date());
  if (targetStatus === 'PAUSED' || targetStatus === 'CANCELLED') nextRunAt = null;
  await db.run(
    `UPDATE subscriptions SET status = ?, next_run_at = ?, activated_by = COALESCE(activated_by, ?), updated_at = ? WHERE id = ?`,
    [targetStatus, nextRunAt, targetStatus === 'ACTIVE' ? (req.user.tenant_user_id || req.user.id) : null, now(), id]
  );
  const after = await getSubscription(db, id);
  if (targetStatus === 'ACTIVE' && nextRunAt) await enqueueSubscription(after, req.user.organization_id);
  await writeTenantAudit(db, req, { eventType: `subscription.${targetStatus.toLowerCase()}`, entityType: 'subscription', entityId: id, before, after });
  await announce(req.user.organization_id, 'subscriptions.changed', { action: targetStatus.toLowerCase(), subscription_id: Number(id) });
  return after;
}

export async function processDueSubscriptions(db, organizationId, limit = 50) {
  const due = await db.all(
    `SELECT id FROM subscriptions WHERE status = 'ACTIVE' AND next_run_at IS NOT NULL
      AND next_run_at <= ? ORDER BY next_run_at, id LIMIT ?`,
    [now(), Math.min(Math.max(Number(limit) || 50, 1), 200)]
  );
  const results = [];
  for (const row of due) {
    const subscription = await db.one('SELECT * FROM subscriptions WHERE id = ?', [row.id]);
    const occurrenceKey = String(subscription.next_run_at).slice(0, 10);
    let run = await db.one('SELECT * FROM subscription_runs WHERE subscription_id = ? AND occurrence_key = ?', [row.id, occurrenceKey]);
    if (!run) {
      const inserted = await insertWithId(db,
        `INSERT INTO subscription_runs
          (subscription_id, occurrence_key, scheduled_at, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, 'PENDING', 0, ?, ?)`,
        [row.id, occurrenceKey, subscription.next_run_at, now(), now()]
      );
      run = await db.one('SELECT * FROM subscription_runs WHERE id = ?', [insertedId(inserted)]);
    }
    results.push(await generateSubscriptionRun(db, organizationId, run.id));
  }
  return results;
}

export async function generateSubscriptionRun(db, organizationId, runId) {
  const run = await db.one('SELECT * FROM subscription_runs WHERE id = ?', [runId]);
  if (!run) throw httpError(404, 'subscription_run_not_found', 'Subscription run was not found.');
  if (run.status === 'COMPLETED') return { ...runView(run), duplicate: true };
  const subscription = await db.one('SELECT * FROM subscriptions WHERE id = ?', [run.subscription_id]);
  if (!subscription || subscription.status !== 'ACTIVE') {
    await db.run(`UPDATE subscription_runs SET status = 'SKIPPED', error_code = 'subscription_not_active', completed_at = ?, updated_at = ? WHERE id = ?`, [now(), now(), runId]);
    return { run_id: Number(runId), status: 'SKIPPED' };
  }
  await db.run(`UPDATE subscription_runs SET status = 'RUNNING', attempts = attempts + 1, started_at = ?, updated_at = ? WHERE id = ?`, [now(), now(), runId]);
  try {
    const items = await resolveRunItems(db, subscription);
    const scheduledDate = String(run.scheduled_at).slice(0, 10);
    const dueDate = addDays(scheduledDate > today() ? scheduledDate : today(), Number(subscription.due_days || 0));
    const request = {
      requestId: `subscription:${subscription.id}:${run.occurrence_key}`,
      user: { id: 'subscription-worker', tenant_user_id: 'subscription-worker', organization_id: organizationId, permissions: ['*'], role: 'system' },
      headers: { 'idempotency-key': `subscription:${subscription.id}:${run.occurrence_key}` },
      ip: 'worker'
    };
    const checkout = await checkoutPos(db, {
      subscription_run_id: run.id, customer_id: subscription.customer_id,
      warehouse_id: subscription.warehouse_id, items, payments: [],
      allow_partial_payment: true, due_date: dueDate,
      invoice_details: parseJson(subscription.invoice_details, {}),
      notes: `Generated by ${subscription.subscription_no}`
    }, request);
    const next = advanceOccurrence(String(run.scheduled_at).slice(0, 10), subscription.frequency, Number(subscription.interval_count));
    const completed = subscription.end_date && next > subscription.end_date;
    await db.run(
      `UPDATE subscriptions SET last_run_at = ?, next_run_at = ?, status = ?, updated_at = ? WHERE id = ?`,
      [run.scheduled_at, completed ? null : `${next}T00:00:00.000Z`, completed ? 'COMPLETED' : 'ACTIVE', now(), subscription.id]
    );
    if (!completed) await enqueueSubscription({ ...subscription, next_run_at: `${next}T00:00:00.000Z` }, organizationId);
    await publishOrganizationEvent(organizationId, 'subscription.invoice_generated', {
      subscription_id: subscription.id, run_id: run.id, invoice_id: checkout.invoiceId
    });
    return { run_id: Number(run.id), status: 'COMPLETED', invoice_id: checkout.invoiceId, invoice_number: checkout.invoiceNumber };
  } catch (error) {
    await db.run(
      `UPDATE subscription_runs SET status = 'FAILED', error_code = ?, error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      [error.code || 'generation_failed', String(error.message).slice(0, 2000), now(), now(), run.id]
    );
    return { run_id: Number(run.id), status: 'FAILED', error_code: error.code || 'generation_failed', error_message: error.message };
  }
}

export async function listComplianceDocuments(db, type, query = {}) {
  const complianceType = normalizeComplianceType(type);
  const params = [complianceType];
  const status = query.status ? ' AND cd.status = ?' : '';
  if (query.status) params.push(String(query.status).toUpperCase());
  const rows = await db.all(
    `SELECT cd.*, i.invoice_number, i.grand_total_minor, td.document_no AS trade_document_number
       FROM compliance_documents cd LEFT JOIN invoices i ON i.id = cd.invoice_id
       LEFT JOIN trade_documents td ON td.id = cd.trade_document_id
      WHERE cd.compliance_type = ?${status} ORDER BY cd.created_at DESC, cd.id DESC`, params
  );
  return rows.map(complianceDocumentView);
}

export async function prepareComplianceDocument(db, type, input, req) {
  const complianceType = normalizeComplianceType(type);
  const actorId = req.user.tenant_user_id || req.user.id;
  const snapshot = await complianceSourceSnapshot(db, complianceType, input);
  const existing = snapshot.invoice_id
    ? await db.one('SELECT id, status FROM compliance_documents WHERE compliance_type = ? AND invoice_id = ?', [complianceType, snapshot.invoice_id])
    : await db.one('SELECT id, status FROM compliance_documents WHERE compliance_type = ? AND trade_document_id = ?', [complianceType, snapshot.trade_document_id]);
  if (existing) {
    throw httpError(409, 'compliance_document_exists', `A ${complianceType.toLowerCase()} document already exists for this source.`, {
      compliance_document_id: Number(existing.id), status: existing.status
    });
  }
  const id = await db.transaction(async tx => {
    const sequence = complianceType === 'E_INVOICE' ? 'compliance_einvoice' : 'compliance_eway';
    const number = await nextNumber(tx, sequence, complianceType === 'E_INVOICE' ? 'EINV' : 'EWB');
    const inserted = await insertWithId(tx,
      `INSERT INTO compliance_documents
        (compliance_type, invoice_id, trade_document_id, status, document_number,
         request_snapshot, idempotency_key, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'PREPARED', ?, ?, ?, ?, ?, ?)`,
      [complianceType, snapshot.invoice_id || null, snapshot.trade_document_id || null,
        number, JSON.stringify(snapshot), String(req.headers['idempotency-key']), actorId, now(), now()]
    );
    const documentId = insertedId(inserted);
    await complianceEvent(tx, complianceType.toLowerCase(), documentId, 'prepared', actorId, req.requestId, snapshot);
    return documentId;
  });
  const document = await getComplianceDocument(db, id);
  await writeTenantAudit(db, req, { eventType: `compliance.${complianceType.toLowerCase()}.prepared`, entityType: 'compliance_document', entityId: id, after: document });
  await announce(req.user.organization_id, 'compliance.status_changed', { compliance_document_id: id, status: 'PREPARED' });
  return document;
}

export async function getComplianceDocument(db, id) {
  const row = await db.one('SELECT * FROM compliance_documents WHERE id = ?', [id]);
  if (!row) throw httpError(404, 'compliance_document_not_found', 'The compliance document was not found.');
  const events = await db.all(
    `SELECT * FROM compliance_events WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC, id DESC`,
    [String(row.compliance_type).toLowerCase(), String(id)]
  );
  return { ...complianceDocumentView(row), events: events.map(item => ({ ...item, sanitized_payload: parseJson(item.sanitized_payload, {}) })) };
}

export async function generateComplianceDocument(db, id, req, fetchImpl = globalThis.fetch) {
  const document = await db.one('SELECT * FROM compliance_documents WHERE id = ?', [id]);
  if (!document) throw httpError(404, 'compliance_document_not_found', 'The compliance document was not found.');
  if (document.status === 'GENERATED') return { ...complianceDocumentView(document), duplicate: true };
  if (!['PREPARED', 'FAILED'].includes(document.status)) throw httpError(409, 'compliance_document_not_generatable', 'The compliance document cannot be generated in its current state.');
  const config = await loadComplianceProvider(db);
  await db.run(`UPDATE compliance_documents SET status = 'PENDING', error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?`, [now(), id]);
  const payload = parseJson(document.request_snapshot, {});
  try {
    const result = await providerRequest(config, document.compliance_type === 'E_INVOICE' ? '/e-invoices' : '/e-way-bills', payload, fetchImpl);
    const providerReference = result.irn || result.eway_bill_number || result.reference || result.id;
    if (!providerReference) throw providerPayloadError('The compliance provider did not return an authoritative reference.');
    await db.transaction(async tx => {
      await tx.run(
        `UPDATE compliance_documents SET status = 'GENERATED', provider = ?, provider_reference = ?,
          irn = ?, acknowledgement_number = ?, acknowledgement_at = ?, signed_qr = ?,
          valid_until = ?, response_snapshot = ?, generated_at = ?, updated_at = ? WHERE id = ?`,
        [config.provider, String(providerReference), result.irn || null,
          result.acknowledgement_number || result.ack_no || null,
          result.acknowledgement_at || result.ack_at || now(), result.signed_qr || null,
          result.valid_until || null, JSON.stringify(sanitize(result)), now(), now(), id]
      );
      await complianceEvent(tx, String(document.compliance_type).toLowerCase(), id, 'generated', req.user.id, req.requestId, result);
    });
  } catch (error) {
    await db.transaction(async tx => {
      await tx.run(`UPDATE compliance_documents SET status = 'FAILED', error_code = ?, error_message = ?, updated_at = ? WHERE id = ?`, [error.code || 'provider_error', String(error.message).slice(0, 2000), now(), id]);
      await complianceEvent(tx, String(document.compliance_type).toLowerCase(), id, 'generation_failed', req.user.id, req.requestId, {}, error.message);
    });
    throw error;
  }
  const after = await getComplianceDocument(db, id);
  await writeTenantAudit(db, req, { eventType: `compliance.${String(document.compliance_type).toLowerCase()}.generated`, entityType: 'compliance_document', entityId: id, after });
  await announce(req.user.organization_id, 'compliance.status_changed', { compliance_document_id: Number(id), status: 'GENERATED' });
  return after;
}

export async function cancelComplianceDocument(db, id, reason, req, fetchImpl = globalThis.fetch) {
  const document = await db.one('SELECT * FROM compliance_documents WHERE id = ?', [id]);
  if (!document) throw httpError(404, 'compliance_document_not_found', 'The compliance document was not found.');
  if (document.status !== 'GENERATED') throw httpError(409, 'compliance_document_not_generated', 'Only a generated compliance document can be cancelled.');
  if (document.compliance_type === 'E_INVOICE' && Date.now() - new Date(document.generated_at).getTime() > 24 * 60 * 60 * 1000) {
    throw httpError(409, 'einvoice_cancellation_window_expired', 'The e-invoice cancellation window has expired.');
  }
  const config = await loadComplianceProvider(db);
  const resource = document.compliance_type === 'E_INVOICE' ? 'e-invoices' : 'e-way-bills';
  const result = await providerRequest(config, `/${resource}/${encodeURIComponent(document.provider_reference)}/cancel`, { reason }, fetchImpl);
  if (!['cancelled', 'success'].includes(String(result.status || '').toLowerCase())) {
    throw providerPayloadError('The provider did not confirm cancellation.');
  }
  await db.transaction(async tx => {
    await tx.run(`UPDATE compliance_documents SET status = 'CANCELLED', cancellation_reason = ?, cancelled_at = ?, response_snapshot = ?, updated_at = ? WHERE id = ?`, [reason, now(), JSON.stringify(sanitize(result)), now(), id]);
    await complianceEvent(tx, String(document.compliance_type).toLowerCase(), id, 'cancelled', req.user.id, req.requestId, result);
  });
  const after = await getComplianceDocument(db, id);
  await writeTenantAudit(db, req, { eventType: 'compliance.document.cancelled', entityType: 'compliance_document', entityId: id, before: document, after });
  await announce(req.user.organization_id, 'compliance.status_changed', { compliance_document_id: Number(id), status: 'CANCELLED' });
  return after;
}

export async function listGstReturns(db, type, query = {}) {
  const returnType = normalizeReturnType(type);
  const params = [returnType];
  const period = query.period ? ' AND period = ?' : '';
  if (query.period) params.push(query.period);
  const rows = await db.all(`SELECT * FROM gst_return_periods WHERE return_type = ?${period} ORDER BY period DESC, id DESC`, params);
  return rows.map(returnView);
}

export async function prepareGstReturn(db, type, period, req) {
  const returnType = normalizeReturnType(type);
  const { from, to } = periodRange(period);
  const summary = await buildReturnSummary(db, returnType, from, to);
  const actorId = req.user.tenant_user_id || req.user.id;
  const id = await db.transaction(async tx => {
    let existing = await tx.one('SELECT * FROM gst_return_periods WHERE return_type = ? AND period = ?', [returnType, period]);
    if (existing && ['PENDING_APPROVAL', 'APPROVED', 'FILED'].includes(existing.status)) {
      throw httpError(409, 'gst_return_locked', 'This GST return can no longer be re-prepared.');
    }
    if (existing) {
      await tx.run(`UPDATE gst_return_periods SET status = 'PREPARED', summary = ?, prepared_by = ?, prepared_at = ?, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?`, [JSON.stringify(summary), actorId, now(), now(), existing.id]);
    } else {
      const inserted = await insertWithId(tx,
        `INSERT INTO gst_return_periods
          (return_type, period, status, summary, prepared_by, prepared_at, created_at, updated_at)
         VALUES (?, ?, 'PREPARED', ?, ?, ?, ?, ?)`,
        [returnType, period, JSON.stringify(summary), actorId, now(), now(), now()]
      );
      existing = { id: insertedId(inserted) };
    }
    await tx.run('DELETE FROM gst_reconciliation_rows WHERE return_id = ?', [existing.id]);
    if (['GSTR_1', 'GSTR_3B', 'IMS'].includes(returnType)) {
      const invoices = await tx.all(
        `SELECT i.id, i.invoice_number, i.issued_at, i.customer_snapshot, i.taxable_total_minor,
                i.cgst_total_minor, i.sgst_total_minor, i.igst_total_minor
           FROM invoices i WHERE i.invoice_status = 'ISSUED' AND i.issued_at >= ? AND i.issued_at < ? ORDER BY i.issued_at, i.id`,
        [from, to]
      );
      for (const invoice of invoices) {
        const customer = parseJson(invoice.customer_snapshot, {});
        await tx.run(
          `INSERT INTO gst_reconciliation_rows
            (return_id, source_type, source_id, counterparty_gstin, document_number,
             document_date, taxable_minor, tax_minor, match_status, metadata, created_at, updated_at)
           VALUES (?, 'invoice', ?, ?, ?, ?, ?, ?, 'MATCHED', ?, ?, ?)`,
          [existing.id, String(invoice.id), customer.gstin || null, invoice.invoice_number,
            String(invoice.issued_at).slice(0, 10), Number(invoice.taxable_total_minor),
            Number(invoice.cgst_total_minor) + Number(invoice.sgst_total_minor) + Number(invoice.igst_total_minor),
            JSON.stringify({ source: 'books' }), now(), now()]
        );
      }
    }
    await complianceEvent(tx, 'gst_return', existing.id, 'prepared', actorId, req.requestId, summary);
    return Number(existing.id);
  });
  const result = await getGstReturn(db, id);
  await writeTenantAudit(db, req, { eventType: `compliance.${returnType.toLowerCase()}.prepared`, entityType: 'gst_return', entityId: id, after: result });
  await announce(req.user.organization_id, 'compliance.status_changed', { gst_return_id: id, status: 'PREPARED' });
  return result;
}

export async function getGstReturn(db, id) {
  const row = await db.one('SELECT * FROM gst_return_periods WHERE id = ?', [id]);
  if (!row) throw httpError(404, 'gst_return_not_found', 'The GST return was not found.');
  const rows = await db.all('SELECT * FROM gst_reconciliation_rows WHERE return_id = ? ORDER BY id', [id]);
  return { ...returnView(row), rows: rows.map(reconciliationView) };
}

export async function importGstr2bRows(db, period, rows, req) {
  const actorId = req.user.tenant_user_id || req.user.id;
  let record = await db.one(`SELECT * FROM gst_return_periods WHERE return_type = 'GSTR_2B' AND period = ?`, [period]);
  const id = await db.transaction(async tx => {
    if (!record) {
      const inserted = await insertWithId(tx,
        `INSERT INTO gst_return_periods (return_type, period, status, summary, prepared_by, prepared_at, created_at, updated_at)
         VALUES ('GSTR_2B', ?, 'PREPARED', ?, ?, ?, ?, ?)`,
        [period, JSON.stringify({ imported_rows: rows.length }), actorId, now(), now(), now()]
      );
      record = { id: insertedId(inserted) };
    } else if (['PENDING_APPROVAL', 'APPROVED', 'FILED'].includes(record.status)) {
      throw httpError(409, 'gst_return_locked', 'This GSTR-2B period is locked.');
    }
    await tx.run('DELETE FROM gst_reconciliation_rows WHERE return_id = ?', [record.id]);
    for (const row of rows) {
      const book = await tx.one('SELECT id, taxable_total_minor, cgst_total_minor, sgst_total_minor, igst_total_minor FROM invoices WHERE invoice_number = ?', [row.document_number]);
      const portalTax = toMinor(row.tax || 0);
      const portalTaxable = toMinor(row.taxable || 0);
      const bookTax = book ? Number(book.cgst_total_minor) + Number(book.sgst_total_minor) + Number(book.igst_total_minor) : null;
      const matchStatus = !book ? 'MISSING_BOOKS' : bookTax === portalTax && Number(book.taxable_total_minor) === portalTaxable ? 'MATCHED' : 'MISMATCH';
      await tx.run(
        `INSERT INTO gst_reconciliation_rows
          (return_id, source_type, source_id, counterparty_gstin, document_number, document_date,
           taxable_minor, tax_minor, match_status, ims_action, metadata, created_at, updated_at)
         VALUES (?, 'gstr2b_import', ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
        [record.id, book?.id ? String(book.id) : null, row.gstin || null, row.document_number,
          row.document_date || null, portalTaxable, portalTax, matchStatus,
          JSON.stringify({ imported: true }), now(), now()]
      );
    }
    await tx.run(`UPDATE gst_return_periods SET status = 'PREPARED', summary = ?, prepared_by = ?, prepared_at = ?, updated_at = ? WHERE id = ?`, [JSON.stringify({ imported_rows: rows.length }), actorId, now(), now(), record.id]);
    return Number(record.id);
  });
  await writeTenantAudit(db, req, { eventType: 'compliance.gstr2b.imported', entityType: 'gst_return', entityId: id, after: { rows: rows.length } });
  return getGstReturn(db, id);
}

export async function updateImsAction(db, returnId, rowId, action, req) {
  const record = await db.one('SELECT * FROM gst_return_periods WHERE id = ?', [returnId]);
  if (!record || !['GSTR_2B', 'IMS'].includes(record.return_type)) throw httpError(404, 'ims_return_not_found', 'An IMS-compatible return was not found.');
  if (!['DRAFT', 'PREPARED'].includes(record.status)) throw httpError(409, 'gst_return_locked', 'IMS decisions are locked for this return.');
  const row = await db.one('SELECT * FROM gst_reconciliation_rows WHERE id = ? AND return_id = ?', [rowId, returnId]);
  if (!row) throw httpError(404, 'reconciliation_row_not_found', 'The reconciliation row was not found.');
  await db.run('UPDATE gst_reconciliation_rows SET ims_action = ?, updated_at = ? WHERE id = ?', [action, now(), rowId]);
  await writeTenantAudit(db, req, { eventType: 'compliance.ims.updated', entityType: 'gst_reconciliation_row', entityId: rowId, before: row, after: { ims_action: action } });
  return getGstReturn(db, returnId);
}

export async function requestGstReturnApproval(db, id, req) {
  const before = await db.one('SELECT * FROM gst_return_periods WHERE id = ?', [id]);
  if (!before) throw httpError(404, 'gst_return_not_found', 'The GST return was not found.');
  if (before.status !== 'PREPARED') throw httpError(409, 'gst_return_not_prepared', 'Only a prepared return can request approval.');
  await db.run(`UPDATE gst_return_periods SET status = 'PENDING_APPROVAL', approval_requested_by = ?, approval_requested_at = ?, updated_at = ? WHERE id = ?`, [req.user.id, now(), now(), id]);
  const after = await getGstReturn(db, id);
  await writeTenantAudit(db, req, { eventType: 'compliance.return_approval_requested', entityType: 'gst_return', entityId: id, before, after });
  return after;
}

export async function decideGstReturnApproval(db, id, decision, req) {
  const before = await db.one('SELECT * FROM gst_return_periods WHERE id = ?', [id]);
  if (!before) throw httpError(404, 'gst_return_not_found', 'The GST return was not found.');
  if (before.status !== 'PENDING_APPROVAL') throw httpError(409, 'gst_return_not_pending_approval', 'The return is not awaiting approval.');
  const approved = decision === 'approve';
  await db.run(
    `UPDATE gst_return_periods SET status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?`,
    [approved ? 'APPROVED' : 'PREPARED', approved ? req.user.id : null, approved ? now() : null, now(), id]
  );
  const after = await getGstReturn(db, id);
  await writeTenantAudit(db, req, { eventType: `compliance.return_${approved ? 'approved' : 'rejected'}`, entityType: 'gst_return', entityId: id, before, after });
  return after;
}

export async function fileGstReturn(db, id, req, fetchImpl = globalThis.fetch) {
  const record = await db.one('SELECT * FROM gst_return_periods WHERE id = ?', [id]);
  if (!record) throw httpError(404, 'gst_return_not_found', 'The GST return was not found.');
  if (record.status === 'FILED') return { ...returnView(record), duplicate: true };
  if (record.status !== 'APPROVED' || !record.approved_by) throw httpError(409, 'gst_return_not_approved', 'Authorized approval is required before filing.');
  const config = await loadComplianceProvider(db);
  try {
    const result = await providerRequest(config, `/returns/${record.return_type.toLowerCase()}/file`, { period: record.period, summary: parseJson(record.summary, {}) }, fetchImpl);
    const reference = result.acknowledgement_number || result.reference || result.id;
    if (!reference || !['filed', 'success', 'accepted'].includes(String(result.status || '').toLowerCase())) {
      throw providerPayloadError('The provider did not confirm GST return filing.');
    }
    await db.run(
      `UPDATE gst_return_periods SET status = 'FILED', provider = ?, provider_reference = ?,
       filed_by = ?, filed_at = ?, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?`,
      [config.provider, String(reference), req.user.id, now(), now(), id]
    );
  } catch (error) {
    await db.run(`UPDATE gst_return_periods SET error_code = ?, error_message = ?, updated_at = ? WHERE id = ?`, [error.code || 'provider_error', String(error.message).slice(0, 2000), now(), id]);
    throw error;
  }
  const after = await getGstReturn(db, id);
  await writeTenantAudit(db, req, { eventType: 'compliance.return_filed', entityType: 'gst_return', entityId: id, after });
  await announce(req.user.organization_id, 'compliance.status_changed', { gst_return_id: Number(id), status: 'FILED' });
  return after;
}

export async function tdsTcsReport(db, query = {}) {
  const from = query.from || `${today().slice(0, 4)}-04-01`;
  const to = query.to || today();
  const sales = await db.one(
    `SELECT COALESCE(SUM(taxable_total_minor), 0) AS taxable_minor,
            COALESCE(SUM(cgst_total_minor + sgst_total_minor + igst_total_minor), 0) AS gst_minor,
            COUNT(*) AS invoice_count FROM invoices
      WHERE invoice_status = 'ISSUED' AND issued_at >= ? AND issued_at < ?`,
    [`${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`]
  );
  return {
    from, to, invoice_count: Number(sales.invoice_count || 0),
    taxable_minor: Number(sales.taxable_minor || 0), gst_minor: Number(sales.gst_minor || 0),
    tds_receivable_minor: 0, tds_payable_minor: 0, tcs_receivable_minor: 0, tcs_payable_minor: 0,
    warning: 'No TDS/TCS deduction documents have been posted for this period.'
  };
}

async function complianceSourceSnapshot(db, type, input) {
  if (type === 'E_INVOICE') {
    const invoice = await db.one('SELECT * FROM invoices WHERE id = ?', [input.invoice_id]);
    if (!invoice) throw httpError(404, 'invoice_not_found', 'The invoice was not found.');
    if (invoice.invoice_status !== 'ISSUED') throw httpError(409, 'invoice_not_issued', 'Only an issued invoice is eligible.');
    const seller = parseJson(invoice.seller_snapshot, {});
    const customer = parseJson(invoice.customer_snapshot, {});
    if (!seller.gstin || !customer.gstin || customer.gstin === 'URP') throw httpError(422, 'b2b_gstin_required', 'Valid seller and customer GSTIN values are required for e-invoice preparation.');
    const items = await db.all('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id', [invoice.id]);
    if (items.some(item => !item.hsn_sac)) throw httpError(422, 'hsn_required', 'Every e-invoice line requires HSN/SAC.');
    return { invoice_id: invoice.id, invoice_number: invoice.invoice_number, issued_at: invoice.issued_at, seller, customer, items, totals: complianceTotals(invoice) };
  }
  if (input.invoice_id) {
    const invoice = await db.one('SELECT * FROM invoices WHERE id = ?', [input.invoice_id]);
    if (!invoice) throw httpError(404, 'invoice_not_found', 'The invoice was not found.');
    const delivery = validateEwayTransport({ ...parseJson(invoice.delivery_snapshot, {}), ...input.transport });
    return { invoice_id: invoice.id, invoice_number: invoice.invoice_number, document_date: invoice.issued_at, delivery, totals: complianceTotals(invoice) };
  }
  const document = await db.one(`SELECT * FROM trade_documents WHERE id = ? AND document_type = 'delivery_challan'`, [input.trade_document_id]);
  if (!document) throw httpError(404, 'delivery_challan_not_found', 'The delivery challan was not found.');
  const lines = await db.all('SELECT * FROM trade_document_lines WHERE document_id = ? ORDER BY id', [document.id]);
  return { trade_document_id: document.id, document_number: document.document_no, document_date: document.created_at, transport: validateEwayTransport(input.transport || {}), lines };
}

function validateEwayTransport(transport) {
  const distance = Number(transport.distance_km);
  if (!Number.isFinite(distance) || distance <= 0) {
    throw httpError(422, 'eway_distance_required', 'A positive transport distance is required for an e-way bill.');
  }
  const mode = String(transport.transport_mode || transport.mode || 'ROAD').toUpperCase();
  if (mode === 'ROAD' && !String(transport.vehicle_number || '').trim()) {
    throw httpError(422, 'eway_vehicle_required', 'A vehicle number is required for road transport.');
  }
  return { ...transport, distance_km: distance, transport_mode: mode };
}

async function buildReturnSummary(db, returnType, from, to) {
  const invoice = await db.one(
    `SELECT COUNT(*) AS invoice_count, COALESCE(SUM(taxable_total_minor), 0) AS taxable_minor,
      COALESCE(SUM(cgst_total_minor), 0) AS cgst_minor, COALESCE(SUM(sgst_total_minor), 0) AS sgst_minor,
      COALESCE(SUM(igst_total_minor), 0) AS igst_minor, COALESCE(SUM(cess_total_minor), 0) AS cess_minor
      FROM invoices WHERE invoice_status = 'ISSUED' AND issued_at >= ? AND issued_at < ?`, [from, to]
  );
  const adjustments = await db.one(
    `SELECT COALESCE(SUM(CASE WHEN adjustment_type = 'CREDIT_NOTE' THEN grand_total_minor ELSE 0 END), 0) AS credits_minor,
      COALESCE(SUM(CASE WHEN adjustment_type = 'DEBIT_NOTE' THEN grand_total_minor ELSE 0 END), 0) AS debits_minor
      FROM fiscal_adjustments WHERE status = 'ISSUED' AND issued_at >= ? AND issued_at < ?`, [from, to]
  );
  return { return_type: returnType, ...numericObject(invoice), ...numericObject(adjustments), generated_at: now(), source: 'tenant_books' };
}

async function loadComplianceProvider(db) {
  const row = await db.one(`SELECT encrypted_config FROM integration_credentials WHERE provider = 'gst_compliance' AND status = 'active'`);
  let config = row ? decryptIntegrationConfig(row.encrypted_config) : null;
  if (!config && process.env.GST_PROVIDER_URL && process.env.GST_PROVIDER_API_KEY) {
    config = { base_url: process.env.GST_PROVIDER_URL, api_key: process.env.GST_PROVIDER_API_KEY, provider: process.env.GST_PROVIDER_NAME || 'configured_gsp' };
  }
  if (!config?.base_url || !config?.api_key) throw httpError(503, 'integration_not_configured', 'GST compliance provider credentials are not configured for this organization.');
  return { ...config, provider: config.provider || 'configured_gsp' };
}

async function providerRequest(config, path, body, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${String(config.base_url).replace(/\/$/, '')}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.api_key}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(Number(process.env.GST_PROVIDER_TIMEOUT_MS || 15000))
    });
  } catch (error) {
    const wrapped = httpError(502, 'compliance_provider_unavailable', 'The GST compliance provider is unavailable.');
    wrapped.details = { provider_message: error.message };
    throw wrapped;
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = httpError(502, 'compliance_provider_error', 'The GST compliance provider rejected the request.');
    error.details = { provider_status: response.status, provider_message: result.message || result.error || 'Unknown provider error' };
    throw error;
  }
  return sanitize(result);
}

async function complianceEvent(db, entityType, entityId, eventType, actorId, requestId, payload, errorMessage = null) {
  await db.run(
    `INSERT INTO compliance_events
      (entity_type, entity_id, event_type, actor_user_id, request_id, sanitized_payload, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [entityType, String(entityId), eventType, actorId, requestId || null, JSON.stringify(sanitize(payload)), errorMessage || null, now()]
  );
}

function normalizeComplianceType(value) { const type = String(value).replace(/-/g, '_').toUpperCase().replace(/S$/, ''); if (!['E_INVOICE', 'E_WAY_BILL'].includes(type)) throw httpError(404, 'compliance_type_not_found', 'The compliance document type is not supported.'); return type; }
function normalizeReturnType(value) { const type = String(value).replace(/-/g, '_').toUpperCase(); if (!['GSTR_1', 'GSTR_2B', 'GSTR_3B', 'GSTR_7', 'IMS'].includes(type)) throw httpError(404, 'gst_return_type_not_found', 'The GST return type is not supported.'); return type; }
function periodRange(period) { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw httpError(422, 'invalid_gst_period', 'GST period must use YYYY-MM.'); const from = `${period}-01T00:00:00.000Z`; const date = new Date(from); date.setUTCMonth(date.getUTCMonth() + 1); return { from, to: date.toISOString() }; }
function complianceTotals(invoice) { return { taxable_minor: Number(invoice.taxable_total_minor || 0), cgst_minor: Number(invoice.cgst_total_minor || 0), sgst_minor: Number(invoice.sgst_total_minor || 0), igst_minor: Number(invoice.igst_total_minor || 0), cess_minor: Number(invoice.cess_total_minor || 0), total_minor: Number(invoice.grand_total_minor || 0) }; }
function complianceDocumentView(row) { return { ...row, request_snapshot: parseJson(row.request_snapshot, {}), response_snapshot: parseJson(row.response_snapshot, null), grand_total: row.grand_total_minor == null ? null : fromMinor(row.grand_total_minor) }; }
function returnView(row) { return { ...row, summary: parseJson(row.summary, {}) }; }
function reconciliationView(row) { return { ...row, metadata: parseJson(row.metadata, {}) }; }
function sanitize(value) { if (Array.isArray(value)) return value.map(sanitize); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.entries(value).filter(([key]) => !/secret|token|password|authorization|api_key|signed_invoice/i.test(key)).map(([key, item]) => [key, sanitize(item)])); }
function numericObject(value) { return Object.fromEntries(Object.entries(value || {}).map(([key, item]) => [key, Number(item || 0)])); }
function providerPayloadError(message) { return httpError(502, 'invalid_compliance_provider_response', message); }
function today() { return new Date().toISOString().slice(0, 10); }

async function validateSubscriptionReferences(db, input) {
  const [customer, warehouse] = await Promise.all([
    db.one('SELECT id FROM customers WHERE id = ?', [input.customer_id]),
    db.one('SELECT id FROM warehouses WHERE id = ?', [input.warehouse_id])
  ]);
  if (!customer) throw httpError(404, 'customer_not_found', 'The subscription customer was not found.');
  if (!warehouse) throw httpError(404, 'warehouse_not_found', 'The subscription warehouse was not found.');
  if (!Array.isArray(input.items) || !input.items.length) throw httpError(422, 'subscription_items_required', 'At least one subscription item is required.');
}

async function snapshotSubscriptionItems(db, items) {
  const result = [];
  for (const item of items) {
    const product = await db.one(
      `SELECT p.id, p.name, p.selling_price, COALESCE(pc.minimum_price, 0) AS minimum_price,
              pc.maximum_price FROM products p LEFT JOIN product_commerce pc ON pc.product_id = p.id
       WHERE p.id = ? AND p.status = 1`, [item.product_id]
    );
    if (!product) throw httpError(422, 'invalid_product', `Product ${item.product_id} is unavailable.`);
    const price = item.unit_price == null ? Number(product.selling_price) : Number(item.unit_price);
    if (price < Number(product.minimum_price || 0) || product.maximum_price != null && price > Number(product.maximum_price)) {
      throw httpError(409, 'subscription_price_out_of_range', `${product.name} subscription price is outside its approved range.`);
    }
    result.push({ product_id: Number(item.product_id), variant_id: item.variant_id || null, quantity: Number(item.quantity), unit_price: price });
  }
  return result;
}

async function resolveRunItems(db, subscription) {
  const items = parseJson(subscription.items_snapshot, []);
  if (subscription.price_policy === 'SNAPSHOT') return items;
  const resolved = [];
  for (const item of items) {
    const product = await db.one('SELECT selling_price FROM products WHERE id = ? AND status = 1', [item.product_id]);
    if (!product) throw httpError(409, 'subscription_product_unavailable', `Product ${item.product_id} is unavailable.`);
    resolved.push({ ...item, unit_price: Number(product.selling_price) });
  }
  return resolved;
}

async function enqueueSubscription(subscription, organizationId) {
  if (!subscription.next_run_at) return { queued: false };
  return enqueueDomainJob('subscription.invoice.generate', {
    organization_id: organizationId, subscription_id: subscription.id,
    occurrence_key: String(subscription.next_run_at).slice(0, 10)
  }, {
    delay: Math.max(new Date(subscription.next_run_at).getTime() - Date.now(), 0),
    jobId: `subscription:${organizationId}:${subscription.id}:${String(subscription.next_run_at).slice(0, 10)}`
  });
}

function nextEligibleRun(subscription, currentDate) {
  const start = normalizeDate(subscription.start_date);
  const today = currentDate.toISOString().slice(0, 10);
  let next = start;
  while (next < today) next = advanceOccurrence(next, subscription.frequency, Number(subscription.interval_count || 1));
  if (subscription.end_date && next > subscription.end_date) throw httpError(409, 'subscription_schedule_completed', 'The subscription schedule has already ended.');
  return `${next}T00:00:00.000Z`;
}

function advanceOccurrence(date, frequency, interval) {
  const source = new Date(`${date}T00:00:00.000Z`);
  if (frequency === 'DAILY') source.setUTCDate(source.getUTCDate() + interval);
  if (frequency === 'WEEKLY') source.setUTCDate(source.getUTCDate() + 7 * interval);
  if (frequency === 'MONTHLY' || frequency === 'QUARTERLY' || frequency === 'YEARLY') {
    const months = frequency === 'MONTHLY' ? interval : frequency === 'QUARTERLY' ? interval * 3 : interval * 12;
    const day = source.getUTCDate();
    source.setUTCDate(1);
    source.setUTCMonth(source.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + 1, 0)).getUTCDate();
    source.setUTCDate(Math.min(day, lastDay));
  }
  return source.toISOString().slice(0, 10);
}

function addDays(date, days) { const value = new Date(`${date}T00:00:00.000Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
function normalizeDate(value) { const date = new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`); if (!Number.isFinite(date.getTime())) throw httpError(422, 'invalid_date', 'A valid date is required.'); return date.toISOString().slice(0, 10); }
function subscriptionView(row) { return { ...row, items: parseJson(row.items_snapshot, []), invoice_details: parseJson(row.invoice_details, {}), delivery_channels: parseJson(row.delivery_channels, []) }; }
function runView(row) { return { ...row, grand_total: row.grand_total_minor == null ? null : fromMinor(row.grand_total_minor) }; }
function parseJson(value, fallback) { try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; } }
async function nextNumber(db, key, prefix) { const row = await db.one('SELECT * FROM number_sequences WHERE sequence_key = ?', [key]); const value = Number(row?.next_value || 1); if (!row) await db.run('INSERT INTO number_sequences (sequence_key, prefix, next_value, padding, updated_at) VALUES (?, ?, 2, 6, ?)', [key, prefix, now()]); else await db.run('UPDATE number_sequences SET next_value = ?, updated_at = ? WHERE sequence_key = ?', [value + 1, now(), key]); return `${row?.prefix || prefix}-${String(value).padStart(Number(row?.padding || 6), '0')}`; }
function insertWithId(db, sql, params) { return db.run(`${sql}${db.dialect === 'postgres' ? ' RETURNING id' : ''}`, params); }
function insertedId(result) { return Number(result?.id || result?.rows?.[0]?.id); }
function now() { return new Date().toISOString(); }
async function announce(organizationId, event, payload) { return publishOrganizationEvent(organizationId, event, payload); }
