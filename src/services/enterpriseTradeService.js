import crypto from 'crypto';
import { cacheGet, cacheSet, invalidateOrganizationCache, publishOrganizationEvent } from '../platform/phase5Runtime.js';
import { httpError, parseJson, writeTenantAudit } from '../platform/phase5Http.js';
import { calculateInvoiceAmounts, fromMinor } from './moneyService.js';
import {
  attemptInvoicePdf,
  calculateInvoicePaymentState,
  createCheckoutPaymentsTx,
  recordInvoiceLedgerTx,
  resolveInvoiceSnapshots
} from './invoicePaymentService.js';
import { ensureProductBarcodesTx } from './barcodeLabelService.js';
import { postInvoiceAccountingTx, postPaymentAccountingTx } from './financeOperationsService.js';

const DOCUMENT_TYPES = new Set([
  'quotations', 'sales-orders', 'purchase-orders', 'deliveries',
  'packing-lists', 'pro-forma-invoices', 'invoices', 'sales-returns', 'purchase-returns'
]);
const DOCUMENT_TYPE_MAP = {
  quotations: 'quotation',
  'sales-orders': 'sales_order',
  'purchase-orders': 'purchase_order',
  deliveries: 'delivery_challan',
  'packing-lists': 'packing_list',
  'pro-forma-invoices': 'pro_forma_invoice',
  invoices: 'invoice',
  'sales-returns': 'sales_return',
  'purchase-returns': 'purchase_return'
};
const TRANSITIONS = {
  draft: new Set(['pending_approval', 'cancelled']),
  pending_approval: new Set(['approved', 'cancelled']),
  approved: new Set(['partially_fulfilled', 'fulfilled', 'completed', 'cancelled']),
  partially_fulfilled: new Set(['fulfilled', 'cancelled']),
  fulfilled: new Set(['completed']),
  completed: new Set(),
  cancelled: new Set()
};

export async function listProducts(db, query = {}) {
  const params = [];
  const conditions = [];
  if (query.status !== 'all') conditions.push('p.status = 1');
  if (query.q) {
    conditions.push('(lower(p.name) LIKE ? OR lower(p.sku) LIKE ? OR lower(COALESCE(p.barcode, \'\')) LIKE ?)');
    const search = `%${String(query.q).toLowerCase()}%`;
    params.push(search, search, search);
  }
  const limit = Math.min(Math.max(Number(query.limit || 100), 1), 500);
  const offset = Math.max(Number(query.offset || 0), 0);
  params.push(limit, offset);
  const rows = await db.all(
    `SELECT p.*, b.name AS brand_name, c.name AS category_name,
            pc.hsn_code, pc.gst_rate, pc.minimum_price, pc.maximum_price,
            pc.valuation_method, pc.track_batches, pc.track_serials,
            COALESCE(SUM(ws.quantity), 0) AS quantity_on_hand
       FROM products p
       LEFT JOIN brands b ON b.id = p.brand_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN product_commerce pc ON pc.product_id = p.id
       LEFT JOIN warehouse_stock ws ON ws.product_id = p.id
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      GROUP BY p.id, b.name, c.name, pc.product_id, pc.hsn_code, pc.gst_rate,
               pc.minimum_price, pc.maximum_price, pc.valuation_method,
               pc.track_batches, pc.track_serials
      ORDER BY p.name LIMIT ? OFFSET ?`,
    params
  );
  return rows.map(normalizeJsonFields);
}

export async function getProduct(db, id) {
  const product = await db.one(
    `SELECT p.*, pc.hsn_code, pc.gst_rate, pc.minimum_price, pc.maximum_price,
            pc.valuation_method, pc.track_batches, pc.track_serials, pc.metadata
       FROM products p LEFT JOIN product_commerce pc ON pc.product_id = p.id
      WHERE p.id = ?`,
    [id]
  );
  if (!product) throw httpError(404, 'product_not_found', 'Product was not found.');
  const [variants, suppliers, media, balances, barcodeAssignments, attachments] = await Promise.all([
    db.all('SELECT * FROM product_variants WHERE product_id = ? ORDER BY id', [id]),
    db.all(
      `SELECT sp.*, s.name AS supplier_name FROM supplier_products sp
       JOIN suppliers s ON s.id = sp.supplier_id WHERE sp.product_id = ? ORDER BY sp.preferred DESC, s.name`,
      [id]
    ),
    db.all('SELECT * FROM product_media WHERE product_id = ? ORDER BY display_order, id', [id]),
    db.all(
      `SELECT ws.*, w.name AS warehouse_name, w.code AS warehouse_code
       FROM warehouse_stock ws JOIN warehouses w ON w.id = ws.warehouse_id
       WHERE ws.product_id = ? ORDER BY w.name`,
      [id]
    ),
    db.all(
      `SELECT * FROM barcode_assignments
        WHERE product_id = ? AND archived_at IS NULL ORDER BY variant_id, is_primary DESC, id`,
      [id]
    ),
    db.all('SELECT * FROM attachments WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC', ['product', String(id)])
  ]);
  return {
    ...normalizeJsonFields(product),
    variants: variants.map(normalizeJsonFields),
    suppliers,
    media: media.map(normalizeJsonFields),
    balances,
    barcode_assignments: barcodeAssignments,
    attachments
  };
}

export async function createProduct(db, input, req) {
  const result = await db.transaction(async tx => {
    const duplicate = await tx.one('SELECT id FROM products WHERE sku = ? OR (? IS NOT NULL AND barcode = ?)', [
      input.sku, input.barcode || null, input.barcode || null
    ]);
    if (duplicate) throw httpError(409, 'duplicate_product_identifier', 'SKU or barcode already exists.');
    const timestamp = now();
    const inserted = await insertWithId(tx,
      `INSERT INTO products
        (sku, barcode, name, brand_id, category_id, description, uom, coverage_per_box,
         cost_price, selling_price, material, finish, dimensions, shade_lot_number,
         min_stock_alert, image_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        input.sku, input.barcode || null, input.name, input.brand_id || null, input.category_id || null,
        input.description || null, input.uom || 'piece', input.coverage_per_box || null,
        input.cost_price || 0, input.selling_price || 0, input.material || null, input.finish || null,
        input.dimensions || null, input.shade_lot_number || null, input.min_stock_alert ?? 5,
        input.image_url || null, timestamp, timestamp
      ]
    );
    const id = inserted.id || inserted.rows?.[0]?.id;
    await tx.run(
      `INSERT INTO product_commerce
        (product_id, hsn_code, gst_rate, minimum_price, maximum_price, valuation_method,
         track_batches, track_serials, metadata, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, input.hsn_code || null, input.gst_rate || 0, input.minimum_price || 0,
        input.maximum_price || null, input.valuation_method || 'weighted_average',
        input.track_batches ? 1 : 0, input.track_serials ? 1 : 0,
        JSON.stringify(input.metadata || {}), timestamp
      ]
    );
    for (const variant of input.variants || []) {
      await tx.run(
        `INSERT INTO product_variants
          (product_id, sku, barcode, name, attributes, cost_price, selling_price, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [id, variant.sku, variant.barcode || null, variant.name, JSON.stringify(variant.attributes || {}),
          variant.cost_price || 0, variant.selling_price || 0, timestamp, timestamp]
      );
    }
    await ensureProductBarcodesTx(tx, id, input.variants || [], req.user.id, {
      barcode_type: input.barcode_type
    });
    return id;
  });
  const product = await getProduct(db, result);
  await writeTenantAudit(db, req, { eventType: 'product.created', entityType: 'product', entityId: result, after: product });
  await announce(req, 'products.changed', { action: 'created', product_id: result });
  return product;
}

export async function updateProduct(db, id, input, req) {
  const before = await getProduct(db, id);
  if (before.barcode && input.barcode !== undefined && input.barcode !== before.barcode) {
    throw httpError(
      409,
      'barcode_regeneration_required',
      'Use the Barcode & Label Center regeneration action to change a persistent barcode.'
    );
  }
  const barcode = before.barcode || input.barcode || null;
  await db.transaction(async tx => {
    const duplicate = await tx.one(
      'SELECT id FROM products WHERE id <> ? AND (sku = ? OR (? IS NOT NULL AND barcode = ?))',
      [id, input.sku, barcode, barcode]
    );
    if (duplicate) throw httpError(409, 'duplicate_product_identifier', 'SKU or barcode already exists.');
    const result = await tx.run(
      `UPDATE products SET sku = ?, barcode = ?, name = ?, brand_id = ?, category_id = ?,
        description = ?, uom = ?, coverage_per_box = ?, cost_price = ?, selling_price = ?,
        material = ?, finish = ?, dimensions = ?, shade_lot_number = ?, min_stock_alert = ?,
        image_url = ?, status = ?, updated_at = ? WHERE id = ?`,
      [
        input.sku, barcode, input.name, input.brand_id || null, input.category_id || null,
        input.description || null, input.uom || 'piece', input.coverage_per_box || null,
        input.cost_price || 0, input.selling_price || 0, input.material || null, input.finish || null,
        input.dimensions || null, input.shade_lot_number || null, input.min_stock_alert ?? 5,
        input.image_url || null, input.status === false ? 0 : 1, now(), id
      ]
    );
    if (!result.changes) throw httpError(404, 'product_not_found', 'Product was not found.');
    await tx.run(
      `INSERT INTO product_commerce
        (product_id, hsn_code, gst_rate, minimum_price, maximum_price, valuation_method,
         track_batches, track_serials, metadata, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (product_id) DO UPDATE SET
         hsn_code = excluded.hsn_code, gst_rate = excluded.gst_rate,
         minimum_price = excluded.minimum_price, maximum_price = excluded.maximum_price,
         valuation_method = excluded.valuation_method, track_batches = excluded.track_batches,
         track_serials = excluded.track_serials, metadata = excluded.metadata,
         updated_at = excluded.updated_at`,
      [
        id, input.hsn_code || null, input.gst_rate || 0, input.minimum_price || 0,
        input.maximum_price || null, input.valuation_method || 'weighted_average',
        input.track_batches ? 1 : 0, input.track_serials ? 1 : 0,
        JSON.stringify(input.metadata || {}), now()
      ]
    );
  });
  const after = await getProduct(db, id);
  await writeTenantAudit(db, req, { eventType: 'product.updated', entityType: 'product', entityId: id, before, after });
  await announce(req, 'products.changed', { action: 'updated', product_id: Number(id) });
  return after;
}

export async function archiveProduct(db, id, req) {
  const before = await getProduct(db, id);
  const activeReservations = await db.one(
    `SELECT COUNT(*) AS count FROM stock_reservations
      WHERE product_id = ? AND status = 'active' AND quantity > fulfilled_quantity`,
    [id]
  );
  if (Number(activeReservations.count)) throw httpError(409, 'product_has_reservations', 'Release active stock reservations before archiving this product.');
  await db.run('UPDATE products SET status = 0, updated_at = ? WHERE id = ?', [now(), id]);
  const after = { ...before, status: 0 };
  await writeTenantAudit(db, req, { eventType: 'product.archived', entityType: 'product', entityId: id, before, after });
  await announce(req, 'products.changed', { action: 'archived', product_id: Number(id) });
  return after;
}

export async function listInventoryBalances(db, query = {}) {
  const params = [];
  const conditions = [];
  if (query.warehouse_id) { conditions.push('ws.warehouse_id = ?'); params.push(query.warehouse_id); }
  if (query.product_id) { conditions.push('ws.product_id = ?'); params.push(query.product_id); }
  return db.all(
    `SELECT ws.warehouse_id, w.name AS warehouse_name, w.code AS warehouse_code,
            ws.product_id, p.sku, p.name AS product_name, ws.quantity AS on_hand,
            COALESCE(r.reserved, 0) AS reserved,
            ws.quantity - COALESCE(r.reserved, 0) AS available,
            COALESCE(v.average_cost, p.cost_price, 0) AS average_cost,
            COALESCE(v.total_value, ws.quantity * p.cost_price, 0) AS inventory_value,
            COALESCE(rr.reorder_point, p.min_stock_alert, 0) AS reorder_point
       FROM warehouse_stock ws
       JOIN warehouses w ON w.id = ws.warehouse_id
       JOIN products p ON p.id = ws.product_id
       LEFT JOIN inventory_valuation_state v ON v.warehouse_id = ws.warehouse_id AND v.product_id = ws.product_id
       LEFT JOIN reorder_rules rr ON rr.warehouse_id = ws.warehouse_id AND rr.product_id = ws.product_id
       LEFT JOIN (
         SELECT warehouse_id, product_id, SUM(quantity - fulfilled_quantity) AS reserved
         FROM stock_reservations WHERE status = 'active' GROUP BY warehouse_id, product_id
       ) r ON r.warehouse_id = ws.warehouse_id AND r.product_id = ws.product_id
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY w.name, p.name`,
    params
  );
}

export async function listStockMovements(db, query = {}) {
  const params = [];
  const where = [];
  for (const key of ['warehouse_id', 'product_id', 'movement_type', 'reference_type', 'reference_id']) {
    if (query[key]) { where.push(`sm.${key} = ?`); params.push(query[key]); }
  }
  params.push(Math.min(Math.max(Number(query.limit || 100), 1), 500));
  return db.all(
    `SELECT sm.*, p.sku, p.name AS product_name, w.name AS warehouse_name
       FROM stock_movements sm
       JOIN products p ON p.id = sm.product_id
       JOIN warehouses w ON w.id = sm.warehouse_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY sm.occurred_at DESC, sm.id DESC LIMIT ?`,
    params
  );
}

export async function postStockMovement(db, input, req) {
  const movement = await db.transaction(tx => postStockMovementTx(tx, input, req.user.id));
  await writeTenantAudit(db, req, {
    eventType: `inventory.${input.movement_type}`,
    entityType: 'stock_movement',
    entityId: movement.id,
    after: movement
  });
  await announce(req, 'inventory.changed', movement);
  return movement;
}

export async function postStockMovementTx(tx, input, actorUserId) {
  const product = await tx.one(
    `SELECT p.id, p.cost_price, COALESCE(pc.valuation_method, 'weighted_average') AS valuation_method
       FROM products p LEFT JOIN product_commerce pc ON pc.product_id = p.id WHERE p.id = ?`,
    [input.product_id]
  );
  if (!product) throw httpError(404, 'product_not_found', 'Product was not found.');
  const warehouse = await tx.one('SELECT id FROM warehouses WHERE id = ?', [input.warehouse_id]);
  if (!warehouse) throw httpError(404, 'warehouse_not_found', 'Warehouse was not found.');

  const quantity = Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity === 0) throw httpError(422, 'invalid_quantity', 'Movement quantity must be non-zero.');
  const direction = movementDirection(input.movement_type, quantity);
  const signedQuantity = direction === 'out' ? -Math.abs(quantity) : Math.abs(quantity);
  const lock = tx.dialect === 'postgres' ? ' FOR UPDATE' : '';
  const balance = await tx.one(
    `SELECT quantity FROM warehouse_stock WHERE warehouse_id = ? AND product_id = ?${lock}`,
    [input.warehouse_id, input.product_id]
  );
  const onHand = Number(balance?.quantity || 0);
  const newOnHand = onHand + signedQuantity;
  if (newOnHand < -1e-9) throw httpError(409, 'insufficient_stock', `Only ${onHand} units are currently on hand.`);

  let unitCost = Number(input.unit_cost ?? product.cost_price ?? 0);
  if (direction === 'out') {
    unitCost = await consumeCostLayers(tx, {
      warehouseId: input.warehouse_id,
      productId: input.product_id,
      quantity: Math.abs(signedQuantity),
      method: input.valuation_method || product.valuation_method
    });
  }
  const movementNo = input.movement_no || `MOV-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const inserted = await insertWithId(tx,
    `INSERT INTO stock_movements
      (movement_no, movement_type, product_id, variant_id, warehouse_id, batch_id,
       quantity, unit_cost, total_cost, reference_type, reference_id, notes,
       actor_user_id, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      movementNo, input.movement_type, input.product_id, input.variant_id || null,
      input.warehouse_id, input.batch_id || null, signedQuantity, unitCost,
      Math.abs(signedQuantity) * unitCost, input.reference_type || null,
      input.reference_id == null ? null : String(input.reference_id), input.notes || null,
      actorUserId, input.occurred_at || now(), now()
    ]
  );
  const movementId = inserted.id || inserted.rows?.[0]?.id;
  await tx.run(
    `INSERT INTO warehouse_stock (warehouse_id, product_id, quantity, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (warehouse_id, product_id) DO UPDATE SET quantity = excluded.quantity, updated_at = excluded.updated_at`,
    [input.warehouse_id, input.product_id, newOnHand, now()]
  );

  if (direction === 'in') {
    await tx.run(
      `INSERT INTO inventory_cost_layers
        (warehouse_id, product_id, source_movement_id, received_at, original_quantity, remaining_quantity, unit_cost)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [input.warehouse_id, input.product_id, movementId, input.occurred_at || now(), Math.abs(signedQuantity), Math.abs(signedQuantity), unitCost]
    );
  }
  await updateValuationState(tx, {
    warehouseId: input.warehouse_id,
    productId: input.product_id,
    signedQuantity,
    unitCost,
    method: input.valuation_method || product.valuation_method
  });
  if (input.batch_no && direction === 'in') {
    await tx.run(
      `INSERT INTO inventory_batches
        (product_id, warehouse_id, batch_no, manufactured_at, expires_at, quantity, unit_cost, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
       ON CONFLICT (product_id, warehouse_id, batch_no) DO UPDATE SET
         quantity = inventory_batches.quantity + excluded.quantity,
         expires_at = COALESCE(excluded.expires_at, inventory_batches.expires_at),
         unit_cost = excluded.unit_cost`,
      [input.product_id, input.warehouse_id, input.batch_no, input.manufactured_at || null,
        input.expires_at || null, Math.abs(signedQuantity), unitCost, now()]
    );
  }
  return tx.one('SELECT * FROM stock_movements WHERE id = ?', [movementId]);
}

export async function transferStock(db, input, req) {
  if (input.from_warehouse_id === input.to_warehouse_id) {
    throw httpError(422, 'same_warehouse_transfer', 'Source and destination warehouses must differ.');
  }
  const transferId = input.reference_id || crypto.randomUUID();
  const movements = await db.transaction(async tx => {
    const outbound = await postStockMovementTx(tx, {
      ...input,
      warehouse_id: input.from_warehouse_id,
      movement_type: 'transfer_out',
      reference_type: 'stock_transfer',
      reference_id: transferId
    }, req.user.id);
    const inbound = await postStockMovementTx(tx, {
      ...input,
      warehouse_id: input.to_warehouse_id,
      movement_type: 'transfer_in',
      unit_cost: outbound.unit_cost,
      reference_type: 'stock_transfer',
      reference_id: transferId
    }, req.user.id);
    return { transfer_id: transferId, outbound, inbound };
  });
  await writeTenantAudit(db, req, { eventType: 'inventory.transferred', entityType: 'stock_transfer', entityId: transferId, after: movements });
  await announce(req, 'inventory.changed', movements);
  return movements;
}

export async function reserveStock(db, input, req) {
  const result = await db.transaction(async tx => {
    const balance = await availableStock(tx, input.warehouse_id, input.product_id);
    if (Number(input.quantity) > balance.available) {
      throw httpError(409, 'insufficient_available_stock', `Only ${balance.available} units are available after reservations.`);
    }
    const inserted = await insertWithId(tx,
      `INSERT INTO stock_reservations
        (reservation_no, product_id, variant_id, warehouse_id, quantity, fulfilled_quantity,
         reference_type, reference_id, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'active', ?, ?, ?)`,
      [
        input.reservation_no || `RES-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`,
        input.product_id, input.variant_id || null, input.warehouse_id, input.quantity,
        input.reference_type, String(input.reference_id), input.expires_at || null, now(), now()
      ]
    );
    return tx.one('SELECT * FROM stock_reservations WHERE id = ?', [inserted.id || inserted.rows?.[0]?.id]);
  });
  await writeTenantAudit(db, req, { eventType: 'inventory.reserved', entityType: 'stock_reservation', entityId: result.id, after: result });
  await announce(req, 'inventory.changed', result);
  return result;
}

export async function listReorderRecommendations(db) {
  return db.all(
    `SELECT ws.product_id, p.sku, p.name AS product_name, ws.warehouse_id,
            w.name AS warehouse_name, ws.quantity AS on_hand,
            COALESCE(r.reserved, 0) AS reserved,
            ws.quantity - COALESCE(r.reserved, 0) AS available,
            COALESCE(rr.reorder_point, p.min_stock_alert, 0) AS reorder_point,
            CASE WHEN COALESCE(rr.reorder_quantity, 0) > 0 THEN rr.reorder_quantity
                 ELSE MAX(COALESCE(rr.reorder_point, p.min_stock_alert, 0) * 2 -
                          (ws.quantity - COALESCE(r.reserved, 0)), 0) END AS recommended_quantity,
            rr.preferred_supplier_id, s.name AS preferred_supplier
       FROM warehouse_stock ws
       JOIN products p ON p.id = ws.product_id
       JOIN warehouses w ON w.id = ws.warehouse_id
       LEFT JOIN reorder_rules rr ON rr.product_id = ws.product_id AND rr.warehouse_id = ws.warehouse_id
       LEFT JOIN suppliers s ON s.id = rr.preferred_supplier_id
       LEFT JOIN (
         SELECT warehouse_id, product_id, SUM(quantity - fulfilled_quantity) AS reserved
         FROM stock_reservations WHERE status = 'active' GROUP BY warehouse_id, product_id
       ) r ON r.warehouse_id = ws.warehouse_id AND r.product_id = ws.product_id
      WHERE ws.quantity - COALESCE(r.reserved, 0) <= COALESCE(rr.reorder_point, p.min_stock_alert, 0)
      ORDER BY available ASC, p.name`
  );
}

export async function listParties(db, partyType, query = {}) {
  const table = partyTable(partyType);
  const params = [];
  let filter = '';
  if (query.q) {
    filter = 'WHERE lower(p.name) LIKE ? OR lower(COALESCE(p.phone, \'\')) LIKE ? OR lower(COALESCE(p.email, \'\')) LIKE ?';
    const search = `%${String(query.q).toLowerCase()}%`;
    params.push(search, search, search);
  }
  const rows = await db.all(
    `SELECT p.*, pp.gstin AS profile_gstin, pp.legal_name, pp.payment_terms_days,
            pp.lead_time_days, pp.rating, pp.tags, pp.notes
       FROM ${table} p LEFT JOIN party_profiles pp
         ON pp.party_type = ? AND pp.party_id = p.id
       ${filter} ORDER BY p.name`,
    [partyType, ...params]
  );
  return rows.map(normalizeJsonFields);
}

export async function getParty(db, partyType, id) {
  const table = partyTable(partyType);
  const party = await db.one(
    `SELECT p.*, pp.gstin AS profile_gstin, pp.legal_name, pp.payment_terms_days,
            pp.lead_time_days, pp.rating, pp.tags, pp.notes
       FROM ${table} p LEFT JOIN party_profiles pp ON pp.party_type = ? AND pp.party_id = p.id
      WHERE p.id = ?`,
    [partyType, id]
  );
  if (!party) throw httpError(404, `${partyType}_not_found`, `${capitalize(partyType)} was not found.`);
  const [contacts, addresses, communications, documents, attachments] = await Promise.all([
    db.all('SELECT * FROM party_contacts WHERE party_type = ? AND party_id = ? ORDER BY is_primary DESC, name', [partyType, id]),
    db.all('SELECT * FROM party_addresses WHERE party_type = ? AND party_id = ? ORDER BY is_primary DESC, id', [partyType, id]),
    db.all('SELECT * FROM party_communications WHERE party_type = ? AND party_id = ? ORDER BY occurred_at DESC LIMIT 100', [partyType, id]),
    db.all('SELECT * FROM trade_documents WHERE party_type = ? AND party_id = ? ORDER BY created_at DESC LIMIT 100', [partyType, id]),
    db.all('SELECT * FROM attachments WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC', [partyType, String(id)])
  ]);
  return { ...normalizeJsonFields(party), contacts, addresses, communications, documents: documents.map(normalizeJsonFields), attachments };
}

export async function createParty(db, partyType, input, req) {
  const table = partyTable(partyType);
  const id = await db.transaction(async tx => {
    const timestamp = now();
    let inserted;
    if (partyType === 'customer') {
      inserted = await tx.run(
        `INSERT INTO customers
          (name, phone, email, address, credit_limit, balance, loyalty_points, tier, created_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
        [input.name, input.phone || null, input.email || null, input.address || null, input.credit_limit || 0, input.tier || 'bronze', timestamp]
      );
    } else {
      inserted = await tx.run(
        `INSERT INTO suppliers
          (name, phone, email, gstin, address, payment_terms, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        [input.name, input.phone || null, input.email || null, input.gstin || null, input.address || null, input.payment_terms_days || 0, timestamp]
      );
    }
    const partyId = inserted.id || inserted.rows?.[0]?.id;
    await tx.run(
      `INSERT INTO party_profiles
        (party_type, party_id, gstin, legal_name, payment_terms_days, lead_time_days, rating, tags, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        partyType, partyId, input.gstin || null, input.legal_name || input.name,
        input.payment_terms_days || 0, input.lead_time_days || 0, input.rating || null,
        JSON.stringify(input.tags || []), input.notes || null, timestamp
      ]
    );
    for (const contact of input.contacts || []) {
      await tx.run(
        `INSERT INTO party_contacts
          (party_type, party_id, name, title, email, phone, is_primary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [partyType, partyId, contact.name, contact.title || null, contact.email || null,
          contact.phone || null, contact.is_primary ? 1 : 0, timestamp]
      );
    }
    for (const address of input.addresses || []) {
      await tx.run(
        `INSERT INTO party_addresses
          (party_type, party_id, address_type, line1, line2, city, state, postal_code, country, is_primary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [partyType, partyId, address.address_type || 'billing', address.line1, address.line2 || null,
          address.city || null, address.state || null, address.postal_code || null,
          address.country || 'IN', address.is_primary ? 1 : 0, timestamp]
      );
    }
    return partyId;
  });
  const party = await getParty(db, partyType, id);
  await writeTenantAudit(db, req, { eventType: `${partyType}.created`, entityType: partyType, entityId: id, after: party });
  await announce(req, 'parties.changed', { action: 'created', party_type: partyType, party_id: id });
  return party;
}

export async function updateParty(db, partyType, id, input, req) {
  const before = await getParty(db, partyType, id);
  const table = partyTable(partyType);
  await db.transaction(async tx => {
    if (partyType === 'customer') {
      await tx.run(
        `UPDATE customers SET name = ?, phone = ?, email = ?, address = ?,
          credit_limit = ?, tier = ? WHERE id = ?`,
        [input.name, input.phone || null, input.email || null, input.address || null,
          input.credit_limit || 0, input.tier || 'bronze', id]
      );
    } else {
      await tx.run(
        `UPDATE suppliers SET name = ?, phone = ?, email = ?, gstin = ?, address = ?,
          payment_terms = ?, status = ? WHERE id = ?`,
        [input.name, input.phone || null, input.email || null, input.gstin || null,
          input.address || null, input.payment_terms_days || 0, input.status === false ? 0 : 1, id]
      );
    }
    await tx.run(
      `INSERT INTO party_profiles
        (party_type, party_id, gstin, legal_name, payment_terms_days, lead_time_days, rating, tags, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (party_type, party_id) DO UPDATE SET
         gstin = excluded.gstin, legal_name = excluded.legal_name,
         payment_terms_days = excluded.payment_terms_days, lead_time_days = excluded.lead_time_days,
         rating = excluded.rating, tags = excluded.tags, notes = excluded.notes, updated_at = excluded.updated_at`,
      [
        partyType, id, input.gstin || null, input.legal_name || input.name,
        input.payment_terms_days || 0, input.lead_time_days || 0, input.rating || null,
        JSON.stringify(input.tags || []), input.notes || null, now()
      ]
    );
    if (!await tx.one(`SELECT id FROM ${table} WHERE id = ?`, [id])) {
      throw httpError(404, `${partyType}_not_found`, `${capitalize(partyType)} was not found.`);
    }
  });
  const after = await getParty(db, partyType, id);
  await writeTenantAudit(db, req, { eventType: `${partyType}.updated`, entityType: partyType, entityId: id, before, after });
  await announce(req, 'parties.changed', { action: 'updated', party_type: partyType, party_id: Number(id) });
  return after;
}

export async function addPartyDetail(db, partyType, id, detailType, input, req) {
  await getParty(db, partyType, id);
  let table;
  let statement;
  let values;
  if (detailType === 'contacts') {
    table = 'party_contacts';
    statement = `INSERT INTO party_contacts
      (party_type, party_id, name, title, email, phone, is_primary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    values = [partyType, id, input.name, input.title || null, input.email || null, input.phone || null, input.is_primary ? 1 : 0, now()];
  } else if (detailType === 'addresses') {
    table = 'party_addresses';
    statement = `INSERT INTO party_addresses
      (party_type, party_id, address_type, line1, line2, city, state, postal_code, country, is_primary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    values = [partyType, id, input.address_type || 'billing', input.line1, input.line2 || null,
      input.city || null, input.state || null, input.postal_code || null, input.country || 'IN', input.is_primary ? 1 : 0, now()];
  } else if (detailType === 'communications') {
    table = 'party_communications';
    statement = `INSERT INTO party_communications
      (party_type, party_id, channel, direction, subject, body, occurred_at, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    values = [partyType, id, input.channel, input.direction, input.subject || null, input.body || null,
      input.occurred_at || now(), req.user.id, now()];
  } else {
    throw httpError(404, 'party_detail_not_found', 'Party detail type was not found.');
  }
  const inserted = await insertWithId(db, statement, values);
  const detailId = inserted.id || inserted.rows?.[0]?.id;
  const detail = await db.one(`SELECT * FROM ${table} WHERE id = ?`, [detailId]);
  await writeTenantAudit(db, req, { eventType: `${partyType}.${detailType}.created`, entityType: detailType, entityId: detailId, after: detail });
  return detail;
}

export async function createCycleCount(db, input, req) {
  const result = await db.transaction(async tx => {
    const warehouse = await tx.one('SELECT id FROM warehouses WHERE id = ?', [input.warehouse_id]);
    if (!warehouse) throw httpError(404, 'warehouse_not_found', 'Warehouse was not found.');
    const inserted = await insertWithId(tx,
      `INSERT INTO cycle_counts
        (count_no, warehouse_id, status, scheduled_at, created_by, created_at)
       VALUES (?, ?, 'draft', ?, ?, ?)`,
      [input.count_no || `CC-${Date.now()}`, input.warehouse_id, input.scheduled_at || null, req.user.id, now()]
    );
    const cycleId = inserted.id || inserted.rows?.[0]?.id;
    const balances = input.product_ids?.length
      ? await tx.all(`SELECT product_id, quantity FROM warehouse_stock WHERE warehouse_id = ? AND product_id IN (${input.product_ids.map(() => '?').join(',')})`, [input.warehouse_id, ...input.product_ids])
      : await tx.all('SELECT product_id, quantity FROM warehouse_stock WHERE warehouse_id = ?', [input.warehouse_id]);
    for (const balance of balances) {
      await tx.run(
        `INSERT INTO cycle_count_items (cycle_count_id, product_id, expected_quantity)
         VALUES (?, ?, ?)`,
        [cycleId, balance.product_id, balance.quantity]
      );
    }
    return cycleId;
  });
  const cycle = await getCycleCount(db, result);
  await writeTenantAudit(db, req, { eventType: 'inventory.cycle_count_created', entityType: 'cycle_count', entityId: result, after: cycle });
  return cycle;
}

export async function getCycleCount(db, id) {
  const cycle = await db.one('SELECT * FROM cycle_counts WHERE id = ?', [id]);
  if (!cycle) throw httpError(404, 'cycle_count_not_found', 'Cycle count was not found.');
  return { ...cycle, items: await db.all('SELECT * FROM cycle_count_items WHERE cycle_count_id = ? ORDER BY id', [id]) };
}

export async function completeCycleCount(db, id, input, req) {
  const before = await getCycleCount(db, id);
  if (!['draft', 'in_progress'].includes(before.status)) throw httpError(409, 'cycle_count_not_open', 'This cycle count is already closed.');
  await db.transaction(async tx => {
    for (const counted of input.items) {
      const line = before.items.find(item => Number(item.id) === Number(counted.item_id));
      if (!line) throw httpError(422, 'cycle_count_item_not_found', `Cycle count item ${counted.item_id} was not found.`);
      const variance = Number(counted.counted_quantity) - Number(line.expected_quantity);
      await tx.run(
        `UPDATE cycle_count_items SET counted_quantity = ?, variance = ?, notes = ? WHERE id = ?`,
        [counted.counted_quantity, variance, counted.notes || null, line.id]
      );
      if (Math.abs(variance) > 1e-9) {
        await postStockMovementTx(tx, {
          product_id: line.product_id,
          warehouse_id: before.warehouse_id,
          movement_type: variance > 0 ? 'adjustment_in' : 'adjustment_out',
          quantity: Math.abs(variance),
          reference_type: 'cycle_count',
          reference_id: id,
          notes: counted.notes || 'Cycle count variance.'
        }, req.user.id);
      }
    }
    await tx.run(
      `UPDATE cycle_counts SET status = 'completed', completed_at = ?, approved_by = ? WHERE id = ?`,
      [now(), req.user.id, id]
    );
  });
  const after = await getCycleCount(db, id);
  await writeTenantAudit(db, req, { eventType: 'inventory.cycle_count_completed', entityType: 'cycle_count', entityId: id, before, after });
  await announce(req, 'inventory.changed', { action: 'cycle_count_completed', cycle_count_id: Number(id) });
  return after;
}

export async function createTradeDocument(db, routeType, input, req) {
  const documentType = mapDocumentType(routeType);
  const result = await db.transaction(async tx => {
    let sourceDocument = null;
    if (input.source_document_id) {
      sourceDocument = await tx.one('SELECT * FROM trade_documents WHERE id = ?', [input.source_document_id]);
      if (!sourceDocument) throw httpError(404, 'source_document_not_found', 'The source document was not found.');
      assertConversionAllowed(sourceDocument, documentType);
      const existing = await tx.one(
        `SELECT * FROM document_links
          WHERE source_entity_type = 'trade_document' AND source_entity_id = ?
            AND relationship_type = ?`,
        [sourceDocument.id, `converted_to:${documentType}`]
      );
      if (existing) throw httpError(409, 'document_already_converted', 'This conversion has already been completed.');
    }
    await validateTradeParty(tx, documentType, input);
    const calculated = await calculateLines(tx, input.lines, documentType);
    await enforceCreditLimit(tx, documentType, input.party_id, calculated.grand_total);
    const documentNo = input.document_no || await nextNumber(tx, documentType);
    const timestamp = now();
    const inserted = await insertWithId(tx,
      `INSERT INTO trade_documents
        (document_no, document_type, status, party_type, party_id, warehouse_id, currency,
         subtotal, discount, tax_total, grand_total, source_document_id, expected_at,
         notes, metadata, created_by, created_at, updated_at)
       VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        documentNo, documentType, partyTypeForDocument(documentType), input.party_id || null,
        input.warehouse_id || null, input.currency || 'INR', calculated.subtotal,
        Number(input.discount || 0), calculated.tax_total,
        calculated.grand_total - Number(input.discount || 0), input.source_document_id || null,
        input.expected_at || null, input.notes || null, JSON.stringify(input.metadata || {}),
        req.user.id, timestamp, timestamp
      ]
    );
    const documentId = inserted.id || inserted.rows?.[0]?.id;
    for (const line of calculated.lines) {
      await tx.run(
        `INSERT INTO trade_document_lines
          (document_id, product_id, variant_id, description, quantity, fulfilled_quantity,
           unit_price, discount, tax_rate, tax_amount, line_total, metadata)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        [
          documentId, line.product_id, line.variant_id || null, line.description || null,
          line.quantity, line.unit_price, line.discount, line.tax_rate, line.tax_amount,
          line.line_total, JSON.stringify(line.metadata || {})
        ]
      );
    }
    await timeline(tx, documentType, documentId, 'created', req.user.id, `${documentNo} was created.`);
    if (sourceDocument) {
      await tx.run(
        `INSERT INTO document_links
          (source_entity_type, source_entity_id, target_entity_type, target_entity_id,
           relationship_type, metadata, created_by, created_at)
         VALUES ('trade_document', ?, 'trade_document', ?, ?, ?, ?, ?)`,
        [sourceDocument.id, documentId, `converted_to:${documentType}`,
          JSON.stringify({ source_document_no: sourceDocument.document_no, target_document_no: documentNo }), req.user.id, timestamp]
      );
      await timeline(tx, sourceDocument.document_type, sourceDocument.id, `converted.${documentType}`, req.user.id, `${sourceDocument.document_no} converted to ${documentNo}.`);
    }
    return documentId;
  });
  const document = await getTradeDocument(db, result);
  await writeTenantAudit(db, req, { eventType: `${documentType}.created`, entityType: documentType, entityId: result, after: document });
  await announce(req, 'trade.changed', { action: 'created', document_type: documentType, document_id: result });
  return document;
}

export async function listTradeDocuments(db, routeType, query = {}) {
  const documentType = mapDocumentType(routeType);
  const params = [documentType];
  const where = ['td.document_type = ?'];
  if (query.status) { where.push('td.status = ?'); params.push(query.status); }
  if (query.party_id) { where.push('td.party_id = ?'); params.push(query.party_id); }
  return db.all(
    `SELECT td.*,
      CASE WHEN td.party_type = 'customer' THEN c.name ELSE s.name END AS party_name
      FROM trade_documents td
      LEFT JOIN customers c ON td.party_type = 'customer' AND c.id = td.party_id
      LEFT JOIN suppliers s ON td.party_type = 'supplier' AND s.id = td.party_id
      WHERE ${where.join(' AND ')}
      ORDER BY td.created_at DESC`,
    params
  ).then(rows => rows.map(normalizeJsonFields));
}

export async function getTradeDocument(db, id) {
  const document = await db.one('SELECT * FROM trade_documents WHERE id = ?', [id]);
  if (!document) throw httpError(404, 'trade_document_not_found', 'Trade document was not found.');
  const [lines, approvals, timelineRows, attachments, links] = await Promise.all([
    db.all('SELECT * FROM trade_document_lines WHERE document_id = ? ORDER BY id', [id]),
    db.all('SELECT * FROM approval_requests WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC', [document.document_type, String(id)]),
    db.all('SELECT * FROM entity_timeline WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC', [document.document_type, String(id)]),
    db.all('SELECT * FROM attachments WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC', [document.document_type, String(id)]),
    db.all(
      `SELECT * FROM document_links
        WHERE (source_entity_type = 'trade_document' AND source_entity_id = ?)
           OR (target_entity_type = 'trade_document' AND target_entity_id = ?)
        ORDER BY created_at DESC`,
      [id, id]
    )
  ]);
  return {
    ...normalizeJsonFields(document),
    lines: lines.map(normalizeJsonFields),
    approvals,
    timeline: timelineRows.map(normalizeJsonFields),
    attachments,
    links: links.map(normalizeJsonFields)
  };
}

export async function transitionTradeDocument(db, id, targetStatus, input, req) {
  const before = await getTradeDocument(db, id);
  if (!TRANSITIONS[before.status]?.has(targetStatus)) {
    throw httpError(409, 'invalid_workflow_transition', `Cannot transition ${before.status} to ${targetStatus}.`);
  }
  if (targetStatus === 'approved') throw httpError(409, 'approval_endpoint_required', 'Use the approval endpoint to approve a pending document.');
  await db.transaction(async tx => {
    if (targetStatus === 'pending_approval') {
      await tx.run(
        `INSERT INTO approval_requests
          (entity_type, entity_id, status, requested_by, assigned_role, reason, created_at)
         VALUES (?, ?, 'pending', ?, 'manager', ?, ?)`,
        [before.document_type, String(id), req.user.id, input.reason || null, now()]
      );
    }
    if (targetStatus === 'cancelled') {
      await releaseDocumentReservations(tx, before);
      await tx.run(
        `UPDATE approval_requests SET status = 'rejected', decision_notes = ?, decided_by = ?, decided_at = ?
          WHERE entity_type = ? AND entity_id = ? AND status = 'pending'`,
        [input.reason || 'Document cancelled.', req.user.id, now(), before.document_type, String(id)]
      );
    }
    if (targetStatus === 'fulfilled' && ['sales_return', 'purchase_return'].includes(before.document_type)) {
      if (!before.warehouse_id) throw httpError(409, 'warehouse_required', 'A warehouse is required to post this return.');
      for (const line of before.lines) {
        await postStockMovementTx(tx, {
          product_id: line.product_id,
          variant_id: line.variant_id,
          warehouse_id: before.warehouse_id,
          movement_type: before.document_type === 'sales_return' ? 'sales_return' : 'purchase_return',
          quantity: Number(line.quantity) - Number(line.fulfilled_quantity),
          unit_cost: line.unit_price,
          reference_type: before.document_type,
          reference_id: id
        }, req.user.id);
        await tx.run('UPDATE trade_document_lines SET fulfilled_quantity = quantity WHERE id = ?', [line.id]);
      }
    }
    await tx.run(
      `UPDATE trade_documents SET status = ?, cancelled_at = ?, updated_at = ? WHERE id = ?`,
      [targetStatus, targetStatus === 'cancelled' ? now() : null, now(), id]
    );
    await timeline(tx, before.document_type, id, `status.${targetStatus}`, req.user.id, `Status changed from ${before.status} to ${targetStatus}.`);
  });
  const after = await getTradeDocument(db, id);
  await writeTenantAudit(db, req, { eventType: `${before.document_type}.transitioned`, entityType: before.document_type, entityId: id, before, after });
  await announce(req, 'trade.changed', { action: 'transitioned', document_id: Number(id), status: targetStatus });
  return after;
}

export async function decideApproval(db, approvalId, decision, notes, req) {
  const result = await db.transaction(async tx => {
    const lock = tx.dialect === 'postgres' ? ' FOR UPDATE' : '';
    const approval = await tx.one(`SELECT * FROM approval_requests WHERE id = ?${lock}`, [approvalId]);
    if (!approval) throw httpError(404, 'approval_not_found', 'Approval request was not found.');
    if (approval.status !== 'pending') throw httpError(409, 'approval_already_decided', 'This approval request has already been decided.');
    const document = await tx.one('SELECT * FROM trade_documents WHERE id = ? AND document_type = ?', [approval.entity_id, approval.entity_type]);
    if (!document || document.status !== 'pending_approval') throw httpError(409, 'approval_target_changed', 'The document is no longer pending approval.');
    const status = decision === 'approve' ? 'approved' : 'rejected';
    await tx.run(
      `UPDATE approval_requests SET status = ?, decision_notes = ?, decided_by = ?, decided_at = ? WHERE id = ?`,
      [status, notes || null, req.user.id, now(), approvalId]
    );
    if (decision === 'approve') {
      if (document.document_type === 'sales_order') await reserveSalesOrderTx(tx, document.id, req.user.id);
      await tx.run(
        'UPDATE trade_documents SET status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?',
        ['approved', req.user.id, now(), now(), document.id]
      );
    } else {
      await tx.run('UPDATE trade_documents SET status = ?, updated_at = ? WHERE id = ?', ['draft', now(), document.id]);
    }
    await timeline(tx, document.document_type, document.id, `approval.${status}`, req.user.id, notes || `Approval ${status}.`);
    return { approval, document_id: document.id };
  });
  const document = await getTradeDocument(db, result.document_id);
  await writeTenantAudit(db, req, { eventType: `approval.${decision}d`, entityType: 'approval', entityId: approvalId, after: document });
  await announce(req, 'approvals.changed', { approval_id: Number(approvalId), decision, document_id: result.document_id });
  return document;
}

export async function receivePurchaseOrder(db, id, input, req) {
  const purchaseOrder = await getTradeDocument(db, id);
  if (purchaseOrder.document_type !== 'purchase_order') throw httpError(422, 'not_purchase_order', 'Only purchase orders can be received.');
  if (!['approved', 'partially_fulfilled'].includes(purchaseOrder.status)) {
    throw httpError(409, 'purchase_order_not_receivable', 'The purchase order must be approved before receiving.');
  }
  const receiptId = await db.transaction(async tx => {
    const receiptNo = await nextNumber(tx, 'goods_receipt');
    const inserted = await insertWithId(tx,
      `INSERT INTO goods_receipts
        (receipt_no, purchase_order_id, warehouse_id, supplier_id, status, received_at, received_by, notes, created_at)
       VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
      [receiptNo, id, input.warehouse_id || purchaseOrder.warehouse_id, purchaseOrder.party_id, now(), req.user.id, input.notes || null, now()]
    );
    const grnId = inserted.id || inserted.rows?.[0]?.id;
    for (const received of input.items) {
      const line = purchaseOrder.lines.find(item => Number(item.id) === Number(received.line_id));
      if (!line) throw httpError(422, 'invalid_purchase_line', `Purchase order line ${received.line_id} was not found.`);
      const remaining = Number(line.quantity) - Number(line.fulfilled_quantity);
      if (received.quantity > remaining) throw httpError(409, 'receive_quantity_exceeded', `Line ${line.id} has only ${remaining} remaining.`);
      await tx.run(
        `INSERT INTO goods_receipt_items
          (goods_receipt_id, trade_line_id, product_id, quantity, unit_cost, batch_no, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [grnId, line.id, line.product_id, received.quantity, line.unit_price, received.batch_no || null, received.expires_at || null]
      );
      await postStockMovementTx(tx, {
        product_id: line.product_id,
        variant_id: line.variant_id,
        warehouse_id: input.warehouse_id || purchaseOrder.warehouse_id,
        movement_type: 'purchase_receipt',
        quantity: received.quantity,
        unit_cost: line.unit_price,
        batch_no: received.batch_no,
        expires_at: received.expires_at,
        reference_type: 'goods_receipt',
        reference_id: grnId
      }, req.user.id);
      await tx.run(
        'UPDATE trade_document_lines SET fulfilled_quantity = fulfilled_quantity + ? WHERE id = ?',
        [received.quantity, line.id]
      );
    }
    const progress = await fulfillmentStatus(tx, id);
    await tx.run('UPDATE trade_documents SET status = ?, fulfilled_at = ?, updated_at = ? WHERE id = ?', [
      progress, progress === 'fulfilled' ? now() : null, now(), id
    ]);
    await timeline(tx, 'purchase_order', id, 'goods_received', req.user.id, `${receiptNo} was received.`);
    await tx.run(
      `INSERT INTO document_links
        (source_entity_type, source_entity_id, target_entity_type, target_entity_id,
         relationship_type, metadata, created_by, created_at)
       VALUES ('purchase_order', ?, 'goods_receipt', ?, ?, ?, ?, ?)`,
      [id, grnId, `receipt:${grnId}`, JSON.stringify({ receipt_no: receiptNo }), req.user.id, now()]
    );
    return grnId;
  });
  const receipt = await db.one('SELECT * FROM goods_receipts WHERE id = ?', [receiptId]);
  receipt.items = await db.all('SELECT * FROM goods_receipt_items WHERE goods_receipt_id = ?', [receiptId]);
  await writeTenantAudit(db, req, { eventType: 'purchase_order.received', entityType: 'goods_receipt', entityId: receiptId, after: receipt });
  await announce(req, 'inventory.changed', { action: 'purchase_received', purchase_order_id: Number(id), goods_receipt_id: receiptId });
  return receipt;
}

export async function fulfillSalesOrder(db, id, input, req) {
  const salesOrder = await getTradeDocument(db, id);
  if (salesOrder.document_type !== 'sales_order') throw httpError(422, 'not_sales_order', 'Only sales orders can be fulfilled.');
  if (!['approved', 'partially_fulfilled'].includes(salesOrder.status)) {
    throw httpError(409, 'sales_order_not_fulfillable', 'The sales order must be approved before fulfilment.');
  }
  await db.transaction(async tx => {
    for (const fulfilled of input.items) {
      const line = salesOrder.lines.find(item => Number(item.id) === Number(fulfilled.line_id));
      if (!line) throw httpError(422, 'invalid_sales_line', `Sales order line ${fulfilled.line_id} was not found.`);
      const remaining = Number(line.quantity) - Number(line.fulfilled_quantity);
      if (fulfilled.quantity > remaining) throw httpError(409, 'fulfil_quantity_exceeded', `Line ${line.id} has only ${remaining} remaining.`);
      await postStockMovementTx(tx, {
        product_id: line.product_id,
        variant_id: line.variant_id,
        warehouse_id: input.warehouse_id || salesOrder.warehouse_id,
        movement_type: 'sale',
        quantity: fulfilled.quantity,
        reference_type: 'sales_order',
        reference_id: id
      }, req.user.id);
      await tx.run(
        `UPDATE trade_document_lines SET fulfilled_quantity = fulfilled_quantity + ? WHERE id = ?`,
        [fulfilled.quantity, line.id]
      );
      await tx.run(
        `UPDATE stock_reservations SET fulfilled_quantity = fulfilled_quantity + ?,
          status = CASE WHEN fulfilled_quantity + ? >= quantity THEN 'fulfilled' ELSE status END,
          updated_at = ?
          WHERE reference_type = 'sales_order' AND reference_id = ? AND product_id = ? AND status = 'active'`,
        [fulfilled.quantity, fulfilled.quantity, now(), String(id), line.product_id]
      );
    }
    const progress = await fulfillmentStatus(tx, id);
    await tx.run('UPDATE trade_documents SET status = ?, fulfilled_at = ?, updated_at = ? WHERE id = ?', [
      progress, progress === 'fulfilled' ? now() : null, now(), id
    ]);
    await timeline(tx, 'sales_order', id, 'stock_fulfilled', req.user.id, 'Reserved stock was fulfilled.');
  });
  const result = await getTradeDocument(db, id);
  await writeTenantAudit(db, req, { eventType: 'sales_order.fulfilled', entityType: 'sales_order', entityId: id, after: result });
  await announce(req, 'inventory.changed', { action: 'sales_fulfilled', sales_order_id: Number(id) });
  return result;
}

export async function dashboardSummary(db, organizationId, refresh = false) {
  if (!refresh) {
    const cached = await cacheGet(organizationId, 'dashboard:summary');
    if (cached) return { ...cached, cache: 'hit' };
  }
  const [sales, todaySales, inventory, orders, parties, lowStock, catalog] = await Promise.all([
    db.one(
      `SELECT COALESCE(SUM(total), 0) AS revenue,
              COALESCE(SUM(total - tax_amount), 0) AS net_revenue,
              COUNT(*) AS sale_count
         FROM sales WHERE sale_date >= ?`,
      [monthStart()]
    ),
    db.one(
      `SELECT COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS sale_count
         FROM sales WHERE sale_date >= ?`,
      [new Date().toISOString().slice(0, 10)]
    ),
    db.one(
      `SELECT COALESCE(SUM(v.total_value), 0) AS inventory_value,
              COALESCE(SUM(v.on_hand), 0) AS units_on_hand
         FROM inventory_valuation_state v`
    ),
    db.all(
      `SELECT document_type, status, COUNT(*) AS count, COALESCE(SUM(grand_total), 0) AS total
         FROM trade_documents GROUP BY document_type, status ORDER BY document_type, status`
    ),
    db.one(
      `SELECT
        (SELECT COALESCE(SUM(balance), 0) FROM customers) AS customer_outstanding,
        (SELECT COUNT(*) FROM customers) AS customer_count,
        (SELECT COUNT(*) FROM suppliers WHERE status = 1) AS supplier_count`
    ),
    listReorderRecommendations(db),
    db.one(
      `SELECT (SELECT COUNT(*) FROM products WHERE status = 1) AS product_count,
              (SELECT COUNT(*) FROM warehouses) AS warehouse_count`
    )
  ]);
  const profit = await db.one(
    `SELECT COALESCE(SUM((si.unit_price - COALESCE(p.cost_price, 0)) * si.quantity), 0) AS gross_profit
       FROM sale_items si JOIN products p ON p.id = si.product_id
       JOIN sales s ON s.id = si.sale_id WHERE s.sale_date >= ?`,
    [monthStart()]
  );
  const summary = {
    period: { from: monthStart(), to: now() },
    revenue: Number(sales.revenue || 0),
    net_revenue: Number(sales.net_revenue || 0),
    gross_profit: Number(profit.gross_profit || 0),
    sale_count: Number(sales.sale_count || 0),
    today_revenue: Number(todaySales.revenue || 0),
    today_sale_count: Number(todaySales.sale_count || 0),
    inventory_value: Number(inventory.inventory_value || 0),
    units_on_hand: Number(inventory.units_on_hand || 0),
    customer_outstanding: Number(parties.customer_outstanding || 0),
    customer_count: Number(parties.customer_count || 0),
    supplier_count: Number(parties.supplier_count || 0),
    product_count: Number(catalog.product_count || 0),
    warehouse_count: Number(catalog.warehouse_count || 0),
    order_status: orders,
    low_stock_count: lowStock.length,
    low_stock: lowStock.slice(0, 10),
    generated_at: now(),
    cache: 'miss'
  };
  await cacheSet(organizationId, 'dashboard:summary', summary, 60);
  return summary;
}

export async function dashboardActivity(db, limit = 50) {
  return db.all(
    `SELECT id, request_id, actor_user_id, event_type, entity_type, entity_id,
            before_state, after_state, metadata, created_at
       FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ?`,
    [Math.min(Math.max(Number(limit), 1), 200)]
  ).then(rows => rows.map(normalizeJsonFields));
}

export async function checkoutPos(db, input, req) {
  const actorId = req.user.tenant_user_id || req.user.id;
  const result = await db.transaction(async tx => {
    const warehouse = await tx.one('SELECT * FROM warehouses WHERE id = ?', [input.warehouse_id]);
    if (!warehouse) throw httpError(404, 'warehouse_not_found', 'Warehouse was not found.');
    const customer = input.customer_id
      ? await tx.one('SELECT * FROM customers WHERE id = ?', [input.customer_id])
      : null;
    if (input.customer_id && !customer) throw httpError(404, 'customer_not_found', 'Customer was not found.');
    let sourceSalesOrder = null;
    if (input.source_trade_document_id) {
      const lock = tx.dialect === 'postgres' ? ' FOR UPDATE' : '';
      sourceSalesOrder = await tx.one(
        `SELECT * FROM trade_documents WHERE id = ? AND document_type = 'sales_order'${lock}`,
        [input.source_trade_document_id]
      );
      if (!sourceSalesOrder) throw httpError(404, 'sales_order_not_found', 'The source sales order was not found.');
      if (sourceSalesOrder.status !== 'approved') {
        throw httpError(409, 'sales_order_not_invoiceable', 'The sales order must be approved and unfulfilled before invoicing.');
      }
      const existingLink = await tx.one(
        `SELECT id FROM document_links
          WHERE source_entity_type = 'sales_order' AND source_entity_id = ?
            AND target_entity_type = 'invoice' AND relationship_type = 'converted_to:invoice'`,
        [sourceSalesOrder.id]
      );
      if (existingLink) throw httpError(409, 'document_already_converted', 'This sales order already has an invoice.');
      if (Number(sourceSalesOrder.party_id) !== Number(input.customer_id)
          || Number(sourceSalesOrder.warehouse_id) !== Number(input.warehouse_id)) {
        throw httpError(409, 'conversion_context_changed', 'The sales order customer or warehouse no longer matches checkout.');
      }
      sourceSalesOrder.lines = await tx.all(
        'SELECT * FROM trade_document_lines WHERE document_id = ? ORDER BY id',
        [sourceSalesOrder.id]
      );
      const submitted = input.items.map(item => `${item.product_id}:${item.variant_id || ''}:${Number(item.quantity)}`).sort();
      const expected = sourceSalesOrder.lines.map(line => `${line.product_id}:${line.variant_id || ''}:${Number(line.quantity)}`).sort();
      if (JSON.stringify(submitted) !== JSON.stringify(expected)) {
        throw httpError(409, 'conversion_lines_changed', 'The invoice items must match the approved sales order.');
      }
    }
    const snapshots = await resolveInvoiceSnapshots(tx, input, req, customer);
    const lines = [];
    for (const item of input.items) {
      const product = await tx.one(
        `SELECT p.*, COALESCE(pc.hsn_code, '') AS hsn_code,
                COALESCE(pc.gst_rate, 0) AS gst_rate,
                COALESCE(pc.minimum_price, 0) AS minimum_price, pc.maximum_price
         FROM products p LEFT JOIN product_commerce pc ON pc.product_id = p.id
         WHERE p.id = ? AND p.status = 1`,
        [item.product_id]
      );
      if (!product) throw httpError(422, 'invalid_product', `Product ${item.product_id} is unavailable.`);
      const requestedPrice = item.unit_price == null ? Number(product.selling_price || 0) : Number(item.unit_price);
      const unitPrice = requestedPrice;
      if (item.unit_price != null && Math.abs(unitPrice - Number(product.selling_price || 0)) > 0.000001) {
        const permissions = req.user.permissions || [];
        const canOverride = permissions.includes('*')
          || permissions.includes('trade.sales.price_override')
          || permissions.includes('trade.sales.*')
          || permissions.includes('trade.*');
        if (!canOverride) throw httpError(403, 'price_override_permission_required', 'Permission to override the selling price is required.');
      }
      if (unitPrice < Number(product.minimum_price || 0)) throw httpError(409, 'minimum_price_violation', `${product.name} cannot be sold below its minimum price.`);
      if (product.maximum_price != null && unitPrice > Number(product.maximum_price)) throw httpError(409, 'maximum_price_violation', `${product.name} exceeds its maximum price.`);
      lines.push({
        ...item,
        product,
        unit_price: unitPrice,
        gst_rate: product.gst_rate,
        hsn_sac: product.hsn_code || '',
        unit: product.uom || 'piece'
      });
    }
    const calculated = calculateInvoiceAmounts(lines, input.discount || 0, snapshots.is_interstate);
    const invoiceNo = await nextNumber(tx, 'invoice');
    const timestamp = now();
    const dueDate = input.due_date
      || (input.allow_partial_payment
        ? new Date(Date.now() + snapshots.default_credit_days * 86400000).toISOString().slice(0, 10)
        : null);
    const paymentMethods = Array.isArray(input.payments) && input.payments.length
      ? input.payments.map(item => String(item.method).toLowerCase())
      : [String(input.payment_method || 'credit').toLowerCase()];
    const compatibilityPaymentMethod = paymentMethods.length > 1 ? 'split' : paymentMethods[0];
    const saleInsert = await insertWithId(tx,
      `INSERT INTO sales
        (invoice_no, customer_id, warehouse_id, user_id, subtotal, discount, tax_amount,
         total, payment_method, payment_status, sale_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoiceNo, input.customer_id || null, input.warehouse_id, actorId,
        fromMinor(calculated.subtotal_minor), fromMinor(calculated.discount_total_minor),
        fromMinor(calculated.cgst_total_minor + calculated.sgst_total_minor + calculated.igst_total_minor),
        fromMinor(calculated.grand_total_minor), compatibilityPaymentMethod, 'pending', timestamp
      ]
    );
    const saleId = saleInsert.id || saleInsert.rows?.[0]?.id;
    const documentInsert = await insertWithId(tx,
      `INSERT INTO trade_documents
        (document_no, document_type, status, party_type, party_id, warehouse_id, source_document_id, currency,
         subtotal, discount, tax_total, grand_total, notes, metadata, created_by,
         approved_by, approved_at, fulfilled_at, created_at, updated_at)
       VALUES (?, 'invoice', 'completed', 'customer', ?, ?, ?, 'INR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoiceNo, input.customer_id || null, input.warehouse_id, sourceSalesOrder?.id || null,
        fromMinor(calculated.subtotal_minor), fromMinor(calculated.discount_total_minor),
        fromMinor(calculated.cgst_total_minor + calculated.sgst_total_minor + calculated.igst_total_minor),
        fromMinor(calculated.grand_total_minor), input.notes || null,
        JSON.stringify({ sale_id: saleId, channel: 'pos', invoice_engine: 'phase5-invoice-payments-002' }),
        actorId, actorId, timestamp, timestamp, timestamp, timestamp
      ]
    );
    const documentId = documentInsert.id || documentInsert.rows?.[0]?.id;
    const invoiceInsert = await insertWithId(tx,
      `INSERT INTO invoices
        (sale_id, trade_document_id, customer_id, invoice_number, invoice_status,
         payment_status, currency, subtotal_minor, discount_total_minor, taxable_total_minor,
         cgst_total_minor, sgst_total_minor, igst_total_minor, cess_total_minor,
         round_off_minor, grand_total_minor, issued_at, due_date, seller_snapshot,
         customer_snapshot, delivery_snapshot, bank_snapshot, terms_snapshot,
         document_settings_snapshot, pdf_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ISSUED', 'UNPAID', 'INR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
      [
        saleId, documentId, input.customer_id || null, invoiceNo,
        calculated.subtotal_minor, calculated.discount_total_minor, calculated.taxable_total_minor,
        calculated.cgst_total_minor, calculated.sgst_total_minor, calculated.igst_total_minor,
        calculated.cess_total_minor, calculated.round_off_minor, calculated.grand_total_minor,
        timestamp, dueDate, JSON.stringify(snapshots.seller), JSON.stringify(snapshots.customer),
        JSON.stringify(snapshots.delivery), JSON.stringify(snapshots.bank), snapshots.terms,
        JSON.stringify(snapshots.document || {}),
        timestamp, timestamp
      ]
    );
    const invoiceId = invoiceInsert.id || invoiceInsert.rows?.[0]?.id;
    for (const line of calculated.lines) {
      await tx.run(
        `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total_price)
         VALUES (?, ?, ?, ?, ?)`,
        [saleId, line.product_id, line.quantity, fromMinor(line.rate_minor), fromMinor(line.line_total_minor)]
      );
      await tx.run(
        `INSERT INTO trade_document_lines
          (document_id, product_id, variant_id, description, quantity, fulfilled_quantity,
           unit_price, discount, tax_rate, tax_amount, line_total, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        [documentId, line.product_id, line.variant_id || null, line.product.name, line.quantity,
          line.quantity, fromMinor(line.rate_minor), Number(line.gst_rate),
          fromMinor(line.cgst_minor + line.sgst_minor + line.igst_minor),
          fromMinor(line.line_total_minor), JSON.stringify({ sale_id: saleId, invoice_id: invoiceId })]
      );
      await tx.run(
        `INSERT INTO invoice_items
          (invoice_id, product_id, variant_id, description, hsn_sac, quantity, unit,
           rate_minor, gross_minor, discount_minor, taxable_minor, gst_rate,
           cgst_minor, sgst_minor, igst_minor, cess_minor, line_total_minor, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invoiceId, line.product_id, line.variant_id || null, line.product.name,
          line.hsn_sac || '', line.quantity, line.unit, line.rate_minor, line.gross_minor,
          line.discount_minor, line.taxable_minor, line.gst_rate, line.cgst_minor,
          line.sgst_minor, line.igst_minor, line.cess_minor, line.line_total_minor,
          JSON.stringify({ sku: line.product.sku, source: 'pos' })
        ]
      );
      await postStockMovementTx(tx, {
        product_id: line.product_id,
        variant_id: line.variant_id,
        warehouse_id: input.warehouse_id,
        movement_type: 'sale',
        quantity: line.quantity,
        reference_type: 'sale',
        reference_id: saleId
      }, actorId);
    }
    if (sourceSalesOrder) {
      await tx.run(
        'UPDATE trade_document_lines SET fulfilled_quantity = quantity WHERE document_id = ?',
        [sourceSalesOrder.id]
      );
      await tx.run(
        `UPDATE stock_reservations SET fulfilled_quantity = quantity, status = 'fulfilled', updated_at = ?
          WHERE reference_type = 'sales_order' AND reference_id = ? AND status = 'active'`,
        [timestamp, String(sourceSalesOrder.id)]
      );
      await tx.run(
        `UPDATE trade_documents SET status = 'completed', fulfilled_at = ?, updated_at = ? WHERE id = ?`,
        [timestamp, timestamp, sourceSalesOrder.id]
      );
      await tx.run(
        `INSERT INTO document_links
          (source_entity_type, source_entity_id, target_entity_type, target_entity_id,
           relationship_type, metadata, created_by, created_at)
         VALUES ('sales_order', ?, 'invoice', ?, 'converted_to:invoice', ?, ?, ?)`,
        [sourceSalesOrder.id, invoiceId, JSON.stringify({ invoice_number: invoiceNo, trade_document_id: documentId }), actorId, timestamp]
      );
      await timeline(tx, 'sales_order', sourceSalesOrder.id, 'converted.invoice', actorId, `${invoiceNo} was created.`);
    }
    const invoice = {
      id: invoiceId,
      sale_id: saleId,
      trade_document_id: documentId,
      customer_id: input.customer_id || null,
      invoice_number: invoiceNo,
      grand_total_minor: calculated.grand_total_minor,
      due_date: dueDate
    };
    await postInvoiceAccountingTx(tx, {
      invoiceId, invoiceNumber: invoiceNo, customerId: input.customer_id || null,
      taxableMinor: calculated.grand_total_minor - calculated.cgst_total_minor
        - calculated.sgst_total_minor - calculated.igst_total_minor - calculated.cess_total_minor,
      taxMinor: calculated.cgst_total_minor + calculated.sgst_total_minor
        + calculated.igst_total_minor + calculated.cess_total_minor,
      grandTotalMinor: calculated.grand_total_minor, issuedAt: timestamp
    }, actorId);
    const payments = await createCheckoutPaymentsTx(tx, { invoice, input, customer, actorId, req });
    for (const allocation of payments.allocations) await postPaymentAccountingTx(tx, allocation, actorId);
    await recordInvoiceLedgerTx(tx, invoice, payments, actorId);
    const paymentSummary = await calculateInvoicePaymentState(tx, invoiceId);
    await timeline(tx, 'invoice', documentId, 'pos.completed', actorId, `${invoiceNo} completed through POS.`);
    return {
      sale_id: saleId,
      trade_document_id: documentId,
      invoice_id: invoiceId,
      invoice_no: invoiceNo,
      total: fromMinor(calculated.grand_total_minor),
      payment_status: paymentSummary.status,
      payment_summary: paymentSummary,
      allocations: payments.allocations
    };
  });
  const pdf = await attemptInvoicePdf(db, req.user.organization_id, result.invoice_id, {
    actorId,
    generateBuffer: req.invoicePdfGenerator
  });
  const response = {
    success: true,
    saleId: result.sale_id,
    sale_id: result.sale_id,
    tradeDocumentId: result.trade_document_id,
    trade_document_id: result.trade_document_id,
    invoiceId: result.invoice_id,
    invoice_id: result.invoice_id,
    invoiceNumber: result.invoice_no,
    invoice_no: result.invoice_no,
    total: result.total,
    paymentStatus: result.payment_status,
    payment_status: result.payment_status,
    paymentSummary: result.payment_summary,
    payment_summary: result.payment_summary,
    allocations: result.allocations,
    pdf
  };
  await writeTenantAudit(db, req, {
    eventType: 'pos.checkout_completed',
    entityType: 'sale',
    entityId: result.sale_id,
    after: response
  });
  await announce(req, 'sales.changed', result);
  await announce(req, 'invoices.changed', { invoice_id: result.invoice_id, payment_status: result.payment_status, pdf });
  return response;
}

async function calculateLines(tx, lines, documentType) {
  let subtotal = 0;
  let taxTotal = 0;
  const calculated = [];
  for (const input of lines) {
    const product = await tx.one(
      `SELECT p.id, p.name, p.selling_price, p.cost_price,
              COALESCE(pc.gst_rate, 0) AS gst_rate, COALESCE(pc.minimum_price, 0) AS minimum_price,
              pc.maximum_price
         FROM products p LEFT JOIN product_commerce pc ON pc.product_id = p.id WHERE p.id = ? AND p.status = 1`,
      [input.product_id]
    );
    if (!product) throw httpError(422, 'invalid_product', `Product ${input.product_id} is unavailable.`);
    const quantity = Number(input.quantity);
    const unitPrice = Number(input.unit_price);
    const discount = Number(input.discount || 0);
    const taxRate = Number(input.tax_rate ?? product.gst_rate ?? 0);
    if (['quotation', 'sales_order', 'pro_forma_invoice', 'invoice', 'sales_return'].includes(documentType)) {
      if (unitPrice < Number(product.minimum_price || 0)) throw httpError(409, 'minimum_price_violation', `${product.name} cannot be sold below its minimum price.`);
      if (product.maximum_price != null && unitPrice > Number(product.maximum_price)) throw httpError(409, 'maximum_price_violation', `${product.name} exceeds its maximum price.`);
    }
    const taxable = Math.max(quantity * unitPrice - discount, 0);
    const taxAmount = roundMoney(taxable * taxRate / 100);
    const lineTotal = roundMoney(taxable + taxAmount);
    subtotal += taxable;
    taxTotal += taxAmount;
    calculated.push({ ...input, quantity, unit_price: unitPrice, discount, tax_rate: taxRate, tax_amount: taxAmount, line_total: lineTotal });
  }
  return {
    lines: calculated,
    subtotal: roundMoney(subtotal),
    tax_total: roundMoney(taxTotal),
    grand_total: roundMoney(subtotal + taxTotal)
  };
}

async function validateTradeParty(tx, documentType, input) {
  const partyType = partyTypeForDocument(documentType);
  if (!partyType) return;
  if (!input.party_id) throw httpError(422, 'party_required', `${capitalize(partyType)} is required.`);
  const table = partyTable(partyType);
  const party = await tx.one(`SELECT id FROM ${table} WHERE id = ?`, [input.party_id]);
  if (!party) throw httpError(422, 'invalid_party', `${capitalize(partyType)} was not found.`);
}

async function enforceCreditLimit(tx, documentType, customerId, amount) {
  if (!['quotation', 'sales_order', 'invoice'].includes(documentType) || !customerId) return;
  const customer = await tx.one('SELECT credit_limit, balance FROM customers WHERE id = ?', [customerId]);
  if (Number(customer.credit_limit || 0) > 0 && Number(customer.balance || 0) + amount > Number(customer.credit_limit)) {
    throw httpError(409, 'credit_limit_exceeded', 'This transaction would exceed the customer credit limit.');
  }
}

async function reserveSalesOrderTx(tx, documentId, userId) {
  const document = await tx.one('SELECT * FROM trade_documents WHERE id = ?', [documentId]);
  const lines = await tx.all('SELECT * FROM trade_document_lines WHERE document_id = ?', [documentId]);
  if (!document.warehouse_id) throw httpError(409, 'warehouse_required', 'A warehouse is required before approving this sales order.');
  for (const line of lines) {
    const balance = await availableStock(tx, document.warehouse_id, line.product_id);
    if (line.quantity > balance.available) throw httpError(409, 'insufficient_available_stock', `${line.quantity} units requested but only ${balance.available} are available.`);
    await tx.run(
      `INSERT INTO stock_reservations
        (reservation_no, product_id, variant_id, warehouse_id, quantity, fulfilled_quantity,
         reference_type, reference_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 'sales_order', ?, 'active', ?, ?)`,
      [`RES-SO-${documentId}-${line.id}`, line.product_id, line.variant_id || null,
        document.warehouse_id, line.quantity, String(documentId), now(), now()]
    );
  }
  await timeline(tx, 'sales_order', documentId, 'stock_reserved', userId, 'Stock was reserved during approval.');
}

async function releaseDocumentReservations(tx, document) {
  if (document.document_type !== 'sales_order') return;
  await tx.run(
    `UPDATE stock_reservations SET status = 'released', updated_at = ?
      WHERE reference_type = 'sales_order' AND reference_id = ? AND status = 'active'`,
    [now(), String(document.id)]
  );
}

async function availableStock(tx, warehouseId, productId) {
  const row = await tx.one(
    `SELECT COALESCE(ws.quantity, 0) AS on_hand, COALESCE(r.reserved, 0) AS reserved
       FROM (SELECT ? AS warehouse_id, ? AS product_id) x
       LEFT JOIN warehouse_stock ws ON ws.warehouse_id = x.warehouse_id AND ws.product_id = x.product_id
       LEFT JOIN (
         SELECT warehouse_id, product_id, SUM(quantity - fulfilled_quantity) AS reserved
           FROM stock_reservations WHERE status = 'active'
          GROUP BY warehouse_id, product_id
       ) r ON r.warehouse_id = x.warehouse_id AND r.product_id = x.product_id`,
    [warehouseId, productId]
  );
  return { on_hand: Number(row.on_hand || 0), reserved: Number(row.reserved || 0), available: Number(row.on_hand || 0) - Number(row.reserved || 0) };
}

async function consumeCostLayers(tx, { warehouseId, productId, quantity, method }) {
  const state = await tx.one(
    'SELECT average_cost FROM inventory_valuation_state WHERE warehouse_id = ? AND product_id = ?',
    [warehouseId, productId]
  );
  if (method === 'weighted_average' || !['fifo', 'lifo'].includes(method)) return Number(state?.average_cost || 0);
  const order = method === 'lifo' ? 'received_at DESC, id DESC' : 'received_at ASC, id ASC';
  const layers = await tx.all(
    `SELECT * FROM inventory_cost_layers
      WHERE warehouse_id = ? AND product_id = ? AND remaining_quantity > 0
      ORDER BY ${order}`,
    [warehouseId, productId]
  );
  let remaining = quantity;
  let totalCost = 0;
  for (const layer of layers) {
    if (remaining <= 0) break;
    const consumed = Math.min(remaining, Number(layer.remaining_quantity));
    totalCost += consumed * Number(layer.unit_cost);
    remaining -= consumed;
    await tx.run('UPDATE inventory_cost_layers SET remaining_quantity = remaining_quantity - ? WHERE id = ?', [consumed, layer.id]);
  }
  if (remaining > 1e-9) throw httpError(409, 'cost_layer_shortage', 'Inventory cost layers do not cover the requested stock issue.');
  return quantity ? totalCost / quantity : 0;
}

async function updateValuationState(tx, { warehouseId, productId, signedQuantity, unitCost, method }) {
  const current = await tx.one(
    'SELECT * FROM inventory_valuation_state WHERE warehouse_id = ? AND product_id = ?',
    [warehouseId, productId]
  );
  const oldOnHand = Number(current?.on_hand || 0);
  const oldValue = Number(current?.total_value || 0);
  const newOnHand = oldOnHand + signedQuantity;
  let newValue;
  if (signedQuantity > 0) newValue = oldValue + signedQuantity * unitCost;
  else newValue = Math.max(oldValue - Math.abs(signedQuantity) * unitCost, 0);
  const averageCost = newOnHand > 0 ? newValue / newOnHand : 0;
  await tx.run(
    `INSERT INTO inventory_valuation_state
      (warehouse_id, product_id, valuation_method, on_hand, average_cost, total_value, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (warehouse_id, product_id) DO UPDATE SET
       valuation_method = excluded.valuation_method, on_hand = excluded.on_hand,
       average_cost = excluded.average_cost, total_value = excluded.total_value,
       updated_at = excluded.updated_at`,
    [warehouseId, productId, method || 'weighted_average', newOnHand, averageCost, newValue, now()]
  );
}

function movementDirection(type, quantity) {
  const outbound = new Set(['sale', 'damage', 'transfer_out', 'purchase_return', 'adjustment_out']);
  const inbound = new Set(['opening', 'purchase_receipt', 'sales_return', 'transfer_in', 'adjustment_in']);
  if (outbound.has(type)) return 'out';
  if (inbound.has(type)) return 'in';
  if (type === 'adjustment') return quantity < 0 ? 'out' : 'in';
  throw httpError(422, 'invalid_movement_type', `Unsupported movement type '${type}'.`);
}

async function fulfillmentStatus(tx, documentId) {
  const totals = await tx.one(
    `SELECT SUM(quantity) AS ordered, SUM(fulfilled_quantity) AS fulfilled
       FROM trade_document_lines WHERE document_id = ?`,
    [documentId]
  );
  if (Number(totals.fulfilled) <= 0) return 'approved';
  return Number(totals.fulfilled) + 1e-9 >= Number(totals.ordered) ? 'fulfilled' : 'partially_fulfilled';
}

async function nextNumber(tx, type) {
  const prefixes = {
    quotation: 'QT', sales_order: 'SO', purchase_order: 'PO', goods_receipt: 'GRN',
    delivery_challan: 'DC', packing_list: 'PL', pro_forma_invoice: 'PI', invoice: 'INV',
    sales_return: 'SR', purchase_return: 'PR'
  };
  const year = new Date().getFullYear();
  const settingsRow = await tx.one(`SELECT setting_value FROM organization_settings WHERE setting_key = 'settings.documents'`);
  const documentSettings = parseJson(settingsRow?.setting_value, {});
  const numbering = documentSettings.numbering || {};
  const prefixKeys = {
    quotation: 'quotation_prefix', sales_order: 'sales_order_prefix', purchase_order: 'purchase_order_prefix',
    delivery_challan: 'delivery_prefix', packing_list: 'packing_list_prefix', pro_forma_invoice: 'pro_forma_prefix',
    credit_note: 'credit_note_prefix', debit_note: 'debit_note_prefix'
  };
  const basePrefix = String(numbering[prefixKeys[type]] || prefixes[type] || 'DOC').trim().toUpperCase();
  const yearlyReset = type === 'invoice' || numbering.yearly_reset === true;
  const sequenceKey = yearlyReset ? `${type}:${year}` : type;
  const prefix = yearlyReset ? `${basePrefix}-${year}` : basePrefix;
  const padding = Number(numbering.padding || 6);
  const lock = tx.dialect === 'postgres' ? ' FOR UPDATE' : '';
  let sequence = await tx.one(`SELECT * FROM number_sequences WHERE sequence_key = ?${lock}`, [sequenceKey]);
  if (!sequence) {
    await tx.run(
      'INSERT INTO number_sequences (sequence_key, prefix, next_value, padding, updated_at) VALUES (?, ?, 2, 6, ?)',
      [sequenceKey, prefix, now()]
    );
    sequence = { prefix, next_value: 1, padding };
  } else {
    await tx.run('UPDATE number_sequences SET prefix = ?, padding = ?, next_value = next_value + 1, updated_at = ? WHERE sequence_key = ?', [prefix, padding, now(), sequenceKey]);
    sequence = { ...sequence, prefix, padding };
  }
  let value = Number(sequence.next_value);
  let candidate = `${sequence.prefix}-${String(value).padStart(Number(sequence.padding), '0')}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const tradeExists = await tx.one('SELECT id FROM trade_documents WHERE document_no = ?', [candidate]);
    const saleExists = type === 'invoice' ? await tx.one('SELECT id FROM sales WHERE invoice_no = ?', [candidate]) : null;
    if (!tradeExists && !saleExists) return candidate;
    value += 1;
    candidate = `${sequence.prefix}-${String(value).padStart(Number(sequence.padding), '0')}`;
    await tx.run('UPDATE number_sequences SET next_value = ?, updated_at = ? WHERE sequence_key = ?', [value + 1, now(), sequenceKey]);
  }
  throw httpError(409, 'number_sequence_exhausted', `Could not allocate a unique ${type} number.`);
}

async function timeline(tx, entityType, entityId, eventType, actor, message, metadata = {}) {
  await tx.run(
    `INSERT INTO entity_timeline
      (entity_type, entity_id, event_type, actor_user_id, message, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [entityType, String(entityId), eventType, actor, message, JSON.stringify(metadata), now()]
  );
}

async function announce(req, event, payload) {
  await invalidateOrganizationCache(req.user.organization_id);
  await publishOrganizationEvent(req.user.organization_id, event, payload);
}

function mapDocumentType(routeType) {
  if (!DOCUMENT_TYPES.has(routeType)) throw httpError(404, 'document_type_not_found', 'Trade document type was not found.');
  return DOCUMENT_TYPE_MAP[routeType];
}

function assertConversionAllowed(source, targetType) {
  const targets = {
    quotation: new Set(['sales_order', 'pro_forma_invoice']),
    sales_order: new Set(['delivery_challan', 'packing_list'])
  };
  if (!targets[source.document_type]?.has(targetType)) {
    throw httpError(409, 'document_conversion_not_allowed', `${source.document_type} cannot be converted to ${targetType}.`);
  }
  const allowedStatuses = source.document_type === 'quotation'
    ? new Set(['approved', 'completed'])
    : new Set(['approved', 'partially_fulfilled', 'fulfilled']);
  if (!allowedStatuses.has(source.status)) {
    throw httpError(409, 'source_document_not_convertible', 'Approve the source document before converting it.');
  }
}

function partyTypeForDocument(documentType) {
  if (['quotation', 'sales_order', 'delivery_challan', 'packing_list', 'pro_forma_invoice', 'invoice', 'sales_return'].includes(documentType)) return 'customer';
  if (['purchase_order', 'purchase_return'].includes(documentType)) return 'supplier';
  return null;
}

function partyTable(partyType) {
  if (partyType === 'customer') return 'customers';
  if (partyType === 'supplier') return 'suppliers';
  throw httpError(404, 'party_type_not_found', 'Party type was not found.');
}

function normalizeJsonFields(row) {
  if (!row) return row;
  const normalized = { ...row };
  for (const key of ['metadata', 'attributes', 'tags', 'before_state', 'after_state', 'raw_response']) {
    if (key in normalized) normalized[key] = parseJson(normalized[key], key === 'tags' ? [] : {});
  }
  return normalized;
}

function insertWithId(tx, sql, params) {
  return tx.run(`${sql}${tx.dialect === 'postgres' ? ' RETURNING id' : ''}`, params);
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function monthStart() {
  const date = new Date();
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function now() {
  return new Date().toISOString();
}
