import express from 'express';
import { supabase } from '../config/supabase.js';
import { createToken, verifyPassword, verifyToken } from '../src/utils/authToken.js';

const router = express.Router();

// Middleware to check authentication & role
export const checkRole = (allowedRoles) => {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ error: 'Authorization header is missing.' });
      }

      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      const session = verifyToken(token);
      if (!session) return res.status(401).json({ error: 'Your session is invalid or has expired.' });

      if (!allowedRoles.includes(session.role)) {
        return res.status(403).json({ error: 'Access Denied: Insufficient permissions.' });
      }

      req.user = session;
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
};

// Login Route
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    // Check user credentials from the database
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    if (!user.status || !verifyPassword(password, user.password_hash, user.username)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        role: user.role
      },
      token: createToken(user)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Current Profile
router.get('/profile', checkRole(['admin', 'manager', 'cashier', 'warehouse_staff']), async (req, res) => {
  const userId = req.user.id;
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, full_name, email, role, status')
      .eq('id', userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
