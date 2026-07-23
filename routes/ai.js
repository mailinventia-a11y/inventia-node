import express from 'express';
import { supabase } from '../config/supabase.js';
import { checkRole } from './auth.js';

const router = express.Router();

router.post('/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    // 1. Fetch products, brands, and categories to ground the answers
    const { data: products, error: pError } = await supabase.from('products').select('*');
    if (pError) throw pError;

    const { data: brands, error: bError } = await supabase.from('brands').select('*');
    if (bError) throw bError;

    const { data: categories, error: cError } = await supabase.from('categories').select('*');
    if (cError) throw cError;

    const { data: warehouses, error: wError } = await supabase.from('warehouses').select('*');
    if (wError) throw wError;

    const { data: stockData } = await supabase.from('warehouse_stock').select('product_id, quantity');
    const stockMap = {};
    if (stockData) {
      stockData.forEach(item => {
        stockMap[item.product_id] = (stockMap[item.product_id] || 0) + item.quantity;
      });
    }

    // Attach brands, categories, and stock to products manually for consistency in SQLite fallback
    const enrichedProducts = products.map(p => {
      const b = brands.find(brand => brand.id === p.brand_id);
      const c = categories.find(cat => cat.id === p.category_id);
      return {
        ...p,
        brands: b ? { name: b.name, code: b.code } : null,
        categories: c ? { name: c.name } : null,
        stock: stockMap[p.id] || 0
      };
    });

    const query = message.toLowerCase();
    let reply = "";

    if (query.includes('hello') || query.includes('hi') || query.includes('hey') || query.includes('greetings')) {
      reply = `Hello! I am your **POS AI Assistant**. I have real-time access to all products, brands, categories, and warehouses. How can I help you today?`;
    } else if (query.includes('products') || query.includes('list') || query.includes('catalog')) {
      const itemsList = enrichedProducts.slice(0, 5).map(p => `- **${p.name}** (SKU: \`${p.sku}\`) - **$${p.selling_price.toFixed(2)}**`).join('\n');
      reply = `Here is a sample of our active product catalog:\n\n${itemsList}\n\nAsk me about a specific item, brand, or category for more details.`;
    } else if (query.includes('price') || query.includes('cost') || query.includes('how much')) {
      const matched = enrichedProducts.find(p => query.includes(p.name.toLowerCase()) || query.includes(p.sku.toLowerCase()));
      if (matched) {
        reply = `The selling price for **${matched.name}** (SKU: \`${matched.sku}\`) is **$${matched.selling_price.toFixed(2)}** (UOM: ${matched.uom}). Cost price is $${matched.cost_price.toFixed(2)}.`;
      } else {
        reply = `I couldn't find a specific product matching that name in your query. Could you please specify the name or SKU?`;
      }
    } else if (query.includes('stock') || query.includes('qty') || query.includes('available') || query.includes('inventory')) {
      const matched = enrichedProducts.find(p => query.includes(p.name.toLowerCase()) || query.includes(p.sku.toLowerCase()));
      if (matched) {
        const stockQty = matched.stock || 0;
        reply = `We currently have **${stockQty} ${matched.uom}s** of **${matched.name}** in stock.\n\n*Status:* ${stockQty < matched.min_stock_alert ? '⚠️ LOW STOCK (Reorder Alert)' : '✅ OK'}`;
      } else {
        reply = `To check stock, please mention a product name or SKU (for example: "stock of Chocolate Bar" or "qty of FOD001").`;
      }
    } else if (query.includes('brand') || query.includes('maker') || query.includes('manufacturer')) {
      const brandNames = [...new Set(brands.map(b => b.name))];
      reply = `We carry the following brands in our inventory:\n${brandNames.map(b => `- **${b}**`).join('\n')}`;
    } else if (query.includes('category') || query.includes('type')) {
      const catNames = [...new Set(categories.map(c => c.name))];
      reply = `Our inventory is categorized into:\n${catNames.map(c => `- **${c}**`).join('\n')}`;
    } else if (query.includes('warehouse') || query.includes('location') || query.includes('showroom')) {
      const whList = warehouses.map(w => `- **${w.name}** (\`${w.code}\`) - *${w.type}* at ${w.address}`).join('\n');
      reply = `We have the following registered physical locations:\n\n${whList}`;
    } else {
      const keywords = query.split(' ');
      const searchResults = enrichedProducts.filter(p => 
        keywords.some(kw => kw.length > 2 && (
          p.name.toLowerCase().includes(kw) || 
          p.sku.toLowerCase().includes(kw) || 
          (p.material && p.material.toLowerCase().includes(kw)) ||
          (p.finish && p.finish.toLowerCase().includes(kw))
        ))
      );

      if (searchResults.length > 0) {
        const listStr = searchResults.slice(0, 3).map(p => `- **${p.name}** (SKU: \`${p.sku}\`) - Price: **$${p.selling_price.toFixed(2)}** | Material: *${p.material || 'N/A'}*`).join('\n');
        reply = `I found the following products matching your query:\n\n${listStr}`;
      } else {
        reply = `I am your POS AI Assistant. I can search inventory, look up prices, check stock levels, and list warehouse locations. Could you please rephrase or specify a product name/SKU?`;
      }
    }

    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
