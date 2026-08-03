import crypto from 'crypto';
import { decryptIntegrationConfig, encryptIntegrationConfig } from '../platform/phase5Database.js';
import { httpError, parseJson, writeTenantAudit } from '../platform/phase5Http.js';
import { enqueueDomainJob, publishOrganizationEvent } from '../platform/phase5Runtime.js';
import { toMinor } from './moneyService.js';

const DEFERRED_PROVIDERS = new Set(['shopify', 'shiprocket']);

export async function getStoreSettings(db) {
  const row = await db.one('SELECT * FROM store_settings WHERE id = 1');
  if (!row) throw httpError(500, 'store_settings_missing', 'Store settings have not been initialized.');
  return storeSettingsView(row);
}

export async function updateStoreSettings(db, input, req) {
  const before = await getStoreSettings(db);
  const next = { ...before, ...input, contact_details: input.contact_details || before.contact_details };
  await db.run(
    `UPDATE store_settings SET store_slug = ?, status = ?, mode = ?, stock_policy = ?,
      contact_details = ?, terms = ?, updated_by = ?, updated_at = ? WHERE id = 1`,
    [next.store_slug, next.status, next.mode, next.stock_policy, JSON.stringify(next.contact_details || {}),
      next.terms || '', actor(req), now()]
  );
  const after = await getStoreSettings(db);
  await writeTenantAudit(db, req, { eventType: 'store.settings_updated', entityType: 'store_settings', entityId: 1, before, after });
  await announce(req.user.organization_id, 'store.catalog_changed', { action: 'settings_updated', status: after.status });
  return after;
}

export async function listCatalogManagement(db) {
  const rows = await db.all(
    `SELECT p.id AS product_id, p.sku, p.name, p.selling_price, p.image_url,
            pc.hsn_code, pc.gst_rate, COALESCE(SUM(ws.quantity), 0) AS available_stock,
            scp.id, COALESCE(scp.published, 0) AS published, scp.price_minor,
            COALESCE(scp.show_stock, 0) AS show_stock, scp.max_order_quantity,
            COALESCE(scp.sort_order, 0) AS sort_order, scp.metadata, scp.published_at
       FROM products p
       LEFT JOIN product_commerce pc ON pc.product_id = p.id
       LEFT JOIN warehouse_stock ws ON ws.product_id = p.id
       LEFT JOIN store_catalog_products scp ON scp.product_id = p.id
      WHERE p.status = 1
      GROUP BY p.id, pc.product_id, pc.hsn_code, pc.gst_rate, scp.id, scp.published,
               scp.price_minor, scp.show_stock, scp.max_order_quantity, scp.sort_order,
               scp.metadata, scp.published_at
      ORDER BY COALESCE(scp.sort_order, 0), p.name`
  );
  return rows.map(catalogManagementView);
}

export async function updateCatalogProduct(db, productId, input, req) {
  const product = await db.one('SELECT id, selling_price FROM products WHERE id = ? AND status = 1', [productId]);
  if (!product) throw httpError(404, 'product_not_found', 'The product was not found.');
  const before = await db.one('SELECT * FROM store_catalog_products WHERE product_id = ?', [productId]);
  const priceMinor = input.price == null ? null : toMinor(input.price);
  await db.run(
    `INSERT INTO store_catalog_products
      (product_id, published, price_minor, show_stock, max_order_quantity, sort_order,
       metadata, published_at, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (product_id) DO UPDATE SET published = excluded.published,
       price_minor = excluded.price_minor, show_stock = excluded.show_stock,
       max_order_quantity = excluded.max_order_quantity, sort_order = excluded.sort_order,
       metadata = excluded.metadata, published_at = excluded.published_at,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [productId, input.published ? 1 : 0, priceMinor, input.show_stock ? 1 : 0,
      input.max_order_quantity || null, input.sort_order || 0, JSON.stringify(input.metadata || {}),
      input.published ? (before?.published_at || now()) : null, actor(req), now(), now()]
  );
  const after = await db.one('SELECT * FROM store_catalog_products WHERE product_id = ?', [productId]);
  await writeTenantAudit(db, req, { eventType: input.published ? 'store.catalog_published' : 'store.catalog_updated', entityType: 'store_catalog_product', entityId: productId, before, after });
  await announce(req.user.organization_id, 'store.catalog_changed', { product_id: Number(productId), published: Boolean(input.published) });
  return catalogManagementView({ ...product, ...after, product_id: Number(productId) });
}

export async function getPublicCatalog(db, organization) {
  const settings = await getStoreSettings(db);
  if (settings.status !== 'PUBLISHED') throw httpError(404, 'store_not_published', 'This catalogue is not currently published.');
  const rows = await db.all(
    `SELECT p.id AS product_id, p.sku, p.name, p.description, p.image_url,
            p.selling_price, pc.hsn_code, pc.gst_rate,
            scp.price_minor, scp.show_stock, scp.max_order_quantity, scp.metadata,
            COALESCE(SUM(ws.quantity), 0) AS available_stock
       FROM store_catalog_products scp JOIN products p ON p.id = scp.product_id
       LEFT JOIN product_commerce pc ON pc.product_id = p.id
       LEFT JOIN warehouse_stock ws ON ws.product_id = p.id
      WHERE scp.published = 1 AND p.status = 1
      GROUP BY p.id, pc.product_id, pc.hsn_code, pc.gst_rate, scp.price_minor,
               scp.show_stock, scp.max_order_quantity, scp.metadata, scp.sort_order
      ORDER BY scp.sort_order, p.name`
  );
  const products = rows.filter(row => settings.stock_policy !== 'IN_STOCK_ONLY' || Number(row.available_stock) > 0)
    .map(row => publicCatalogView(row, settings));
  return {
    organization: { id: organization.id, slug: organization.slug, name: organization.name },
    store: settings, products,
    ordering_enabled: settings.mode === 'DIRECT_ORDER'
  };
}

export async function createPublicOrder(db, organizationId, input, idempotencyKey) {
  const settings = await getStoreSettings(db);
  if (settings.status !== 'PUBLISHED') throw httpError(404, 'store_not_published', 'This catalogue is not currently published.');
  if (settings.mode !== 'DIRECT_ORDER') throw httpError(409, 'store_catalog_only', 'This catalogue is not accepting direct orders.');
  if (input.payment) throw httpError(503, 'online_payment_not_available', 'Online payment must be completed through a verified provider capture flow.');
  const existing = await db.one('SELECT id FROM online_orders WHERE idempotency_key = ?', [idempotencyKey]);
  if (existing) return { ...(await getOnlineOrder(db, existing.id)), duplicate: true };
  const result = await db.transaction(async tx => {
    const lines = [];
    for (const requested of input.items) {
      const row = await tx.one(
        `SELECT p.id, p.sku, p.name, p.selling_price, p.image_url, pc.hsn_code,
                COALESCE(pc.gst_rate, 0) AS gst_rate, scp.price_minor,
                scp.max_order_quantity, COALESCE(SUM(ws.quantity), 0) AS available_stock
           FROM store_catalog_products scp JOIN products p ON p.id = scp.product_id
           LEFT JOIN product_commerce pc ON pc.product_id = p.id
           LEFT JOIN warehouse_stock ws ON ws.product_id = p.id
          WHERE scp.product_id = ? AND scp.published = 1 AND p.status = 1
          GROUP BY p.id, pc.product_id, pc.hsn_code, pc.gst_rate, scp.price_minor, scp.max_order_quantity`,
        [requested.product_id]
      );
      if (!row) throw httpError(422, 'catalog_product_unavailable', 'A requested product is not published.');
      const quantity = Number(requested.quantity);
      if (row.max_order_quantity && quantity > Number(row.max_order_quantity)) throw httpError(422, 'catalog_quantity_limit', `${row.name} exceeds its maximum order quantity.`);
      if (settings.stock_policy === 'IN_STOCK_ONLY' && quantity > Number(row.available_stock)) throw httpError(409, 'catalog_stock_unavailable', `${row.name} does not have enough available stock.`);
      const unitPriceMinor = row.price_minor == null ? toMinor(row.selling_price) : Number(row.price_minor);
      const taxableMinor = Math.round(unitPriceMinor * quantity);
      const taxMinor = Math.round(taxableMinor * Number(row.gst_rate || 0) / 100);
      lines.push({ row, quantity, unitPriceMinor, taxableMinor, taxMinor, lineTotalMinor: taxableMinor + taxMinor });
    }
    const subtotalMinor = lines.reduce((sum, line) => sum + line.taxableMinor, 0);
    const taxMinor = lines.reduce((sum, line) => sum + line.taxMinor, 0);
    const orderNumber = await nextOrderNumber(tx);
    const publicOrderId = crypto.randomUUID();
    const inserted = await insertWithId(tx,
      `INSERT INTO online_orders
        (order_number, public_order_id, customer_snapshot, status, currency,
         subtotal_minor, tax_minor, grand_total_minor, source, payment_verified,
         idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, 'PENDING_REVIEW', 'INR', ?, ?, ?, 'PUBLIC_CATALOG', 0, ?, ?, ?)`,
      [orderNumber, publicOrderId, JSON.stringify(input.customer), subtotalMinor, taxMinor,
        subtotalMinor + taxMinor, idempotencyKey, now(), now()]
    );
    const orderId = insertedId(inserted);
    for (const line of lines) {
      await tx.run(
        `INSERT INTO online_order_items
          (online_order_id, product_id, quantity, unit_price_minor, tax_rate,
           taxable_minor, tax_minor, line_total_minor, product_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderId, line.row.id, line.quantity, line.unitPriceMinor, Number(line.row.gst_rate || 0),
          line.taxableMinor, line.taxMinor, line.lineTotalMinor,
          JSON.stringify({ sku: line.row.sku, name: line.row.name, hsn_code: line.row.hsn_code, image_url: line.row.image_url })]
      );
    }
    return orderId;
  });
  const order = await getOnlineOrder(db, result);
  await queueWebhookEvent(db, organizationId, 'store.order_received', { order_id: order.id, order_number: order.order_number, status: order.status });
  await announce(organizationId, 'store.order_received', { order_id: order.id, order_number: order.order_number });
  return order;
}

export async function listOnlineOrders(db, query = {}) {
  const params = [];
  const where = [];
  if (query.status) { where.push('status = ?'); params.push(String(query.status).toUpperCase()); }
  const rows = await db.all(`SELECT * FROM online_orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC`, params);
  return rows.map(onlineOrderView);
}

export async function getOnlineOrder(db, id) {
  const order = await db.one('SELECT * FROM online_orders WHERE id = ?', [id]);
  if (!order) throw httpError(404, 'online_order_not_found', 'The online order was not found.');
  const items = await db.all('SELECT * FROM online_order_items WHERE online_order_id = ? ORDER BY id', [id]);
  return { ...onlineOrderView(order), items: items.map(item => ({ ...item, product_snapshot: parseJson(item.product_snapshot, {}) })) };
}

export async function reviewOnlineOrder(db, id, decision, input, req) {
  const before = await getOnlineOrder(db, id);
  if (before.status !== 'PENDING_REVIEW') throw httpError(409, 'online_order_already_reviewed', 'This order has already been reviewed.');
  const target = decision === 'accept' ? 'ACCEPTED' : 'REJECTED';
  await db.run(
    `UPDATE online_orders SET status = ?, rejection_reason = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`,
    [target, target === 'REJECTED' ? input.reason : null, actor(req), now(), now(), id]
  );
  const after = await getOnlineOrder(db, id);
  await writeTenantAudit(db, req, { eventType: `store.order_${decision}ed`, entityType: 'online_order', entityId: id, before, after });
  await queueWebhookEvent(db, req.user.organization_id, `store.order_${decision}ed`, { order_id: after.id, order_number: after.order_number, status: after.status });
  await announce(req.user.organization_id, 'store.order_changed', { order_id: Number(id), status: target });
  return after;
}

export async function listIntegrations(db) {
  const rows = await db.all(
    `SELECT ip.*, CASE WHEN ic.provider IS NULL THEN 0 ELSE 1 END AS configured
       FROM integration_providers ip LEFT JOIN integration_credentials ic ON ic.provider = ip.provider
      ORDER BY ip.category, ip.display_name`
  );
  return rows.map(integrationView);
}

export async function getIntegration(db, provider) {
  const row = await db.one(
    `SELECT ip.*, CASE WHEN ic.provider IS NULL THEN 0 ELSE 1 END AS configured
       FROM integration_providers ip LEFT JOIN integration_credentials ic ON ic.provider = ip.provider
      WHERE ip.provider = ?`, [provider]
  );
  if (!row) throw httpError(404, 'integration_not_found', 'The integration was not found.');
  return integrationView(row);
}

export async function configureIntegration(db, provider, input, req) {
  const current = await getIntegration(db, provider);
  if (DEFERRED_PROVIDERS.has(provider)) throw httpError(409, 'integration_deferred', `${current.display_name} is deferred until the core integration framework is stabilized.`);
  if (!input.config || !Object.keys(input.config).length) throw httpError(422, 'integration_config_required', 'Provider configuration is required.');
  await db.transaction(async tx => {
    await tx.run(
      `INSERT INTO integration_credentials (provider, encrypted_config, status, updated_by, updated_at)
       VALUES (?, ?, 'active', ?, ?)
       ON CONFLICT (provider) DO UPDATE SET encrypted_config = excluded.encrypted_config,
         status = 'active', updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [provider, encryptIntegrationConfig(input.config), actor(req), now()]
    );
    await tx.run(
      `UPDATE integration_providers SET enabled = ?, status = ?, last_error = NULL,
        updated_by = ?, updated_at = ? WHERE provider = ?`,
      [input.enabled === false ? 0 : 1, input.enabled === false ? 'DISABLED' : 'READY', actor(req), now(), provider]
    );
  });
  const after = await getIntegration(db, provider);
  await writeTenantAudit(db, req, { eventType: 'integration.configured', entityType: 'integration', entityId: provider, before: current, after, metadata: { secret_fields_redacted: true } });
  return after;
}

export async function disableIntegration(db, provider, req) {
  const before = await getIntegration(db, provider);
  await db.run(`UPDATE integration_providers SET enabled = 0, status = 'DISABLED', updated_by = ?, updated_at = ? WHERE provider = ?`, [actor(req), now(), provider]);
  const after = await getIntegration(db, provider);
  await writeTenantAudit(db, req, { eventType: 'integration.disabled', entityType: 'integration', entityId: provider, before, after });
  return after;
}

export async function testIntegration(db, provider, req, fetchImpl = globalThis.fetch) {
  const integration = await getIntegration(db, provider);
  if (DEFERRED_PROVIDERS.has(provider)) throw httpError(409, 'integration_deferred', `${integration.display_name} is not enabled in this milestone.`);
  const config = await integrationConfig(db, provider);
  const url = config.health_url || config.base_url;
  if (!url) throw httpError(422, 'integration_health_url_required', 'A provider health URL is required.');
  let result;
  try {
    const response = await fetchImpl(url, { headers: providerHeaders(config), signal: AbortSignal.timeout(Number(config.timeout_ms || 10000)) });
    if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}.`);
    result = { ok: true, status: response.status };
    await db.run(`UPDATE integration_providers SET status = 'READY', last_health_status = 'healthy', last_health_at = ?, last_error = NULL, updated_at = ? WHERE provider = ?`, [now(), now(), provider]);
  } catch (error) {
    await db.run(`UPDATE integration_providers SET status = 'ERROR', last_health_status = 'failed', last_health_at = ?, last_error = ?, updated_at = ? WHERE provider = ?`, [now(), String(error.message).slice(0, 1000), now(), provider]);
    throw httpError(502, 'integration_health_failed', 'The configured provider health check failed.');
  }
  await writeTenantAudit(db, req, { eventType: 'integration.health_checked', entityType: 'integration', entityId: provider, after: result });
  return { provider, ...result };
}

export async function syncIntegration(db, provider, input, req, fetchImpl = globalThis.fetch) {
  const integration = await getIntegration(db, provider);
  if (provider !== 'tally') throw httpError(409, 'integration_sync_not_supported', `${integration.display_name} sync is not available in this milestone.`);
  const config = await integrationConfig(db, provider);
  if (!integration.enabled) throw httpError(409, 'integration_disabled', 'The integration is disabled.');
  const exportData = await tallyExport(db, input.from, input.to);
  const inserted = await insertWithId(db,
    `INSERT INTO integration_sync_runs
      (provider, sync_type, status, checkpoint, sanitized_request, records_processed,
       idempotency_key, requested_by, started_at)
     VALUES ('tally', 'ACCOUNTING_EXPORT', 'RUNNING', ?, ?, 0, ?, ?, ?)`,
    [JSON.stringify({ from: input.from || null, to: input.to || null }), JSON.stringify({ counts: exportData.counts }),
      String(req.headers['idempotency-key']), actor(req), now()]
  );
  const runId = insertedId(inserted);
  try {
    const response = await fetchImpl(config.sync_url || config.base_url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...providerHeaders(config) },
      body: JSON.stringify(exportData), signal: AbortSignal.timeout(Number(config.timeout_ms || 20000))
    });
    if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}.`);
    const responseText = (await response.text()).slice(0, 4000);
    await db.run(
      `UPDATE integration_sync_runs SET status = 'COMPLETED', sanitized_response = ?,
        records_processed = ?, completed_at = ? WHERE id = ?`,
      [JSON.stringify({ status: response.status, body: responseText }), exportData.counts.total, now(), runId]
    );
    await announce(req.user.organization_id, 'integration.sync_completed', { provider, run_id: runId, records_processed: exportData.counts.total });
  } catch (error) {
    await db.run(`UPDATE integration_sync_runs SET status = 'FAILED', error_code = 'provider_sync_failed', error_message = ?, completed_at = ? WHERE id = ?`, [String(error.message).slice(0, 1000), now(), runId]);
    throw httpError(502, 'integration_sync_failed', 'Tally sync failed; no successful sync was recorded.');
  }
  return db.one('SELECT * FROM integration_sync_runs WHERE id = ?', [runId]);
}

export async function listIntegrationRuns(db, provider) {
  return db.all('SELECT * FROM integration_sync_runs WHERE provider = ? ORDER BY started_at DESC, id DESC LIMIT 200', [provider]);
}

export async function listApiKeys(db) {
  return db.all(`SELECT id, name, key_prefix, scopes, status, expires_at, last_used_at, created_by, created_at, revoked_at FROM tenant_api_keys ORDER BY created_at DESC`)
    .then(rows => rows.map(row => ({ ...row, scopes: parseJson(row.scopes, []) })));
}

export async function createApiKey(db, input, req) {
  const secret = `inv_${crypto.randomBytes(32).toString('base64url')}`;
  const prefix = secret.slice(0, 12);
  const inserted = await insertWithId(db,
    `INSERT INTO tenant_api_keys (name, key_prefix, secret_hash, scopes, status, expires_at, created_by, created_at)
     VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
    [input.name, prefix, sha256(secret), JSON.stringify(input.scopes), input.expires_at || null, actor(req), now()]
  );
  const id = insertedId(inserted);
  await writeTenantAudit(db, req, { eventType: 'integration.api_key_created', entityType: 'tenant_api_key', entityId: id, after: { name: input.name, key_prefix: prefix, scopes: input.scopes } });
  return { id, name: input.name, key_prefix: prefix, secret, scopes: input.scopes, expires_at: input.expires_at || null, warning: 'Copy this secret now. It will not be shown again.' };
}

export async function revokeApiKey(db, id, req) {
  const before = await db.one('SELECT * FROM tenant_api_keys WHERE id = ?', [id]);
  if (!before) throw httpError(404, 'api_key_not_found', 'The API key was not found.');
  if (before.status === 'REVOKED') return { id: Number(id), status: 'REVOKED', duplicate: true };
  await db.run(`UPDATE tenant_api_keys SET status = 'REVOKED', revoked_at = ? WHERE id = ?`, [now(), id]);
  await writeTenantAudit(db, req, { eventType: 'integration.api_key_revoked', entityType: 'tenant_api_key', entityId: id, before, after: { ...before, status: 'REVOKED' } });
  return { id: Number(id), status: 'REVOKED' };
}

export async function listWebhookSubscriptions(db) {
  return db.all(`SELECT id, name, endpoint_url, events, status, created_by, created_at, updated_at FROM webhook_subscriptions ORDER BY created_at DESC`)
    .then(rows => rows.map(row => ({ ...row, events: parseJson(row.events, []) })));
}

export async function createWebhookSubscription(db, input, req) {
  const secret = input.secret || crypto.randomBytes(32).toString('base64url');
  const inserted = await insertWithId(db,
    `INSERT INTO webhook_subscriptions
      (name, endpoint_url, encrypted_secret, events, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
    [input.name, input.endpoint_url, encryptIntegrationConfig({ secret }), JSON.stringify(input.events), actor(req), now(), now()]
  );
  const id = insertedId(inserted);
  await writeTenantAudit(db, req, { eventType: 'integration.webhook_created', entityType: 'webhook_subscription', entityId: id, after: { name: input.name, endpoint_url: input.endpoint_url, events: input.events } });
  return { id, name: input.name, endpoint_url: input.endpoint_url, events: input.events, status: 'ACTIVE', secret, warning: 'Copy this signing secret now. It will not be shown again.' };
}

export async function updateWebhookSubscription(db, id, input, req) {
  const before = await db.one('SELECT * FROM webhook_subscriptions WHERE id = ?', [id]);
  if (!before) throw httpError(404, 'webhook_subscription_not_found', 'The webhook subscription was not found.');
  await db.run(`UPDATE webhook_subscriptions SET name = ?, endpoint_url = ?, events = ?, status = ?, updated_at = ? WHERE id = ?`,
    [input.name, input.endpoint_url, JSON.stringify(input.events), input.status, now(), id]);
  const after = (await listWebhookSubscriptions(db)).find(row => Number(row.id) === Number(id));
  await writeTenantAudit(db, req, { eventType: 'integration.webhook_updated', entityType: 'webhook_subscription', entityId: id, before: webhookSafe(before), after });
  return after;
}

export async function listWebhookDeliveries(db, query = {}) {
  const params = [];
  let filter = '';
  if (query.status) { filter = 'WHERE wd.status = ?'; params.push(String(query.status).toUpperCase()); }
  return db.all(
    `SELECT wd.*, ws.name AS subscription_name, ws.endpoint_url
       FROM webhook_deliveries wd JOIN webhook_subscriptions ws ON ws.id = wd.subscription_id
       ${filter} ORDER BY wd.created_at DESC, wd.id DESC LIMIT 500`, params
  ).then(rows => rows.map(row => ({ ...row, sanitized_payload: parseJson(row.sanitized_payload, {}) })));
}

export async function queueWebhookEvent(db, organizationId, eventType, payload) {
  const subscriptions = await db.all(`SELECT * FROM webhook_subscriptions WHERE status = 'ACTIVE'`);
  const eventId = crypto.randomUUID();
  const queued = [];
  for (const subscription of subscriptions) {
    const events = parseJson(subscription.events, []);
    if (!events.includes('*') && !events.includes(eventType)) continue;
    const inserted = await insertWithId(db,
      `INSERT INTO webhook_deliveries
        (subscription_id, event_id, event_type, status, attempt_count, sanitized_payload, created_at)
       VALUES (?, ?, ?, 'PENDING', 0, ?, ?) ON CONFLICT (subscription_id, event_id) DO NOTHING`,
      [subscription.id, eventId, eventType, JSON.stringify(payload), now()]
    );
    const id = insertedId(inserted);
    if (id) {
      queued.push(id);
      await enqueueDomainJob('integration.webhook.deliver', { organization_id: organizationId, delivery_id: id }, { jobId: `webhook:${organizationId}:${id}` });
    }
  }
  return { event_id: eventId, delivery_ids: queued };
}

export async function deliverWebhook(db, id, fetchImpl = globalThis.fetch) {
  const delivery = await db.one(
    `SELECT wd.*, ws.endpoint_url, ws.encrypted_secret, ws.status AS subscription_status
       FROM webhook_deliveries wd JOIN webhook_subscriptions ws ON ws.id = wd.subscription_id WHERE wd.id = ?`, [id]
  );
  if (!delivery) throw httpError(404, 'webhook_delivery_not_found', 'The webhook delivery was not found.');
  if (delivery.status === 'DELIVERED') return { id: Number(id), status: 'DELIVERED', duplicate: true };
  if (delivery.subscription_status !== 'ACTIVE') throw httpError(409, 'webhook_subscription_inactive', 'The webhook subscription is not active.');
  const payload = { id: delivery.event_id, type: delivery.event_type, created_at: delivery.created_at, data: parseJson(delivery.sanitized_payload, {}) };
  const body = JSON.stringify(payload);
  const { secret } = decryptIntegrationConfig(delivery.encrypted_secret);
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
  try {
    const response = await fetchImpl(delivery.endpoint_url, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-inventia-event': delivery.event_type, 'x-inventia-signature': signature },
      body, signal: AbortSignal.timeout(10000)
    });
    const responseText = (await response.text()).slice(0, 2000);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${responseText}`);
    await db.run(`UPDATE webhook_deliveries SET status = 'DELIVERED', attempt_count = attempt_count + 1, response_status = ?, sanitized_response = ?, delivered_at = ? WHERE id = ?`, [response.status, responseText, now(), id]);
  } catch (error) {
    await db.run(`UPDATE webhook_deliveries SET status = 'FAILED', attempt_count = attempt_count + 1, error_message = ?, next_attempt_at = ? WHERE id = ?`, [String(error.message).slice(0, 1000), new Date(Date.now() + 60000).toISOString(), id]);
    throw httpError(502, 'webhook_delivery_failed', 'Webhook delivery failed and remains retryable.');
  }
  return db.one('SELECT * FROM webhook_deliveries WHERE id = ?', [id]);
}

async function integrationConfig(db, provider) {
  const row = await db.one(`SELECT encrypted_config FROM integration_credentials WHERE provider = ? AND status = 'active'`, [provider]);
  if (!row) throw httpError(503, 'integration_not_configured', `${provider} integration is not configured.`);
  return decryptIntegrationConfig(row.encrypted_config);
}

async function tallyExport(db, from, to) {
  const conditions = [];
  const params = [];
  if (from) { conditions.push('issued_at >= ?'); params.push(`${from}T00:00:00.000Z`); }
  if (to) { conditions.push('issued_at <= ?'); params.push(`${to}T23:59:59.999Z`); }
  const invoices = await db.all(`SELECT invoice_number, issued_at, currency, grand_total_minor, payment_status FROM invoices ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY issued_at`, params);
  const journals = await db.all(`SELECT journal_number, journal_type, journal_date, description, total_debit_minor, total_credit_minor FROM journals WHERE status = 'POSTED' ORDER BY journal_date`);
  return { version: 1, generated_at: now(), invoices, journals, counts: { invoices: invoices.length, journals: journals.length, total: invoices.length + journals.length } };
}

async function nextOrderNumber(tx) {
  const lock = tx.dialect === 'postgres' ? ' FOR UPDATE' : '';
  const row = await tx.one(`SELECT * FROM number_sequences WHERE sequence_key = 'online_order'${lock}`);
  const value = Number(row?.next_value || 1);
  if (row) await tx.run(`UPDATE number_sequences SET next_value = next_value + 1, updated_at = ? WHERE sequence_key = 'online_order'`, [now()]);
  else await tx.run(`INSERT INTO number_sequences (sequence_key, prefix, next_value, padding, updated_at) VALUES ('online_order', 'WEB', 2, 6, ?)`, [now()]);
  return `${row?.prefix || 'WEB'}-${String(value).padStart(Number(row?.padding || 6), '0')}`;
}

function storeSettingsView(row) {
  return { ...row, contact_details: parseJson(row.contact_details, {}) };
}
function catalogManagementView(row) {
  return { ...row, product_id: Number(row.product_id), published: Boolean(Number(row.published)), show_stock: Boolean(Number(row.show_stock)), metadata: parseJson(row.metadata, {}) };
}
function publicCatalogView(row, settings) {
  const showStock = Boolean(Number(row.show_stock)) || settings.stock_policy === 'SHOW_AVAILABLE';
  return { id: Number(row.product_id), sku: row.sku, name: row.name, description: row.description, image_url: row.image_url,
    price_minor: row.price_minor == null ? toMinor(row.selling_price) : Number(row.price_minor), currency: 'INR',
    hsn_code: row.hsn_code, gst_rate: Number(row.gst_rate || 0), in_stock: Number(row.available_stock) > 0,
    available_stock: showStock ? Number(row.available_stock) : undefined, max_order_quantity: row.max_order_quantity == null ? null : Number(row.max_order_quantity), metadata: parseJson(row.metadata, {}) };
}
function onlineOrderView(row) { return { ...row, customer_snapshot: parseJson(row.customer_snapshot, {}), payment_verified: Boolean(Number(row.payment_verified)) }; }
function integrationView(row) { return { ...row, enabled: Boolean(Number(row.enabled)), configured: Boolean(Number(row.configured)), capabilities: parseJson(row.capabilities, []) }; }
function webhookSafe(row) { const { encrypted_secret, ...safe } = row; return { ...safe, events: parseJson(safe.events, []) }; }
function providerHeaders(config) { return config.api_key ? { authorization: `Bearer ${config.api_key}` } : {}; }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function actor(req) { return req.user.tenant_user_id || req.user.id; }
function now() { return new Date().toISOString(); }
function insertedId(result) { return result?.id || result?.lastID || result?.rows?.[0]?.id; }
function insertWithId(db, sql, params) { return db.run(`${sql}${db.dialect === 'postgres' && !/ON CONFLICT/i.test(sql) ? ' RETURNING id' : ''}`, params); }
async function announce(organizationId, event, payload) { if (organizationId) await publishOrganizationEvent(organizationId, event, payload); }
