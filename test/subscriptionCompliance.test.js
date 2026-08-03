import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inventia-subscription-compliance-test-'));
process.env.NODE_ENV = 'test';
process.env.PHASE5_DATA_DIR = path.join(testRoot, 'control');
process.env.DEFAULT_TENANT_DATABASE_URL = `sqlite:${path.join(testRoot, 'tenant.db')}`;
process.env.JWT_SECRET = 'subscription-compliance-test-jwt-secret';
process.env.TENANT_MASTER_KEY = 'subscription-compliance-test-master-key';
process.env.INVOICE_STORAGE_DIR = path.join(testRoot, 'uploads');
delete process.env.CONTROL_DATABASE_URL;
delete process.env.TENANT_DATABASE_ADMIN_URL;
delete process.env.REDIS_URL;
delete process.env.GST_PROVIDER_URL;
delete process.env.GST_PROVIDER_API_KEY;

const databaseModule = await import('../src/platform/phase5Database.js');
const authModule = await import('../src/platform/phase5Auth.js');
const trade = await import('../src/services/enterpriseTradeService.js');
const service = await import('../src/services/subscriptionComplianceService.js');

const { defaultTenant: db } = await databaseModule.initializePhase5Platform({ hashPassword: authModule.hashPlatformPassword });
const session = await authModule.loginPlatform({ username: 'admin', password: 'admin123' });
const request = key => ({
  requestId: key,
  user: { id: session.user.id, tenant_user_id: session.user.id, role: session.user.role, permissions: ['*'], organization_id: session.organization.id },
  headers: { 'idempotency-key': key }, ip: '127.0.0.1', tenantDb: db,
  invoicePdfGenerator: async () => { throw new Error('PDF unavailable in subscription tests.'); }
});

await db.run(`INSERT INTO warehouses (name, code, type, created_at) VALUES ('Recurring Main', 'REC-MAIN', 'warehouse', ?)`, [new Date().toISOString()]);
await db.run(
  `INSERT INTO organization_settings (setting_key, setting_value, updated_at)
   VALUES ('state_code', ?, ?), ('company_state', ?, ?), ('company_gstin', ?, ?), ('company_name', ?, ?)`,
  [JSON.stringify('29'), new Date().toISOString(), JSON.stringify('Karnataka'), new Date().toISOString(),
    JSON.stringify('29ABCDE1234F1Z5'), new Date().toISOString(), JSON.stringify('Inventia Test'), new Date().toISOString()]
);
const customer = await trade.createParty(db, 'customer', {
  name: 'Recurring GST Customer', gstin: '29AAAAA0000A1Z5', address: 'Bengaluru', credit_limit: 100000
}, request('subscription-customer'));
const product = await trade.createProduct(db, {
  sku: 'SUB-001', name: 'Recurring Product', uom: 'piece', hsn_code: '9403', gst_rate: 18,
  cost_price: 40, selling_price: 100, minimum_price: 90, maximum_price: 120
}, request('subscription-product'));
await trade.postStockMovement(db, { product_id: product.id, warehouse_id: 1, movement_type: 'purchase_receipt', quantity: 20, unit_cost: 40 }, request('subscription-stock'));

test('a due subscription occurrence creates one invoice and consumes stock exactly once', async () => {
  const start = new Date().toISOString().slice(0, 10);
  const created = await service.createSubscription(db, {
    name: 'Monthly interiors service', customer_id: customer.id, warehouse_id: 1,
    frequency: 'MONTHLY', interval_count: 1, start_date: start, due_days: 7,
    price_policy: 'SNAPSHOT', items: [{ product_id: product.id, quantity: 2, unit_price: 100 }],
    delivery_channels: ['IN_APP']
  }, request('subscription-create'));
  const active = await service.transitionSubscription(db, created.id, 'ACTIVE', request('subscription-activate'));
  assert.equal(active.status, 'ACTIVE');
  const results = await service.processDueSubscriptions(db, session.organization.id);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'COMPLETED');
  const run = await db.one('SELECT * FROM subscription_runs WHERE subscription_id = ?', [created.id]);
  assert.ok(run.invoice_id);
  const stock = await db.one('SELECT quantity FROM warehouse_stock WHERE warehouse_id = 1 AND product_id = ?', [product.id]);
  assert.equal(Number(stock.quantity), 18);
  const duplicate = await service.generateSubscriptionRun(db, session.organization.id, run.id);
  assert.equal(duplicate.duplicate, true);
  const invoiceCount = await db.one('SELECT COUNT(*) AS count FROM invoices WHERE id = ?', [run.invoice_id]);
  assert.equal(Number(invoiceCount.count), 1);
  const stockAfter = await db.one('SELECT quantity FROM warehouse_stock WHERE warehouse_id = 1 AND product_id = ?', [product.id]);
  assert.equal(Number(stockAfter.quantity), 18);
});

test('failed subscription generation remains retryable without partial commercial records', async () => {
  const start = new Date().toISOString().slice(0, 10);
  const created = await service.createSubscription(db, {
    name: 'Unavailable stock schedule', customer_id: customer.id, warehouse_id: 1,
    frequency: 'YEARLY', interval_count: 1, start_date: start, due_days: 7,
    price_policy: 'CURRENT_APPROVED', items: [{ product_id: product.id, quantity: 1000 }],
    delivery_channels: ['IN_APP']
  }, request('subscription-failure-create'));
  await service.transitionSubscription(db, created.id, 'ACTIVE', request('subscription-failure-activate'));
  const results = await service.processDueSubscriptions(db, session.organization.id);
  const failed = results.find(item => item.status === 'FAILED');
  assert.ok(failed);
  const run = await db.one('SELECT * FROM subscription_runs WHERE subscription_id = ?', [created.id]);
  assert.equal(run.invoice_id, null);
  const invoiceCount = await db.one(`SELECT COUNT(*) AS count FROM invoices WHERE customer_id = ?`, [customer.id]);
  assert.equal(Number(invoiceCount.count), 1);
  const retry = await service.generateSubscriptionRun(db, session.organization.id, run.id);
  assert.equal(retry.status, 'FAILED');
  const after = await db.one('SELECT * FROM subscription_runs WHERE id = ?', [run.id]);
  assert.equal(Number(after.attempts), 2);
});

test('e-invoice generation requires credentials and authoritative provider evidence', async () => {
  const invoice = await db.one('SELECT * FROM invoices ORDER BY id LIMIT 1');
  const prepared = await service.prepareComplianceDocument(db, 'e-invoices', { invoice_id: invoice.id }, request('einvoice-prepare'));
  assert.equal(prepared.status, 'PREPARED');
  await assert.rejects(
    () => service.generateComplianceDocument(db, prepared.id, request('einvoice-no-config')),
    error => error.status === 503 && error.code === 'integration_not_configured'
  );
  assert.equal((await db.one('SELECT status FROM compliance_documents WHERE id = ?', [prepared.id])).status, 'PREPARED');
  process.env.GST_PROVIDER_URL = 'https://gsp.test';
  process.env.GST_PROVIDER_API_KEY = 'test-key';
  const generated = await service.generateComplianceDocument(db, prepared.id, request('einvoice-generate'), async () => ({
    ok: true, status: 200, json: async () => ({ status: 'success', irn: 'IRN-TEST-001', acknowledgement_number: 'ACK-001', signed_qr: 'SIGNED-QR' })
  }));
  assert.equal(generated.status, 'GENERATED');
  assert.equal(generated.irn, 'IRN-TEST-001');
  const duplicate = await service.generateComplianceDocument(db, prepared.id, request('einvoice-duplicate'));
  assert.equal(duplicate.duplicate, true);
});

test('GST returns require explicit approval and provider-confirmed filing', async () => {
  const period = new Date().toISOString().slice(0, 7);
  const prepared = await service.prepareGstReturn(db, 'gstr-1', period, request('gstr1-prepare'));
  assert.equal(prepared.status, 'PREPARED');
  await assert.rejects(() => service.fileGstReturn(db, prepared.id, request('gstr1-unapproved')), error => error.code === 'gst_return_not_approved');
  await service.requestGstReturnApproval(db, prepared.id, request('gstr1-request-approval'));
  const approved = await service.decideGstReturnApproval(db, prepared.id, 'approve', request('gstr1-approve'));
  assert.equal(approved.status, 'APPROVED');
  delete process.env.GST_PROVIDER_URL;
  delete process.env.GST_PROVIDER_API_KEY;
  await assert.rejects(() => service.fileGstReturn(db, prepared.id, request('gstr1-no-provider')), error => error.code === 'integration_not_configured');
  assert.equal((await db.one('SELECT status FROM gst_return_periods WHERE id = ?', [prepared.id])).status, 'APPROVED');
  process.env.GST_PROVIDER_URL = 'https://gsp.test';
  process.env.GST_PROVIDER_API_KEY = 'test-key';
  const filed = await service.fileGstReturn(db, prepared.id, request('gstr1-file'), async () => ({
    ok: true, status: 200, json: async () => ({ status: 'filed', acknowledgement_number: 'ARN-001' })
  }));
  assert.equal(filed.status, 'FILED');
  assert.equal(filed.provider_reference, 'ARN-001');
});

test('GSTR-2B imports reconcile rows and IMS decisions remain auditable before filing', async () => {
  const period = new Date().toISOString().slice(0, 7);
  const imported = await service.importGstr2bRows(db, period, [{
    gstin: '29BBBBB0000B1Z5', document_number: 'SUP-INV-1', document_date: `${period}-01`, taxable: 100, tax: 18
  }], request('gstr2b-import'));
  assert.equal(imported.rows.length, 1);
  assert.equal(imported.rows[0].match_status, 'MISSING_BOOKS');
  const updated = await service.updateImsAction(db, imported.id, imported.rows[0].id, 'ACCEPT', request('ims-accept'));
  assert.equal(updated.rows[0].ims_action, 'ACCEPT');
});
