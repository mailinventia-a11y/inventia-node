import Decimal from 'decimal.js';
import { httpError, parseJson, writeTenantAudit } from '../platform/phase5Http.js';
import { invalidateOrganizationCache, publishOrganizationEvent } from '../platform/phase5Runtime.js';
import { calculateInvoicePaymentState } from './invoicePaymentService.js';
import {
  checkoutPos,
  createTradeDocument,
  getTradeDocument,
  postStockMovementTx,
  receivePurchaseOrder
} from './enterpriseTradeService.js';
import { fromMinor, toMinor } from './moneyService.js';
import { postFiscalAdjustmentAccountingTx } from './financeOperationsService.js';

const CONVERSION_ROUTES = Object.freeze({
  sales_order: 'sales-orders',
  pro_forma_invoice: 'pro-forma-invoices',
  delivery_challan: 'deliveries',
  packing_list: 'packing-lists'
});

export async function convertDocument(db, documentId, input, req) {
  const source = await getTradeDocument(db, documentId);
  const target = String(input.target_type || '').replace(/-/g, '_');
  if (target === 'invoice') return convertSalesOrderToInvoice(db, source, input, req);
  if (target === 'goods_receipt') return convertPurchaseOrderToReceipt(db, source, input, req);
  const route = CONVERSION_ROUTES[target];
  if (!route) throw httpError(422, 'conversion_target_invalid', 'The requested conversion target is not supported.');
  return createTradeDocument(db, route, {
    party_id: source.party_id,
    warehouse_id: source.warehouse_id,
    currency: source.currency || 'INR',
    discount: Number(source.discount || 0) + source.lines.reduce((sum, line) => sum + Number(line.discount || 0), 0),
    source_document_id: source.id,
    expected_at: input.expected_at || source.expected_at || undefined,
    notes: input.notes || source.notes || undefined,
    metadata: { converted_from: source.document_no, conversion_target: target },
    lines: source.lines.map(line => ({
      product_id: line.product_id,
      variant_id: line.variant_id || undefined,
      description: line.description || undefined,
      quantity: Number(line.quantity),
      unit_price: Number(line.unit_price),
      discount: Number(line.discount || 0),
      tax_rate: Number(line.tax_rate || 0),
      metadata: parseJson(line.metadata, {})
    }))
  }, req);
}

async function convertSalesOrderToInvoice(db, source, input, req) {
  if (source.document_type !== 'sales_order') throw httpError(409, 'invoice_conversion_source_invalid', 'Only a sales order can be converted to an invoice.');
  if (source.status !== 'approved') throw httpError(409, 'sales_order_not_invoiceable', 'The sales order must be approved and unfulfilled before invoicing.');
  if (!source.party_id || !source.warehouse_id) throw httpError(409, 'invoice_conversion_data_missing', 'Customer and warehouse are required.');
  const dueDate = input.due_date || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  return checkoutPos(db, {
    customer_id: source.party_id,
    warehouse_id: source.warehouse_id,
    items: source.lines.map(line => ({
      product_id: line.product_id,
      variant_id: line.variant_id || undefined,
      quantity: Number(line.quantity),
      unit_price: Number(line.unit_price)
    })),
    discount: Number(source.discount || 0),
    payment_method: 'credit',
    allow_partial_payment: true,
    due_date: dueDate,
    notes: input.notes || `Converted from ${source.document_no}.`,
    source_trade_document_id: source.id
  }, req);
}

async function convertPurchaseOrderToReceipt(db, source, input, req) {
  if (source.document_type !== 'purchase_order') throw httpError(409, 'receipt_conversion_source_invalid', 'Only a purchase order can produce a GRN.');
  const requested = Array.isArray(input.items) && input.items.length
    ? input.items
    : source.lines.map(line => ({ line_id: line.id, quantity: Number(line.quantity) - Number(line.fulfilled_quantity) })).filter(line => line.quantity > 0);
  return receivePurchaseOrder(db, source.id, {
    warehouse_id: source.warehouse_id,
    notes: input.notes,
    items: requested
  }, req);
}

export async function listDocumentLinks(db, query = {}) {
  const conditions = [];
  const params = [];
  if (query.entity_type && query.entity_id) {
    conditions.push(`((source_entity_type = ? AND source_entity_id = ?) OR (target_entity_type = ? AND target_entity_id = ?))`);
    params.push(query.entity_type, query.entity_id, query.entity_type, query.entity_id);
  }
  return db.all(`SELECT * FROM document_links ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 500`, params)
    .then(rows => rows.map(row => ({ ...row, metadata: parseJson(row.metadata, {}) })));
}

export async function listDocumentTemplates(db, query = {}) {
  const params = [];
  const where = [];
  if (query.document_type) { where.push('document_type = ?'); params.push(query.document_type); }
  if (query.status) { where.push('status = ?'); params.push(query.status); }
  const rows = await db.all(
    `SELECT * FROM document_templates ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY is_default DESC, name ASC`,
    params
  );
  return rows.map(row => ({ ...row, configuration: parseJson(row.configuration, {}) }));
}

export async function saveDocumentTemplate(db, id, input, req) {
  const actorId = req.user.tenant_user_id || req.user.id;
  const timestamp = now();
  const templateId = await db.transaction(async tx => {
    if (input.is_default) {
      await tx.run('UPDATE document_templates SET is_default = 0, updated_at = ? WHERE document_type = ? AND format = ?', [timestamp, input.document_type, input.format]);
    }
    if (id) {
      const existing = await tx.one('SELECT id FROM document_templates WHERE id = ?', [id]);
      if (!existing) throw httpError(404, 'document_template_not_found', 'The document template was not found.');
      await tx.run(
        `UPDATE document_templates SET name = ?, document_type = ?, format = ?, configuration = ?,
          is_default = ?, status = ?, updated_at = ? WHERE id = ?`,
        [input.name, input.document_type, input.format, JSON.stringify(input.configuration || {}), input.is_default ? 1 : 0, input.status, timestamp, id]
      );
      return Number(id);
    }
    const inserted = await insertWithId(tx,
      `INSERT INTO document_templates
        (name, document_type, format, configuration, is_default, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.name, input.document_type, input.format, JSON.stringify(input.configuration || {}), input.is_default ? 1 : 0, input.status, actorId, timestamp, timestamp]
    );
    return insertedId(inserted);
  });
  const template = await db.one('SELECT * FROM document_templates WHERE id = ?', [templateId]);
  const normalized = { ...template, configuration: parseJson(template.configuration, {}) };
  await writeTenantAudit(db, req, { eventType: id ? 'document_template.updated' : 'document_template.created', entityType: 'document_template', entityId: templateId, after: normalized });
  await announce(req, 'documents.changed', { action: id ? 'template_updated' : 'template_created', template_id: templateId });
  return normalized;
}

export async function listFiscalAdjustments(db, adjustmentType, query = {}) {
  const params = [normalizeAdjustmentType(adjustmentType)];
  const where = ['fa.adjustment_type = ?'];
  if (query.status) { where.push('fa.status = ?'); params.push(String(query.status).toUpperCase()); }
  if (query.party_id) { where.push('fa.party_id = ?'); params.push(query.party_id); }
  return db.all(
    `SELECT fa.*, c.name AS customer_name, s.name AS supplier_name, i.invoice_number,
            td.document_no AS source_document_no
       FROM fiscal_adjustments fa
       LEFT JOIN customers c ON fa.party_type = 'customer' AND c.id = fa.party_id
       LEFT JOIN suppliers s ON fa.party_type = 'supplier' AND s.id = fa.party_id
       LEFT JOIN invoices i ON i.id = fa.invoice_id
       LEFT JOIN trade_documents td ON td.id = fa.trade_document_id
      WHERE ${where.join(' AND ')} ORDER BY fa.created_at DESC, fa.id DESC`,
    params
  ).then(rows => rows.map(normalizeAdjustment));
}

export async function getFiscalAdjustment(db, id) {
  const adjustment = await db.one('SELECT * FROM fiscal_adjustments WHERE id = ?', [id]);
  if (!adjustment) throw httpError(404, 'fiscal_adjustment_not_found', 'The fiscal adjustment was not found.');
  const [lines, timeline, links] = await Promise.all([
    db.all('SELECT * FROM fiscal_adjustment_lines WHERE adjustment_id = ? ORDER BY id', [id]),
    db.all(`SELECT * FROM entity_timeline WHERE entity_type = 'fiscal_adjustment' AND entity_id = ? ORDER BY created_at DESC`, [String(id)]),
    db.all(`SELECT * FROM document_links WHERE target_entity_type = 'fiscal_adjustment' AND target_entity_id = ? ORDER BY created_at DESC`, [id])
  ]);
  return { ...normalizeAdjustment(adjustment), lines: lines.map(normalizeAdjustment), timeline, links: links.map(normalizeAdjustment) };
}

export async function createFiscalAdjustment(db, adjustmentType, input, req) {
  const type = normalizeAdjustmentType(adjustmentType);
  const actorId = req.user.tenant_user_id || req.user.id;
  const id = await db.transaction(async tx => {
    const source = await resolveAdjustmentSource(tx, type, input);
    const calculated = calculateAdjustmentLines(input.lines);
    if (type === 'CREDIT_NOTE' && source.invoice) {
      const prior = await tx.one(`SELECT COALESCE(SUM(grand_total_minor), 0) AS amount FROM fiscal_adjustments WHERE invoice_id = ? AND adjustment_type = 'CREDIT_NOTE' AND status <> 'CANCELLED'`, [source.invoice.id]);
      if (Number(prior?.amount || 0) + calculated.grand_total_minor > Number(source.invoice.grand_total_minor)) {
        throw httpError(409, 'credit_note_exceeds_invoice', 'Credit notes cannot exceed the original invoice total.');
      }
    }
    const adjustmentNumber = await nextAdjustmentNumber(tx, type);
    const timestamp = now();
    const inserted = await insertWithId(tx,
      `INSERT INTO fiscal_adjustments
        (adjustment_number, adjustment_type, status, invoice_id, trade_document_id,
         party_type, party_id, warehouse_id, currency, reason, subtotal_minor,
         tax_total_minor, grand_total_minor, affects_stock, party_snapshot,
         document_snapshot, created_by, created_at, updated_at)
       VALUES (?, ?, 'DRAFT', ?, ?, ?, ?, ?, 'INR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [adjustmentNumber, type, source.invoice?.id || null, source.tradeDocument?.id || null,
        source.partyType, source.party.id, input.warehouse_id || source.tradeDocument?.warehouse_id || null,
        input.reason, calculated.subtotal_minor, calculated.tax_total_minor,
        calculated.grand_total_minor, input.affects_stock ? 1 : 0,
        JSON.stringify(source.party), JSON.stringify(source.invoice || source.tradeDocument),
        actorId, timestamp, timestamp]
    );
    const adjustmentId = insertedId(inserted);
    for (const line of calculated.lines) {
      await tx.run(
        `INSERT INTO fiscal_adjustment_lines
          (adjustment_id, product_id, variant_id, description, quantity, unit,
           rate_minor, discount_minor, taxable_minor, tax_rate, tax_minor,
           line_total_minor, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [adjustmentId, line.product_id || null, line.variant_id || null, line.description,
          line.quantity, line.unit, line.rate_minor, line.discount_minor,
          line.taxable_minor, line.tax_rate, line.tax_minor, line.line_total_minor,
          JSON.stringify(line.metadata || {})]
      );
    }
    const sourceEntityType = source.invoice ? 'invoice' : 'trade_document';
    const sourceEntityId = source.invoice?.id || source.tradeDocument.id;
    await tx.run(
      `INSERT INTO document_links
        (source_entity_type, source_entity_id, target_entity_type, target_entity_id,
         relationship_type, metadata, created_by, created_at)
       VALUES (?, ?, 'fiscal_adjustment', ?, ?, ?, ?, ?)`,
      [sourceEntityType, sourceEntityId, adjustmentId, `adjustment:${type.toLowerCase()}`,
        JSON.stringify({ adjustment_number: adjustmentNumber }), actorId, timestamp]
    );
    await writeTimeline(tx, adjustmentId, 'created', actorId, `${adjustmentNumber} created as a draft.`);
    return adjustmentId;
  });
  const adjustment = await getFiscalAdjustment(db, id);
  await writeTenantAudit(db, req, { eventType: 'fiscal_adjustment.created', entityType: 'fiscal_adjustment', entityId: id, after: adjustment });
  await announce(req, 'documents.changed', { action: 'adjustment_created', adjustment_id: id });
  return adjustment;
}

export async function transitionFiscalAdjustment(db, id, action, input, req) {
  const actorId = req.user.tenant_user_id || req.user.id;
  const before = await getFiscalAdjustment(db, id);
  if (action === 'cancel') {
    if (before.status !== 'DRAFT') throw httpError(409, 'issued_adjustment_immutable', 'Issued fiscal notes require a reversing note and cannot be cancelled.');
    await db.run(`UPDATE fiscal_adjustments SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = ?, cancellation_reason = ?, updated_at = ? WHERE id = ?`, [actorId, now(), input.reason, now(), id]);
  } else if (action === 'issue') {
    if (before.status !== 'DRAFT') throw httpError(409, 'adjustment_not_draft', 'Only draft fiscal notes can be issued.');
    await db.transaction(async tx => {
      if (before.affects_stock) {
        if (!before.warehouse_id) throw httpError(409, 'warehouse_required', 'A warehouse is required when the note affects stock.');
        for (const line of before.lines) {
          if (!line.product_id) throw httpError(409, 'product_required_for_stock', 'Every stock-affecting line needs a product.');
          await postStockMovementTx(tx, {
            product_id: line.product_id,
            variant_id: line.variant_id,
            warehouse_id: before.warehouse_id,
            movement_type: before.adjustment_type === 'CREDIT_NOTE' ? 'sales_return' : 'purchase_return',
            quantity: Number(line.quantity),
            unit_cost: fromMinor(line.rate_minor),
            reference_type: before.adjustment_type.toLowerCase(),
            reference_id: id
          }, actorId);
        }
      }
      const direction = before.adjustment_type === 'CREDIT_NOTE' ? 'CREDIT' : 'DEBIT';
      await tx.run(
        `INSERT INTO party_ledger_entries
          (party_type, party_id, fiscal_adjustment_id, direction, amount_minor,
           reference_number, description, created_by, occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [before.party_type, before.party_id, id, direction, before.grand_total_minor,
          before.adjustment_number, before.reason, actorId, now(), now()]
      );
      if (before.party_type === 'customer') {
        const delta = direction === 'CREDIT' ? -fromMinor(before.grand_total_minor) : fromMinor(before.grand_total_minor);
        await tx.run(
          'UPDATE customers SET balance = CASE WHEN balance + ? < 0 THEN 0 ELSE balance + ? END WHERE id = ?',
          [delta, delta, before.party_id]
        );
      }
      await tx.run(`UPDATE fiscal_adjustments SET status = 'ISSUED', issued_by = ?, issued_at = ?, updated_at = ? WHERE id = ?`, [actorId, now(), now(), id]);
      await postFiscalAdjustmentAccountingTx(tx, before, actorId);
      await writeTimeline(tx, id, 'issued', actorId, `${before.adjustment_number} issued.`);
    });
    if (before.invoice_id) await calculateInvoicePaymentState(db, before.invoice_id);
  } else {
    throw httpError(422, 'adjustment_action_invalid', 'The fiscal adjustment action is invalid.');
  }
  const after = await getFiscalAdjustment(db, id);
  await writeTenantAudit(db, req, { eventType: `fiscal_adjustment.${action}d`, entityType: 'fiscal_adjustment', entityId: id, before, after });
  await announce(req, 'documents.changed', { action: `adjustment_${action}d`, adjustment_id: Number(id) });
  return after;
}

async function resolveAdjustmentSource(tx, type, input) {
  if (type === 'CREDIT_NOTE') {
    const invoice = await tx.one('SELECT * FROM invoices WHERE id = ?', [input.invoice_id]);
    if (!invoice || invoice.invoice_status !== 'ISSUED') throw httpError(404, 'invoice_not_adjustable', 'An issued invoice is required.');
    if (!invoice.customer_id) throw httpError(409, 'invoice_customer_required', 'Credit notes require an invoice customer.');
    const party = await tx.one('SELECT * FROM customers WHERE id = ?', [invoice.customer_id]);
    return { invoice, tradeDocument: null, partyType: 'customer', party };
  }
  const tradeDocument = await tx.one('SELECT * FROM trade_documents WHERE id = ?', [input.trade_document_id]);
  if (!tradeDocument || tradeDocument.party_type !== 'supplier') throw httpError(404, 'supplier_document_not_adjustable', 'A supplier document is required.');
  const party = await tx.one('SELECT * FROM suppliers WHERE id = ?', [tradeDocument.party_id]);
  return { invoice: null, tradeDocument, partyType: 'supplier', party };
}

function calculateAdjustmentLines(lines) {
  let subtotal = new Decimal(0);
  let taxTotal = new Decimal(0);
  const calculated = lines.map(line => {
    const quantity = new Decimal(line.quantity);
    const rate = new Decimal(line.rate);
    const discount = new Decimal(line.discount || 0);
    const taxable = Decimal.max(quantity.mul(rate).minus(discount), 0);
    const tax = taxable.mul(new Decimal(line.tax_rate || 0)).div(100);
    const total = taxable.plus(tax);
    subtotal = subtotal.plus(taxable);
    taxTotal = taxTotal.plus(tax);
    return {
      ...line,
      quantity: quantity.toString(), unit: line.unit || 'piece',
      rate_minor: toMinor(rate), discount_minor: toMinor(discount),
      taxable_minor: toMinor(taxable), tax_rate: new Decimal(line.tax_rate || 0).toString(),
      tax_minor: toMinor(tax), line_total_minor: toMinor(total)
    };
  });
  return { lines: calculated, subtotal_minor: toMinor(subtotal), tax_total_minor: toMinor(taxTotal), grand_total_minor: toMinor(subtotal.plus(taxTotal)) };
}

async function nextAdjustmentNumber(tx, type) {
  const key = type === 'CREDIT_NOTE' ? 'credit_note' : 'debit_note';
  const fallback = type === 'CREDIT_NOTE' ? 'CN' : 'DN';
  const settingsRow = await tx.one(`SELECT setting_value FROM organization_settings WHERE setting_key = 'settings.documents'`);
  const settings = parseJson(settingsRow?.setting_value, {});
  const numbering = settings.numbering || {};
  const prefix = String(type === 'CREDIT_NOTE' ? numbering.credit_note_prefix || fallback : numbering.debit_note_prefix || fallback).trim().toUpperCase();
  const padding = Number(numbering.padding || 6);
  const year = new Date().getFullYear();
  const sequenceKey = numbering.yearly_reset ? `${key}:${year}` : key;
  const formattedPrefix = numbering.yearly_reset ? `${prefix}-${year}` : prefix;
  const lock = tx.dialect === 'postgres' ? ' FOR UPDATE' : '';
  let sequence = await tx.one(`SELECT * FROM number_sequences WHERE sequence_key = ?${lock}`, [sequenceKey]);
  if (!sequence) {
    await tx.run('INSERT INTO number_sequences (sequence_key, prefix, next_value, padding, updated_at) VALUES (?, ?, 2, ?, ?)', [sequenceKey, formattedPrefix, padding, now()]);
    sequence = { prefix: formattedPrefix, next_value: 1, padding };
  } else {
    await tx.run('UPDATE number_sequences SET prefix = ?, padding = ?, next_value = next_value + 1, updated_at = ? WHERE sequence_key = ?', [formattedPrefix, padding, now(), sequenceKey]);
    sequence = { ...sequence, prefix: formattedPrefix, padding };
  }
  let value = Number(sequence.next_value);
  let candidate = `${sequence.prefix}-${String(value).padStart(Number(sequence.padding), '0')}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const exists = await tx.one('SELECT id FROM fiscal_adjustments WHERE adjustment_number = ?', [candidate]);
    if (!exists) return candidate;
    value += 1;
    candidate = `${sequence.prefix}-${String(value).padStart(Number(sequence.padding), '0')}`;
    await tx.run('UPDATE number_sequences SET next_value = ?, updated_at = ? WHERE sequence_key = ?', [value + 1, now(), sequenceKey]);
  }
  throw httpError(409, 'number_sequence_exhausted', `Could not allocate a unique ${type.toLowerCase()} number.`);
}

function normalizeAdjustmentType(value) {
  const normalized = String(value || '').replace(/-/g, '_').toUpperCase().replace(/S$/, '');
  if (!['CREDIT_NOTE', 'DEBIT_NOTE'].includes(normalized)) throw httpError(404, 'adjustment_type_not_found', 'Fiscal adjustment type was not found.');
  return normalized;
}

function normalizeAdjustment(row) {
  if (!row) return row;
  const normalized = { ...row };
  for (const key of ['party_snapshot', 'document_snapshot', 'metadata']) normalized[key] = parseJson(normalized[key], {});
  normalized.grand_total = fromMinor(normalized.grand_total_minor || 0);
  normalized.subtotal = fromMinor(normalized.subtotal_minor || 0);
  normalized.tax_total = fromMinor(normalized.tax_total_minor || 0);
  return normalized;
}

async function writeTimeline(tx, id, eventType, actor, message) {
  await tx.run(`INSERT INTO entity_timeline (entity_type, entity_id, event_type, actor_user_id, message, metadata, created_at) VALUES ('fiscal_adjustment', ?, ?, ?, ?, ?, ?)`, [String(id), eventType, actor, message, JSON.stringify({}), now()]);
}

async function announce(req, event, payload) {
  await invalidateOrganizationCache(req.user.organization_id);
  await publishOrganizationEvent(req.user.organization_id, event, payload);
}

function insertWithId(tx, sql, params) {
  return tx.run(`${sql}${tx.dialect === 'postgres' ? ' RETURNING id' : ''}`, params);
}

function insertedId(result) {
  return result.id || result.rows?.[0]?.id;
}

function now() {
  return new Date().toISOString();
}
