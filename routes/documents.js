import express from 'express';
import bwipjs from 'bwip-js';
import QRCode from 'qrcode';
import PDFDocument from 'pdfkit';
import { ZipArchive } from 'archiver';
import multer from 'multer';
import { supabase } from '../config/supabase.js';
import { checkRole } from './auth.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const authenticated = checkRole(['admin', 'manager', 'cashier', 'warehouse_staff']);
const documentManagers = checkRole(['admin', 'manager']);

const barcodeTypes = {
  code128: 'code128',
  code39: 'code39',
  ean13: 'ean13',
  upc: 'upca',
  upca: 'upca',
  qr: 'qrcode'
};

router.post('/barcodes/generate', authenticated, async (req, res) => {
  try {
    const { value, format = 'code128', product_id, scale = 3, height = 12, include_text = true } = req.body;
    if (!value?.trim()) return res.status(400).json({ error: 'Barcode value is required.' });
    const bcid = barcodeTypes[String(format).toLowerCase()];
    if (!bcid) return res.status(400).json({ error: 'Supported formats: Code128, Code39, EAN13, UPC, QR.' });
    const png = await bwipjs.toBuffer({
      bcid, text: value.trim(), scale: clamp(scale, 1, 8), height: clamp(height, 5, 50),
      includetext: Boolean(include_text), textxalign: 'center', backgroundcolor: 'FFFFFF'
    });
    const filename = `barcode-${safeName(value)}.png`;
    const document = await registerDocument({
      type: 'barcode', filename, mimeType: 'image/png', content: png,
      entityType: product_id ? 'product' : null, entityId: product_id,
      userId: req.user.id, metadata: { value, format: bcid }
    });
    await supabase.from('barcode_history').insert([{
      product_id: product_id || null, barcode_value: value.trim(), barcode_type: bcid,
      document_file_id: document.id, generated_by: req.user.id
    }]);
    res.status(201).json({
      id: document.id, value, format: bcid, filename,
      download_url: `/api/documents/${document.id}/download`,
      data_url: `data:image/png;base64,${png.toString('base64')}`
    });
  } catch (error) {
    res.status(400).json({ error: readableBarcodeError(error) });
  }
});

router.post('/barcodes/bulk', authenticated, async (req, res) => {
  const { items, format = 'code128' } = req.body;
  if (!Array.isArray(items) || items.length === 0 || items.length > 250) {
    return res.status(400).json({ error: 'Provide between 1 and 250 barcode items.' });
  }
  const bcid = barcodeTypes[String(format).toLowerCase()];
  if (!bcid) return res.status(400).json({ error: 'Unsupported barcode format.' });
  res.attachment(`inventia-barcodes-${Date.now()}.zip`);
  const zip = new ZipArchive({ zlib: { level: 9 } });
  zip.on('error', error => res.destroy(error));
  zip.pipe(res);
  try {
    for (const item of items) {
      const value = String(item.value || '').trim();
      if (!value) continue;
      const png = await bwipjs.toBuffer({ bcid, text: value, scale: 3, height: 12, includetext: true, textxalign: 'center' });
      const copies = clamp(item.copies || 1, 1, 100);
      for (let copy = 1; copy <= copies; copy += 1) {
        zip.append(png, { name: `${safeName(item.name || value)}-${copy}.png` });
      }
    }
    await zip.finalize();
  } catch (error) {
    zip.abort();
    if (!res.headersSent) res.status(400).json({ error: readableBarcodeError(error) });
  }
});

router.get('/barcodes/history', authenticated, async (_req, res) => {
  const { data, error } = await supabase.from('barcode_history').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get('/barcodes/scan/:value', authenticated, async (req, res) => {
  const { data, error } = await supabase.from('products').select('*');
  if (error) return res.status(500).json({ error: error.message });
  const needle = req.params.value.toLowerCase();
  const product = data.find(item => String(item.barcode || '').toLowerCase() === needle || String(item.sku || '').toLowerCase() === needle);
  if (!product) return res.status(404).json({ error: 'No product matches this barcode or SKU.' });
  res.json(product);
});

router.post('/barcodes/print', authenticated, async (req, res) => createPrintJob(req, res, 'barcode'));

router.post('/qr/generate', authenticated, async (req, res) => {
  try {
    const { value, entity_type, entity_id, size = 320, error_correction = 'M' } = req.body;
    if (!value?.trim()) return res.status(400).json({ error: 'QR value is required.' });
    const png = await QRCode.toBuffer(value.trim(), {
      type: 'png', width: clamp(size, 128, 2048), margin: 2,
      errorCorrectionLevel: ['L', 'M', 'Q', 'H'].includes(error_correction) ? error_correction : 'M'
    });
    const filename = `qr-${safeName(entity_type || 'code')}-${Date.now()}.png`;
    const document = await registerDocument({
      type: 'qr_code', filename, mimeType: 'image/png', content: png,
      entityType: entity_type, entityId: entity_id, userId: req.user.id,
      metadata: { value, error_correction }
    });
    res.status(201).json({
      id: document.id, filename, download_url: `/api/documents/${document.id}/download`,
      data_url: `data:image/png;base64,${png.toString('base64')}`
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/invoices/templates', authenticated, async (_req, res) => {
  const { data, error } = await supabase.from('invoice_templates').select('*').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(template => ({ ...template, config: parseJson(template.config) })));
});

router.get('/invoices', authenticated, async (_req, res) => {
  const { data, error } = await supabase.from('invoices').select('*').order('createdAt', { ascending: false }).limit(500);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.patch('/invoices/:id/status', authenticated, async (req, res) => {
  const allowed = ['draft', 'paid', 'partially_paid', 'cancelled', 'overdue', 'completed', 'pending'];
  const status = String(req.body.status || '').toLowerCase();
  if (!allowed.includes(status)) return res.status(400).json({ error: `Status must be one of: ${allowed.join(', ')}.` });
  const { data, error } = await supabase.from('invoices').update({ paymentStatus: status }).eq('id', req.params.id).select();
  if (error) return res.status(400).json({ error: error.message });
  if (!data[0]) return res.status(404).json({ error: 'Invoice not found.' });
  res.json(data[0]);
});

router.post('/invoices/templates', documentManagers, async (req, res) => {
  const { name, template_type = 'classic', config = {}, is_default = 0 } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Template name is required.' });
  if (is_default) await clearDefaultInvoiceTemplates();
  const { data, error } = await supabase.from('invoice_templates').insert([{
    name: name.trim(), template_type, config: JSON.stringify(config),
    is_default: is_default ? 1 : 0, created_by: req.user.id
  }]).select();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ ...data[0], config });
});

router.get('/barcodes/templates', authenticated, async (_req, res) => {
  const { data, error } = await supabase.from('barcode_templates').select('*').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(template => ({ ...template, config: parseJson(template.config) })));
});

router.post('/barcodes/templates', documentManagers, async (req, res) => {
  const { name, barcode_type = 'code128', label_size = '40x20', config = {}, is_default = 0 } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Template name is required.' });
  const { data, error } = await supabase.from('barcode_templates').insert([{
    name: name.trim(), barcode_type, label_size, config: JSON.stringify(config),
    is_default: is_default ? 1 : 0, created_by: req.user.id
  }]).select();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ ...data[0], config });
});

router.get('/labels/templates', authenticated, async (_req, res) => {
  const { data, error } = await supabase.from('label_templates').select('*').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(template => ({ ...template, config: parseJson(template.config) })));
});

router.post('/labels/templates', documentManagers, async (req, res) => {
  const { name, label_type = 'product', width_mm, height_mm, config = {}, is_default = 0 } = req.body;
  if (!name?.trim() || Number(width_mm) <= 0 || Number(height_mm) <= 0) {
    return res.status(400).json({ error: 'Name and positive label dimensions are required.' });
  }
  const { data, error } = await supabase.from('label_templates').insert([{
    name: name.trim(), label_type, width_mm: Number(width_mm), height_mm: Number(height_mm),
    config: JSON.stringify(config), is_default: is_default ? 1 : 0, created_by: req.user.id
  }]).select();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ ...data[0], config });
});

router.get('/document-settings', authenticated, async (_req, res) => {
  const { data, error } = await supabase.from('document_settings').select('*').order('setting_key');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(setting => ({ ...setting, setting_value: parseJson(setting.setting_value) })));
});

router.put('/document-settings', documentManagers, async (req, res) => {
  const { scope = 'organization', settings } = req.body;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return res.status(400).json({ error: 'settings must be an object.' });
  }
  const saved = [];
  const { data: existing } = await supabase.from('document_settings').select('*');
  for (const [key, value] of Object.entries(settings)) {
    const current = (existing || []).find(item => item.setting_scope === scope && item.setting_key === key);
    const payload = { setting_value: JSON.stringify(value), updated_by: req.user.id, updated_at: new Date().toISOString() };
    let result;
    if (current) {
      result = await supabase.from('document_settings').update(payload).eq('id', current.id).select();
    } else {
      result = await supabase.from('document_settings').insert([{
        setting_scope: scope, setting_key: key, ...payload
      }]).select();
    }
    if (result.error) return res.status(400).json({ error: result.error.message });
    saved.push({ ...result.data[0], setting_value: value });
  }
  res.json(saved);
});

router.get('/documents', authenticated, async (req, res) => {
  const { data, error } = await supabase.from('document_files').select('*').order('created_at', { ascending: false }).limit(500);
  if (error) return res.status(500).json({ error: error.message });
  const query = String(req.query.q || '').toLowerCase();
  const type = String(req.query.type || '').toLowerCase();
  const archived = req.query.archived === 'true' ? 1 : 0;
  const results = data.filter(file =>
    Number(file.is_archived || 0) === archived &&
    (!type || String(file.document_type).toLowerCase() === type) &&
    (!query || String(file.filename).toLowerCase().includes(query) || String(file.entity_id || '').toLowerCase().includes(query))
  ).map(withoutContent);
  res.json(results);
});

router.get('/documents/:id/download', authenticated, async (req, res) => {
  const { data, error } = await supabase.from('document_files').select('*').eq('id', req.params.id).single();
  if (error || !data) return res.status(404).json({ error: 'Document not found.' });
  res.setHeader('Content-Type', data.mime_type);
  res.setHeader('Content-Disposition', `attachment; filename="${data.filename.replaceAll('"', '')}"`);
  res.send(Buffer.from(data.content_base64, 'base64'));
});

router.put('/documents/:id/archive', authenticated, async (req, res) => {
  const { data, error } = await supabase.from('document_files').update({
    is_archived: req.body.archived === false ? 0 : 1
  }).eq('id', req.params.id).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json(withoutContent(data[0]));
});

router.delete('/documents/:id', documentManagers, async (req, res) => {
  const { data, error } = await supabase.from('document_files').delete().eq('id', req.params.id).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, document: data[0] ? withoutContent(data[0]) : null });
});

router.post('/pdf/barcode-sheet', authenticated, async (req, res) => {
  const { items, title = 'Barcode Labels', columns = 3 } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'At least one label is required.' });
  try {
    const pdf = await createBarcodeSheet(items, title, clamp(columns, 1, 4));
    const filename = `barcode-sheet-${Date.now()}.pdf`;
    const document = await registerDocument({
      type: 'barcode_sheet', filename, mimeType: 'application/pdf', content: pdf,
      userId: req.user.id, metadata: { labels: items.length, columns }
    });
    res.status(201).json({ id: document.id, filename, download_url: `/api/documents/${document.id}/download` });
  } catch (error) {
    res.status(400).json({ error: readableBarcodeError(error) });
  }
});

router.post('/print', authenticated, async (req, res) => createPrintJob(req, res, req.body.document_type || 'document'));

router.get('/print/jobs', authenticated, async (_req, res) => {
  const { data, error } = await supabase.from('print_jobs').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(job => ({ ...job, settings: parseJson(job.settings) })));
});

router.post('/export', authenticated, async (req, res) => {
  try {
    const { format = 'csv', filename = 'inventia-export', columns, rows } = req.body;
    if (!Array.isArray(rows) || rows.length > 50000) return res.status(400).json({ error: 'Rows must be an array with at most 50,000 records.' });
    const exportData = await generateExport(format, columns, rows);
    const fullName = `${safeName(filename)}.${exportData.extension}`;
    const document = await registerDocument({
      type: 'export', filename: fullName, mimeType: exportData.mimeType,
      content: exportData.buffer, userId: req.user.id,
      metadata: { format, row_count: rows.length }
    });
    await supabase.from('pdf_exports').insert([{
      document_file_id: document.id, export_type: format, row_count: rows.length, created_by: req.user.id
    }]);
    res.status(201).json({ id: document.id, filename: fullName, download_url: `/api/documents/${document.id}/download` });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/ocr', authenticated, upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Upload an image or PDF in the file field.' });
  const { data, error } = await supabase.from('ocr_documents').insert([{
    filename: file.originalname, mime_type: file.mimetype, status: 'pending',
    source_base64: file.buffer.toString('base64'), confidence: null,
    extracted_data: JSON.stringify({}), created_by: req.user.id
  }]).select();
  if (error) return res.status(400).json({ error: error.message });
  res.status(202).json({
    id: data[0].id, status: 'pending',
    message: 'OCR intake accepted. Configure an OCR provider to process this document.'
  });
});

router.get('/ocr/:id', authenticated, async (req, res) => {
  const { data, error } = await supabase.from('ocr_documents').select('*').eq('id', req.params.id).single();
  if (error || !data) return res.status(404).json({ error: 'OCR document not found.' });
  const { source_base64, ...result } = data;
  res.json({ ...result, extracted_data: parseJson(result.extracted_data) });
});

async function createPrintJob(req, res, documentType) {
  const { document_file_id, copies = 1, paper_size = 'A4', orientation = 'portrait', margins = {}, printer = 'browser' } = req.body;
  if (!document_file_id) return res.status(400).json({ error: 'document_file_id is required.' });
  const { data: file } = await supabase.from('document_files').select('id').eq('id', document_file_id).single();
  if (!file) return res.status(404).json({ error: 'Document not found.' });
  const settings = { copies: clamp(copies, 1, 100), paper_size, orientation, margins, printer };
  const { data, error } = await supabase.from('print_jobs').insert([{
    document_file_id, document_type: documentType, status: 'queued',
    settings: JSON.stringify(settings), requested_by: req.user.id
  }]).select();
  if (error) return res.status(400).json({ error: error.message });
  res.status(202).json({ ...data[0], settings });
}

async function registerDocument({ type, filename, mimeType, content, entityType = null, entityId = null, userId, metadata = {} }) {
  const { data, error } = await supabase.from('document_files').insert([{
    document_type: type, filename, mime_type: mimeType, byte_size: content.length,
    content_base64: content.toString('base64'), entity_type: entityType,
    entity_id: entityId == null ? null : String(entityId), metadata: JSON.stringify(metadata),
    is_archived: 0, created_by: userId
  }]).select();
  if (error) throw error;
  return data[0];
}

async function createBarcodeSheet(items, title, columns) {
  const doc = new PDFDocument({ size: 'A4', margin: 30 });
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  const completed = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.fontSize(16).text(title, { align: 'center' }).moveDown();
  const gap = 10;
  const width = (doc.page.width - 60 - gap * (columns - 1)) / columns;
  let column = 0;
  let y = doc.y;
  for (const item of items.slice(0, 500)) {
    if (y + 90 > doc.page.height - 30) {
      doc.addPage();
      y = 30;
      column = 0;
    }
    const png = await bwipjs.toBuffer({
      bcid: barcodeTypes[String(item.format || 'code128').toLowerCase()] || 'code128',
      text: String(item.value), scale: 2, height: 10, includetext: true, textxalign: 'center'
    });
    const x = 30 + column * (width + gap);
    doc.rect(x, y, width, 82).stroke('#d1d5db');
    if (item.name) doc.fontSize(8).text(String(item.name), x + 5, y + 5, { width: width - 10, align: 'center' });
    doc.image(png, x + 8, y + 22, { fit: [width - 16, 48], align: 'center' });
    column += 1;
    if (column >= columns) {
      column = 0;
      y += 92;
    }
  }
  doc.end();
  return completed;
}

async function generateExport(format, columns, rows) {
  const keys = Array.isArray(columns) && columns.length ? columns : Object.keys(rows[0] || {});
  const normalized = String(format).toLowerCase();
  if (normalized === 'json') {
    return { buffer: Buffer.from(JSON.stringify(rows, null, 2)), extension: 'json', mimeType: 'application/json' };
  }
  if (normalized === 'xml') {
    const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const xml = `<?xml version="1.0" encoding="UTF-8"?><inventia>${rows.map(row => `<row>${keys.map(key => `<${safeXmlName(key)}>${escape(row[key])}</${safeXmlName(key)}>`).join('')}</row>`).join('')}</inventia>`;
    return { buffer: Buffer.from(xml), extension: 'xml', mimeType: 'application/xml' };
  }
  if (normalized === 'xlsx' || normalized === 'excel') {
    return {
      buffer: await createXlsx(keys, rows), extension: 'xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    };
  }
  const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const csv = [keys.map(quote).join(','), ...rows.map(row => keys.map(key => quote(row[key])).join(','))].join('\r\n');
  return { buffer: Buffer.from(csv), extension: 'csv', mimeType: 'text/csv' };
}

async function createXlsx(keys, rows) {
  const xmlEscape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const cell = (value, index, rowIndex) => {
    const reference = `${excelColumn(index + 1)}${rowIndex + 1}`;
    if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${reference}" t="n"><v>${value}</v></c>`;
    return `<c r="${reference}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
  };
  const allRows = [Object.fromEntries(keys.map(key => [key, key])), ...rows];
  const sheetRows = allRows.map((row, rowIndex) =>
    `<row r="${rowIndex + 1}">${keys.map((key, index) => cell(row[key], index, rowIndex)).join('')}</row>`
  ).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Inventia Export" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': sheet
  };
  const zip = new ZipArchive({ zlib: { level: 9 } });
  const chunks = [];
  zip.on('data', chunk => chunks.push(chunk));
  const completed = new Promise((resolve, reject) => {
    zip.on('end', () => resolve(Buffer.concat(chunks)));
    zip.on('error', reject);
  });
  Object.entries(files).forEach(([name, content]) => zip.append(content, { name }));
  await zip.finalize();
  return completed;
}

function excelColumn(number) {
  let result = '';
  for (let value = number; value > 0; value = Math.floor((value - 1) / 26)) {
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  }
  return result;
}

async function clearDefaultInvoiceTemplates() {
  const { data } = await supabase.from('invoice_templates').select('*');
  for (const template of data || []) {
    if (template.is_default) await supabase.from('invoice_templates').update({ is_default: 0 }).eq('id', template.id);
  }
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || min));
const safeName = value => String(value || 'document').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || 'document';
const safeXmlName = value => `field_${safeName(value).replaceAll('-', '_')}`;
const parseJson = value => { try { return JSON.parse(value); } catch { return value; } };
const withoutContent = ({ content_base64, ...file }) => ({ ...file, metadata: parseJson(file.metadata), download_url: `/api/documents/${file.id}/download` });
const readableBarcodeError = error => error.message?.replace(/^bwipp\.[^:]+:\s*/, '') || 'Unable to generate barcode.';

export default router;
