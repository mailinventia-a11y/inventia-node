import 'dotenv/config';
import { Worker } from 'bullmq';
import { redisOptions } from '../platform/phase5Runtime.js';
import { getTenantDatabase, initializePhase5Platform } from '../platform/phase5Database.js';
import { hashPlatformPassword } from '../platform/phase5Auth.js';
import { attemptInvoicePdf } from '../services/invoicePaymentService.js';
import { processBarcodePrintJob } from '../services/barcodeLabelService.js';
import { processReminderDelivery } from '../services/businessOperationsService.js';

if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL is required to run the Phase 5 worker.');
}

await initializePhase5Platform({ hashPassword: hashPlatformPassword });

const worker = new Worker('inventia-domain-jobs', async job => {
  switch (job.name) {
    case 'audit.retention':
      return { acknowledged: true, organization_id: job.data.organization_id };
    case 'dashboard.refresh':
      return { invalidated: true, organization_id: job.data.organization_id };
    case 'payment.reconcile':
      return { requested: true, organization_id: job.data.organization_id };
    case 'invoice.pdf.generate': {
      const db = await getTenantDatabase(job.data.organization_id);
      await db.run(
        `UPDATE document_generation_jobs
            SET status = 'RUNNING', started_at = ?, updated_at = ?
          WHERE invoice_id = ? AND status IN ('PENDING', 'FAILED')`,
        [new Date().toISOString(), new Date().toISOString(), job.data.invoice_id]
      );
      const result = await attemptInvoicePdf(
        db,
        job.data.organization_id,
        job.data.invoice_id,
        { actorId: 'phase5-worker' }
      );
      if (result.status !== 'READY') throw new Error(result.error || 'Invoice PDF generation failed.');
      return result;
    }
    case 'barcode.print.generate': {
      const db = await getTenantDatabase(job.data.organization_id);
      const result = await processBarcodePrintJob(
        db,
        job.data.organization_id,
        job.data.print_job_id,
        job.data.actor_id || 'phase5-worker'
      );
      if (result.status !== 'COMPLETED') {
        throw new Error(result.error_message || 'Barcode print output generation failed.');
      }
      return result;
    }
    case 'reminder.deliver': {
      const db = await getTenantDatabase(job.data.organization_id);
      return processReminderDelivery(db, job.data.reminder_id, job.data.organization_id);
    }
    default:
      throw new Error(`Unsupported domain job '${job.name}'.`);
  }
}, {
  connection: redisOptions(),
  concurrency: Number(process.env.WORKER_CONCURRENCY || 5)
});

worker.on('completed', job => console.log(`Completed Phase 5 job ${job.id} (${job.name})`));
worker.on('failed', (job, error) => console.error(`Phase 5 job ${job?.id || 'unknown'} failed:`, error));

async function shutdown() {
  await worker.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
