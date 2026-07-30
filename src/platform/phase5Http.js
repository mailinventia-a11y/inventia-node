import crypto from 'crypto';
import { z } from 'zod';

export function requestContext(req, res, next) {
  req.requestId = String(req.headers['x-request-id'] || crypto.randomUUID()).slice(0, 128);
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

export function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(httpError(422, 'validation_failed', 'The request contains invalid data.', {
        issues: z.flattenError(result.error)
      }));
    }
    req[source] = result.data;
    next();
  };
}

export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export async function executeIdempotent(req, work) {
  const method = req.method.toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return work();
  const key = String(req.headers['idempotency-key'] || '').trim();
  if (!key) throw httpError(400, 'idempotency_key_required', 'An Idempotency-Key header is required.');
  if (key.length > 200) throw httpError(400, 'invalid_idempotency_key', 'The idempotency key is too long.');

  const db = req.tenantDb;
  const requestHash = crypto.createHash('sha256')
    .update(JSON.stringify({ method, path: req.originalUrl, body: req.body || {} }))
    .digest('hex');
  const existing = await db.one('SELECT * FROM idempotency_records WHERE idempotency_key = ?', [key]);
  if (existing) {
    if (existing.user_id !== req.user.id || existing.request_path !== req.path || existing.request_hash !== requestHash) {
      throw httpError(409, 'idempotency_key_conflict', 'This idempotency key was used for a different request.');
    }
    if (existing.status === 'completed') {
      return {
        replayed: true,
        status: existing.response_status,
        body: parseJson(existing.response_body, {})
      };
    }
    throw httpError(409, 'request_in_progress', 'A request with this idempotency key is already in progress.');
  }

  await db.run(
    `INSERT INTO idempotency_records
      (idempotency_key, user_id, request_path, request_hash, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, 'processing', ?, ?)`,
    [key, req.user.id, req.path, requestHash, new Date(Date.now() + 86400000).toISOString(), now()]
  );

  try {
    const result = await work();
    const status = result?.status || 200;
    const body = result?.body ?? result;
    await db.run(
      `UPDATE idempotency_records
          SET response_status = ?, response_body = ?, status = 'completed'
        WHERE idempotency_key = ?`,
      [status, JSON.stringify(body), key]
    );
    return { replayed: false, status, body };
  } catch (error) {
    await db.run('DELETE FROM idempotency_records WHERE idempotency_key = ?', [key]);
    throw error;
  }
}

export async function writeTenantAudit(db, req, {
  eventType,
  entityType,
  entityId,
  before,
  after,
  metadata
}) {
  await db.run(
    `INSERT INTO audit_logs
      (request_id, actor_user_id, event_type, entity_type, entity_id,
       before_state, after_state, ip_address, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.requestId,
      req.user?.id || null,
      eventType,
      entityType || null,
      entityId == null ? null : String(entityId),
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after),
      req.ip,
      JSON.stringify(metadata || {}),
      now()
    ]
  );
}

export function sendMutation(res, result) {
  res.setHeader('Idempotency-Replayed', result.replayed ? 'true' : 'false');
  return res.status(result.status || 200).json(result.body);
}

export function notFoundV1(req, _res, next) {
  next(httpError(404, 'route_not_found', `No API route exists for ${req.method} ${req.originalUrl}.`));
}

export function phase5ErrorHandler(error, req, res, next) {
  if (!req.originalUrl.startsWith('/api/v1')) return next(error);
  const status = Number(error.status || 500);
  if (status >= 500) console.error(`[${req.requestId}]`, error);
  res.status(status).json({
    error: {
      code: error.code || 'internal_error',
      message: status >= 500 && !error.expose ? 'An unexpected server error occurred.' : error.message,
      details: error.details || undefined,
      request_id: req.requestId
    }
  });
}

export function httpError(status, code, message, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  error.expose = status < 500;
  return error;
}

export function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function now() {
  return new Date().toISOString();
}
