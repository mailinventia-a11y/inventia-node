import express from 'express';
import { supabase } from '../config/supabase.js';
import { checkRole } from './auth.js';

const router = express.Router();

// ================= CUSTOMERS =================

// Get all customers
router.get('/customers', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .order('name', { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create customer
router.post('/customers', checkRole(['admin', 'manager', 'cashier']), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('customers')
      .insert([req.body])
      .select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete customer
router.delete('/customers/:id', checkRole(['admin']), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('customers')
      .delete()
      .eq('id', req.params.id)
      .select();
    if (error) throw error;
    res.json({ success: true, data: data[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Razorpay Payment Gateway - Create Order Endpoint
router.post('/razorpay/create-order', checkRole(['admin', 'manager', 'cashier']), async (req, res) => {
  res.status(410).json({
    error: 'razorpay_route_retired',
    message: 'Use POST /api/v1/payments/razorpay/orders. Missing credentials return integration_not_configured.',
    replacement: '/api/v1/payments/razorpay/orders'
  });
});

// ================= POS CHECKOUT & SALES =================

// Checkout mutations have moved to the tenant-scoped, idempotent Phase 5 API.
router.post('/checkout', checkRole(['admin', 'manager', 'cashier']), async (req, res) => {
  res.status(410).json({
    error: 'checkout_route_retired',
    message: 'Use POST /api/v1/pos/checkout with Authorization and Idempotency-Key headers.',
    replacement: '/api/v1/pos/checkout'
  });
});

// ================= INVOICE PDF GENERATION =================

router.get('/invoice/:id/pdf', async (req, res) => {
  res.status(410).json({
    error: 'invoice_pdf_route_retired',
    message: 'Use GET /api/v1/invoices/:id/pdf with a tenant-scoped access token.',
    replacement: `/api/v1/invoices/${encodeURIComponent(req.params.id)}/pdf`
  });
});

// Get all sales history
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sales')
      .select(`
        *,
        customers(name, phone, address),
        users(full_name)
      `)
      .order('sale_date', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete sale transaction
router.delete('/:id', checkRole(['admin']), async (req, res) => {
  try {
    const { error } = await supabase
      .from('sales')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true, message: 'Sale deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
