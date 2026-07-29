import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// Import Routes
import authRoutes from './routes/auth.js';
import inventoryRoutes from './routes/inventory.js';
import salesRoutes from './routes/sales.js';
import usersRoutes from './routes/users.js';
import settingsRoutes from './routes/settings.js';
import aiRoutes from './routes/ai.js';
import invoiceRoutes from './src/routes/invoiceRoutes.js';
import operationsRoutes from './routes/operations.js';
import documentsRoutes from './routes/documents.js';
import financeRoutes from './routes/finance.js';
import searchRoutes from './routes/search.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Security & Production Headers Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-user-role', 'x-user-id']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static UI assets if available (frontend)
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Mount API Endpoints
app.use('/api/auth', authRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/pos', invoiceRoutes);
app.use('/api/operations', operationsRoutes);
app.use('/api', documentsRoutes);
app.use('/api', financeRoutes);
app.use('/api', searchRoutes);

// Health Check / Welcome Endpoint
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    environment: process.env.VERCEL ? 'vercel-serverless' : 'standalone-express',
    message: 'Real-Time Interior Products Inventory & POS System API Server',
    timestamp: new Date()
  });
});

// Centralized Express Error Handling Middleware
app.use((err, req, res, next) => {
  console.error('Unhandled Application Error:', err);
  res.status(err.status || 500).json({
    error: 'Internal Server Error',
    message: err.message || 'An unexpected error occurred.'
  });
});

// Export app instance for serverless environments (Vercel)
export default app;

// Start standalone listener if run directly (Not on Vercel)
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`🚀 Interior POS API Server is running on port ${PORT}`);
    console.log(`📂 Base URL: http://localhost:${PORT}`);
    console.log(`==================================================`);
  });
}
