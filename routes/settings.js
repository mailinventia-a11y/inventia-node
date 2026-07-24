import express from 'express';
import { supabase } from '../config/supabase.js';
import { checkRole } from './auth.js';

const router = express.Router();

// Get settings
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('*');
    
    if (error || !data || data.length === 0) {
      // Return default configuration
      return res.json([
        { setting_key: 'company_name', setting_value: 'Inventia' },
        { setting_key: 'company_address', setting_value: '123 Business Street, City, State 12345' },
        { setting_key: 'company_email', setting_value: 'info@inventia.com' },
        { setting_key: 'company_phone', setting_value: '+1 234 567 890' },
        { setting_key: 'company_code', setting_value: 'INR' },
        { setting_key: 'currency_code', setting_value: 'INR' },
        { setting_key: 'currency_symbol', setting_value: '₹' },
        { setting_key: 'tax_rate', setting_value: '0.10' },
        { setting_key: 'theme_mode', setting_value: 'light' },
        { setting_key: 'theme_color', setting_value: 'blue' }
      ]);
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update settings
router.put('/', checkRole(['admin']), async (req, res) => {
  const settings = req.body; // array of { setting_key, setting_value }
  try {
    for (const item of settings) {
      const { error } = await supabase
        .from('app_settings')
        .upsert([{ setting_key: item.setting_key, setting_value: item.setting_value }]);
      if (error) throw error;
    }
    res.json({ success: true, message: 'Settings updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
