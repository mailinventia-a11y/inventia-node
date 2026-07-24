import { supabase } from '../../config/db.js';
import { createGSTInvoice } from '../services/invoiceService.js';

/**
 * POS Checkout & GST Invoice Generator Controller
 */
export const handlePOSCheckout = async (req, res) => {
  const {
    customerId,
    warehouseId,
    items, // array of { productId, qty, rate, discountPercent, taxPercent, uom, name }
    discount = 0,
    paymentMethod = 'cash',
    paymentStatus = 'completed',
    challanNumber = 'N/A',
    transport = 'N/A',
    vehicle = 'N/A',
    ewayBill = 'N/A'
  } = req.body;

  // Defaults to admin/1 user if header is missing
  const userId = req.headers['x-user-id'] || '1';

  try {
    // 1. Validate Cart
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart items are required.' });
    }
    if (!warehouseId) {
      return res.status(400).json({ error: 'Warehouse location is required.' });
    }

    // Calculate totals for the Sale record
    let subtotal = 0;
    let totalDiscount = Number(discount);
    
    items.forEach(item => {
      subtotal += Number(item.qty) * Number(item.rate);
    });

    // 2. Create Sale in database
    const invoiceNo = 'INV-' + Date.now().toString().slice(-6);
    
    const { data: saleData, error: saleErr } = await supabase
      .from('sales')
      .insert([{
        invoice_no: invoiceNo,
        customer_id: customerId ? Number(customerId) : null,
        warehouse_id: Number(warehouseId),
        user_id: Number(userId),
        subtotal: subtotal,
        discount: totalDiscount,
        tax_amount: (subtotal - totalDiscount) * 0.18, // 18% default GST for Sale meta
        total: subtotal - totalDiscount + ((subtotal - totalDiscount) * 0.18),
        payment_method: paymentMethod,
        payment_status: paymentStatus
      }])
      .select();

    if (saleErr) throw saleErr;
    const sale = saleData[0];

    // Save individual sale item lines to database
    const saleItemInserts = items.map(item => ({
      sale_id: sale.id,
      product_id: item.productId,
      quantity: item.qty,
      unit_price: item.rate,
      total_price: Number(item.qty) * Number(item.rate)
    }));

    const { error: saleItemsErr } = await supabase
      .from('sale_items')
      .insert(saleItemInserts);

    if (saleItemsErr) throw saleItemsErr;

    // Adjust inventory levels (deduct stock from the warehouse)
    for (const item of items) {
      // Find current stock in selected warehouse
      const { data: wsData } = await supabase
        .from('warehouse_stock')
        .select('quantity')
        .eq('warehouse_id', warehouseId)
        .eq('product_id', item.productId)
        .maybeSingle();

      const currentQty = wsData ? wsData.quantity : 0;
      const newQty = Math.max(0, currentQty - item.qty);

      // Update warehouse stock
      await supabase
        .from('warehouse_stock')
        .update({ quantity: newQty })
        .eq('warehouse_id', warehouseId)
        .eq('product_id', item.productId);

      // Create an inventory audit trail log
      await supabase
        .from('inventory_logs')
        .insert([{
          product_id: item.productId,
          warehouse_id: warehouseId,
          change_qty: -item.qty,
          reason: 'sale',
          reference_id: sale.id,
          notes: `POS checkout invoice: ${invoiceNo}`,
          user_id: userId
        }]);
    }

    // 3. Create GST Invoice & Generate PDF
    const invoiceResult = await createGSTInvoice({
      customerId,
      saleId: sale.id,
      items,
      paymentMethod,
      paymentStatus,
      challanNumber,
      transport,
      vehicle,
      ewayBill
    });

    // 4. Return success response
    return res.status(200).json({
      success: true,
      invoiceNumber: invoiceResult.invoiceNumber,
      pdfUrl: invoiceResult.pdfUrl
    });

  } catch (err) {
    console.error('POS Checkout Controller Error:', err);
    return res.status(500).json({ error: err.message });
  }
};
