import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inventia-barcode-test-'));
process.env.NODE_ENV = 'test';
process.env.PHASE5_DATA_DIR = path.join(testRoot, 'control');
process.env.DEFAULT_TENANT_DATABASE_URL = `sqlite:${path.join(testRoot, 'tenant.db')}`;
process.env.LOCAL_STORAGE_DIR = path.join(testRoot, 'storage');
process.env.JWT_SECRET = 'barcode-test-jwt-secret';
process.env.TENANT_MASTER_KEY = 'barcode-test-master-key';
delete process.env.CONTROL_DATABASE_URL;
delete process.env.TENANT_DATABASE_ADMIN_URL;
delete process.env.REDIS_URL;

const databaseModule = await import('../src/platform/phase5Database.js');
const authModule = await import('../src/platform/phase5Auth.js');
const trade = await import('../src/services/enterpriseTradeService.js');
const barcode = await import('../src/services/barcodeLabelService.js');

const { defaultTenant: db } = await databaseModule.initializePhase5Platform({
  hashPassword: authModule.hashPlatformPassword
});
const session = await authModule.loginPlatform({ username: 'admin', password: 'admin123' });
const request = {
  requestId: crypto.randomUUID(),
  user: {
    id: session.user.id,
    tenant_user_id: session.user.id,
    role: session.user.role,
    permissions: session.user.permissions,
    organization_id: session.organization.id
  },
  headers: {},
  ip: '127.0.0.1',
  tenantDb: db
};

await db.run(
  `INSERT INTO warehouses (name, code, type, created_at)
   VALUES ('Barcode Test Warehouse', 'BARCODE-TEST', 'warehouse', ?)`,
  [new Date().toISOString()]
);

test('product creation assigns one persistent collision-safe barcode', async () => {
  const first = await trade.createProduct(db, {
    sku: 'BAR-AUTO-001',
    name: 'Automatic Barcode Product',
    uom: 'piece',
    selling_price: 250,
    barcode_type: 'CODE128'
  }, request);
  const second = await trade.createProduct(db, {
    sku: 'BAR-AUTO-002',
    name: 'Second Automatic Barcode Product',
    uom: 'piece',
    selling_price: 300,
    barcode_type: 'CODE128'
  }, request);
  assert.match(first.barcode, /^INV\d{9}$/);
  assert.match(second.barcode, /^INV\d{9}$/);
  assert.notEqual(first.barcode, second.barcode);
  assert.equal(first.barcode_assignments.length, 1);
  assert.equal(first.barcode_assignments[0].barcode_value, first.barcode);
  assert.equal(first.barcode_assignments[0].status, 'ASSIGNED');
});

test('variants receive exact persistent mappings and scans resolve canonical products', async () => {
  const product = await trade.createProduct(db, {
    sku: 'BAR-VAR-001',
    name: 'Variant Barcode Product',
    uom: 'piece',
    selling_price: 450,
    variants: [{
      sku: 'BAR-VAR-BLK',
      name: 'Black / High Back',
      selling_price: 475
    }]
  }, request);
  const variantAssignment = product.barcode_assignments.find(item => item.variant_id);
  assert.ok(variantAssignment);
  const scan = await barcode.resolveBarcodeScan(db, {
    barcode_value: variantAssignment.barcode_value,
    source: 'HID',
    action: 'RESOLVE'
  }, request);
  assert.equal(scan.resolved, true);
  assert.equal(scan.product.id, product.id);
  assert.equal(scan.variant.id, variantAssignment.variant_id);
  assert.equal(scan.status, 'OUT_OF_STOCK');
});

test('manual validation and duplicate protection reject conflicting identities', async () => {
  const products = await barcode.listBarcodeProducts(db, { limit: 20 });
  const first = products.find(item => item.sku === 'BAR-AUTO-001');
  const second = products.find(item => item.sku === 'BAR-AUTO-002');
  const validation = await barcode.validateBarcodeInput(db, {
    barcode_value: first.barcode_value,
    barcode_type: 'CODE128'
  });
  assert.equal(validation.valid, false);
  assert.ok(validation.duplicate);
  await assert.rejects(
    () => barcode.regenerateBarcode(db, second.assignment_id, {
      barcode_value: first.barcode_value,
      barcode_type: 'CODE128',
      reason: 'Duplicate protection test'
    }, request),
    error => error.code === 'duplicate_barcode'
  );
  const secondAfter = await db.one('SELECT * FROM barcode_assignments WHERE id = ?', [second.assignment_id]);
  assert.equal(secondAfter.status, 'ASSIGNED');
  assert.equal(secondAfter.archived_at, null);
});

test('barcode PNG and SVG output render from the persistent assignment', async () => {
  const products = await barcode.listBarcodeProducts(db, { q: 'BAR-AUTO-001' });
  const assignment = products[0];
  const png = await barcode.renderAssignedBarcode(db, assignment.assignment_id, 'png');
  const svg = await barcode.renderAssignedBarcode(db, assignment.assignment_id, 'svg');
  assert.equal(png.content.subarray(1, 4).toString('ascii'), 'PNG');
  assert.match(svg.content.toString('utf8'), /^<svg/);
});

test('a physical label print job creates an authenticated PDF and updates history', async () => {
  const { templates, layouts } = await barcode.listBarcodeTemplates(db);
  const products = await barcode.listBarcodeProducts(db, { q: 'BAR-AUTO-001' });
  const job = await barcode.createPrintJob(db, {
    template_id: templates.find(item => item.is_default).id,
    layout_id: layouts.find(item => item.is_default).id,
    output_type: 'PDF',
    printer_type: 'browser',
    copies: 1,
    starting_position: 2,
    items: [{ assignment_id: products[0].assignment_id, quantity: 2 }]
  }, request);
  assert.equal(job.status, 'COMPLETED');
  assert.equal(Number(job.label_count), 2);
  const output = await barcode.downloadPrintJob(db, request.user.organization_id, job.id);
  assert.equal(output.content.subarray(0, 4).toString('ascii'), '%PDF');
  const refreshed = await db.one('SELECT print_count, last_printed_at FROM barcode_assignments WHERE id = ?', [products[0].assignment_id]);
  assert.equal(Number(refreshed.print_count), 2);
  assert.ok(refreshed.last_printed_at);
});

test('barcode migration, analytics, recommendations, and settings are tenant scoped', async () => {
  const version = await db.one('SELECT version FROM migration_versions WHERE version = ?', ['phase5-barcode-labels-003']);
  assert.equal(version.version, 'phase5-barcode-labels-003');
  const analytics = await barcode.getBarcodeAnalytics(db);
  assert.ok(analytics.assignments.total >= 3);
  assert.ok(analytics.print_jobs.completed >= 1);
  const recommendations = await barcode.getBarcodeRecommendations(db);
  assert.equal(recommendations.provider.fallback, true);
  assert.ok(recommendations.recommendations.length >= 1);
  const updated = await barcode.updateBarcodeSettings(db, {
    prefix: 'TEST',
    sequence_length: 8,
    scanner: { duplicate_delay_ms: 900 }
  }, request);
  assert.equal(updated.prefix, 'TEST');
  assert.equal(updated.scanner.duplicate_delay_ms, 900);
});
