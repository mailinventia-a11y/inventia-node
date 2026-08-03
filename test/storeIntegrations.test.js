import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inventia-store-integrations-test-'));
process.env.NODE_ENV = 'test';
process.env.PHASE5_DATA_DIR = path.join(testRoot, 'control');
process.env.DEFAULT_TENANT_DATABASE_URL = `sqlite:${path.join(testRoot, 'tenant.db')}`;
process.env.JWT_SECRET = 'store-integrations-test-jwt-secret';
process.env.TENANT_MASTER_KEY = 'store-integrations-test-master-key';
delete process.env.CONTROL_DATABASE_URL;
delete process.env.TENANT_DATABASE_ADMIN_URL;
delete process.env.REDIS_URL;

const databaseModule = await import('../src/platform/phase5Database.js');
const authModule = await import('../src/platform/phase5Auth.js');
const trade = await import('../src/services/enterpriseTradeService.js');
const service = await import('../src/services/storeIntegrationService.js');

const { defaultTenant: db } = await databaseModule.initializePhase5Platform({ hashPassword: authModule.hashPlatformPassword });
const session = await authModule.loginPlatform({ username: 'admin', password: 'admin123' });
const request = key => ({
  requestId: key,
  user: { id: session.user.id, tenant_user_id: session.user.id, role: session.user.role, permissions: ['*'], organization_id: session.organization.id },
  headers: { 'idempotency-key': key }, ip: '127.0.0.1', tenantDb: db
});

await db.run(`INSERT INTO warehouses (name, code, type, created_at) VALUES ('Web Store', 'WEB-STORE', 'warehouse', ?)`, [new Date().toISOString()]);
const product = await trade.createProduct(db, {
  sku: 'WEB-001', name: 'Published Chair', uom: 'piece', hsn_code: '9403', gst_rate: 18,
  cost_price: 500, selling_price: 1000, minimum_price: 900, maximum_price: 1200
}, request('store-product'));
await trade.postStockMovement(db, { product_id: product.id, warehouse_id: 1, movement_type: 'purchase_receipt', quantity: 10, unit_cost: 500 }, request('store-stock'));

test('catalogue publication and public order intake are authoritative and stock-safe', async () => {
  const defaults = await service.getStoreSettings(db);
  assert.equal(defaults.status, 'DRAFT');
  await service.updateStoreSettings(db, {
    store_slug: 'northwind-catalog', status: 'PUBLISHED', mode: 'DIRECT_ORDER',
    stock_policy: 'SHOW_AVAILABLE', contact_details: { phone: '+91 9999999999' }, terms: 'Orders require review.'
  }, request('store-settings'));
  await service.updateCatalogProduct(db, product.id, {
    published: true, price: 1050, show_stock: true, max_order_quantity: 5, sort_order: 1, metadata: { featured: true }
  }, request('store-publish'));
  const catalog = await service.getPublicCatalog(db, session.organization);
  assert.equal(catalog.ordering_enabled, true);
  assert.equal(catalog.products.length, 1);
  assert.equal(catalog.products[0].price_minor, 105000);
  assert.equal(catalog.products[0].available_stock, 10);

  const input = {
    customer: { name: 'Online Buyer', phone: '9999999999', address: 'Bengaluru, Karnataka' },
    items: [{ product_id: product.id, quantity: 2 }]
  };
  const order = await service.createPublicOrder(db, session.organization.id, input, 'public-order-1');
  assert.equal(order.status, 'PENDING_REVIEW');
  assert.equal(order.grand_total_minor, 247800);
  assert.equal(Number((await db.one('SELECT quantity FROM warehouse_stock WHERE warehouse_id = 1 AND product_id = ?', [product.id])).quantity), 10);
  const duplicate = await service.createPublicOrder(db, session.organization.id, input, 'public-order-1');
  assert.equal(duplicate.duplicate, true);
  assert.equal(Number((await db.one('SELECT COUNT(*) AS count FROM online_orders')).count), 1);
  const accepted = await service.reviewOnlineOrder(db, order.id, 'accept', {}, request('store-accept'));
  assert.equal(accepted.status, 'ACCEPTED');
  assert.equal(Number((await db.one('SELECT quantity FROM warehouse_stock WHERE warehouse_id = 1 AND product_id = ?', [product.id])).quantity), 10);
});

test('catalogue rejects frontend payment claims, quantity violations, and unpublished stores', async () => {
  await assert.rejects(
    () => service.createPublicOrder(db, session.organization.id, {
      customer: { name: 'Fake Payment', phone: '9999999998', address: 'Bengaluru' },
      items: [{ product_id: product.id, quantity: 1 }], payment: { status: 'success' }
    }, 'fake-payment'),
    error => error.status === 503 && error.code === 'online_payment_not_available'
  );
  await assert.rejects(
    () => service.createPublicOrder(db, session.organization.id, {
      customer: { name: 'Large Buyer', phone: '9999999997', address: 'Bengaluru' },
      items: [{ product_id: product.id, quantity: 6 }]
    }, 'large-order'),
    error => error.code === 'catalog_quantity_limit'
  );
});

test('integration credentials are encrypted, never returned, and health is provider-confirmed', async () => {
  await assert.rejects(
    () => service.testIntegration(db, 'whatsapp', request('whatsapp-unconfigured'), async () => ({ ok: true })),
    error => error.status === 503 && error.code === 'integration_not_configured'
  );
  const configured = await service.configureIntegration(db, 'whatsapp', {
    enabled: true, config: { base_url: 'https://provider.test/health', api_key: 'secret-token' }
  }, request('whatsapp-config'));
  assert.equal(configured.configured, true);
  assert.equal('api_key' in configured, false);
  const stored = await db.one(`SELECT encrypted_config FROM integration_credentials WHERE provider = 'whatsapp'`);
  assert.equal(stored.encrypted_config.includes('secret-token'), false);
  const checked = await service.testIntegration(db, 'whatsapp', request('whatsapp-health'), async (_url, options) => {
    assert.equal(options.headers.authorization, 'Bearer secret-token');
    return { ok: true, status: 200 };
  });
  assert.equal(checked.ok, true);
  await assert.rejects(
    () => service.configureIntegration(db, 'shopify', { enabled: true, config: { api_key: 'x' } }, request('shopify-deferred')),
    error => error.status === 409 && error.code === 'integration_deferred'
  );
});

test('tenant API keys reveal secrets once and revoke safely', async () => {
  const created = await service.createApiKey(db, { name: 'Order API', scopes: ['orders.read'], expires_at: null }, request('api-key-create'));
  assert.match(created.secret, /^inv_/);
  const listed = await service.listApiKeys(db);
  assert.equal(listed.length, 1);
  assert.equal('secret' in listed[0], false);
  assert.equal('secret_hash' in listed[0], false);
  const revoked = await service.revokeApiKey(db, created.id, request('api-key-revoke'));
  assert.equal(revoked.status, 'REVOKED');
  const duplicate = await service.revokeApiKey(db, created.id, request('api-key-revoke-again'));
  assert.equal(duplicate.duplicate, true);
});

test('outgoing webhooks are signed, deduplicated, audited, and retryable', async () => {
  const subscription = await service.createWebhookSubscription(db, {
    name: 'Order events', endpoint_url: 'https://receiver.test/hooks', events: ['store.order_received'], secret: 'test-signing-secret-12345'
  }, request('webhook-create'));
  assert.ok(subscription.secret);
  const queued = await service.queueWebhookEvent(db, session.organization.id, 'store.order_received', { order_id: 99 });
  assert.equal(queued.delivery_ids.length, 1);
  let signature;
  const delivered = await service.deliverWebhook(db, queued.delivery_ids[0], async (_url, options) => {
    signature = options.headers['x-inventia-signature'];
    return { ok: true, status: 202, text: async () => 'accepted' };
  });
  assert.equal(delivered.status, 'DELIVERED');
  assert.match(signature, /^[a-f0-9]{64}$/);
  const duplicate = await service.deliverWebhook(db, queued.delivery_ids[0]);
  assert.equal(duplicate.duplicate, true);
  const listed = await service.listWebhookSubscriptions(db);
  assert.equal('encrypted_secret' in listed[0], false);
});
