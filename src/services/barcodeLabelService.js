import crypto from 'crypto';
import { PassThrough } from 'stream';
import { ZipArchive } from 'archiver';
import bwipjs from 'bwip-js';
import PDFDocument from 'pdfkit';
import { createStorageAdapter } from '../platform/storageAdapter.js';
import { httpError, parseJson, writeTenantAudit } from '../platform/phase5Http.js';
import { enqueueDomainJob, publishOrganizationEvent } from '../platform/phase5Runtime.js';

const storage = createStorageAdapter();
const BARCODE_TYPES = {
  CODE128: 'code128',
  CODE39: 'code39',
  EAN8: 'ean8',
  EAN13: 'ean13',
  UPCA: 'upca',
  UPCE: 'upce',
  QRCODE: 'qrcode',
  ITF14: 'itf14',
  DATAMATRIX: 'datamatrix'
};
const DEFAULT_SETTINGS = {
  enabled: true,
  auto_generate: true,
  default_type: 'CODE128',
  assignment_level: 'product',
  prefix: 'INV',
  suffix: '',
  sequence_length: 9,
  pattern: '{PREFIX}{SEQUENCE}{SUFFIX}',
  prevent_duplicates: true,
  allow_manual: true,
  allow_regeneration: true,
  default_label_quantity: 1,
  scanner: {
    mode: 'HID',
    prefix: '',
    suffix: '',
    termination_key: 'Enter',
    duplicate_delay_ms: 750,
    sound: true,
    auto_add_to_pos: true
  }
};

export async function getBarcodeSettings(db) {
  const row = await db.one(
    'SELECT setting_value, updated_by, updated_at FROM organization_settings WHERE setting_key = ?',
    ['barcode.settings']
  );
  return {
    ...DEFAULT_SETTINGS,
    ...parseJson(row?.setting_value, {}),
    scanner: { ...DEFAULT_SETTINGS.scanner, ...parseJson(row?.setting_value, {})?.scanner },
    updated_by: row?.updated_by || null,
    updated_at: row?.updated_at || null,
    supported_types: Object.keys(BARCODE_TYPES)
  };
}

export async function updateBarcodeSettings(db, input, req) {
  const before = await getBarcodeSettings(db);
  const next = {
    ...DEFAULT_SETTINGS,
    ...stripMetadata(before),
    ...input,
    scanner: { ...DEFAULT_SETTINGS.scanner, ...before.scanner, ...(input.scanner || {}) }
  };
  normalizeBarcodeType(next.default_type);
  await db.run(
    `INSERT INTO organization_settings (setting_key, setting_value, updated_by, updated_at)
     VALUES ('barcode.settings', ?, ?, ?)
     ON CONFLICT (setting_key) DO UPDATE SET
       setting_value = excluded.setting_value, updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
    [JSON.stringify(next), req.user.id, now()]
  );
  await writeTenantAudit(db, req, {
    eventType: 'barcode.settings_changed',
    entityType: 'barcode_settings',
    entityId: 'barcode.settings',
    before: stripMetadata(before),
    after: next
  });
  await publishEvent(req, 'barcode.settings.changed', next);
  return getBarcodeSettings(db);
}

export async function ensureProductBarcodesTx(tx, productId, variants, actorId, options = {}) {
  const settings = await getBarcodeSettings(tx);
  if (!settings.enabled || !settings.auto_generate) return { status: 'DISABLED', assignments: [] };
  const product = await tx.one('SELECT id, sku, barcode FROM products WHERE id = ?', [productId]);
  const assignments = [];
  const targets = [{ product_id: productId, variant_id: null, requested_value: product?.barcode || null }];
  if (settings.assignment_level === 'variant' || (variants || []).length) {
    const savedVariants = await tx.all('SELECT id, product_id, sku, barcode FROM product_variants WHERE product_id = ? ORDER BY id', [productId]);
    targets.push(...savedVariants.map(variant => ({
      product_id: productId,
      variant_id: variant.id,
      requested_value: variant.barcode || null
    })));
  }
  for (const target of targets) {
    try {
      assignments.push(await assignBarcodeTx(tx, {
        ...target,
        barcode_type: options.barcode_type || settings.default_type,
        source: target.requested_value ? 'MANUAL' : 'AUTO',
        actor_id: actorId,
        settings
      }));
    } catch (error) {
      await tx.run(
        `INSERT INTO barcode_generation_jobs
          (product_id, variant_id, status, attempt_count, last_error, created_at, updated_at)
         VALUES (?, ?, 'PENDING', 0, ?, ?, ?)`,
        [target.product_id, target.variant_id, String(error.message || error).slice(0, 1000), now(), now()]
      );
    }
  }
  return { status: assignments.length === targets.length ? 'ASSIGNED' : 'PENDING', assignments };
}

export async function getBarcodeOverview(db) {
  const [productStats, variantStats, printStats, scannerStats, recentAssignments, recentJobs, missing] = await Promise.all([
    db.one(
      `SELECT COUNT(*) AS total_products,
              SUM(CASE WHEN ba.id IS NOT NULL THEN 1 ELSE 0 END) AS with_barcode,
              SUM(CASE WHEN ba.id IS NULL THEN 1 ELSE 0 END) AS without_barcode
         FROM products p
         LEFT JOIN barcode_assignments ba
           ON ba.product_id = p.id AND ba.variant_id IS NULL
          AND ba.is_primary = 1 AND ba.archived_at IS NULL
        WHERE p.status = 1`
    ),
    db.one(
      `SELECT COUNT(*) AS variant_count,
              SUM(CASE WHEN ba.id IS NOT NULL THEN 1 ELSE 0 END) AS variant_barcodes
         FROM product_variants pv
         LEFT JOIN barcode_assignments ba
           ON ba.variant_id = pv.id AND ba.is_primary = 1 AND ba.archived_at IS NULL
        WHERE pv.status = 'active'`
    ),
    db.one(
      `SELECT COALESCE(SUM(CASE WHEN completed_at >= ? AND status = 'COMPLETED' THEN label_count ELSE 0 END), 0) AS printed_today,
              SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed_jobs,
              SUM(CASE WHEN status IN ('PENDING', 'RUNNING') THEN 1 ELSE 0 END) AS queued_jobs
         FROM barcode_print_jobs`,
      [startOfToday()]
    ),
    db.one(
      `SELECT COUNT(*) AS scans_today,
              SUM(CASE WHEN status = 'UNKNOWN' THEN 1 ELSE 0 END) AS unknown_today
         FROM barcode_scan_events WHERE created_at >= ?`,
      [startOfToday()]
    ),
    db.all(
      `SELECT ba.*, p.name AS product_name, p.sku, pv.name AS variant_name
         FROM barcode_assignments ba
         JOIN products p ON p.id = ba.product_id
         LEFT JOIN product_variants pv ON pv.id = ba.variant_id
        ORDER BY ba.assigned_at DESC LIMIT 8`
    ),
    db.all(
      `SELECT j.*, t.name AS template_name, l.name AS layout_name
         FROM barcode_print_jobs j
         JOIN barcode_templates t ON t.id = j.template_id
         JOIN label_layouts l ON l.id = j.layout_id
        ORDER BY j.created_at DESC LIMIT 8`
    ),
    db.all(
      `SELECT p.id, p.sku, p.name
         FROM products p
         LEFT JOIN barcode_assignments ba
           ON ba.product_id = p.id AND ba.variant_id IS NULL
          AND ba.is_primary = 1 AND ba.archived_at IS NULL
        WHERE p.status = 1 AND ba.id IS NULL
        ORDER BY p.name LIMIT 8`
    )
  ]);
  return {
    kpis: {
      total_products: Number(productStats.total_products || 0),
      products_with_barcode: Number(productStats.with_barcode || 0),
      products_without_barcode: Number(productStats.without_barcode || 0),
      variant_barcodes: Number(variantStats.variant_barcodes || 0),
      labels_printed_today: Number(printStats.printed_today || 0),
      failed_print_jobs: Number(printStats.failed_jobs || 0),
      queued_print_jobs: Number(printStats.queued_jobs || 0),
      scanner_status: 'READY',
      scans_today: Number(scannerStats.scans_today || 0),
      unknown_scans_today: Number(scannerStats.unknown_today || 0)
    },
    recent_assignments: recentAssignments,
    recent_print_jobs: recentJobs,
    missing_products: missing
  };
}

export async function listBarcodeProducts(db, query = {}) {
  const conditions = ['p.status = 1'];
  const params = [];
  if (query.q) {
    conditions.push(`(lower(p.name) LIKE ? OR lower(p.sku) LIKE ? OR lower(COALESCE(ba.barcode_value, '')) LIKE ?)`);
    const q = `%${String(query.q).toLowerCase()}%`;
    params.push(q, q, q);
  }
  if (query.status === 'missing') conditions.push('ba.id IS NULL');
  if (query.status === 'assigned') conditions.push('ba.id IS NOT NULL');
  if (query.type) { conditions.push('ba.barcode_type = ?'); params.push(normalizeBarcodeType(query.type)); }
  if (query.warehouse_id) {
    conditions.push('EXISTS (SELECT 1 FROM warehouse_stock fws WHERE fws.product_id = p.id AND fws.warehouse_id = ?)');
    params.push(Number(query.warehouse_id));
  }
  const limit = Math.min(Math.max(Number(query.limit || 200), 1), 500);
  const offset = Math.max(Number(query.offset || 0), 0);
  params.push(limit, offset);
  const rows = await db.all(
    `SELECT p.id AS product_id, p.name AS product_name, p.sku, p.image_url, p.uom,
            p.selling_price, p.cost_price, p.status AS product_status,
            b.name AS brand_name, c.name AS category_name,
            pc.hsn_code, pc.gst_rate,
            ba.id AS assignment_id, ba.barcode_value, ba.barcode_type,
            ba.status AS barcode_status, ba.assigned_at, ba.last_printed_at, ba.print_count,
            COALESCE((SELECT SUM(ws.quantity) FROM warehouse_stock ws WHERE ws.product_id = p.id), 0) AS warehouse_stock,
            (SELECT ib.batch_no FROM inventory_batches ib WHERE ib.product_id = p.id ORDER BY ib.created_at DESC LIMIT 1) AS batch_no,
            (SELECT ib.expires_at FROM inventory_batches ib WHERE ib.product_id = p.id ORDER BY ib.created_at DESC LIMIT 1) AS expires_at
       FROM products p
       LEFT JOIN brands b ON b.id = p.brand_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN product_commerce pc ON pc.product_id = p.id
       LEFT JOIN barcode_assignments ba
         ON ba.product_id = p.id AND ba.variant_id IS NULL
        AND ba.is_primary = 1 AND ba.archived_at IS NULL
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.name LIMIT ? OFFSET ?`,
    params
  );
  return rows.map(row => ({
    ...row,
    barcode_status: row.assignment_id ? row.barcode_status : 'MISSING'
  }));
}

export async function generateMissingBarcodes(db, input, req) {
  const settings = await getBarcodeSettings(db);
  const productIds = Array.isArray(input.product_ids) && input.product_ids.length
    ? input.product_ids.map(Number)
    : (await db.all(
      `SELECT p.id FROM products p
       LEFT JOIN barcode_assignments ba
         ON ba.product_id = p.id AND ba.variant_id IS NULL
        AND ba.is_primary = 1 AND ba.archived_at IS NULL
       WHERE p.status = 1 AND ba.id IS NULL ORDER BY p.id LIMIT 500`
    )).map(row => Number(row.id));
  const assignments = await db.transaction(async tx => {
    const generated = [];
    for (const productId of productIds) {
      const product = await tx.one('SELECT id FROM products WHERE id = ? AND status = 1', [productId]);
      if (!product) continue;
      const existing = await tx.one(
        `SELECT * FROM barcode_assignments
          WHERE product_id = ? AND variant_id IS NULL AND is_primary = 1 AND archived_at IS NULL`,
        [productId]
      );
      if (existing) continue;
      generated.push(await assignBarcodeTx(tx, {
        product_id: productId,
        variant_id: null,
        barcode_type: input.barcode_type || settings.default_type,
        source: 'AUTO',
        actor_id: req.user.id,
        settings
      }));
    }
    return generated;
  });
  await writeTenantAudit(db, req, {
    eventType: 'barcode.bulk_generated',
    entityType: 'barcode_assignment',
    entityId: 'bulk',
    metadata: { requested: productIds.length, generated: assignments.length }
  });
  await publishEvent(req, 'barcode.assigned', { count: assignments.length });
  return { generated: assignments.length, assignments };
}

export async function assignBarcode(db, input, req) {
  const settings = await getBarcodeSettings(db);
  const assignment = await db.transaction(tx => assignBarcodeTx(tx, {
    product_id: input.product_id,
    variant_id: input.variant_id || null,
    requested_value: input.barcode_value,
    barcode_type: input.barcode_type || settings.default_type,
    source: input.source || 'MANUAL',
    actor_id: req.user.id,
    settings
  }));
  await writeTenantAudit(db, req, {
    eventType: 'barcode.assigned',
    entityType: 'barcode_assignment',
    entityId: assignment.id,
    after: assignment
  });
  await publishEvent(req, 'barcode.assigned', assignment);
  return assignment;
}

export async function regenerateBarcode(db, assignmentId, input, req) {
  const settings = await getBarcodeSettings(db);
  if (!settings.allow_regeneration) throw httpError(403, 'barcode_regeneration_disabled', 'Barcode regeneration is disabled for this organization.');
  const before = await db.one('SELECT * FROM barcode_assignments WHERE id = ? AND archived_at IS NULL', [assignmentId]);
  if (!before) throw httpError(404, 'barcode_assignment_not_found', 'Barcode assignment was not found.');
  const after = await db.transaction(async tx => {
    await tx.run(
      `UPDATE barcode_assignments
          SET status = 'ARCHIVED', is_primary = 0, archived_at = ?, updated_at = ?
        WHERE id = ?`,
      [now(), now(), assignmentId]
    );
    return assignBarcodeTx(tx, {
      product_id: before.product_id,
      variant_id: before.variant_id,
      requested_value: input.barcode_value || null,
      barcode_type: input.barcode_type || before.barcode_type,
      source: 'REGENERATED',
      actor_id: req.user.id,
      settings,
      force: true
    });
  });
  await writeTenantAudit(db, req, {
    eventType: 'barcode.regenerated',
    entityType: 'barcode_assignment',
    entityId: after.id,
    before,
    after,
    metadata: { reason: input.reason }
  });
  await publishEvent(req, 'barcode.regenerated', { before_id: before.id, assignment: after });
  return after;
}

export async function validateBarcodeInput(db, input) {
  const type = normalizeBarcodeType(input.barcode_type);
  const value = normalizeBarcodeValue(input.barcode_value);
  const validation = validateBarcodeValue(value, type);
  const duplicate = await db.one(
    'SELECT id, product_id, variant_id, status FROM barcode_assignments WHERE barcode_value = ? AND archived_at IS NULL',
    [value]
  );
  return {
    valid: validation.valid && !duplicate,
    barcode_value: value,
    barcode_type: type,
    duplicate: duplicate || null,
    message: duplicate ? 'This barcode is already assigned.' : validation.message
  };
}

export async function renderAssignedBarcode(db, assignmentId, format = 'png') {
  const assignment = await assignmentSnapshot(db, assignmentId);
  const normalizedFormat = String(format || 'png').toLowerCase();
  const options = barcodeRenderOptions(assignment.barcode_value, assignment.barcode_type);
  if (normalizedFormat === 'svg') {
    return {
      content: Buffer.from(bwipjs.toSVG(options)),
      contentType: 'image/svg+xml',
      filename: `${safeFileName(assignment.sku)}-${safeFileName(assignment.barcode_value)}.svg`
    };
  }
  if (normalizedFormat !== 'png') throw httpError(422, 'unsupported_barcode_output', 'Barcode output must be PNG or SVG.');
  return {
    content: await bwipjs.toBuffer(options),
    contentType: 'image/png',
    filename: `${safeFileName(assignment.sku)}-${safeFileName(assignment.barcode_value)}.png`
  };
}

export async function resolveBarcodeScan(db, input, req) {
  const rawValue = String(input.barcode_value || '').trim();
  const settings = await getBarcodeSettings(db);
  const value = normalizeScannerValue(rawValue, settings.scanner);
  const assignment = await db.one(
    `SELECT ba.*, p.name AS product_name, p.sku AS product_sku, p.selling_price,
            p.uom, p.status AS product_status, pv.name AS variant_name, pv.sku AS variant_sku,
            COALESCE((SELECT SUM(ws.quantity) FROM warehouse_stock ws WHERE ws.product_id = p.id), 0) AS available_stock
       FROM barcode_assignments ba
       JOIN products p ON p.id = ba.product_id
       LEFT JOIN product_variants pv ON pv.id = ba.variant_id
      WHERE lower(ba.barcode_value) = lower(?) AND ba.status = 'ASSIGNED' AND ba.archived_at IS NULL`,
    [value]
  );
  const status = !assignment ? 'UNKNOWN'
    : !assignment.product_status ? 'INVALID'
      : Number(assignment.available_stock || 0) <= 0 ? 'OUT_OF_STOCK' : 'RESOLVED';
  const inserted = await insertWithId(db,
    `INSERT INTO barcode_scan_events
      (barcode_value, product_id, variant_id, user_id, source, action, device, status, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      value, assignment?.product_id || null, assignment?.variant_id || null, req.user.id,
      input.source || 'MANUAL', input.action || 'RESOLVE', input.device || null, status,
      JSON.stringify(input.metadata || {}), now()
    ]
  );
  const response = {
    scan_event_id: inserted.id || inserted.rows?.[0]?.id,
    status,
    barcode_value: value,
    resolved: Boolean(assignment),
    product: assignment ? {
      id: assignment.product_id,
      name: assignment.product_name,
      sku: assignment.product_sku,
      selling_price: Number(assignment.selling_price || 0),
      uom: assignment.uom,
      available_stock: Number(assignment.available_stock || 0)
    } : null,
    variant: assignment?.variant_id ? {
      id: assignment.variant_id,
      name: assignment.variant_name,
      sku: assignment.variant_sku
    } : null
  };
  await publishEvent(req, 'barcode.scanned', response);
  return response;
}

export async function listScanHistory(db, query = {}) {
  const limit = Math.min(Math.max(Number(query.limit || 100), 1), 500);
  return db.all(
    `SELECT se.*, p.name AS product_name, p.sku, pv.name AS variant_name
       FROM barcode_scan_events se
       LEFT JOIN products p ON p.id = se.product_id
       LEFT JOIN product_variants pv ON pv.id = se.variant_id
      ORDER BY se.created_at DESC LIMIT ?`,
    [limit]
  ).then(rows => rows.map(row => ({ ...row, metadata: parseJson(row.metadata, {}) })));
}

export async function listBarcodeTemplates(db) {
  const [templates, layouts] = await Promise.all([
    db.all(`SELECT * FROM barcode_templates WHERE status = 'active' ORDER BY is_default DESC, name`),
    db.all('SELECT * FROM label_layouts ORDER BY is_default DESC, name')
  ]);
  return {
    templates: templates.map(row => ({ ...row, configuration: parseJson(row.configuration, {}) })),
    layouts: layouts.map(row => ({
      ...row,
      margins: parseJson(row.margins, {}),
      gaps: parseJson(row.gaps, {})
    }))
  };
}

export async function createBarcodeTemplate(db, input, req) {
  const timestamp = now();
  const template = await db.transaction(async tx => {
    if (input.is_default) await tx.run('UPDATE barcode_templates SET is_default = 0, updated_at = ?', [timestamp]);
    const inserted = await insertWithId(tx,
      `INSERT INTO barcode_templates
        (name, category, configuration, is_default, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      [input.name, input.category || 'product', JSON.stringify(input.configuration || {}),
        input.is_default ? 1 : 0, req.user.id, timestamp, timestamp]
    );
    return tx.one('SELECT * FROM barcode_templates WHERE id = ?', [inserted.id || inserted.rows?.[0]?.id]);
  });
  await writeTenantAudit(db, req, {
    eventType: 'barcode.template_created',
    entityType: 'barcode_template',
    entityId: template.id,
    after: { ...template, configuration: parseJson(template.configuration, {}) }
  });
  return { ...template, configuration: parseJson(template.configuration, {}) };
}

export async function updateBarcodeTemplate(db, id, input, req) {
  const before = await db.one('SELECT * FROM barcode_templates WHERE id = ? AND status = ?', [id, 'active']);
  if (!before) throw httpError(404, 'barcode_template_not_found', 'Label template was not found.');
  await db.transaction(async tx => {
    if (input.is_default) await tx.run('UPDATE barcode_templates SET is_default = 0, updated_at = ?', [now()]);
    await tx.run(
      `UPDATE barcode_templates SET name = ?, category = ?, configuration = ?,
       is_default = ?, updated_at = ? WHERE id = ?`,
      [
        input.name ?? before.name, input.category ?? before.category,
        JSON.stringify(input.configuration ?? parseJson(before.configuration, {})),
        input.is_default == null ? before.is_default : input.is_default ? 1 : 0,
        now(), id
      ]
    );
  });
  const after = await db.one('SELECT * FROM barcode_templates WHERE id = ?', [id]);
  await writeTenantAudit(db, req, {
    eventType: 'barcode.template_edited',
    entityType: 'barcode_template',
    entityId: id,
    before,
    after
  });
  return { ...after, configuration: parseJson(after.configuration, {}) };
}

export async function archiveBarcodeTemplate(db, id, req) {
  const before = await db.one('SELECT * FROM barcode_templates WHERE id = ? AND status = ?', [id, 'active']);
  if (!before) throw httpError(404, 'barcode_template_not_found', 'Label template was not found.');
  if (before.is_default) throw httpError(409, 'default_template_cannot_archive', 'Choose another default template before archiving this one.');
  await db.run(`UPDATE barcode_templates SET status = 'archived', updated_at = ? WHERE id = ?`, [now(), id]);
  await writeTenantAudit(db, req, {
    eventType: 'barcode.template_archived',
    entityType: 'barcode_template',
    entityId: id,
    before
  });
  return { id: Number(id), status: 'archived' };
}

export async function createPrintJob(db, input, req) {
  const template = input.template_id
    ? await db.one(`SELECT * FROM barcode_templates WHERE id = ? AND status = 'active'`, [input.template_id])
    : await db.one(`SELECT * FROM barcode_templates WHERE is_default = 1 AND status = 'active' ORDER BY id LIMIT 1`);
  const layout = input.layout_id
    ? await db.one('SELECT * FROM label_layouts WHERE id = ?', [input.layout_id])
    : await db.one('SELECT * FROM label_layouts WHERE is_default = 1 ORDER BY id LIMIT 1');
  if (!template) throw httpError(422, 'barcode_template_required', 'Choose an active label template.');
  if (!layout) throw httpError(422, 'label_layout_required', 'Choose a label paper layout.');
  const created = await db.transaction(async tx => {
    const jobNumber = await nextPrintJobNumber(tx);
    const outputType = String(input.output_type || 'PDF').toUpperCase();
    const inserted = await insertWithId(tx,
      `INSERT INTO barcode_print_jobs
        (job_number, template_id, layout_id, status, output_type, printer_type,
         item_count, label_count, copies, starting_position, requested_by, created_at, updated_at)
       VALUES (?, ?, ?, 'PENDING', ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      [
        jobNumber, template.id, layout.id, outputType, input.printer_type || layout.printer_type || 'browser',
        input.items.length, input.copies || 1, input.starting_position || 1,
        req.user.id, now(), now()
      ]
    );
    const jobId = inserted.id || inserted.rows?.[0]?.id;
    let labelCount = 0;
    for (const item of input.items) {
      const snapshot = await assignmentSnapshot(tx, item.assignment_id);
      const quantity = Math.max(1, Number(item.quantity || 1));
      labelCount += quantity * Number(input.copies || 1);
      await tx.run(
        `INSERT INTO barcode_print_job_items
          (print_job_id, product_id, variant_id, barcode_assignment_id, quantity, snapshot)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [jobId, snapshot.product_id, snapshot.variant_id, snapshot.id, quantity, JSON.stringify(snapshot)]
      );
    }
    await tx.run('UPDATE barcode_print_jobs SET label_count = ? WHERE id = ?', [labelCount, jobId]);
    return jobId;
  });
  const pendingJob = await db.one('SELECT * FROM barcode_print_jobs WHERE id = ?', [created]);
  const queueState = Number(pendingJob.label_count || 0) > 500
    ? await enqueueDomainJob('barcode.print.generate', {
      organization_id: req.user.organization_id,
      print_job_id: created,
      actor_id: req.user.id
    }, { jobId: `barcode-print:${req.user.organization_id}:${created}` })
    : { queued: false };
  const result = queueState.queued
    ? pendingJob
    : await processPrintJob(db, req.user.organization_id, created, req.user.id);
  await writeTenantAudit(db, req, {
    eventType: result.status === 'COMPLETED' ? 'barcode.labels_printed' : 'barcode.print_failed',
    entityType: 'barcode_print_job',
    entityId: created,
    after: result
  });
  await publishEvent(req, `barcode.print.${result.status.toLowerCase()}`, result);
  return result;
}

export async function listPrintJobs(db, query = {}) {
  const status = query.status ? String(query.status).toUpperCase() : null;
  const params = [];
  const where = [];
  if (status) { where.push('j.status = ?'); params.push(status); }
  params.push(Math.min(Math.max(Number(query.limit || 100), 1), 500));
  return db.all(
    `SELECT j.*, t.name AS template_name, l.name AS layout_name
       FROM barcode_print_jobs j
       JOIN barcode_templates t ON t.id = j.template_id
       JOIN label_layouts l ON l.id = j.layout_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY j.created_at DESC LIMIT ?`,
    params
  );
}

export async function retryPrintJob(db, id, req) {
  const job = await db.one('SELECT * FROM barcode_print_jobs WHERE id = ?', [id]);
  if (!job) throw httpError(404, 'barcode_print_job_not_found', 'Print job was not found.');
  if (!['FAILED', 'PENDING'].includes(job.status)) {
    throw httpError(409, 'barcode_print_job_not_retryable', 'Only pending or failed jobs can be retried.');
  }
  const result = await processPrintJob(db, req.user.organization_id, id, req.user.id);
  await writeTenantAudit(db, req, {
    eventType: 'barcode.print_retried',
    entityType: 'barcode_print_job',
    entityId: id,
    before: job,
    after: result
  });
  await publishEvent(req, `barcode.print.${result.status.toLowerCase()}`, result);
  return result;
}

export async function processBarcodePrintJob(db, organizationId, jobId, actorId = 'phase5-worker') {
  return processPrintJob(db, organizationId, jobId, actorId);
}

export async function cancelPrintJob(db, id, req) {
  const job = await db.one('SELECT * FROM barcode_print_jobs WHERE id = ?', [id]);
  if (!job) throw httpError(404, 'barcode_print_job_not_found', 'Print job was not found.');
  if (!['PENDING', 'FAILED'].includes(job.status)) {
    throw httpError(409, 'barcode_print_job_not_cancellable', 'Only pending or failed print jobs can be cancelled.');
  }
  await db.run(`UPDATE barcode_print_jobs SET status = 'CANCELLED', updated_at = ? WHERE id = ?`, [now(), id]);
  await writeTenantAudit(db, req, {
    eventType: 'barcode.print_cancelled',
    entityType: 'barcode_print_job',
    entityId: id,
    before: job,
    after: { ...job, status: 'CANCELLED' }
  });
  return { ...job, status: 'CANCELLED' };
}

export async function downloadPrintJob(db, organizationId, id) {
  const job = await db.one('SELECT * FROM barcode_print_jobs WHERE id = ?', [id]);
  if (!job) throw httpError(404, 'barcode_print_job_not_found', 'Print job was not found.');
  if (job.status !== 'COMPLETED' || !job.output_file_key) {
    throw httpError(409, 'barcode_print_job_not_ready', 'Print output is not ready.');
  }
  if (!job.output_file_key.startsWith(`${organizationId}/barcodes/`)) {
    throw httpError(403, 'barcode_print_job_access_denied', 'This print output belongs to another organization.');
  }
  return {
    content: await storage.read(job.output_file_key),
    contentType: job.output_content_type,
    filename: `${job.job_number}.${job.output_type === 'ZIP' ? 'zip' : 'pdf'}`
  };
}

export async function getBarcodeAnalytics(db) {
  const [assignments, scans, jobs, templates, topPrinted] = await Promise.all([
    db.one(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN source = 'AUTO' THEN 1 ELSE 0 END) AS auto_assigned,
              SUM(CASE WHEN source = 'MANUAL' THEN 1 ELSE 0 END) AS manual_assigned,
              SUM(CASE WHEN source = 'REGENERATED' THEN 1 ELSE 0 END) AS regenerated
         FROM barcode_assignments WHERE archived_at IS NULL`
    ),
    db.one(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'RESOLVED' THEN 1 ELSE 0 END) AS resolved,
              SUM(CASE WHEN status = 'UNKNOWN' THEN 1 ELSE 0 END) AS unknown
         FROM barcode_scan_events`
    ),
    db.one(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
              COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN label_count ELSE 0 END), 0) AS labels
         FROM barcode_print_jobs`
    ),
    db.all(
      `SELECT t.id, t.name, COUNT(j.id) AS uses, COALESCE(SUM(j.label_count), 0) AS labels
         FROM barcode_templates t
         LEFT JOIN barcode_print_jobs j ON j.template_id = t.id AND j.status = 'COMPLETED'
        WHERE t.status = 'active'
        GROUP BY t.id, t.name ORDER BY uses DESC, t.name LIMIT 10`
    ),
    db.all(
      `SELECT ba.id, ba.barcode_value, ba.print_count, p.name AS product_name, p.sku
         FROM barcode_assignments ba JOIN products p ON p.id = ba.product_id
        WHERE ba.archived_at IS NULL ORDER BY ba.print_count DESC, p.name LIMIT 10`
    )
  ]);
  return {
    assignments: numericObject(assignments),
    scans: numericObject(scans),
    print_jobs: numericObject(jobs),
    template_usage: templates.map(numericObject),
    top_printed: topPrinted.map(numericObject)
  };
}

export async function getBarcodeRecommendations(db) {
  const [missing, neverPrinted, lowStock, unknownScans, failures] = await Promise.all([
    db.all(
      `SELECT p.id, p.name, p.sku FROM products p
       LEFT JOIN barcode_assignments ba
         ON ba.product_id = p.id AND ba.variant_id IS NULL AND ba.archived_at IS NULL
       WHERE p.status = 1 AND ba.id IS NULL ORDER BY p.name LIMIT 25`
    ),
    db.all(
      `SELECT p.id, p.name, p.sku, ba.id AS assignment_id
         FROM barcode_assignments ba JOIN products p ON p.id = ba.product_id
        WHERE ba.archived_at IS NULL AND ba.print_count = 0 ORDER BY ba.assigned_at LIMIT 25`
    ),
    db.all(
      `SELECT p.id, p.name, p.sku, COALESCE(SUM(ws.quantity), 0) AS stock, p.min_stock_alert
         FROM products p LEFT JOIN warehouse_stock ws ON ws.product_id = p.id
        WHERE p.status = 1 GROUP BY p.id, p.name, p.sku, p.min_stock_alert
        HAVING COALESCE(SUM(ws.quantity), 0) <= p.min_stock_alert
        ORDER BY stock LIMIT 25`
    ),
    db.all(
      `SELECT barcode_value, COUNT(*) AS scan_count, MAX(created_at) AS last_scanned_at
         FROM barcode_scan_events WHERE status = 'UNKNOWN'
        GROUP BY barcode_value ORDER BY scan_count DESC LIMIT 25`
    ),
    db.all(
      `SELECT id, job_number, error_message, created_at
         FROM barcode_print_jobs WHERE status = 'FAILED' ORDER BY created_at DESC LIMIT 10`
    )
  ]);
  const recommendations = [];
  if (missing.length) recommendations.push({
    priority: 'high', type: 'assign_missing', title: `Assign ${missing.length} missing product barcodes`,
    reason: 'Products without persistent identities cannot be scanned reliably in POS or inventory workflows.',
    action: 'GENERATE_MISSING', records: missing
  });
  if (unknownScans.length) recommendations.push({
    priority: 'high', type: 'map_unknown', title: `Review ${unknownScans.length} unknown scanned codes`,
    reason: 'Frequently scanned unknown values may represent unmapped supplier or legacy barcodes.',
    action: 'OPEN_SCANNER_HISTORY', records: unknownScans
  });
  if (neverPrinted.length) recommendations.push({
    priority: 'medium', type: 'print_unlabeled', title: `Print labels for ${neverPrinted.length} never-printed items`,
    reason: 'Assigned products without physical labels add manual lookup time during receiving and checkout.',
    action: 'OPEN_BATCH_PRINT', records: neverPrinted
  });
  if (lowStock.length) recommendations.push({
    priority: 'medium', type: 'low_stock_labels', title: `${lowStock.length} low-stock items need shelf-label review`,
    reason: 'Low-stock shelves benefit from clear scan-ready replenishment labels.',
    action: 'OPEN_PRODUCTS', records: lowStock
  });
  if (failures.length) recommendations.push({
    priority: 'high', type: 'retry_prints', title: `Retry ${failures.length} failed print jobs`,
    reason: 'Failed output jobs are persisted and safe to retry without duplicating barcode assignments.',
    action: 'OPEN_PRINT_QUEUE', records: failures
  });
  if (!recommendations.length) recommendations.push({
    priority: 'low', type: 'healthy', title: 'Barcode operations are healthy',
    reason: 'All active products are assigned and no unresolved print or scanner issues need attention.',
    action: 'OPEN_ANALYTICS', records: []
  });
  return {
    provider: { active: 'local-business-intelligence', fallback: true },
    generated_at: now(),
    recommendations
  };
}

async function assignBarcodeTx(tx, input) {
  const product = await tx.one('SELECT id, sku, barcode, status FROM products WHERE id = ?', [input.product_id]);
  if (!product || !product.status) throw httpError(404, 'product_not_found', 'An active product is required for barcode assignment.');
  let variant = null;
  if (input.variant_id) {
    variant = await tx.one(
      'SELECT id, product_id, sku, barcode, status FROM product_variants WHERE id = ? AND product_id = ?',
      [input.variant_id, input.product_id]
    );
    if (!variant || variant.status !== 'active') throw httpError(404, 'variant_not_found', 'An active product variant is required for barcode assignment.');
  }
  if (!input.force) {
    const existing = await tx.one(
      `SELECT * FROM barcode_assignments
        WHERE product_id = ? AND ${variant ? 'variant_id = ?' : 'variant_id IS NULL'}
          AND is_primary = 1 AND archived_at IS NULL`,
      variant ? [product.id, variant.id] : [product.id]
    );
    if (existing) return existing;
  }
  const type = normalizeBarcodeType(input.barcode_type || input.settings.default_type);
  let value = input.requested_value ? normalizeBarcodeValue(input.requested_value) : null;
  if (value) {
    if (!input.settings.allow_manual && input.source === 'MANUAL') {
      throw httpError(403, 'manual_barcode_disabled', 'Manual barcode entry is disabled.');
    }
    const validation = validateBarcodeValue(value, type);
    if (!validation.valid) throw httpError(422, 'invalid_barcode', validation.message);
  } else {
    value = await generateUniqueValue(tx, type, input.settings);
  }
  const duplicate = await tx.one(
    'SELECT id FROM barcode_assignments WHERE barcode_value = ? AND archived_at IS NULL',
    [value]
  );
  if (duplicate) throw httpError(409, 'duplicate_barcode', 'This barcode is already assigned.');
  const inserted = await insertWithId(tx,
    `INSERT INTO barcode_assignments
      (product_id, variant_id, barcode_value, barcode_type, status, source, is_primary,
       created_by, assigned_at, updated_at)
     VALUES (?, ?, ?, ?, 'ASSIGNED', ?, 1, ?, ?, ?)`,
    [product.id, variant?.id || null, value, type, input.source || 'AUTO', input.actor_id || null, now(), now()]
  );
  if (variant) await tx.run('UPDATE product_variants SET barcode = ?, updated_at = ? WHERE id = ?', [value, now(), variant.id]);
  else await tx.run('UPDATE products SET barcode = ?, updated_at = ? WHERE id = ?', [value, now(), product.id]);
  return tx.one('SELECT * FROM barcode_assignments WHERE id = ?', [inserted.id || inserted.rows?.[0]?.id]);
}

async function generateUniqueValue(tx, type, settings) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const sequence = await allocateSequence(tx, settings);
    const value = formatGeneratedValue(sequence, type, settings);
    const duplicate = await tx.one('SELECT id FROM barcode_assignments WHERE barcode_value = ?', [value]);
    if (!duplicate) return value;
  }
  throw httpError(409, 'barcode_sequence_exhausted', 'Unable to allocate a unique barcode after repeated collision checks.');
}

async function allocateSequence(tx, settings) {
  const key = 'barcode:default';
  let row = await tx.one(
    `SELECT sequence_key, prefix, next_value, padding FROM number_sequences
      WHERE sequence_key = ?${tx.dialect === 'postgres' ? ' FOR UPDATE' : ''}`,
    [key]
  );
  if (!row) {
    await tx.run(
      `INSERT INTO number_sequences (sequence_key, prefix, next_value, padding, updated_at)
       VALUES (?, ?, 1, ?, ?)`,
      [key, settings.prefix || 'INV', settings.sequence_length || 9, now()]
    );
    row = { sequence_key: key, prefix: settings.prefix || 'INV', next_value: 1, padding: settings.sequence_length || 9 };
  }
  await tx.run(
    `UPDATE number_sequences SET prefix = ?, padding = ?, next_value = ?, updated_at = ?
      WHERE sequence_key = ?`,
    [settings.prefix || '', settings.sequence_length || 9, Number(row.next_value) + 1, now(), key]
  );
  return Number(row.next_value);
}

function formatGeneratedValue(sequence, type, settings) {
  if (['EAN13', 'UPCA', 'EAN8', 'ITF14'].includes(type)) {
    const bodyLength = { EAN13: 12, UPCA: 11, EAN8: 7, ITF14: 13 }[type];
    const numericPrefix = String(settings.prefix || '').replace(/\D/g, '');
    const body = `${numericPrefix}${String(sequence)}`.slice(-bodyLength).padStart(bodyLength, '0');
    return `${body}${gtinCheckDigit(body)}`;
  }
  if (type === 'UPCE') return String(sequence).slice(-7).padStart(7, '0');
  const padded = String(sequence).padStart(Number(settings.sequence_length || 9), '0');
  const pattern = settings.pattern || '{PREFIX}{SEQUENCE}{SUFFIX}';
  return pattern
    .replaceAll('{PREFIX}', settings.prefix || '')
    .replaceAll('{YEAR}', String(new Date().getFullYear()))
    .replaceAll('{SEQUENCE}', padded)
    .replaceAll('{SUFFIX}', settings.suffix || '');
}

function validateBarcodeValue(value, type) {
  if (!value) return { valid: false, message: 'Barcode value is required.' };
  if (value.length > 2000) return { valid: false, message: 'Barcode value is too long.' };
  if (type === 'CODE39' && !/^[0-9A-Z .\-$/+%]+$/.test(value)) {
    return { valid: false, message: 'Code39 supports uppercase letters, numbers, spaces, and . - $ / + % only.' };
  }
  const lengths = { EAN8: 8, EAN13: 13, UPCA: 12, ITF14: 14 };
  if (lengths[type]) {
    if (!new RegExp(`^\\d{${lengths[type]}}$`).test(value)) {
      return { valid: false, message: `${type} requires exactly ${lengths[type]} digits.` };
    }
    const expected = gtinCheckDigit(value.slice(0, -1));
    if (value.at(-1) !== expected) return { valid: false, message: `${type} check digit is invalid.` };
  }
  if (type === 'UPCE' && !/^\d{6,8}$/.test(value)) {
    return { valid: false, message: 'UPC-E requires 6 to 8 digits.' };
  }
  try {
    if (type !== 'QRCODE') bwipjs.toSVG(barcodeRenderOptions(value, type));
  } catch (error) {
    return { valid: false, message: readableBarcodeError(error) };
  }
  return { valid: true, message: 'Barcode is valid.' };
}

function gtinCheckDigit(body) {
  const digits = String(body).split('').map(Number).reverse();
  const total = digits.reduce((sum, digit, index) => sum + digit * (index % 2 === 0 ? 3 : 1), 0);
  return String((10 - (total % 10)) % 10);
}

function barcodeRenderOptions(value, type) {
  const bcid = BARCODE_TYPES[normalizeBarcodeType(type)];
  const options = {
    bcid,
    text: String(value),
    scale: 3,
    height: 12,
    paddingwidth: 2,
    paddingheight: 2,
    backgroundcolor: 'FFFFFF',
    barcolor: '111827'
  };
  if (type !== 'QRCODE' && type !== 'DATAMATRIX') {
    options.includetext = true;
    options.textxalign = 'center';
    options.textsize = 9;
  }
  return options;
}

async function assignmentSnapshot(db, assignmentId) {
  const row = await db.one(
    `SELECT ba.*, p.name AS product_name, p.sku, p.uom, p.selling_price,
            p.cost_price, p.shade_lot_number AS batch_no,
            pv.name AS variant_name, pv.sku AS variant_sku,
            pc.hsn_code, pc.gst_rate,
            b.name AS brand_name, c.name AS category_name,
            (SELECT ib.expires_at FROM inventory_batches ib
              WHERE ib.product_id = p.id ORDER BY ib.created_at DESC LIMIT 1) AS expires_at
       FROM barcode_assignments ba
       JOIN products p ON p.id = ba.product_id
       LEFT JOIN product_variants pv ON pv.id = ba.variant_id
       LEFT JOIN product_commerce pc ON pc.product_id = p.id
       LEFT JOIN brands b ON b.id = p.brand_id
       LEFT JOIN categories c ON c.id = p.category_id
      WHERE ba.id = ? AND ba.status = 'ASSIGNED' AND ba.archived_at IS NULL`,
    [assignmentId]
  );
  if (!row) throw httpError(404, 'barcode_assignment_not_found', 'An active barcode assignment was not found.');
  return row;
}

async function processPrintJob(db, organizationId, jobId, actorId) {
  await db.run(
    `UPDATE barcode_print_jobs
        SET status = 'RUNNING', error_message = NULL, started_at = ?, updated_at = ?
      WHERE id = ?`,
    [now(), now(), jobId]
  );
  try {
    const job = await db.one(
      `SELECT j.*, t.configuration, l.page_width_mm, l.page_height_mm,
              l.label_width_mm, l.label_height_mm, l.rows, l.columns,
              l.margins, l.gaps, l.orientation
         FROM barcode_print_jobs j
         JOIN barcode_templates t ON t.id = j.template_id
         JOIN label_layouts l ON l.id = j.layout_id
        WHERE j.id = ?`,
      [jobId]
    );
    const rows = await db.all('SELECT * FROM barcode_print_job_items WHERE print_job_id = ? ORDER BY id', [jobId]);
    const labels = [];
    for (const row of rows) {
      const snapshot = parseJson(row.snapshot, {});
      for (let copy = 0; copy < Number(row.quantity) * Number(job.copies); copy += 1) labels.push(snapshot);
    }
    const output = job.output_type === 'ZIP'
      ? await createBarcodeZip(labels)
      : await createLabelPdf(job, labels);
    const extension = job.output_type === 'ZIP' ? 'zip' : 'pdf';
    const contentType = job.output_type === 'ZIP' ? 'application/zip' : 'application/pdf';
    const key = `${organizationId}/barcodes/${new Date().getFullYear()}/${safeFileName(job.job_number)}.${extension}`;
    const stored = await storage.putKey({ key, contentType, buffer: output });
    await db.transaction(async tx => {
      await tx.run(
        `UPDATE barcode_print_jobs
            SET status = 'COMPLETED', storage_provider = ?, output_file_key = ?,
                output_content_type = ?, output_size_bytes = ?, completed_at = ?, updated_at = ?
          WHERE id = ?`,
        [stored.provider, stored.key, contentType, stored.size_bytes, now(), now(), jobId]
      );
      for (const row of rows) {
        await tx.run(
          `UPDATE barcode_assignments SET print_count = print_count + ?,
           last_printed_at = ?, updated_at = ? WHERE id = ?`,
          [Number(row.quantity) * Number(job.copies), now(), now(), row.barcode_assignment_id]
        );
      }
    });
    return db.one('SELECT * FROM barcode_print_jobs WHERE id = ?', [jobId]);
  } catch (error) {
    await db.run(
      `UPDATE barcode_print_jobs
          SET status = 'FAILED', error_message = ?, completed_at = ?, updated_at = ?
        WHERE id = ?`,
      [String(error.message || error).slice(0, 2000), now(), now(), jobId]
    );
    return db.one('SELECT * FROM barcode_print_jobs WHERE id = ?', [jobId]);
  }
}

async function createLabelPdf(job, labels) {
  const width = mmToPoints(Number(job.page_width_mm));
  const height = mmToPoints(Number(job.page_height_mm));
  const doc = new PDFDocument({ size: [width, height], margin: 0, autoFirstPage: false, compress: true });
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const margins = parseJson(job.margins, { top: 0, left: 0 });
  const gaps = parseJson(job.gaps, { horizontal: 0, vertical: 0 });
  const config = parseJson(job.configuration, {});
  const slots = Number(job.rows) * Number(job.columns);
  const start = Math.min(Math.max(Number(job.starting_position || 1), 1), slots);
  let slotIndex = start - 1;
  doc.addPage();
  for (const label of labels) {
    if (slotIndex >= slots) {
      doc.addPage();
      slotIndex = 0;
    }
    const column = slotIndex % Number(job.columns);
    const row = Math.floor(slotIndex / Number(job.columns));
    const x = mmToPoints(Number(margins.left || 0) + column * (Number(job.label_width_mm) + Number(gaps.horizontal || 0)));
    const y = mmToPoints(Number(margins.top || 0) + row * (Number(job.label_height_mm) + Number(gaps.vertical || 0)));
    await drawLabel(doc, x, y, mmToPoints(Number(job.label_width_mm)), mmToPoints(Number(job.label_height_mm)), label, config);
    slotIndex += 1;
  }
  doc.end();
  return finished;
}

async function drawLabel(doc, x, y, width, height, label, config) {
  const padding = mmToPoints(1.5);
  if (config.border !== false) doc.rect(x, y, width, height).lineWidth(0.4).strokeColor('#CBD5E1').stroke();
  let cursorY = y + padding;
  const innerWidth = width - padding * 2;
  if (config.show_product !== false) {
    doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(Number(config.font_size_pt || 8))
      .text(String(label.product_name || ''), x + padding, cursorY, { width: innerWidth, align: config.alignment || 'center', lineBreak: false, ellipsis: true });
    cursorY += mmToPoints(3.3);
  }
  if (config.show_variant && label.variant_name) {
    doc.font('Helvetica').fontSize(6).fillColor('#475569')
      .text(String(label.variant_name), x + padding, cursorY, { width: innerWidth, align: 'center', lineBreak: false, ellipsis: true });
    cursorY += mmToPoints(2.6);
  }
  const barcodeHeight = Math.min(mmToPoints(Number(config.barcode_height_mm || 11)), Math.max(mmToPoints(7), height - (cursorY - y) - mmToPoints(5)));
  const png = await bwipjs.toBuffer({
    ...barcodeRenderOptions(label.barcode_value, label.barcode_type),
    includetext: false,
    height: Math.max(5, Number(config.barcode_height_mm || 11))
  });
  doc.image(png, x + padding, cursorY, { fit: [innerWidth, barcodeHeight], align: 'center', valign: 'center' });
  cursorY += barcodeHeight + mmToPoints(0.6);
  if (config.show_barcode_number !== false) {
    doc.font('Courier-Bold').fontSize(6.5).fillColor('#0F172A')
      .text(String(label.barcode_value), x + padding, cursorY, { width: innerWidth, align: 'center', lineBreak: false });
  }
  const footer = [];
  if (config.show_sku !== false) footer.push(`SKU ${label.variant_sku || label.sku}`);
  if (config.show_mrp !== false) footer.push(`MRP INR ${Number(label.selling_price || 0).toFixed(2)}`);
  if (config.show_batch && label.batch_no) footer.push(`Batch ${label.batch_no}`);
  if (config.show_expiry && label.expires_at) footer.push(`Exp ${String(label.expires_at).slice(0, 10)}`);
  if (footer.length) {
    doc.font('Helvetica').fontSize(5.5).fillColor('#475569')
      .text(footer.join('  •  '), x + padding, y + height - mmToPoints(3.1), {
        width: innerWidth, align: 'center', lineBreak: false, ellipsis: true
      });
  }
}

async function createBarcodeZip(labels) {
  const output = new PassThrough();
  const chunks = [];
  output.on('data', chunk => chunks.push(chunk));
  const completed = new Promise((resolve, reject) => {
    output.on('end', () => resolve(Buffer.concat(chunks)));
    output.on('error', reject);
  });
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on('error', error => output.destroy(error));
  archive.pipe(output);
  let index = 0;
  for (const label of labels) {
    index += 1;
    const png = await bwipjs.toBuffer(barcodeRenderOptions(label.barcode_value, label.barcode_type));
    archive.append(png, { name: `${String(index).padStart(4, '0')}-${safeFileName(label.sku)}-${safeFileName(label.barcode_value)}.png` });
  }
  await archive.finalize();
  return completed;
}

async function nextPrintJobNumber(tx) {
  const sequenceKey = `barcode-print:${new Date().getFullYear()}`;
  let row = await tx.one(
    `SELECT next_value FROM number_sequences WHERE sequence_key = ?${tx.dialect === 'postgres' ? ' FOR UPDATE' : ''}`,
    [sequenceKey]
  );
  if (!row) {
    await tx.run(
      `INSERT INTO number_sequences (sequence_key, prefix, next_value, padding, updated_at)
       VALUES (?, ?, 1, 6, ?)`,
      [sequenceKey, `LBL-${new Date().getFullYear()}-`, now()]
    );
    row = { next_value: 1 };
  }
  await tx.run('UPDATE number_sequences SET next_value = ?, updated_at = ? WHERE sequence_key = ?', [
    Number(row.next_value) + 1, now(), sequenceKey
  ]);
  return `LBL-${new Date().getFullYear()}-${String(row.next_value).padStart(6, '0')}`;
}

function normalizeBarcodeType(value) {
  const type = String(value || 'CODE128').toUpperCase().replace(/[-_\s]/g, '');
  const aliases = { QR: 'QRCODE', CODE128: 'CODE128', CODE39: 'CODE39', DATAMATRIX: 'DATAMATRIX' };
  const normalized = aliases[type] || type;
  if (!BARCODE_TYPES[normalized]) throw httpError(422, 'unsupported_barcode_type', `Unsupported barcode type '${value}'.`);
  return normalized;
}

function normalizeBarcodeValue(value) {
  return String(value || '').trim();
}

function normalizeScannerValue(value, scanner) {
  let result = String(value || '').trim();
  if (scanner.prefix && result.startsWith(scanner.prefix)) result = result.slice(scanner.prefix.length);
  if (scanner.suffix && result.endsWith(scanner.suffix)) result = result.slice(0, -scanner.suffix.length);
  return result.trim();
}

function stripMetadata(settings) {
  const { updated_by: _updatedBy, updated_at: _updatedAt, supported_types: _supported, ...clean } = settings;
  return clean;
}

function insertWithId(db, sql, params) {
  return db.run(`${sql}${db.dialect === 'postgres' ? ' RETURNING id' : ''}`, params);
}

function numericObject(value) {
  return Object.fromEntries(Object.entries(value || {}).map(([key, entry]) => [
    key,
    typeof entry === 'number' || (typeof entry === 'string' && /^-?\d+(\.\d+)?$/.test(entry))
      ? Number(entry)
      : entry
  ]));
}

function mmToPoints(value) {
  return Number(value) * 72 / 25.4;
}

function safeFileName(value) {
  return String(value || 'barcode').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

function readableBarcodeError(error) {
  return String(error?.message || error || 'Barcode validation failed.').replace(/^bwipp\.[^:]+:\s*/, '');
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

async function publishEvent(req, event, payload) {
  return publishOrganizationEvent(req.user.organization_id, event, payload);
}

function now() {
  return new Date().toISOString();
}
