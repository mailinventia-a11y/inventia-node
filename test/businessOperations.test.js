import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inventia-business-operations-test-'));
process.env.NODE_ENV = 'test';
process.env.PHASE5_DATA_DIR = path.join(testRoot, 'control');
process.env.DEFAULT_TENANT_DATABASE_URL = `sqlite:${path.join(testRoot, 'tenant.db')}`;
process.env.JWT_SECRET = 'business-operations-test-jwt-secret';
process.env.TENANT_MASTER_KEY = 'business-operations-test-master-key';
process.env.INVOICE_STORAGE_DIR = path.join(testRoot, 'uploads');
delete process.env.CONTROL_DATABASE_URL;
delete process.env.TENANT_DATABASE_ADMIN_URL;
delete process.env.REDIS_URL;

const databaseModule = await import('../src/platform/phase5Database.js');
const authModule = await import('../src/platform/phase5Auth.js');
const trade = await import('../src/services/enterpriseTradeService.js');
const finance = await import('../src/services/financeOperationsService.js');
const operations = await import('../src/services/businessOperationsService.js');

const { defaultTenant: db } = await databaseModule.initializePhase5Platform({ hashPassword: authModule.hashPlatformPassword });
const session = await authModule.loginPlatform({ username: 'admin', password: 'admin123' });
const baseRequest = {
  requestId: 'business-operations-test',
  user: {
    id: session.user.id, tenant_user_id: session.user.id, role: session.user.role,
    permissions: ['*'], organization_id: session.organization.id
  },
  headers: { 'idempotency-key': 'business-operations-test' }, ip: '127.0.0.1', tenantDb: db,
  protocol: 'http', get: name => name === 'host' ? 'localhost:3000' : '',
  invoicePdfGenerator: async () => { throw new Error('PDF unavailable in business operations tests.'); }
};

await db.run(`INSERT INTO warehouses (name, code, type, created_at) VALUES ('Operations Main', 'OPS-MAIN', 'warehouse', ?)`, [new Date().toISOString()]);
const customer = await trade.createParty(db, 'customer', { name: 'Operations Customer', credit_limit: 10000 }, baseRequest);
const product = await trade.createProduct(db, {
  sku: 'OPS-001', name: 'Operations Product', uom: 'piece', cost_price: 50,
  selling_price: 100, minimum_price: 90, maximum_price: 120, gst_rate: 18
}, baseRequest);
await trade.postStockMovement(db, { product_id: product.id, warehouse_id: 1, movement_type: 'purchase_receipt', quantity: 10, unit_cost: 50 }, baseRequest);
const checkout = await trade.checkoutPos(db, {
  customer_id: customer.id, warehouse_id: 1,
  items: [{ product_id: product.id, quantity: 1, unit_price: 100 }],
  payments: [], allow_partial_payment: true, due_date: '2026-09-30'
}, { ...baseRequest, headers: { 'idempotency-key': 'operations-checkout' } });

test('payment links are outstanding-bounded, token-hashed, publicly resolvable, and cancellable', async () => {
  const request = { ...baseRequest, headers: { 'idempotency-key': 'payment-link-create' } };
  const created = await operations.createPaymentLink(db, {
    invoice_id: checkout.invoiceId, amount: 50, expires_at: '2027-01-01T00:00:00.000Z'
  }, request);
  assert.match(created.url, new RegExp(`/pay/${session.organization.id}/`));
  assert.equal(created.amount_minor, 5000);
  const stored = await db.one('SELECT * FROM payment_links WHERE id = ?', [created.id]);
  assert.notEqual(stored.link_token_hash, created.token);
  assert.equal(stored.link_token_hash.length, 64);
  const resolved = await operations.resolvePublicPaymentLink(db, created.token);
  assert.equal(resolved.invoice_number, checkout.invoiceNumber);
  assert.equal(resolved.payment_available, false);
  assert.match(resolved.next_step, /not configured/i);
  await operations.cancelPaymentLink(db, created.id, request);
  const cancelled = await operations.resolvePublicPaymentLink(db, created.token);
  assert.equal(cancelled.status, 'CANCELLED');
  await assert.rejects(
    () => operations.createPaymentLink(db, { invoice_id: checkout.invoiceId, amount: 1000, expires_at: '2027-01-01T00:00:00.000Z' }, { ...request, headers: { 'idempotency-key': 'payment-link-too-large' } }),
    error => error.code === 'invalid_payment_link_amount'
  );
});

test('in-app reminders create real tenant notifications and external channels never simulate success', async () => {
  const due = '2026-01-01T00:00:00.000Z';
  const inApp = await operations.createReminder(db, {
    reminder_type: 'payment_due', entity_type: 'invoice', entity_id: checkout.invoiceId,
    recipient_type: 'organization', channel: 'IN_APP', scheduled_at: due,
    subject: 'Invoice due', message: 'Please review the outstanding invoice.'
  }, { ...baseRequest, headers: { 'idempotency-key': 'reminder-in-app' } });
  assert.equal(inApp.status, 'SENT');
  const notifications = await operations.listTenantNotifications(db, session.user.id);
  assert.equal(notifications.some(item => item.entity_id === String(checkout.invoiceId)), true);
  const external = await operations.createReminder(db, {
    reminder_type: 'payment_due', entity_type: 'invoice', entity_id: checkout.invoiceId,
    recipient_type: 'customer', recipient_id: String(customer.id), channel: 'WHATSAPP',
    scheduled_at: due, message: 'Payment reminder'
  }, { ...baseRequest, headers: { 'idempotency-key': 'reminder-whatsapp' } });
  assert.equal(external.status, 'FAILED');
  assert.match(external.last_error, /not configured/i);
  const delivery = await db.one('SELECT * FROM notification_deliveries WHERE reminder_id = ?', [external.id]);
  assert.equal(delivery.status, 'FAILED');
});

test('projects link validated invoices and expenses into duplicate-proof profitability', async () => {
  const project = await operations.createProject(db, {
    name: 'Showroom Fitout', customer_id: customer.id, status: 'ACTIVE',
    budget_revenue: 500, budget_cost: 200
  }, { ...baseRequest, headers: { 'idempotency-key': 'project-create' } });
  await operations.linkProjectDocument(db, project.id, {
    entity_type: 'invoice', entity_id: checkout.invoiceId, relationship_type: 'billing'
  }, { ...baseRequest, headers: { 'idempotency-key': 'project-invoice-link' } });
  const accounts = await finance.listFinanceAccounts(db);
  const expense = await finance.createExpense(db, {
    expense_account_id: accounts.find(account => account.code === '6000').id,
    payment_account_id: accounts.find(account => account.code === '1000').id,
    subtotal: 50, tax: 9, expense_date: '2026-08-02', status: 'PAID',
    project_id: project.id, description: 'Installation materials'
  }, { ...baseRequest, headers: { 'idempotency-key': 'project-expense' } });
  await operations.linkProjectDocument(db, project.id, {
    entity_type: 'expense', entity_id: expense.id, relationship_type: 'cost'
  }, { ...baseRequest, headers: { 'idempotency-key': 'project-expense-link' } });
  const profitability = await operations.projectProfitability(db, project.id);
  assert.equal(profitability.revenue_minor, 11800);
  assert.equal(profitability.cost_minor, 5900);
  assert.equal(profitability.profit_minor, 5900);
  const costEntries = await db.all(`SELECT * FROM project_entries WHERE project_id = ? AND source_type = 'expense'`, [project.id]);
  assert.equal(costEntries.length, 1);
  await assert.rejects(
    () => operations.linkProjectDocument(db, project.id, { entity_type: 'invoice', entity_id: checkout.invoiceId }, { ...baseRequest, headers: { 'idempotency-key': 'project-invoice-duplicate' } }),
    error => /unique|duplicate/i.test(error.message)
  );
});
