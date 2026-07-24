import express from 'express';
import { supabase } from '../config/supabase.js';
import { checkRole } from './auth.js';
import PDFDocument from 'pdfkit';

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
  try {
    const { amount, currency = 'INR', receipt = 'rcpt_' + Date.now() } = req.body;
    const razorpayOrderId = 'order_rzp_' + Math.random().toString(36).substring(2, 10);
    res.json({
      success: true,
      order_id: razorpayOrderId,
      amount: Math.round(Number(amount) * 100), // amount in paise
      currency: currency,
      key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_mockkey123'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= POS CHECKOUT & SALES =================

// POS Checkout Route
router.post('/checkout', checkRole(['admin', 'manager', 'cashier']), async (req, res) => {
  const {
    customer_id,
    warehouse_id,
    items, // array of { product_id, quantity, unit_price }
    discount = 0,
    tax_rate = 0.1, // 10% default
    payment_method, // cash, card, upi, razorpay, credit
    payment_status = 'completed'
  } = req.body;

  const userId = req.user.id;

  try {
    // 1. Calculate Totals
    let subtotal = 0;
    for (const item of items) {
      subtotal += item.quantity * item.unit_price;
    }

    const discountAmount = Number(discount);
    const taxAmount = (subtotal - discountAmount) * Number(tax_rate);
    const total = subtotal - discountAmount + taxAmount;

    // 2. Validate Customer Credit if payment method is "credit"
    if (payment_method === 'credit' && customer_id) {
      const { data: customer, error: custErr } = await supabase
        .from('customers')
        .select('credit_limit, balance')
        .eq('id', customer_id)
        .single();

      if (custErr || !customer) {
        return res.status(400).json({ error: 'Customer not found for credit sale.' });
      }

      const projectedBalance = Number(customer.balance) + total;
      if (projectedBalance > Number(customer.credit_limit)) {
        return res.status(400).json({ error: 'Credit limit exceeded for this customer.' });
      }
    }

    // 3. Verify Stock availability for all items in this warehouse
    for (const item of items) {
      const { data: stock, error: stockErr } = await supabase
        .from('warehouse_stock')
        .select('quantity')
        .eq('warehouse_id', warehouse_id)
        .eq('product_id', item.product_id)
        .maybeSingle();

      if (stockErr || !stock || stock.quantity < item.quantity) {
        return res.status(400).json({ error: `Insufficient stock for product ID: ${item.product_id}` });
      }
    }

    // 4. Generate unique invoice number
    const invoiceNo = 'INV-' + Date.now();

    // 5. Insert Sale header record
    const { data: saleData, error: saleError } = await supabase
      .from('sales')
      .insert([{
        invoice_no: invoiceNo,
        customer_id,
        warehouse_id,
        user_id: userId,
        subtotal,
        discount: discountAmount,
        tax_amount: taxAmount,
        total,
        payment_method,
        payment_status: payment_method === 'credit' ? 'pending' : payment_status
      }])
      .select();

    if (saleError) throw saleError;
    const saleId = saleData[0].id;

    // 6. Insert Sale Items, update stock ledger, and insert inventory audit log
    for (const item of items) {
      // Create Sale Item
      const { error: itemError } = await supabase
        .from('sale_items')
        .insert([{
          sale_id: saleId,
          product_id: item.product_id,
          quantity: item.quantity,
          unit_price: item.unit_price,
          total_price: item.quantity * item.unit_price
        }]);
      if (itemError) throw itemError;

      // Update Warehouse Stock
      const { data: currentStock } = await supabase
        .from('warehouse_stock')
        .select('quantity')
        .eq('warehouse_id', warehouse_id)
        .eq('product_id', item.product_id)
        .single();

      const newQty = currentStock.quantity - item.quantity;
      const { error: stockUpdateError } = await supabase
        .from('warehouse_stock')
        .update({ quantity: newQty })
        .eq('warehouse_id', warehouse_id)
        .eq('product_id', item.product_id);
      if (stockUpdateError) throw stockUpdateError;

      // Create Inventory Log
      const { error: logError } = await supabase
        .from('inventory_logs')
        .insert([{
          product_id: item.product_id,
          warehouse_id,
          change_qty: -item.quantity,
          reason: 'sale',
          reference_id: saleId,
          notes: `POS Sale Invoice: ${invoiceNo}`,
          user_id: userId
        }]);
      if (logError) throw logError;
    }

    // 7. Update Customer Account balance, points & Tier progression
    if (customer_id) {
      const { data: customer } = await supabase
        .from('customers')
        .select('balance, loyalty_points, tier')
        .eq('id', customer_id)
        .single();

      const currentPts = customer ? (customer.loyalty_points || 0) : 0;
      const currentBal = customer ? Number(customer.balance || 0) : 0;
      const newPoints = currentPts + Math.floor(total / 10); // 1 point per $10 spent
      const newBalance = payment_method === 'credit' ? currentBal + total : currentBal;

      let newTier = 'bronze';
      if (newPoints >= 1000) newTier = 'platinum';
      else if (newPoints >= 500) newTier = 'gold';
      else if (newPoints >= 100) newTier = 'silver';

      await supabase
        .from('customers')
        .update({
          balance: newBalance,
          loyalty_points: newPoints,
          tier: newTier
        })
        .eq('id', customer_id);
    }

    res.json({
      success: true,
      message: 'Sale transaction completed successfully.',
      saleId,
      invoice_no: invoiceNo,
      total
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= INVOICE PDF GENERATION =================

router.get('/invoice/:id/pdf', async (req, res) => {
  try {
    // 1. Fetch sale data
    const { data: sale, error: saleErr } = await supabase
      .from('sales')
      .select(`
        *,
        customers(name, phone, address),
        users(full_name)
      `)
      .eq('id', req.params.id)
      .single();

    if (saleErr || !sale) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }

    // 2. Fetch sale items
    const { data: items, error: itemsErr } = await supabase
      .from('sale_items')
      .select(`
        *,
        products(name, sku, uom)
      `)
      .eq('sale_id', req.params.id);

    if (itemsErr) throw itemsErr;

    // Fetch currency settings dynamically
    const { data: settingsData } = await supabase
      .from('settings')
      .select('setting_key, setting_value');

    let currencySymbol = '$';
    if (settingsData) {
      const sym = settingsData.find(s => s.setting_key === 'currency_symbol');
      if (sym) currencySymbol = sym.setting_value;
    }

    // 3. Generate PDF
    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Invoice-${sale.invoice_no}.pdf`);
    doc.pipe(res);

    // Header
    doc.fontSize(20).text('INVENTIA', { align: 'center' });
    doc.fontSize(10).text('Premium POS & Inventory Management System', { align: 'center' });
    doc.moveDown();

    // Invoice Meta
    doc.fontSize(12).text(`Invoice No: ${sale.invoice_no}`);
    doc.text(`Date: ${new Date(sale.sale_date).toLocaleString()}`);
    doc.text(`Payment Method: ${sale.payment_method.toUpperCase()}`);
    doc.text(`Served By: ${sale.users?.full_name || 'N/A'}`);
    doc.moveDown();

    // Customer info
    if (sale.customers) {
      doc.text('Bill To:', { underline: true });
      doc.text(`Name: ${sale.customers.name}`);
      doc.text(`Phone: ${sale.customers.phone}`);
      doc.text(`Address: ${sale.customers.address || 'N/A'}`);
      doc.moveDown();
    }

    // Table Header
    const tableTop = 330;
    doc.font('Helvetica-Bold');
    doc.text('Product / SKU', 50, tableTop);
    doc.text('Qty', 280, tableTop, { width: 50, align: 'right' });
    doc.text('Unit Price', 340, tableTop, { width: 80, align: 'right' });
    doc.text('Total', 430, tableTop, { width: 100, align: 'right' });
    doc.line(50, tableTop + 15, 530, tableTop + 15).stroke();
    doc.font('Helvetica');

    // Table Content
    let position = tableTop + 25;
    items.forEach(item => {
      doc.text(`${item.products.name} (${item.products.sku})`, 50, position, { width: 220 });
      doc.text(`${item.quantity} ${item.products.uom}`, 280, position, { width: 50, align: 'right' });
      doc.text(`${currencySymbol}${Number(item.unit_price).toFixed(2)}`, 340, position, { width: 80, align: 'right' });
      doc.text(`${currencySymbol}${Number(item.total_price).toFixed(2)}`, 430, position, { width: 100, align: 'right' });
      position += 20;
    });

    // Summary calculation
    doc.line(50, position + 5, 530, position + 5).stroke();
    position += 15;
    doc.text('Subtotal:', 340, position, { width: 80, align: 'right' });
    doc.text(`${currencySymbol}${Number(sale.subtotal).toFixed(2)}`, 430, position, { width: 100, align: 'right' });

    position += 15;
    doc.text('Discount:', 340, position, { width: 80, align: 'right' });
    doc.text(`-${currencySymbol}${Number(sale.discount).toFixed(2)}`, 430, position, { width: 100, align: 'right' });

    position += 15;
    doc.text('Tax:', 340, position, { width: 80, align: 'right' });
    doc.text(`${currencySymbol}${Number(sale.tax_amount).toFixed(2)}`, 430, position, { width: 100, align: 'right' });

    position += 20;
    doc.font('Helvetica-Bold');
    doc.text('Total Amount:', 340, position, { width: 80, align: 'right' });
    doc.text(`${currencySymbol}${Number(sale.total).toFixed(2)}`, 430, position, { width: 100, align: 'right' });

    // Footer
    doc.font('Helvetica-Oblique');
    doc.text('Thank you for shopping with Inventia!', 50, position + 60, { align: 'center' });

    doc.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
