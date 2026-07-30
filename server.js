import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import swaggerUi from 'swagger-ui-express';

import authRoutes from './routes/auth.js';
import inventoryRoutes from './routes/inventory.js';
import salesRoutes from './routes/sales.js';
import usersRoutes from './routes/users.js';
import settingsRoutes from './routes/settings.js';
import aiRoutes from './routes/ai.js';
import operationsRoutes from './routes/operations.js';
import documentsRoutes from './routes/documents.js';
import financeRoutes from './routes/finance.js';
import searchRoutes from './routes/search.js';
import v1Routes from './src/routes/v1Routes.js';
import { razorpayWebhookHandler } from './src/routes/razorpayWebhook.js';
import { phase5OpenApi } from './src/platform/openapi.js';
import { DEFAULT_ORGANIZATION_ID, initializePhase5Platform } from './src/platform/phase5Database.js';
import { hashPlatformPassword } from './src/platform/phase5Auth.js';
import { initializePhase5Runtime, runtimeState } from './src/platform/phase5Runtime.js';
import { notFoundV1, phase5ErrorHandler, requestContext } from './src/platform/phase5Http.js';

const app = express();
const PORT = process.env.PORT || 3000;
const APP_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_INDEX_FILE = path.join(APP_DIRECTORY, 'public', 'index.html');
const BARCODE_CLIENT_ROUTES = [
  '/barcodes',
  '/barcodes/products',
  '/barcodes/generate',
  '/barcodes/templates',
  '/barcodes/batch-print',
  '/barcodes/scanner',
  '/barcodes/print-queue',
  '/barcodes/history',
  '/barcodes/analytics',
  '/barcodes/recommendations',
  '/barcodes/settings'
];

app.use(requestContext);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 'Authorization', 'x-user-role', 'x-user-id',
    'x-request-id', 'idempotency-key', 'x-inventia-organization'
  ]
}));

// Signature verification requires the exact bytes sent by Razorpay.
app.post('/api/v1/webhooks/razorpay', express.raw({ type: 'application/json', limit: '2mb' }), razorpayWebhookHandler);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static('public'));
app.use('/uploads/invoices', (_req, res) => {
  res.status(404).json({ error: 'not_found', message: 'Invoice files require an authenticated invoice PDF endpoint.' });
});
app.use('/uploads', express.static('uploads'));

app.use('/api/v1/docs', swaggerUi.serve, swaggerUi.setup(phase5OpenApi));
app.get('/api/v1/openapi.json', (_req, res) => res.json(phase5OpenApi));
app.use('/api/v1', v1Routes);

// Phase 1-4 compatibility adapters remain available while the UI migrates.
app.use('/api', (req, res, next) => {
  const requestedOrganization = req.headers['x-inventia-organization'];
  if (requestedOrganization && requestedOrganization !== DEFAULT_ORGANIZATION_ID) {
    return res.status(409).json({
      error: 'compatibility_route_default_tenant_only',
      message: 'This compatibility endpoint is only available for the default organization. Use /api/v1 for the active tenant.',
      request_id: req.requestId
    });
  }
  next();
});
app.use('/api/auth', authRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/operations', operationsRoutes);
app.use('/api', documentsRoutes);
app.use('/api', financeRoutes);
app.use('/api', searchRoutes);

app.get('/api/status', (_req, res) => {
  res.json({
    status: 'online',
    environment: process.env.VERCEL ? 'vercel-serverless' : 'standalone-express',
    message: 'Inventia Enterprise Core Trade API',
    phase: 5,
    platform: runtimeState(),
    timestamp: new Date()
  });
});

app.get(BARCODE_CLIENT_ROUTES, (_req, res) => {
  res.sendFile(PUBLIC_INDEX_FILE);
});

app.use('/api/v1', notFoundV1);
app.use(phase5ErrorHandler);
app.use((err, req, res, _next) => {
  console.error(`[${req.requestId || 'no-request-id'}] Unhandled Application Error:`, err);
  res.status(err.status || 500).json({
    error: 'Internal Server Error',
    message: err.message || 'An unexpected error occurred.',
    request_id: req.requestId
  });
});

export default app;

if (!process.env.VERCEL) {
  const server = http.createServer(app);
  await initializePhase5Platform({ hashPassword: hashPlatformPassword });
  await initializePhase5Runtime(server);
  server.listen(PORT, () => {
    console.log(`Inventia Phase 5 API running at http://localhost:${PORT}`);
  });
}
