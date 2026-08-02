import crypto from 'node:crypto';
import { httpError, writeTenantAudit } from '../platform/phase5Http.js';
import { enqueueDomainJob, publishOrganizationEvent } from '../platform/phase5Runtime.js';
import { fromMinor, toMinor } from './moneyService.js';
import { calculateInvoicePaymentState } from './invoicePaymentService.js';

const PROJECT_STATUSES = new Set(['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']);
const REMINDER_CHANNELS = new Set(['IN_APP', 'EMAIL', 'SMS', 'WHATSAPP']);

export async function listPaymentLinks(db, query = {}) {
  const where = [];
  const params = [];
  if (query.status) { where.push('pl.status = ?'); params.push(String(query.status).toUpperCase()); }
  if (query.invoice_id) { where.push('pl.invoice_id = ?'); params.push(query.invoice_id); }
  await expirePaymentLinks(db);
  const rows = await db.all(
    `SELECT pl.*, i.invoice_number, i.payment_status, i.grand_total_minor,
            c.name AS customer_name
       FROM payment_links pl JOIN invoices i ON i.id = pl.invoice_id
       LEFT JOIN customers c ON c.id = pl.customer_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY pl.created_at DESC, pl.id DESC LIMIT 500`, params
  );
  return rows.map(paymentLinkView);
}

export async function createPaymentLink(db, input, req) {
  const actorId = req.user.tenant_user_id || req.user.id;
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const linkId = await db.transaction(async tx => {
    const invoice = await tx.one('SELECT * FROM invoices WHERE id = ?', [input.invoice_id]);
    if (!invoice) throw httpError(404, 'invoice_not_found', 'The invoice was not found.');
    if (invoice.invoice_status !== 'ISSUED') throw httpError(409, 'invoice_not_payable', 'Only issued invoices can receive payment links.');
    const paymentState = await calculateInvoicePaymentState(tx, invoice.id, { persist: false });
    const outstandingMinor = Number(paymentState.outstanding_minor);
    if (outstandingMinor <= 0) throw httpError(409, 'invoice_already_settled', 'This invoice has no outstanding balance.');
    const amountMinor = input.amount == null ? outstandingMinor : toMinor(input.amount, 'Payment link amount');
    if (amountMinor <= 0 || amountMinor > outstandingMinor) {
      throw httpError(422, 'invalid_payment_link_amount', 'Payment link amount must be positive and cannot exceed the outstanding balance.');
    }
    const expiresAt = new Date(input.expires_at);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw httpError(422, 'future_expiry_required', 'Payment link expiry must be in the future.');
    }
    const inserted = await insertWithId(tx,
      `INSERT INTO payment_links
        (link_token_hash, invoice_id, customer_id, amount_minor, currency, provider,
         status, expires_at, usage_limit, usage_count, metadata, idempotency_key,
         created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'inventia', 'ACTIVE', ?, 1, 0, ?, ?, ?, ?, ?)`,
      [tokenHash, invoice.id, invoice.customer_id || null, amountMinor, invoice.currency || 'INR',
        expiresAt.toISOString(), JSON.stringify({ invoice_number: invoice.invoice_number }),
        String(req.headers['idempotency-key']), actorId, now(), now()]
    );
    return insertedId(inserted);
  });
  const link = await db.one('SELECT * FROM payment_links WHERE id = ?', [linkId]);
  await writeTenantAudit(db, req, { eventType: 'payment_link.created', entityType: 'payment_link', entityId: linkId, after: paymentLinkView(link) });
  await announce(req, 'payments.changed', { action: 'payment_link_created', payment_link_id: linkId });
  return {
    ...paymentLinkView(link),
    token,
    url: `${req.protocol}://${req.get('host')}/pay/${encodeURIComponent(req.user.organization_id)}/${token}`
  };
}

export async function cancelPaymentLink(db, id, req) {
  const before = await db.one('SELECT * FROM payment_links WHERE id = ?', [id]);
  if (!before) throw httpError(404, 'payment_link_not_found', 'The payment link was not found.');
  if (before.status !== 'ACTIVE') throw httpError(409, 'payment_link_not_active', 'Only an active payment link can be cancelled.');
  await db.run(`UPDATE payment_links SET status = 'CANCELLED', updated_at = ? WHERE id = ?`, [now(), id]);
  const after = await db.one('SELECT * FROM payment_links WHERE id = ?', [id]);
  await writeTenantAudit(db, req, { eventType: 'payment_link.cancelled', entityType: 'payment_link', entityId: id, before, after });
  await announce(req, 'payments.changed', { action: 'payment_link_cancelled', payment_link_id: Number(id) });
  return paymentLinkView(after);
}

export async function resolvePublicPaymentLink(db, token) {
  const tokenHash = hashToken(token);
  const row = await db.one(
    `SELECT pl.*, i.invoice_number, i.payment_status, i.invoice_status,
            c.name AS customer_name
       FROM payment_links pl JOIN invoices i ON i.id = pl.invoice_id
       LEFT JOIN customers c ON c.id = pl.customer_id
      WHERE pl.link_token_hash = ?`, [tokenHash]
  );
  if (!row) throw httpError(404, 'payment_link_not_found', 'The payment link was not found.');
  if (row.status === 'ACTIVE' && new Date(row.expires_at).getTime() <= Date.now()) {
    await db.run(`UPDATE payment_links SET status = 'EXPIRED', updated_at = ? WHERE id = ?`, [now(), row.id]);
    row.status = 'EXPIRED';
  }
  return {
    status: row.status,
    invoice_number: row.invoice_number,
    customer_name: row.customer_name || 'Customer',
    amount: fromMinor(row.amount_minor),
    amount_minor: Number(row.amount_minor),
    currency: row.currency,
    expires_at: row.expires_at,
    payment_provider: null,
    payment_available: false,
    next_step: row.status === 'ACTIVE'
      ? 'Online provider checkout is not configured for this payment request. Contact the organization to complete payment.'
      : 'This payment request is not active.'
  };
}

export async function listReminders(db, query = {}) {
  const where = [];
  const params = [];
  if (query.status) { where.push('r.status = ?'); params.push(String(query.status).toUpperCase()); }
  if (query.entity_type) { where.push('r.entity_type = ?'); params.push(query.entity_type); }
  return db.all(
    `SELECT r.*, (SELECT COUNT(*) FROM notification_deliveries nd WHERE nd.reminder_id = r.id) AS delivery_count
       FROM reminders r ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY r.scheduled_at DESC, r.id DESC LIMIT 500`, params
  );
}

export async function createReminder(db, input, req) {
  const actorId = req.user.tenant_user_id || req.user.id;
  const channel = String(input.channel || 'IN_APP').toUpperCase();
  if (!REMINDER_CHANNELS.has(channel)) throw httpError(422, 'invalid_reminder_channel', 'The reminder channel is not supported.');
  await assertReminderEntity(db, input.entity_type, input.entity_id);
  const scheduledAt = new Date(input.scheduled_at);
  if (!Number.isFinite(scheduledAt.getTime())) throw httpError(422, 'invalid_reminder_schedule', 'A valid reminder schedule is required.');
  const inserted = await insertWithId(db,
    `INSERT INTO reminders
      (reminder_type, entity_type, entity_id, recipient_type, recipient_id, channel,
       scheduled_at, status, subject, message, attempts, idempotency_key,
       created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'SCHEDULED', ?, ?, 0, ?, ?, ?, ?)`,
    [input.reminder_type, input.entity_type, String(input.entity_id), input.recipient_type,
      input.recipient_id || null, channel, scheduledAt.toISOString(), input.subject || null,
      input.message, String(req.headers['idempotency-key']), actorId, now(), now()]
  );
  const id = insertedId(inserted);
  let delivery = { queued: false, provider: 'inline' };
  if (scheduledAt.getTime() <= Date.now()) {
    await processReminderDelivery(db, id, req.user.organization_id);
  } else {
    delivery = await enqueueDomainJob('reminder.deliver', {
      organization_id: req.user.organization_id,
      reminder_id: id
    }, { delay: Math.max(scheduledAt.getTime() - Date.now(), 0), jobId: `reminder:${req.user.organization_id}:${id}` });
  }
  const reminder = await db.one('SELECT * FROM reminders WHERE id = ?', [id]);
  await writeTenantAudit(db, req, { eventType: 'reminder.created', entityType: 'reminder', entityId: id, after: reminder });
  await announce(req, 'notifications.changed', { action: 'reminder_created', reminder_id: id });
  return { ...reminder, delivery };
}

export async function cancelReminder(db, id, req) {
  const before = await db.one('SELECT * FROM reminders WHERE id = ?', [id]);
  if (!before) throw httpError(404, 'reminder_not_found', 'The reminder was not found.');
  if (before.status !== 'SCHEDULED') throw httpError(409, 'reminder_not_cancellable', 'Only a scheduled reminder can be cancelled.');
  await db.run(`UPDATE reminders SET status = 'CANCELLED', cancelled_at = ?, updated_at = ? WHERE id = ?`, [now(), now(), id]);
  const after = await db.one('SELECT * FROM reminders WHERE id = ?', [id]);
  await writeTenantAudit(db, req, { eventType: 'reminder.cancelled', entityType: 'reminder', entityId: id, before, after });
  await announce(req, 'notifications.changed', { action: 'reminder_cancelled', reminder_id: Number(id) });
  return after;
}

export async function processDueReminders(db, organizationId, limit = 100) {
  const due = await db.all(
    `SELECT id FROM reminders WHERE status = 'SCHEDULED' AND scheduled_at <= ? ORDER BY scheduled_at, id LIMIT ?`,
    [now(), Math.min(Math.max(Number(limit) || 100, 1), 500)]
  );
  const results = [];
  for (const row of due) results.push(await processReminderDelivery(db, row.id, organizationId));
  return results;
}

export async function processReminderDelivery(db, reminderId, organizationId) {
  const reminder = await db.one('SELECT * FROM reminders WHERE id = ?', [reminderId]);
  if (!reminder) throw httpError(404, 'reminder_not_found', 'The reminder was not found.');
  if (reminder.status === 'SENT') return { reminder_id: reminder.id, status: 'SENT', duplicate: true };
  if (reminder.status !== 'SCHEDULED' && reminder.status !== 'FAILED') {
    throw httpError(409, 'reminder_not_deliverable', 'The reminder cannot be delivered in its current state.');
  }
  await db.run(`UPDATE reminders SET status = 'PROCESSING', attempts = attempts + 1, updated_at = ? WHERE id = ?`, [now(), reminder.id]);
  if (reminder.channel !== 'IN_APP') {
    const message = `${reminder.channel} integration is not configured.`;
    await db.transaction(async tx => {
      await tx.run(
        `INSERT INTO notification_deliveries
          (reminder_id, channel, status, error_message, attempted_at)
         VALUES (?, ?, 'FAILED', ?, ?)`, [reminder.id, reminder.channel, message, now()]
      );
      await tx.run(`UPDATE reminders SET status = 'FAILED', last_error = ?, updated_at = ? WHERE id = ?`, [message, now(), reminder.id]);
    });
    return { reminder_id: reminder.id, status: 'FAILED', code: 'integration_not_configured' };
  }
  const result = await db.transaction(async tx => {
    const inserted = await insertWithId(tx,
      `INSERT INTO notifications
        (user_id, type, title, message, entity_type, entity_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [reminder.recipient_type === 'user' ? reminder.recipient_id : null,
        reminder.reminder_type, reminder.subject || 'Business reminder', reminder.message,
        reminder.entity_type, reminder.entity_id, now()]
    );
    const notificationId = insertedId(inserted);
    await tx.run(
      `INSERT INTO notification_deliveries
        (reminder_id, notification_id, channel, provider, status, attempted_at, delivered_at)
       VALUES (?, ?, 'IN_APP', 'inventia', 'DELIVERED', ?, ?)`,
      [reminder.id, notificationId, now(), now()]
    );
    await tx.run(`UPDATE reminders SET status = 'SENT', sent_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`, [now(), now(), reminder.id]);
    return notificationId;
  });
  await publishOrganizationEvent(organizationId, 'notifications.changed', { reminder_id: reminder.id, notification_id: result });
  return { reminder_id: reminder.id, notification_id: result, status: 'SENT' };
}

export async function listTenantNotifications(db, userId) {
  return db.all(
    `SELECT * FROM notifications WHERE user_id IS NULL OR user_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`,
    [userId]
  );
}

export async function markNotificationRead(db, id, userId) {
  const notification = await db.one(`SELECT * FROM notifications WHERE id = ? AND (user_id IS NULL OR user_id = ?)`, [id, userId]);
  if (!notification) throw httpError(404, 'notification_not_found', 'The notification was not found.');
  await db.run('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?', [now(), id]);
  return db.one('SELECT * FROM notifications WHERE id = ?', [id]);
}

export async function listProjects(db, query = {}) {
  const where = [];
  const params = [];
  if (query.status) { where.push('p.status = ?'); params.push(String(query.status).toUpperCase()); }
  if (query.customer_id) { where.push('p.customer_id = ?'); params.push(query.customer_id); }
  const rows = await db.all(
    `SELECT p.*, c.name AS customer_name,
            COALESCE(SUM(CASE WHEN pe.entry_type = 'REVENUE' THEN pe.amount_minor ELSE 0 END), 0) AS revenue_minor,
            COALESCE(SUM(CASE WHEN pe.entry_type = 'COST' THEN pe.amount_minor ELSE 0 END), 0) AS cost_minor
       FROM projects p LEFT JOIN customers c ON c.id = p.customer_id
       LEFT JOIN project_entries pe ON pe.project_id = p.id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       GROUP BY p.id, c.name ORDER BY p.created_at DESC, p.id DESC`, params
  );
  return rows.map(projectView);
}

export async function getProject(db, id) {
  const project = await db.one(
    `SELECT p.*, c.name AS customer_name FROM projects p LEFT JOIN customers c ON c.id = p.customer_id WHERE p.id = ?`, [id]
  );
  if (!project) throw httpError(404, 'project_not_found', 'The project was not found.');
  const [entries, documents] = await Promise.all([
    db.all('SELECT * FROM project_entries WHERE project_id = ? ORDER BY occurred_at DESC, id DESC', [id]),
    db.all('SELECT * FROM project_documents WHERE project_id = ? ORDER BY created_at DESC, id DESC', [id])
  ]);
  return { ...projectView(project), entries: entries.map(entryView), documents };
}

export async function createProject(db, input, req) {
  const actorId = req.user.tenant_user_id || req.user.id;
  if (input.customer_id) await assertRecord(db, 'customers', input.customer_id, 'customer_not_found');
  assertProjectDates(input.start_date, input.end_date);
  const id = await db.transaction(async tx => {
    const projectNo = await nextNumber(tx, 'project', 'PRJ');
    const inserted = await insertWithId(tx,
      `INSERT INTO projects
        (project_no, name, customer_id, status, start_date, end_date,
         budget_revenue_minor, budget_cost_minor, description, metadata,
         created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [projectNo, input.name, input.customer_id || null, String(input.status || 'PLANNED').toUpperCase(),
        input.start_date || null, input.end_date || null, toMinor(input.budget_revenue || 0),
        toMinor(input.budget_cost || 0), input.description || null, JSON.stringify(input.metadata || {}),
        actorId, now(), now()]
    );
    return insertedId(inserted);
  });
  const project = await getProject(db, id);
  await writeTenantAudit(db, req, { eventType: 'project.created', entityType: 'project', entityId: id, after: project });
  await announce(req, 'projects.changed', { action: 'project_created', project_id: id });
  return project;
}

export async function updateProject(db, id, input, req) {
  const before = await db.one('SELECT * FROM projects WHERE id = ?', [id]);
  if (!before) throw httpError(404, 'project_not_found', 'The project was not found.');
  const status = String(input.status || before.status).toUpperCase();
  if (!PROJECT_STATUSES.has(status)) throw httpError(422, 'invalid_project_status', 'The project status is invalid.');
  if (input.customer_id) await assertRecord(db, 'customers', input.customer_id, 'customer_not_found');
  assertProjectDates(input.start_date ?? before.start_date, input.end_date ?? before.end_date);
  await db.run(
    `UPDATE projects SET name = ?, customer_id = ?, status = ?, start_date = ?, end_date = ?,
      budget_revenue_minor = ?, budget_cost_minor = ?, description = ?, metadata = ?, updated_at = ? WHERE id = ?`,
    [input.name ?? before.name, input.customer_id ?? before.customer_id, status,
      input.start_date ?? before.start_date, input.end_date ?? before.end_date,
      input.budget_revenue == null ? before.budget_revenue_minor : toMinor(input.budget_revenue),
      input.budget_cost == null ? before.budget_cost_minor : toMinor(input.budget_cost),
      input.description ?? before.description, JSON.stringify(input.metadata || parseJson(before.metadata, {})), now(), id]
  );
  const project = await getProject(db, id);
  await writeTenantAudit(db, req, { eventType: 'project.updated', entityType: 'project', entityId: id, before, after: project });
  await announce(req, 'projects.changed', { action: 'project_updated', project_id: Number(id) });
  return project;
}

export async function linkProjectDocument(db, projectId, input, req) {
  const actorId = req.user.tenant_user_id || req.user.id;
  const project = await db.one('SELECT * FROM projects WHERE id = ?', [projectId]);
  if (!project) throw httpError(404, 'project_not_found', 'The project was not found.');
  const source = await projectSource(db, input.entity_type, input.entity_id);
  await db.transaction(async tx => {
    await tx.run(
      `INSERT INTO project_documents
        (project_id, entity_type, entity_id, relationship_type, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [projectId, input.entity_type, String(input.entity_id), input.relationship_type || 'related', actorId, now()]
    );
    if (source.entryType && source.amountMinor > 0) {
      await tx.run(
        `INSERT INTO project_entries
          (project_id, entry_type, source_type, source_id, amount_minor, occurred_at, description, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, entry_type, source_type, source_id) DO NOTHING`,
        [projectId, source.entryType, input.entity_type, String(input.entity_id), source.amountMinor,
          source.occurredAt, source.description, actorId, now()]
      );
    }
  });
  await writeTenantAudit(db, req, { eventType: 'project.document_linked', entityType: 'project', entityId: projectId, after: input });
  await announce(req, 'projects.changed', { action: 'project_document_linked', project_id: Number(projectId) });
  return getProject(db, projectId);
}

export async function unlinkProjectDocument(db, projectId, documentId, req) {
  const link = await db.one('SELECT * FROM project_documents WHERE id = ? AND project_id = ?', [documentId, projectId]);
  if (!link) throw httpError(404, 'project_document_not_found', 'The project document link was not found.');
  await db.transaction(async tx => {
    await tx.run('DELETE FROM project_documents WHERE id = ?', [documentId]);
    await tx.run('DELETE FROM project_entries WHERE project_id = ? AND source_type = ? AND source_id = ?', [projectId, link.entity_type, link.entity_id]);
  });
  await writeTenantAudit(db, req, { eventType: 'project.document_unlinked', entityType: 'project', entityId: projectId, before: link });
  await announce(req, 'projects.changed', { action: 'project_document_unlinked', project_id: Number(projectId) });
  return { success: true };
}

export async function projectProfitability(db, id) {
  const project = await getProject(db, id);
  const revenueMinor = project.entries.filter(item => item.entry_type === 'REVENUE').reduce((sum, item) => sum + Number(item.amount_minor), 0);
  const costMinor = project.entries.filter(item => item.entry_type === 'COST').reduce((sum, item) => sum + Number(item.amount_minor), 0);
  const profitMinor = revenueMinor - costMinor;
  return {
    project_id: Number(id), revenue_minor: revenueMinor, cost_minor: costMinor, profit_minor: profitMinor,
    margin_percent: revenueMinor ? Number(((profitMinor / revenueMinor) * 100).toFixed(2)) : 0,
    budget_revenue_minor: Number(project.budget_revenue_minor), budget_cost_minor: Number(project.budget_cost_minor),
    revenue: fromMinor(revenueMinor), cost: fromMinor(costMinor), profit: fromMinor(profitMinor)
  };
}

async function projectSource(db, entityType, entityId) {
  if (entityType === 'invoice') {
    const row = await db.one('SELECT id, invoice_number, grand_total_minor, issued_at, invoice_status FROM invoices WHERE id = ?', [entityId]);
    if (!row) throw httpError(404, 'invoice_not_found', 'The invoice was not found.');
    if (row.invoice_status !== 'ISSUED') throw httpError(409, 'invoice_not_issued', 'Only issued invoices contribute project revenue.');
    return { entryType: 'REVENUE', amountMinor: Number(row.grand_total_minor), occurredAt: row.issued_at, description: `Invoice ${row.invoice_number}` };
  }
  if (entityType === 'expense') {
    const row = await db.one('SELECT id, expense_no, total_minor, expense_date, status FROM expenses WHERE id = ?', [entityId]);
    if (!row) throw httpError(404, 'expense_not_found', 'The expense was not found.');
    if (row.status === 'DRAFT' || row.status === 'VOID') throw httpError(409, 'expense_not_posted', 'Only posted or paid expenses contribute project cost.');
    return { entryType: 'COST', amountMinor: Number(row.total_minor), occurredAt: row.expense_date, description: `Expense ${row.expense_no}` };
  }
  if (entityType === 'trade_document') {
    const row = await db.one('SELECT id, document_no FROM trade_documents WHERE id = ?', [entityId]);
    if (!row) throw httpError(404, 'trade_document_not_found', 'The trade document was not found.');
    return { entryType: null, amountMinor: 0, occurredAt: now(), description: row.document_no };
  }
  throw httpError(422, 'invalid_project_document_type', 'The project document type is not supported.');
}

async function assertReminderEntity(db, entityType, entityId) {
  const tables = { invoice: 'invoices', customer: 'customers', supplier: 'suppliers', project: 'projects', trade_document: 'trade_documents' };
  const table = tables[entityType];
  if (!table) throw httpError(422, 'invalid_reminder_entity', 'The reminder entity type is not supported.');
  await assertRecord(db, table, entityId, 'reminder_entity_not_found');
}

async function assertRecord(db, table, id, code) {
  const row = await db.one(`SELECT id FROM ${table} WHERE id = ?`, [id]);
  if (!row) throw httpError(404, code, 'The referenced record was not found.');
}

async function expirePaymentLinks(db) {
  await db.run(`UPDATE payment_links SET status = 'EXPIRED', updated_at = ? WHERE status = 'ACTIVE' AND expires_at <= ?`, [now(), now()]);
}

async function nextNumber(db, sequenceKey, prefix) {
  const row = await db.one('SELECT * FROM number_sequences WHERE sequence_key = ?', [sequenceKey]);
  if (!row) {
    await db.run('INSERT INTO number_sequences (sequence_key, prefix, next_value, padding, updated_at) VALUES (?, ?, 2, 5, ?)', [sequenceKey, prefix, now()]);
    return `${prefix}-${String(1).padStart(5, '0')}`;
  }
  const value = Number(row.next_value);
  await db.run('UPDATE number_sequences SET next_value = ?, updated_at = ? WHERE sequence_key = ?', [value + 1, now(), sequenceKey]);
  return `${row.prefix || prefix}-${String(value).padStart(Number(row.padding || 5), '0')}`;
}

function paymentLinkView(row) {
  return { ...row, amount: fromMinor(row.amount_minor), link_token_hash: undefined, metadata: parseJson(row.metadata, {}) };
}

function assertProjectDates(startDate, endDate) {
  if (startDate && endDate && String(startDate) > String(endDate)) {
    throw httpError(422, 'invalid_project_dates', 'Project end date cannot be before its start date.');
  }
}

function projectView(row) {
  const revenue = Number(row.revenue_minor || 0);
  const cost = Number(row.cost_minor || 0);
  return {
    ...row, metadata: parseJson(row.metadata, {}), revenue_minor: revenue, cost_minor: cost,
    profit_minor: revenue - cost, budget_revenue: fromMinor(row.budget_revenue_minor || 0),
    budget_cost: fromMinor(row.budget_cost_minor || 0), revenue: fromMinor(revenue),
    cost: fromMinor(cost), profit: fromMinor(revenue - cost)
  };
}

function entryView(row) { return { ...row, amount: fromMinor(row.amount_minor) }; }
function hashToken(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }
function parseJson(value, fallback) { try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; } }
function insertWithId(db, sql, params) { return db.run(`${sql}${db.dialect === 'postgres' ? ' RETURNING id' : ''}`, params); }
function insertedId(result) { return Number(result?.id || result?.rows?.[0]?.id); }
function now() { return new Date().toISOString(); }
async function announce(req, event, payload) { return publishOrganizationEvent(req.user.organization_id, event, payload); }
