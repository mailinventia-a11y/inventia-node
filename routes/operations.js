import express from 'express';
import { supabase } from '../config/supabase.js';
import { checkRole } from './auth.js';

const router = express.Router();
const privileged = checkRole(['admin', 'manager']);
const authenticated = checkRole(['admin', 'manager', 'cashier', 'warehouse_staff']);

router.get('/suppliers', authenticated, async (_req, res) => {
  const { data, error } = await supabase.from('suppliers').select('*').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/suppliers', privileged, async (req, res) => {
  const { name, phone, email, gstin, address, payment_terms = 0 } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Supplier name is required.' });
  const { data, error } = await supabase.from('suppliers').insert([{
    name: name.trim(), phone, email, gstin, address, payment_terms: Number(payment_terms) || 0
  }]).select();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data[0]);
});

router.get('/purchases', authenticated, async (_req, res) => {
  const { data, error } = await supabase.from('purchase_orders').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/purchases', privileged, async (req, res) => {
  const { supplier_id, warehouse_id, expected_date, notes, items } = req.body;
  if (!supplier_id || !warehouse_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Supplier, warehouse, and at least one item are required.' });
  }
  if (items.some(item => !item.product_id || Number(item.quantity) <= 0 || Number(item.unit_cost) < 0)) {
    return res.status(400).json({ error: 'Each item requires a product, positive quantity, and valid unit cost.' });
  }
  const total = items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_cost), 0);
  const orderNo = `PO-${Date.now()}`;
  const { data: orders, error } = await supabase.from('purchase_orders').insert([{
    order_no: orderNo, supplier_id, warehouse_id, expected_date, notes,
    status: 'draft', total, created_by: req.user.id
  }]).select();
  if (error) return res.status(400).json({ error: error.message });

  for (const item of items) {
    const { error: itemError } = await supabase.from('purchase_order_items').insert([{
      purchase_order_id: orders[0].id, product_id: item.product_id,
      quantity: Number(item.quantity), received_quantity: 0,
      unit_cost: Number(item.unit_cost),
      line_total: Number(item.quantity) * Number(item.unit_cost)
    }]);
    if (itemError) return res.status(500).json({ error: itemError.message });
  }
  await emitEvent('purchase.created', 'purchase_order', orders[0].id, req.user.id, { order_no: orderNo, total });
  res.status(201).json({ ...orders[0], items });
});

router.post('/purchases/:id/receive', privileged, async (req, res) => {
  const { data: order, error: orderError } = await supabase.from('purchase_orders').select('*').eq('id', req.params.id).single();
  if (orderError || !order) return res.status(404).json({ error: 'Purchase order not found.' });
  if (order.status === 'received') return res.status(409).json({ error: 'Purchase order has already been received.' });
  const { data: items, error: itemsError } = await supabase.from('purchase_order_items').select('*').eq('purchase_order_id', order.id);
  if (itemsError) return res.status(500).json({ error: itemsError.message });

  for (const item of items) {
    const { data: stock } = await supabase.from('warehouse_stock').select('*')
      .eq('warehouse_id', order.warehouse_id).eq('product_id', item.product_id).maybeSingle();
    if (stock) {
      await supabase.from('warehouse_stock').update({ quantity: Number(stock.quantity) + Number(item.quantity) })
        .eq('warehouse_id', order.warehouse_id).eq('product_id', item.product_id);
    } else {
      await supabase.from('warehouse_stock').insert([{
        warehouse_id: order.warehouse_id, product_id: item.product_id, quantity: item.quantity
      }]);
    }
    await supabase.from('purchase_order_items').update({ received_quantity: item.quantity }).eq('id', item.id);
    await supabase.from('inventory_logs').insert([{
      product_id: item.product_id, warehouse_id: order.warehouse_id,
      change_qty: item.quantity, reason: 'purchase_receipt', reference_id: order.id,
      notes: `Received ${order.order_no}`, user_id: req.user.id
    }]);
  }
  await supabase.from('purchase_orders').update({ status: 'received', received_at: new Date().toISOString() }).eq('id', order.id);
  await emitEvent('purchase.received', 'purchase_order', order.id, req.user.id, { order_no: order.order_no });
  res.json({ success: true, order_id: order.id, status: 'received' });
});

router.get('/events', privileged, async (_req, res) => {
  const { data, error } = await supabase.from('domain_events').select('*').order('created_at', { ascending: false }).limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(event => ({ ...event, payload: parseJson(event.payload) })));
});

router.get('/dashboard', authenticated, async (_req, res) => {
  const [products, sales, customers, orders] = await Promise.all([
    supabase.from('products').select('*'),
    supabase.from('sales').select('*'),
    supabase.from('customers').select('*'),
    supabase.from('purchase_orders').select('*')
  ]);
  res.json({
    products: products.data?.length || 0,
    customers: customers.data?.length || 0,
    sales: sales.data?.length || 0,
    revenue: (sales.data || []).reduce((sum, sale) => sum + Number(sale.total || 0), 0),
    open_purchases: (orders.data || []).filter(order => !['received', 'cancelled'].includes(order.status)).length
  });
});

async function emitEvent(eventType, entityType, entityId, userId, payload) {
  await supabase.from('domain_events').insert([{
    event_type: eventType, entity_type: entityType, entity_id: String(entityId),
    actor_user_id: userId, payload: JSON.stringify(payload)
  }]);
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return value; }
}

export default router;
