import express from 'express';
import { supabase } from '../config/supabase.js';
import { checkRole } from './auth.js';

const router = express.Router();

// Get all users
router.get('/', checkRole(['admin', 'manager']), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, username, full_name, email, role, status, created_at')
      .order('id', { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new user
router.post('/', checkRole(['admin']), async (req, res) => {
  const { username, password, full_name, email, role } = req.body;
  try {
    // In a real application, hash the password using bcrypt. 
    // We store a mock hashed password or simple string for demo
    const passwordHash = '$2y$10$jYDiutpajwvRPjavffXbVugffjwINhEua/lGu//OE7.iwBtW7Qwli'; // default 'admin123'
    
    const { data, error } = await supabase
      .from('users')
      .insert([{
        username,
        password_hash: passwordHash,
        full_name,
        email,
        role,
        status: 1
      }])
      .select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle user status (Active/Inactive)
router.put('/:id/status', checkRole(['admin']), async (req, res) => {
  const { status } = req.body;
  try {
    const { data, error } = await supabase
      .from('users')
      .update({ status })
      .eq('id', req.params.id)
      .select();
    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
