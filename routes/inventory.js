import express from 'express';
import { supabase } from '../config/supabase.js';
import { checkRole } from './auth.js';
import fs from 'fs';
import path from 'path';

const router = express.Router();

// ================= BRANDS & CATEGORIES =================

// Get all brands
router.get('/brands', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('brands')
      .select('*')
      .order('name', { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a brand
router.post('/brands', checkRole(['admin', 'manager']), async (req, res) => {
  const { name, code, logo_url } = req.body;
  try {
    const { data, error } = await supabase
      .from('brands')
      .insert([{ name, code, logo_url }])
      .select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all categories & subcategories
router.get('/categories', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('categories')
      .select('*')
      .order('name', { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create category / subcategory
router.post('/categories', checkRole(['admin', 'manager']), async (req, res) => {
  const { name, parent_id, description } = req.body;
  try {
    const { data, error } = await supabase
      .from('categories')
      .insert([{ name, parent_id, description }])
      .select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= PRODUCTS =================

// Get all products (with brand & category data and aggregated stock)
router.get('/products', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select(`
        *,
        brands(name, code),
        categories(name)
      `)
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Fetch all stock quantities to aggregate
    const { data: stockData } = await supabase
      .from('warehouse_stock')
      .select('product_id, quantity');

    const stockMap = {};
    if (stockData) {
      stockData.forEach(item => {
        stockMap[item.product_id] = (stockMap[item.product_id] || 0) + item.quantity;
      });
    }

    // Fetch all sales quantities from sale_items to aggregate sales_count
    const { data: salesData } = await supabase
      .from('sale_items')
      .select('product_id, quantity');

    const salesMap = {};
    if (salesData) {
      salesData.forEach(item => {
        salesMap[item.product_id] = (salesMap[item.product_id] || 0) + item.quantity;
      });
    }

    const productsWithStock = data.map(p => ({
      ...p,
      stock: stockMap[p.id] || 0,
      sales_count: salesMap[p.id] || 0
    }));

    res.json(productsWithStock);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single product details & stock level across warehouses
router.get('/products/:id', async (req, res) => {
  try {
    const { data: product, error: prodErr } = await supabase
      .from('products')
      .select(`
        *,
        brands(name, code),
        categories(name)
      `)
      .eq('id', req.params.id)
      .single();

    if (prodErr || !product) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    // Get stock levels
    const { data: stock, error: stockErr } = await supabase
      .from('warehouse_stock')
      .select(`
        quantity,
        bin_location,
        warehouses(name, code, type)
      `)
      .eq('product_id', req.params.id);

    // Sum stock
    const totalStock = stock ? stock.reduce((sum, item) => sum + item.quantity, 0) : 0;

    res.json({
      ...product,
      stock: totalStock,
      stock_distribution: stock || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new Product
router.post('/products', checkRole(['admin', 'manager']), async (req, res) => {
  const {
    sku, barcode, name, brand_id, category_id, description,
    uom, coverage_per_box, cost_price, selling_price,
    material, finish, dimensions, shade_lot_number, min_stock_alert, image_url
  } = req.body;

  try {
    const { data, error } = await supabase
      .from('products')
      .insert([{
        sku, barcode, name, brand_id, category_id, description,
        uom, coverage_per_box, cost_price, selling_price,
        material, finish, dimensions, shade_lot_number, min_stock_alert, image_url
      }])
      .select();

    if (error) throw error;

    // Seed default warehouse stock of 0 in Main Warehouse (ID 1)
    await supabase.from('warehouse_stock').insert([{
      warehouse_id: 1,
      product_id: data[0].id,
      quantity: 0
    }]);

    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update Product
router.put('/products/:id', checkRole(['admin', 'manager']), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .update(req.body)
      .eq('id', req.params.id)
      .select();

    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete Product
router.delete('/products/:id', checkRole(['admin', 'manager']), async (req, res) => {
  try {
    const { error } = await supabase
      .from('products')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true, message: 'Product deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST Product Image Upload (Base64)
router.post('/products/upload', checkRole(['admin', 'manager']), async (req, res) => {
  const { fileName, base64Data } = req.body;
  try {
    if (!fileName || !base64Data) {
      return res.status(400).json({ error: 'Missing file details.' });
    }

    // Ensure uploads directory exists
    const uploadDir = path.join(process.cwd(), 'public', 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Strip base64 metadata prefix if exists
    const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(cleanBase64, 'base64');

    // Create unique filename to prevent conflict
    const fileExt = path.extname(fileName) || '.jpg';
    const uniqueFileName = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}${fileExt}`;
    const filePath = path.join(uploadDir, uniqueFileName);

    // Save file
    fs.writeFileSync(filePath, buffer);

    res.json({
      success: true,
      imageUrl: `/uploads/${uniqueFileName}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= WAREHOUSES & STOCK =================

// Get all warehouses
router.get('/warehouses', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('warehouses')
      .select('*')
      .order('name', { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a warehouse
router.post('/warehouses', checkRole(['admin']), async (req, res) => {
  const { name, code, type, address } = req.body;
  try {
    const { data, error } = await supabase
      .from('warehouses')
      .insert([{ name, code, type, address }])
      .select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stock Inwarding / Stock Adjustments
router.post('/stock/adjust', checkRole(['admin', 'manager', 'warehouse_staff']), async (req, res) => {
  const { product_id, warehouse_id, quantity_change, reason, notes } = req.body;
  const userId = req.user.id;

  try {
    // 1. Get current stock
    const { data: currentStock, error: stockFetchError } = await supabase
      .from('warehouse_stock')
      .select('*')
      .eq('warehouse_id', warehouse_id)
      .eq('product_id', product_id)
      .maybeSingle();

    let newQuantity = quantity_change;
    if (currentStock) {
      newQuantity = currentStock.quantity + quantity_change;
      // Update quantity
      const { error: updateError } = await supabase
        .from('warehouse_stock')
        .update({ quantity: newQuantity })
        .eq('id', currentStock.id);
      if (updateError) throw updateError;
    } else {
      // Create new stock record
      const { error: insertError } = await supabase
        .from('warehouse_stock')
        .insert([{ warehouse_id, product_id, quantity: quantity_change }]);
      if (insertError) throw insertError;
    }

    // 2. Log changes into Audit Trail (inventory_logs)
    const { error: logError } = await supabase
      .from('inventory_logs')
      .insert([{
        product_id,
        warehouse_id,
        change_qty: quantity_change,
        reason,
        notes,
        user_id: userId
      }]);
    if (logError) throw logError;

    res.json({ success: true, message: 'Stock adjusted successfully.', newQuantity });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= STOCK TRANSFERS =================

// Create Stock Transfer Request
router.post('/stock/transfer', checkRole(['admin', 'manager', 'warehouse_staff']), async (req, res) => {
  const { from_warehouse_id, to_warehouse_id, product_id, quantity } = req.body;
  const userId = req.user.id;

  try {
    // Check if source warehouse has enough stock
    const { data: sourceStock, error: sourceError } = await supabase
      .from('warehouse_stock')
      .select('quantity')
      .eq('warehouse_id', from_warehouse_id)
      .eq('product_id', product_id)
      .single();

    if (sourceError || !sourceStock || sourceStock.quantity < quantity) {
      return res.status(400).json({ error: 'Insufficient stock in source warehouse.' });
    }

    // Create Stock Transfer record (Pending status)
    const { data: transfer, error: transferError } = await supabase
      .from('stock_transfers')
      .insert([{
        from_warehouse_id,
        to_warehouse_id,
        product_id,
        quantity,
        status: 'pending',
        requested_by: userId
      }])
      .select();

    if (transferError) throw transferError;
    res.status(201).json(transfer[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all stock transfers
router.get('/stock/transfers', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('stock_transfers')
      .select(`
        *,
        products(name, sku)
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update category
router.put('/categories/:id', checkRole(['admin', 'manager']), async (req, res) => {
  const { name, parent_id, description } = req.body;
  try {
    const { data, error } = await supabase
      .from('categories')
      .update({ name, parent_id, description, updated_at: new Date() })
      .eq('id', req.params.id)
      .select();
    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete category
router.delete('/categories/:id', checkRole(['admin']), async (req, res) => {
  try {
    const { error } = await supabase
      .from('categories')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true, message: 'Category deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update brand
router.put('/brands/:id', checkRole(['admin', 'manager']), async (req, res) => {
  const { name, code, logo_url } = req.body;
  try {
    const { data, error } = await supabase
      .from('brands')
      .update({ name, code, logo_url })
      .eq('id', req.params.id)
      .select();
    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete brand
router.delete('/brands/:id', checkRole(['admin']), async (req, res) => {
  try {
    const { error } = await supabase
      .from('brands')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true, message: 'Brand deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update warehouse
router.put('/warehouses/:id', checkRole(['admin', 'manager']), async (req, res) => {
  const { name, code, type, address } = req.body;
  try {
    const { data, error } = await supabase
      .from('warehouses')
      .update({ name, code, type, address })
      .eq('id', req.params.id)
      .select();
    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete warehouse
router.delete('/warehouses/:id', checkRole(['admin']), async (req, res) => {
  try {
    const { error } = await supabase
      .from('warehouses')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true, message: 'Warehouse location deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
