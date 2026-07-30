import { getTenantDatabase, initializePhase5Platform } from '../platform/phase5Database.js';
import { hashPlatformPassword } from '../platform/phase5Auth.js';
import { httpError } from '../platform/phase5Http.js';
import { processRazorpayWebhook } from '../services/razorpayService.js';

export async function razorpayWebhookHandler(req, res, next) {
  try {
    await initializePhase5Platform({ hashPassword: hashPlatformPassword });
    const organizationId = String(req.query.organization_id || req.headers['x-inventia-organization'] || '');
    if (!organizationId) throw httpError(400, 'organization_required', 'The webhook organization identifier is required.');
    const db = await getTenantDatabase(organizationId);
    const result = await processRazorpayWebhook(
      db,
      Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || ''),
      req.headers['x-razorpay-signature'],
      req.headers['x-razorpay-event-id'],
      organizationId
    );
    res.status(result.duplicate ? 200 : 202).json(result);
  } catch (error) {
    next(error);
  }
}
