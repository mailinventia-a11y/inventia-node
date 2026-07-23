import express from 'express';
import { supabase } from '../config/supabase.js';

const router = express.Router();

// Middleware to check authentication & role
export const checkRole = (allowedRoles) => {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ error: 'Authorization header is missing.' });
      }

      const token = authHeader.split(' ')[1];
      // In a production system, verify the JWT token here
      // For this implementation, we allow passing a custom header "x-user-role" for ease of testing/mocking
      const userRole = req.headers['x-user-role'] || 'cashier'; 
      const userId = req.headers['x-user-id'] || '1';

      if (!allowedRoles.includes(userRole)) {
        return res.status(403).json({ error: 'Access Denied: Insufficient permissions.' });
      }

      req.user = { id: userId, role: userRole };
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

    // In a real application, compare bcrypt hash. For simplicity:
    // we bypass security checks for demo/admin and return a mock session token
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        role: user.role
      },
      token: 'mock-session-jwt-token-key'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Current Profile
router.get('/profile', async (req, res) => {
  const userId = req.headers['x-user-id'] || '1';
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
