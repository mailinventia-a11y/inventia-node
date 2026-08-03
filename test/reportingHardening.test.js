import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inventia-reporting-test-'));
process.env.NODE_ENV = 'test';
process.env.PHASE5_DATA_DIR = path.join(testRoot, 'control');
process.env.DEFAULT_TENANT_DATABASE_URL = `sqlite:${path.join(testRoot, 'tenant.db')}`;
process.env.JWT_SECRET = 'reporting-test-jwt-secret';
process.env.TENANT_MASTER_KEY = 'reporting-test-master-key';
delete process.env.CONTROL_DATABASE_URL;
delete process.env.TENANT_DATABASE_ADMIN_URL;
delete process.env.REDIS_URL;

const databaseModule = await import('../src/platform/phase5Database.js');
const authModule = await import('../src/platform/phase5Auth.js');
const trade = await import('../src/services/enterpriseTradeService.js');
const reporting = await import('../src/services/reportingService.js');
const ai = await import('../src/services/tenantAiService.js');

const { defaultTenant: db } = await databaseModule.initializePhase5Platform({ hashPassword: authModule.hashPlatformPassword });
const session = await authModule.loginPlatform({ username: 'admin', password: 'admin123' });
const request = key => ({ requestId: key, user: { id: session.user.id, tenant_user_id: session.user.id, organization_id: session.organization.id, role: 'admin', permissions: ['*'] }, headers: { 'idempotency-key': key }, ip: '127.0.0.1' });

await db.run(`INSERT INTO warehouses (name, code, type, created_at) VALUES ('Reports', 'REPORTS', 'warehouse', ?)`, [new Date().toISOString()]);
const product = await trade.createProduct(db, { sku: 'REP-001', name: 'Report Product', cost_price: 50, selling_price: 100, gst_rate: 18 }, request('report-product'));
await trade.postStockMovement(db, { product_id: product.id, warehouse_id: 1, movement_type: 'purchase_receipt', quantity: 4, unit_cost: 50 }, request('report-stock'));

test('unified report centre definitions execute against tenant data and export safely', async () => {
  const definitions = reporting.listReportDefinitions();
  assert.deepEqual(definitions.map(item => item.key), ['sales', 'inventory', 'receivables', 'expenses', 'gst', 'projects', 'online-orders', 'audit']);
  for (const definition of definitions) {
    const result = await reporting.runReport(db, definition.key, { limit: 100 });
    assert.equal(result.report.key, definition.key);
    assert.ok(Array.isArray(result.rows));
  }
  const inventory = await reporting.runReport(db, 'inventory');
  assert.equal(inventory.rows[0].inventory_value_minor, 20000);
  const csv = reporting.reportToCsv(inventory);
  assert.match(csv, /inventory_value_minor/);
  assert.match(csv, /Report Product/);
  await assert.rejects(() => reporting.runReport(db, 'unknown'), error => error.status === 404 && error.code === 'report_not_found');
});

test('AI grounded context includes later milestone operational records without exposing credentials', async () => {
  await db.run(`INSERT INTO online_orders
    (order_number, public_order_id, customer_snapshot, status, currency, subtotal_minor, tax_minor, grand_total_minor, source, payment_verified, idempotency_key, created_at, updated_at)
    VALUES ('WEB-AI-1', 'public-ai-1', ?, 'PENDING_REVIEW', 'INR', 10000, 1800, 11800, 'PUBLIC_CATALOG', 0, 'ai-order', ?, ?)`,
  [JSON.stringify({ name: 'AI Buyer' }), new Date().toISOString(), new Date().toISOString()]);
  const context = await ai.collectTenantBusinessContext(db);
  assert.equal(context.onlineOrders.length, 1);
  assert.ok(Array.isArray(context.projects));
  assert.ok(Array.isArray(context.compliance));
  assert.ok(Array.isArray(context.paymentLinks));
  assert.ok(Array.isArray(context.reminders));
  assert.equal('integration_credentials' in context, false);
});
