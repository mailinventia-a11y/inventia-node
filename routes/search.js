import express from 'express';
import { checkRole } from './auth.js';
import { collectBusinessContext, searchBusiness } from '../src/services/aiBusinessService.js';

const router = express.Router();

router.get('/search', checkRole(['admin', 'manager', 'cashier', 'warehouse_staff']), async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (query.length < 2) return res.json({ query, results: [] });
  try {
    const context = await collectBusinessContext();
    res.json({ query, results: await searchBusiness(query, context) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
