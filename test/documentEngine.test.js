import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inventia-document-engine-test-'));
process.env.NODE_ENV = 'test';
process.env.PHASE5_DATA_DIR = path.join(testRoot, 'control');
process.env.DEFAULT_TENANT_DATABASE_URL = `sqlite:${path.join(testRoot, 'tenant.db')}`;
process.env.JWT_SECRET = 'document-engine-test-jwt-secret';
process.env.TENANT_MASTER_KEY = 'document-engine-test-master-key';
process.env.INVOICE_STORAGE_DIR = path.join(testRoot, 'uploads');
delete process.env.CONTROL_DATABASE_URL;
delete process.env.TENANT_DATABASE_ADMIN_URL;
delete process.env.REDIS_URL;

const databaseModule = await import('../src/platform/phase5Database.js');
const authModule = await import('../src/platform/phase5Auth.js');
const trade = await import('../src/services/enterpriseTradeService.js');
const documents = await import('../src/services/documentEngineService.js');
const invoicePayments = await import('../src/services/invoicePaymentService.js');

const { defaultTenant: db } = await databaseModule.initializePhase5Platform({
  hashPassword: authModule.hashPlatformPassword
});
const session = await authModule.loginPlatform({ username: 'admin', password: 'admin123' });
const request = {
  requestId: 'document-engine-test',
  user: {
    id: session.user.id,
    tenant_user_id: session.user.id,
    role: session.user.role,
    permissions: ['*'],
    organization_id: session.organization.id
  },
  headers: {},
  ip: '127.0.0.1',
  tenantDb: db,
  invoicePdfGenerator: async () => { throw new Error('PDF intentionally unavailable in document-engine tests.'); }
};

await db.run(`INSERT INTO warehouses (name, code, type, created_at) VALUES ('Document Main', 'DOC-MAIN', 'warehouse', ?)`, [new Date().toISOString()]);
const customer = await trade.createParty(db, 'customer', { name: 'Document Customer', credit_limit: 10000 }, request);
const supplier = await trade.createParty(db, 'supplier', { name: 'Document Supplier' }, request);
const product = await trade.createProduct(db, {
  sku: 'DOC-001', name: 'Document Product', uom: 'piece', cost_price: 60,
  selling_price: 100, minimum_price: 90, maximum_price: 120, gst_rate: 18
}, request);
await trade.postStockMovement(db, {
  product_id: product.id, warehouse_id: 1, movement_type: 'purchase_receipt', quantity: 20, unit_cost: 60
}, request);

async function approve(document) {
  await trade.transitionTradeDocument(db, document.id, 'pending_approval', {}, request);
  const approval = await db.one(
    'SELECT * FROM approval_requests WHERE entity_type = ? AND entity_id = ? AND status = ?',
    [document.document_type, String(document.id), 'pending']
  );
  return trade.decideApproval(db, approval.id, 'approve', 'Approved for document engine test.', request);
}

test('quotation conversions create auditable links and reject duplicate targets', async () => {
  const quotation = await trade.createTradeDocument(db, 'quotations', {
    party_id: customer.id, warehouse_id: 1,
    lines: [{ product_id: product.id, quantity: 1, unit_price: 100 }]
  }, request);
  await approve(quotation);
  const proForma = await documents.convertDocument(db, quotation.id, { target_type: 'pro_forma_invoice' }, request);
  assert.equal(proForma.document_type, 'pro_forma_invoice');
  assert.equal(Number(proForma.source_document_id), Number(quotation.id));
  const links = await documents.listDocumentLinks(db, { entity_type: 'trade_document', entity_id: quotation.id });
  assert.equal(links.filter(link => link.relationship_type === 'converted_to:pro_forma_invoice').length, 1);
  await assert.rejects(
    () => documents.convertDocument(db, quotation.id, { target_type: 'pro_forma_invoice' }, request),
    error => error.code === 'document_already_converted'
  );
});

test('sales order invoice conversion consumes stock once and closes its reservation atomically', async () => {
  const order = await trade.createTradeDocument(db, 'sales-orders', {
    party_id: customer.id, warehouse_id: 1,
    lines: [{ product_id: product.id, quantity: 2, unit_price: 100 }]
  }, request);
  await approve(order);
  const before = Number((await db.one('SELECT quantity FROM warehouse_stock WHERE product_id = ? AND warehouse_id = 1', [product.id])).quantity);
  const checkout = await documents.convertDocument(db, order.id, { target_type: 'invoice', due_date: '2026-12-31' }, request);
  assert.match(checkout.invoiceNumber, /^INV-\d{4}-\d{6}$/);
  const after = Number((await db.one('SELECT quantity FROM warehouse_stock WHERE product_id = ? AND warehouse_id = 1', [product.id])).quantity);
  assert.equal(before - after, 2);
  assert.equal((await trade.getTradeDocument(db, order.id)).status, 'completed');
  assert.equal((await db.one(`SELECT status FROM stock_reservations WHERE reference_type = 'sales_order' AND reference_id = ?`, [String(order.id)])).status, 'fulfilled');
  await assert.rejects(
    () => documents.convertDocument(db, order.id, { target_type: 'invoice', due_date: '2026-12-31' }, request),
    error => error.code === 'sales_order_not_invoiceable' || error.code === 'document_already_converted'
  );
});

test('credit notes adjust outstanding without mutating invoice values and issued notes are immutable', async () => {
  const invoice = await db.one('SELECT * FROM invoices ORDER BY id DESC LIMIT 1');
  const originalTotal = Number(invoice.grand_total_minor);
  const note = await documents.createFiscalAdjustment(db, 'credit-notes', {
    invoice_id: invoice.id,
    reason: 'Approved commercial return',
    affects_stock: false,
    lines: [{ product_id: product.id, description: product.name, quantity: 2, unit: 'piece', rate: 100, tax_rate: 18 }]
  }, request);
  assert.equal(note.status, 'DRAFT');
  const issued = await documents.transitionFiscalAdjustment(db, note.id, 'issue', {}, request);
  assert.equal(issued.status, 'ISSUED');
  const payment = await invoicePayments.calculateInvoicePaymentState(db, invoice.id);
  assert.equal(payment.credit_adjustments_minor, originalTotal);
  assert.equal(payment.adjusted_total_minor, 0);
  assert.equal(Number((await db.one('SELECT grand_total_minor FROM invoices WHERE id = ?', [invoice.id])).grand_total_minor), originalTotal);
  await assert.rejects(
    () => documents.transitionFiscalAdjustment(db, note.id, 'cancel', { reason: 'Attempted cancellation' }, request),
    error => error.code === 'issued_adjustment_immutable'
  );
});

test('purchase receipts and debit notes keep multiple links and post the supplier return once', async () => {
  const order = await trade.createTradeDocument(db, 'purchase-orders', {
    party_id: supplier.id, warehouse_id: 1,
    lines: [{ product_id: product.id, quantity: 2, unit_price: 60 }]
  }, request);
  await approve(order);
  const receipt = await trade.receivePurchaseOrder(db, order.id, {
    warehouse_id: 1, items: [{ line_id: order.lines[0].id, quantity: 2 }]
  }, request);
  const before = Number((await db.one('SELECT quantity FROM warehouse_stock WHERE product_id = ? AND warehouse_id = 1', [product.id])).quantity);
  const note = await documents.createFiscalAdjustment(db, 'debit-notes', {
    trade_document_id: order.id, warehouse_id: 1, reason: 'Damaged supplier unit', affects_stock: true,
    lines: [{ product_id: product.id, description: product.name, quantity: 1, unit: 'piece', rate: 60, tax_rate: 18 }]
  }, request);
  await documents.transitionFiscalAdjustment(db, note.id, 'issue', {}, request);
  const after = Number((await db.one('SELECT quantity FROM warehouse_stock WHERE product_id = ? AND warehouse_id = 1', [product.id])).quantity);
  assert.equal(before - after, 1);
  const links = await documents.listDocumentLinks(db, { entity_type: 'trade_document', entity_id: order.id });
  assert.ok(links.some(link => link.target_entity_type === 'fiscal_adjustment'));
  const receiptLink = await db.one(`SELECT * FROM document_links WHERE target_entity_type = 'goods_receipt' AND target_entity_id = ?`, [receipt.id]);
  assert.ok(receiptLink);
  assert.equal(Number((await db.one('SELECT COUNT(*) AS count FROM party_ledger_entries WHERE fiscal_adjustment_id = ?', [note.id])).count), 1);
});
