import express from 'express';
import { z } from 'zod';
import { requirePermission } from '../../platform/phase5Auth.js';
import {
  asyncRoute,
  executeIdempotent,
  sendMutation,
  validate
} from '../../platform/phase5Http.js';
import {
  getSettingsNamespace,
  listFeatureFlags,
  listSettingsNamespaces,
  SETTINGS_NAMESPACES,
  updateFeatureFlag,
  updateSettingsNamespace
} from '../../domains/settings/settingsService.js';

const router = express.Router();

const optionalEmail = z.union([z.literal(''), z.string().trim().email().max(320)]);
const settingSchemas = {
  organization: z.strictObject({
    company_name: z.string().trim().min(1).max(300).optional(),
    legal_name: z.string().trim().max(300).optional(),
    email: optionalEmail.optional(),
    phone: z.string().trim().max(50).optional(),
    address: z.string().trim().max(2000).optional(),
    gstin: z.string().trim().max(30).optional(),
    pan: z.string().trim().max(20).optional(),
    state: z.string().trim().max(100).optional(),
    state_code: z.string().trim().max(10).optional(),
    currency_code: z.string().trim().length(3).transform(value => value.toUpperCase()).optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
    financial_year_start_month: z.coerce.number().int().min(1).max(12).optional()
  }),
  documents: z.strictObject({
    round_off: z.boolean().optional(),
    default_due_days: z.coerce.number().int().min(0).max(3650).optional(),
    discount_type: z.enum(['UNIT_PRICE', 'PRICE_WITH_TAX', 'NET_AMOUNT', 'TOTAL_AMOUNT']).optional(),
    cancellation_remarks_required: z.boolean().optional(),
    pdf_name_pattern: z.string().trim().min(1).max(300).optional(),
    ledger_name_pattern: z.string().trim().min(1).max(300).optional(),
    orientation: z.enum(['portrait', 'landscape']).optional(),
    repeat_header: z.boolean().optional(),
    show_due_date: z.boolean().optional(),
    show_payments: z.boolean().optional(),
    show_round_off: z.boolean().optional(),
    show_hsn_sac: z.boolean().optional(),
    show_hsn_summary: z.boolean().optional(),
    price_decimals: z.coerce.number().int().min(0).max(6).optional(),
    quantity_decimals: z.coerce.number().int().min(0).max(6).optional(),
    margins: z.strictObject({
      top: z.coerce.number().min(0).max(250).optional(),
      right: z.coerce.number().min(0).max(250).optional(),
      bottom: z.coerce.number().min(0).max(250).optional(),
      left: z.coerce.number().min(0).max(250).optional()
    }).optional(),
    numbering: z.strictObject({
      quotation_prefix: z.string().trim().min(1).max(20).optional(),
      sales_order_prefix: z.string().trim().min(1).max(20).optional(),
      purchase_order_prefix: z.string().trim().min(1).max(20).optional(),
      pro_forma_prefix: z.string().trim().min(1).max(20).optional(),
      delivery_prefix: z.string().trim().min(1).max(20).optional(),
      packing_list_prefix: z.string().trim().min(1).max(20).optional(),
      credit_note_prefix: z.string().trim().min(1).max(20).optional(),
      debit_note_prefix: z.string().trim().min(1).max(20).optional(),
      padding: z.coerce.number().int().min(3).max(12).optional(),
      yearly_reset: z.boolean().optional()
    }).optional(),
    template: z.string().trim().min(1).max(200).optional(),
    language: z.string().trim().min(2).max(20).optional(),
    font_family: z.string().trim().min(1).max(100).optional(),
    striped_rows: z.boolean().optional(),
    show_company_logo: z.boolean().optional(),
    show_signature: z.boolean().optional(),
    watermark: z.string().max(200).optional(),
    header_text: z.string().max(1000).optional(),
    footer_text: z.string().max(1000).optional(),
    signature_name: z.string().max(200).optional(),
    thermal_receipt_footer: z.string().max(1000).optional(),
    default_notes: z.string().max(10000).optional(),
    default_terms: z.string().max(10000).optional(),
    notes_by_type: z.record(z.string(), z.string().max(10000)).optional(),
    terms_by_type: z.record(z.string(), z.string().max(10000)).optional(),
    email_template: z.string().max(5000).optional(),
    whatsapp_template: z.string().max(5000).optional()
  }),
  pos: z.strictObject({
    active: z.boolean().optional(),
    send_sms: z.boolean().optional(),
    show_payment_qr: z.boolean().optional(),
    show_cash_received: z.boolean().optional(),
    show_brand_name: z.boolean().optional(),
    manual_quantity_on_scan: z.boolean().optional(),
    allow_duplicate_items: z.boolean().optional(),
    allow_price_edit: z.boolean().optional(),
    require_customer: z.boolean().optional(),
    allow_discount: z.boolean().optional()
  }),
  inventory: z.strictObject({
    default_item_type: z.enum(['PRODUCT', 'SERVICE']).optional(),
    prices_include_tax: z.boolean().optional(),
    maximum_discount_percent: z.union([z.null(), z.coerce.number().min(0).max(100)]).optional(),
    default_unit: z.string().trim().min(1).max(50).optional(),
    default_tax_rate: z.coerce.number().min(0).max(100).optional(),
    track_service_inventory: z.boolean().optional(),
    track_delivery_challan: z.boolean().optional(),
    expiry_date_format: z.enum(['DD-MM-YYYY', 'MM-YYYY', 'MM-YY']).optional(),
    show_batch_details: z.boolean().optional()
  }),
  notifications: z.strictObject({
    promotional: z.boolean().optional(),
    alerts: z.boolean().optional(),
    transactional: z.boolean().optional(),
    low_stock_email: z.boolean().optional(),
    pending_invoice_email: z.boolean().optional(),
    daily_summary_email: z.boolean().optional(),
    weekly_summary_email: z.boolean().optional(),
    monthly_summary_email: z.boolean().optional(),
    monthly_summary_whatsapp: z.boolean().optional()
  }),
  communications: z.strictObject({
    sender_name_source: z.enum(['BRAND_NAME', 'COMPANY_NAME', 'CUSTOM']).optional(),
    custom_sender_name: z.string().trim().max(200).optional(),
    from_email: optionalEmail.optional(),
    cc_emails: z.array(z.string().email().max(320)).max(25).optional(),
    bcc_emails: z.array(z.string().email().max(320)).max(25).optional(),
    whatsapp_enabled: z.boolean().optional()
  }),
  ai: z.strictObject({
    document_upload_instructions: z.string().max(2000).optional(),
    chat_instructions: z.string().max(2000).optional(),
    notes_terms_instructions: z.string().max(2000).optional(),
    product_description_instructions: z.string().max(2000).optional()
  })
};

const namespaceParam = z.object({
  namespace: z.enum(SETTINGS_NAMESPACES)
});
const featureFlagInput = z.strictObject({
  enabled: z.boolean(),
  configuration: z.record(z.string(), z.unknown()).optional()
});

router.get('/settings', requirePermission('dashboard.read'), asyncRoute(async (req, res) => {
  res.json({ namespaces: await listSettingsNamespaces(req.tenantDb) });
}));

router.get('/settings/:namespace', requirePermission('dashboard.read'), validate(namespaceParam, 'params'), asyncRoute(async (req, res) => {
  res.json(await getSettingsNamespace(req.tenantDb, req.params.namespace));
}));

router.put('/settings/:namespace', requirePermission('settings.manage'), validate(namespaceParam, 'params'), asyncRoute(async (req, res) => {
  const parsed = settingSchemas[req.params.namespace].safeParse(req.body);
  if (!parsed.success) {
    const error = new Error('The settings payload is invalid.');
    error.status = 422;
    error.code = 'validation_failed';
    error.details = parsed.error.flatten();
    throw error;
  }
  const result = await executeIdempotent(req, async () => ({
    body: await updateSettingsNamespace(req.tenantDb, req.params.namespace, parsed.data, req)
  }));
  sendMutation(res, result);
}));

router.get('/feature-flags', requirePermission('dashboard.read'), asyncRoute(async (req, res) => {
  res.json({ flags: await listFeatureFlags(req.tenantDb) });
}));

router.put('/feature-flags/:key', requirePermission('settings.manage'), validate(featureFlagInput), asyncRoute(async (req, res) => {
  const result = await executeIdempotent(req, async () => ({
    body: await updateFeatureFlag(req.tenantDb, req.params.key, req.body, req)
  }));
  sendMutation(res, result);
}));

export default router;
