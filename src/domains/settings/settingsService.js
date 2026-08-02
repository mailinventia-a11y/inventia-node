import { parseJson, writeTenantAudit } from '../../platform/phase5Http.js';
import { publishOrganizationEvent } from '../../platform/phase5Runtime.js';

export const SETTINGS_NAMESPACES = Object.freeze([
  'organization',
  'documents',
  'pos',
  'inventory',
  'notifications',
  'communications',
  'ai'
]);

export const SETTINGS_DEFAULTS = Object.freeze({
  organization: {
    company_name: 'Inventia',
    legal_name: '',
    email: '',
    phone: '',
    address: '',
    gstin: '',
    pan: '',
    state: '',
    state_code: '',
    currency_code: 'INR',
    timezone: 'Asia/Kolkata',
    financial_year_start_month: 4
  },
  documents: {
    round_off: true,
    default_due_days: 30,
    discount_type: 'TOTAL_AMOUNT',
    cancellation_remarks_required: true,
    pdf_name_pattern: '{document_title}_{serial_number}_{party_name}',
    ledger_name_pattern: '{ledger_type}_Ledger_{party_name}',
    orientation: 'portrait',
    repeat_header: true,
    show_due_date: true,
    show_payments: true,
    show_round_off: true,
    show_hsn_sac: true,
    show_hsn_summary: true,
    price_decimals: 2,
    quantity_decimals: 3,
    margins: { top: 10, right: 10, bottom: 10, left: 10 },
    numbering: {
      quotation_prefix: 'QT', sales_order_prefix: 'SO', purchase_order_prefix: 'PO',
      pro_forma_prefix: 'PI', delivery_prefix: 'DC', packing_list_prefix: 'PL',
      credit_note_prefix: 'CN', debit_note_prefix: 'DN', padding: 6, yearly_reset: false
    },
    template: 'GST Invoice A4',
    language: 'en-IN',
    font_family: 'Inter',
    striped_rows: false,
    show_company_logo: true,
    show_signature: true,
    watermark: '',
    header_text: '',
    footer_text: '',
    signature_name: '',
    thermal_receipt_footer: '',
    default_notes: '',
    default_terms: '',
    notes_by_type: {},
    terms_by_type: {},
    email_template: '',
    whatsapp_template: ''
  },
  pos: {
    active: true,
    send_sms: false,
    show_payment_qr: false,
    show_cash_received: true,
    show_brand_name: true,
    manual_quantity_on_scan: false,
    allow_duplicate_items: false,
    allow_price_edit: false,
    require_customer: false,
    allow_discount: true
  },
  inventory: {
    default_item_type: 'PRODUCT',
    prices_include_tax: true,
    maximum_discount_percent: null,
    default_unit: 'piece',
    default_tax_rate: 0,
    track_service_inventory: false,
    track_delivery_challan: false,
    expiry_date_format: 'DD-MM-YYYY',
    show_batch_details: true
  },
  notifications: {
    promotional: false,
    alerts: true,
    transactional: true,
    low_stock_email: false,
    pending_invoice_email: false,
    daily_summary_email: false,
    weekly_summary_email: false,
    monthly_summary_email: false,
    monthly_summary_whatsapp: false
  },
  communications: {
    sender_name_source: 'BRAND_NAME',
    custom_sender_name: '',
    from_email: '',
    cc_emails: [],
    bcc_emails: [],
    whatsapp_enabled: false
  },
  ai: {
    document_upload_instructions: '',
    chat_instructions: '',
    notes_terms_instructions: '',
    product_description_instructions: ''
  }
});

export const FEATURE_FLAG_DEFAULTS = Object.freeze({
  frontend_modules: { enabled: true, configuration: {} },
  settings_namespaces: { enabled: true, configuration: {} },
  navigation_v2: { enabled: false, configuration: {} },
  trade_workspaces: { enabled: false, configuration: {} },
  document_engine_v2: { enabled: false, configuration: {} },
  finance_v2: { enabled: false, configuration: {} },
  reminders_v2: { enabled: false, configuration: {} },
  projects_v2: { enabled: false, configuration: {} },
  notifications_v2: { enabled: false, configuration: {} }
});

export async function listSettingsNamespaces(db) {
  const rows = await db.all(
    `SELECT setting_key, setting_value, updated_by, updated_at
       FROM organization_settings
      WHERE setting_key LIKE 'settings.%'`
  );
  const stored = new Map(rows.map(row => [
    row.setting_key.slice('settings.'.length),
    {
      value: parseJson(row.setting_value, {}),
      updated_by: row.updated_by || null,
      updated_at: row.updated_at || null
    }
  ]));

  return Object.fromEntries(SETTINGS_NAMESPACES.map(namespace => {
    const entry = stored.get(namespace);
    return [namespace, {
      namespace,
      settings: mergeSettings(SETTINGS_DEFAULTS[namespace], entry?.value),
      updated_by: entry?.updated_by || null,
      updated_at: entry?.updated_at || null
    }];
  }));
}

export async function getSettingsNamespace(db, namespace) {
  assertNamespace(namespace);
  const row = await db.one(
    `SELECT setting_value, updated_by, updated_at
       FROM organization_settings
      WHERE setting_key = ?`,
    [settingsKey(namespace)]
  );
  return {
    namespace,
    settings: mergeSettings(SETTINGS_DEFAULTS[namespace], parseJson(row?.setting_value, {})),
    updated_by: row?.updated_by || null,
    updated_at: row?.updated_at || null
  };
}

export async function updateSettingsNamespace(db, namespace, changes, req) {
  assertNamespace(namespace);
  const before = await getSettingsNamespace(db, namespace);
  const next = mergeSettings(before.settings, changes);
  const updatedAt = now();

  await db.run(
    `INSERT INTO organization_settings (setting_key, setting_value, updated_by, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (setting_key) DO UPDATE SET
       setting_value = excluded.setting_value,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
    [settingsKey(namespace), JSON.stringify(next), req.user.id, updatedAt]
  );

  const after = {
    namespace,
    settings: next,
    updated_by: req.user.id,
    updated_at: updatedAt
  };
  await writeTenantAudit(db, req, {
    eventType: 'settings.namespace.updated',
    entityType: 'settings_namespace',
    entityId: namespace,
    before,
    after
  });
  await publishOrganizationEvent(req.user.organization_id, 'settings.changed', {
    namespace,
    updated_at: updatedAt
  });
  return after;
}

export async function listFeatureFlags(db) {
  const rows = await db.all(
    `SELECT flag_key, enabled, configuration, updated_by, updated_at
       FROM feature_flags
      ORDER BY flag_key`
  );
  const stored = new Map(rows.map(row => [row.flag_key, normalizeFlag(row)]));
  return Object.fromEntries(Object.entries(FEATURE_FLAG_DEFAULTS).map(([key, defaults]) => [
    key,
    stored.get(key) || {
      key,
      enabled: defaults.enabled,
      configuration: clone(defaults.configuration),
      updated_by: null,
      updated_at: null
    }
  ]));
}

export async function updateFeatureFlag(db, key, input, req) {
  assertFeatureFlag(key);
  const flags = await listFeatureFlags(db);
  const before = flags[key];
  const after = {
    key,
    enabled: input.enabled,
    configuration: input.configuration ?? before.configuration ?? {},
    updated_by: req.user.id,
    updated_at: now()
  };

  await db.run(
    `INSERT INTO feature_flags
       (flag_key, enabled, configuration, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (flag_key) DO UPDATE SET
       enabled = excluded.enabled,
       configuration = excluded.configuration,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
    [key, after.enabled ? 1 : 0, JSON.stringify(after.configuration), req.user.id, after.updated_at]
  );

  await writeTenantAudit(db, req, {
    eventType: 'feature_flag.updated',
    entityType: 'feature_flag',
    entityId: key,
    before,
    after
  });
  await publishOrganizationEvent(req.user.organization_id, 'feature_flags.changed', {
    key,
    enabled: after.enabled,
    updated_at: after.updated_at
  });
  return after;
}

function assertNamespace(namespace) {
  if (!SETTINGS_NAMESPACES.includes(namespace)) {
    const error = new Error('The requested settings namespace does not exist.');
    error.status = 404;
    error.code = 'settings_namespace_not_found';
    throw error;
  }
}

function assertFeatureFlag(key) {
  if (!Object.hasOwn(FEATURE_FLAG_DEFAULTS, key)) {
    const error = new Error('The requested feature flag does not exist.');
    error.status = 404;
    error.code = 'feature_flag_not_found';
    throw error;
  }
}

function settingsKey(namespace) {
  return `settings.${namespace}`;
}

function normalizeFlag(row) {
  return {
    key: row.flag_key,
    enabled: Boolean(Number(row.enabled)),
    configuration: parseJson(row.configuration, {}),
    updated_by: row.updated_by || null,
    updated_at: row.updated_at || null
  };
}

function mergeSettings(defaults, changes) {
  const base = clone(defaults || {});
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return base;
  for (const [key, value] of Object.entries(changes)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      base[key] = mergeSettings(base[key], value);
    } else {
      base[key] = clone(value);
    }
  }
  return base;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (value == null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}
