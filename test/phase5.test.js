import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import crypto from 'node:crypto';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inventia-phase5-test-'));
process.env.NODE_ENV = 'test';
process.env.PHASE5_DATA_DIR = path.join(testRoot, 'control');
process.env.DEFAULT_TENANT_DATABASE_URL = `sqlite:${path.join(testRoot, 'tenant.db')}`;
process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-and-isolated';
process.env.TENANT_MASTER_KEY = 'test-master-key-that-is-long-and-isolated';
delete process.env.CONTROL_DATABASE_URL;
delete process.env.TENANT_DATABASE_ADMIN_URL;
delete process.env.REDIS_URL;
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;

const databaseModule = await import('../src/platform/phase5Database.js');
const authModule = await import('../src/platform/phase5Auth.js');
const trade = await import('../src/services/enterpriseTradeService.js');
const { executeIdempotent } = await import('../src/platform/phase5Http.js');
const razorpay = await import('../src/services/razorpayService.js');

const { defaultTenant: db } = await databaseModule.initializePhase5Platform({
  hashPassword: authModule.hashPlatformPassword
});
const session = await authModule.loginPlatform({ username: 'admin', password: 'admin123' });
const request = {
  requestId: 'phase5-test-request',
  user: {
    id: session.user.id,
    tenant_user_id: session.user.id,
    role: session.user.role,
    organization_id: session.organization.id
  },
  headers: {},
  ip: '127.0.0.1',
  tenantDb: db
};

await db.run(`INSERT INTO warehouses (name, code, type, created_at) VALUES ('Main', 'MAIN', 'warehouse', ?)`, [new Date().toISOString()]);

test('Argon2id authentication issues rotating tenant-scoped sessions', async () => {
  assert.match(session.access_token, /^[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal(session.organization.slug, 'northwind-interiors');
  assert.ok(session.refresh_token.includes('.'));
  const rotated = await authModule.refreshPlatformSession(session.refresh_token);
  assert.notEqual(rotated.refresh_token, session.refresh_token);
  await assert.rejects(() => authModule.refreshPlatformSession(session.refresh_token), error => error.code === 'refresh_token_expired');
});

test('tenant databases are physically isolated', async () => {
  const control = databaseModule.getControlDatabase();
  const organizationId = '00000000-0000-4000-8000-000000000099';
  await control.run(
    `INSERT INTO organizations (id, slug, name, status, created_at, updated_at)
     VALUES (?, 'isolated-test', 'Isolated Test', 'active', ?, ?)`,
    [organizationId, new Date().toISOString(), new Date().toISOString()]
  );
  const isolated = await databaseModule.provisionOrganizationDatabase({ organizationId, slug: 'isolated-test' });
  assert.equal(Number((await isolated.one('SELECT COUNT(*) AS count FROM products')).count), 0);
  assert.notEqual(isolated.identifier, db.identifier);
});

test('stock movements update balances atomically and prevent negative inventory', async () => {
  const product = await trade.createProduct(db, {
    sku: 'P5-TEST-001',
    name: 'Phase 5 Test Product',
    uom: 'piece',
    cost_price: 40,
    selling_price: 80,
    minimum_price: 60,
    gst_rate: 18,
    valuation_method: 'weighted_average'
  }, request);
  const receipt = await trade.postStockMovement(db, {
    product_id: product.id,
    warehouse_id: 1,
    movement_type: 'purchase_receipt',
    quantity: 10,
    unit_cost: 40
  }, request);
  assert.equal(Number(receipt.quantity), 10);
  const balance = await db.one('SELECT quantity FROM warehouse_stock WHERE product_id = ? AND warehouse_id = 1', [product.id]);
  assert.equal(Number(balance.quantity), 10);
  await assert.rejects(
    () => trade.postStockMovement(db, {
      product_id: product.id,
      warehouse_id: 1,
      movement_type: 'sale',
      quantity: 11
    }, request),
    error => error.code === 'insufficient_stock'
  );
});

test('purchase approval and GRN receiving preserve explicit workflow states', async () => {
  const supplier = await trade.createParty(db, 'supplier', {
    name: 'Phase 5 Supplier',
    payment_terms_days: 30,
    lead_time_days: 5
  }, request);
  const product = (await trade.listProducts(db, { q: 'P5-TEST-001', status: 'all' }))[0];
  const order = await trade.createTradeDocument(db, 'purchase-orders', {
    party_id: supplier.id,
    warehouse_id: 1,
    lines: [{ product_id: product.id, quantity: 5, unit_price: 42 }]
  }, request);
  const pending = await trade.transitionTradeDocument(db, order.id, 'pending_approval', {}, request);
  assert.equal(pending.status, 'pending_approval');
  const approval = await db.one(`SELECT * FROM approval_requests WHERE entity_type = 'purchase_order' AND entity_id = ?`, [String(order.id)]);
  const approved = await trade.decideApproval(db, approval.id, 'approve', 'Approved in test', request);
  assert.equal(approved.status, 'approved');
  await assert.rejects(
    () => trade.decideApproval(db, approval.id, 'approve', '', request),
    error => error.code === 'approval_already_decided'
  );
  const receipt = await trade.receivePurchaseOrder(db, order.id, {
    warehouse_id: 1,
    items: [{ line_id: order.lines[0].id, quantity: 5 }]
  }, request);
  assert.match(receipt.receipt_no, /^GRN-/);
  const refreshed = await trade.getTradeDocument(db, order.id);
  assert.equal(refreshed.status, 'fulfilled');

  const cancelledOrder = await trade.createTradeDocument(db, 'purchase-orders', {
    party_id: supplier.id,
    warehouse_id: 1,
    lines: [{ product_id: product.id, quantity: 1, unit_price: 42 }]
  }, request);
  await trade.transitionTradeDocument(db, cancelledOrder.id, 'pending_approval', {}, request);
  await trade.transitionTradeDocument(db, cancelledOrder.id, 'cancelled', { reason: 'No longer required.' }, request);
  const cancelledApproval = await db.one(`SELECT * FROM approval_requests WHERE entity_type = 'purchase_order' AND entity_id = ?`, [String(cancelledOrder.id)]);
  assert.equal(cancelledApproval.status, 'rejected');
  assert.equal(cancelledApproval.decision_notes, 'No longer required.');
});

test('idempotency replays the committed response and rejects key reuse', async () => {
  let executions = 0;
  const req = {
    ...request,
    method: 'POST',
    path: '/test',
    originalUrl: '/api/v1/test',
    body: { value: 1 },
    headers: { 'idempotency-key': 'phase5-idempotency-test' }
  };
  const first = await executeIdempotent(req, async () => {
    executions += 1;
    return { status: 201, body: { saved: true } };
  });
  const second = await executeIdempotent(req, async () => {
    executions += 1;
    return { status: 201, body: { saved: false } };
  });
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(executions, 1);
});

test('Razorpay never simulates success when credentials are missing', async () => {
  await assert.rejects(() => razorpay.loadRazorpayConfig(db), error => {
    assert.equal(error.status, 503);
    assert.equal(error.code, 'integration_not_configured');
    return true;
  });
});

test('official Razorpay order, signature, refund, webhook, and reconciliation flows are auditable', async () => {
  const credentials = { key_id: 'rzp_test_key', key_secret: 'razorpay-test-secret', webhook_secret: 'webhook-test-secret' };
  await db.run(
    `INSERT INTO integration_credentials (provider, encrypted_config, status, updated_by, updated_at)
     VALUES ('razorpay', ?, 'active', ?, ?)`,
    [databaseModule.encryptIntegrationConfig(credentials), request.user.id, new Date().toISOString()]
  );
  const paymentRequest = {
    ...request,
    headers: { 'idempotency-key': 'razorpay-order-test' }
  };
  const mockSdkFactory = () => ({
    orders: {
      create: async input => ({
        id: 'order_phase5_test',
        amount: input.amount,
        amount_due: input.amount,
        currency: input.currency,
        receipt: input.receipt,
        status: 'created'
      })
    },
    payments: {
      refund: async (paymentId, input) => ({
        id: 'rfnd_phase5_test',
        payment_id: paymentId,
        amount: input.amount,
        currency: 'INR',
        status: 'processed'
      })
    }
  });
  const order = await razorpay.createRazorpayOrder(db, { amount: 125.50, currency: 'INR' }, paymentRequest, mockSdkFactory);
  assert.equal(order.order.id, 'order_phase5_test');
  assert.equal(order.order.amount, 12550);

  const paymentId = 'pay_phase5_test';
  const signature = crypto.createHmac('sha256', credentials.key_secret)
    .update(`${order.order.id}|${paymentId}`)
    .digest('hex');
  const verified = await razorpay.verifyRazorpayPayment(db, {
    razorpay_order_id: order.order.id,
    razorpay_payment_id: paymentId,
    razorpay_signature: signature
  }, paymentRequest);
  assert.equal(verified.verified, true);

  const refund = await razorpay.refundRazorpayPayment(db, {
    payment_id: paymentId,
    amount: 25,
    reason: 'Test refund'
  }, { ...paymentRequest, headers: { 'idempotency-key': 'razorpay-refund-test' } }, mockSdkFactory);
  assert.equal(refund.refund.id, 'rfnd_phase5_test');

  const webhookPayload = Buffer.from(JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: paymentId, order_id: order.order.id, status: 'captured' } } }
  }));
  const webhookSignature = crypto.createHmac('sha256', credentials.webhook_secret).update(webhookPayload).digest('hex');
  const processed = await razorpay.processRazorpayWebhook(db, webhookPayload, webhookSignature, 'event_phase5_test', request.user.organization_id);
  assert.equal(processed.status, 'processed');
  const duplicate = await razorpay.processRazorpayWebhook(db, webhookPayload, webhookSignature, 'event_phase5_test', request.user.organization_id);
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(
    () => razorpay.processRazorpayWebhook(db, webhookPayload, 'invalid', 'event_phase5_invalid', request.user.organization_id),
    error => error.code === 'invalid_webhook_signature'
  );

  const reconciliation = await razorpay.paymentReconciliation(db);
  assert.ok(reconciliation.transactions.some(item => item.provider_order_id === order.order.id));
  assert.ok(reconciliation.transactions.some(item => item.provider_refund_id === 'rfnd_phase5_test'));
});

test('permission wildcards are evaluated without role-header trust', () => {
  assert.equal(authModule.hasPermission(['inventory.*'], 'inventory.transfer'), true);
  assert.equal(authModule.hasPermission(['inventory.read'], 'inventory.transfer'), false);
  assert.equal(authModule.hasPermission(['*'], 'payments.refund'), true);
});
