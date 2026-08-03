import crypto from 'crypto';
import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  authenticateV1,
  hashPlatformPassword,
  listPlatformOrganizations,
  loginPlatform,
  logoutPlatformSession,
  refreshPlatformSession,
  requirePermission,
  switchPlatformOrganization,
  writeControlAudit
} from '../platform/phase5Auth.js';
import {
  DEFAULT_ORGANIZATION_ID,
  getControlDatabase,
  getTenantDatabase,
  initializePhase5Platform,
  provisionOrganizationDatabase,
  rolePermissions
} from '../platform/phase5Database.js';
import {
  asyncRoute,
  executeIdempotent,
  httpError,
  sendMutation,
  validate,
  writeTenantAudit
} from '../platform/phase5Http.js';
import { createStorageAdapter } from '../platform/storageAdapter.js';
import {
  archiveProduct,
  addPartyDetail,
  checkoutPos,
  completeCycleCount,
  createCycleCount,
  createParty,
  createProduct,
  createTradeDocument,
  dashboardActivity,
  dashboardSummary,
  decideApproval,
  fulfillSalesOrder,
  getParty,
  getProduct,
  getCycleCount,
  getTradeDocument,
  listInventoryBalances,
  listParties,
  listProducts,
  listReorderRecommendations,
  listStockMovements,
  listTradeDocuments,
  postStockMovement,
  receivePurchaseOrder,
  reserveStock,
  transferStock,
  transitionTradeDocument,
  updateParty,
  updateProduct
} from '../services/enterpriseTradeService.js';
import {
  createRazorpayOrder,
  paymentReconciliation,
  refundRazorpayPayment,
  verifyRazorpayPayment
} from '../services/razorpayService.js';
import {
  collectInvoicePayment,
  confirmPaymentAllocation,
  getInvoice,
  getPaymentMethods,
  listInvoices,
  readInvoicePdf,
  refundPaymentAllocation,
  retryInvoicePdf,
  updatePaymentMethods
} from '../services/invoicePaymentService.js';
import {
  convertDocument,
  createFiscalAdjustment,
  getFiscalAdjustment,
  listDocumentLinks,
  listDocumentTemplates,
  listFiscalAdjustments,
  saveDocumentTemplate,
  transitionFiscalAdjustment
} from '../services/documentEngineService.js';
import {
  approveTenantAiAction,
  createKnowledge,
  deleteKnowledge,
  getTenantAiConversation,
  listKnowledge,
  listTenantAiActions,
  listTenantAiConversations,
  rejectTenantAiAction,
  searchTenantBusiness,
  tenantAiAnalytics,
  tenantAiChat,
  updateKnowledge
} from '../services/tenantAiService.js';
import {
  archiveBarcodeTemplate,
  assignBarcode,
  cancelPrintJob,
  createBarcodeTemplate,
  createPrintJob,
  downloadPrintJob,
  generateMissingBarcodes,
  getBarcodeAnalytics,
  getBarcodeOverview,
  getBarcodeRecommendations,
  getBarcodeSettings,
  listBarcodeProducts,
  listBarcodeTemplates,
  listPrintJobs,
  listScanHistory,
  regenerateBarcode,
  renderAssignedBarcode,
  resolveBarcodeScan,
  retryPrintJob,
  updateBarcodeSettings,
  updateBarcodeTemplate,
  validateBarcodeInput,
  ensureProductBarcodesTx
} from '../services/barcodeLabelService.js';
import settingsFoundationRoutes from './v1/settingsRoutes.js';
import {
  createBankAccount,
  createExpense,
  createFinanceAccount,
  createJournal,
  financeReconciliation,
  financeSummary,
  getAccountLedger,
  getJournal,
  listBankAccounts,
  listExpenses,
  listFinanceAccounts,
  listJournals,
  paymentTimeline,
  postBankTransaction,
  reconcileBankTransaction
} from '../services/financeOperationsService.js';
import {
  cancelPaymentLink,
  cancelReminder,
  createPaymentLink,
  createProject,
  createReminder,
  getProject,
  linkProjectDocument,
  listPaymentLinks,
  listProjects,
  listReminders,
  listTenantNotifications,
  markNotificationRead,
  processDueReminders,
  projectProfitability,
  resolvePublicPaymentLink,
  unlinkProjectDocument,
  updateProject
} from '../services/businessOperationsService.js';
import {
  cancelComplianceDocument,
  createSubscription,
  decideGstReturnApproval,
  fileGstReturn,
  generateComplianceDocument,
  generateSubscriptionRun,
  getComplianceDocument,
  getGstReturn,
  getSubscription,
  importGstr2bRows,
  listComplianceDocuments,
  listGstReturns,
  listSubscriptions,
  prepareComplianceDocument,
  prepareGstReturn,
  processDueSubscriptions,
  requestGstReturnApproval,
  tdsTcsReport,
  transitionSubscription,
  updateImsAction,
  updateSubscription
} from '../services/subscriptionComplianceService.js';
import {
  configureIntegration,
  createApiKey,
  createPublicOrder,
  createWebhookSubscription,
  deliverWebhook,
  disableIntegration,
  getIntegration,
  getOnlineOrder,
  getPublicCatalog,
  getStoreSettings,
  listApiKeys,
  listCatalogManagement,
  listIntegrationRuns,
  listIntegrations,
  listOnlineOrders,
  listWebhookDeliveries,
  listWebhookSubscriptions,
  reviewOnlineOrder,
  revokeApiKey,
  syncIntegration,
  testIntegration,
  updateCatalogProduct,
  updateStoreSettings,
  updateWebhookSubscription
} from '../services/storeIntegrationService.js';
import { listReportDefinitions, reportToCsv, runReport } from '../services/reportingService.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024), files: 1 }
});
const storage = createStorageAdapter();

const loginSchema = z.object({
  organization_slug: z.string().trim().min(1).max(80).optional(),
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(500)
});
const refreshSchema = z.object({ refresh_token: z.string().min(20) });
const productSchema = z.object({
  sku: z.string().trim().min(1).max(100),
  barcode: z.string().trim().max(100).nullable().optional(),
  barcode_type: z.enum(['CODE128', 'CODE39', 'EAN8', 'EAN13', 'UPCA', 'UPCE', 'QRCODE', 'ITF14', 'DATAMATRIX']).optional(),
  name: z.string().trim().min(1).max(300),
  brand_id: z.coerce.number().int().positive().nullable().optional(),
  category_id: z.coerce.number().int().positive().nullable().optional(),
  description: z.string().max(10000).nullable().optional(),
  uom: z.string().trim().min(1).max(50).default('piece'),
  coverage_per_box: z.coerce.number().nonnegative().nullable().optional(),
  cost_price: z.coerce.number().nonnegative().default(0),
  selling_price: z.coerce.number().nonnegative().default(0),
  minimum_price: z.coerce.number().nonnegative().default(0),
  maximum_price: z.coerce.number().nonnegative().nullable().optional(),
  hsn_code: z.string().trim().max(30).nullable().optional(),
  gst_rate: z.coerce.number().min(0).max(100).default(0),
  valuation_method: z.enum(['weighted_average', 'fifo', 'lifo']).default('weighted_average'),
  track_batches: z.boolean().default(false),
  track_serials: z.boolean().default(false),
  min_stock_alert: z.coerce.number().nonnegative().default(5),
  material: z.string().max(100).nullable().optional(),
  finish: z.string().max(100).nullable().optional(),
  dimensions: z.string().max(100).nullable().optional(),
  shade_lot_number: z.string().max(100).nullable().optional(),
  image_url: z.string().max(2000).nullable().optional(),
  status: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  variants: z.array(z.object({
    sku: z.string().trim().min(1).max(100),
    barcode: z.string().max(100).nullable().optional(),
    name: z.string().trim().min(1).max(200),
    attributes: z.record(z.string(), z.unknown()).optional(),
    cost_price: z.coerce.number().nonnegative().default(0),
    selling_price: z.coerce.number().nonnegative().default(0)
  })).max(100).optional()
}).superRefine((value, context) => {
  if (value.maximum_price != null && value.maximum_price < value.minimum_price) {
    context.addIssue({ code: 'custom', path: ['maximum_price'], message: 'Maximum price must be at least the minimum price.' });
  }
  if (value.selling_price < value.minimum_price) {
    context.addIssue({ code: 'custom', path: ['selling_price'], message: 'Selling price cannot be below the minimum price.' });
  }
});
const barcodeTypeSchema = z.enum(['CODE128', 'CODE39', 'EAN8', 'EAN13', 'UPCA', 'UPCE', 'QRCODE', 'ITF14', 'DATAMATRIX']);
const barcodeTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100).default('product'),
  configuration: z.object({
    show_company: z.boolean().optional(),
    show_product: z.boolean().optional(),
    show_variant: z.boolean().optional(),
    show_sku: z.boolean().optional(),
    show_barcode_number: z.boolean().optional(),
    show_mrp: z.boolean().optional(),
    show_selling_price: z.boolean().optional(),
    show_hsn: z.boolean().optional(),
    show_batch: z.boolean().optional(),
    show_expiry: z.boolean().optional(),
    barcode_height_mm: z.coerce.number().min(5).max(100).optional(),
    font_size_pt: z.coerce.number().min(5).max(32).optional(),
    alignment: z.enum(['left', 'center', 'right']).optional(),
    border: z.boolean().optional()
  }).default({}),
  is_default: z.boolean().default(false)
});
const barcodeSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  auto_generate: z.boolean().optional(),
  default_type: barcodeTypeSchema.optional(),
  assignment_level: z.enum(['product', 'variant']).optional(),
  prefix: z.string().max(30).optional(),
  suffix: z.string().max(30).optional(),
  sequence_length: z.coerce.number().int().min(4).max(18).optional(),
  pattern: z.string().max(100).optional(),
  prevent_duplicates: z.boolean().optional(),
  allow_manual: z.boolean().optional(),
  allow_regeneration: z.boolean().optional(),
  default_label_quantity: z.coerce.number().int().min(1).max(10000).optional(),
  scanner: z.object({
    mode: z.enum(['HID', 'BLUETOOTH', 'CAMERA', 'MANUAL']).optional(),
    prefix: z.string().max(30).optional(),
    suffix: z.string().max(30).optional(),
    termination_key: z.enum(['Enter', 'Tab']).optional(),
    duplicate_delay_ms: z.coerce.number().int().min(0).max(10000).optional(),
    sound: z.boolean().optional(),
    auto_add_to_pos: z.boolean().optional()
  }).optional()
}).refine(value => Object.keys(value).length > 0);
const movementSchema = z.object({
  product_id: z.coerce.number().int().positive(),
  variant_id: z.coerce.number().int().positive().nullable().optional(),
  warehouse_id: z.coerce.number().int().positive(),
  movement_type: z.enum(['opening', 'purchase_receipt', 'sale', 'adjustment', 'adjustment_in', 'adjustment_out', 'damage', 'transfer_in', 'transfer_out', 'sales_return', 'purchase_return']),
  quantity: z.coerce.number().refine(value => value !== 0),
  unit_cost: z.coerce.number().nonnegative().optional(),
  batch_no: z.string().max(100).optional(),
  expires_at: z.string().datetime().optional(),
  reference_type: z.string().max(100).optional(),
  reference_id: z.union([z.string(), z.number()]).optional(),
  notes: z.string().max(2000).optional(),
  occurred_at: z.string().datetime().optional()
});
const transferSchema = z.object({
  product_id: z.coerce.number().int().positive(),
  variant_id: z.coerce.number().int().positive().nullable().optional(),
  from_warehouse_id: z.coerce.number().int().positive(),
  to_warehouse_id: z.coerce.number().int().positive(),
  quantity: z.coerce.number().positive(),
  notes: z.string().max(2000).optional()
});
const reserveSchema = z.object({
  product_id: z.coerce.number().int().positive(),
  variant_id: z.coerce.number().int().positive().nullable().optional(),
  warehouse_id: z.coerce.number().int().positive(),
  quantity: z.coerce.number().positive(),
  reference_type: z.string().min(1).max(100),
  reference_id: z.union([z.string(), z.number()]),
  expires_at: z.string().datetime().optional()
});
const partySchema = z.object({
  name: z.string().trim().min(1).max(300),
  legal_name: z.string().max(300).optional(),
  phone: z.string().max(50).nullable().optional(),
  email: z.string().email().nullable().optional(),
  address: z.string().max(2000).nullable().optional(),
  gstin: z.string().max(30).nullable().optional(),
  credit_limit: z.coerce.number().nonnegative().optional(),
  payment_terms_days: z.coerce.number().int().nonnegative().optional(),
  lead_time_days: z.coerce.number().int().nonnegative().optional(),
  rating: z.coerce.number().min(0).max(5).nullable().optional(),
  tier: z.string().max(30).optional(),
  tags: z.array(z.string().max(50)).max(50).optional(),
  notes: z.string().max(10000).nullable().optional(),
  contacts: z.array(z.object({
    name: z.string().min(1).max(200),
    title: z.string().max(100).optional(),
    email: z.string().email().optional(),
    phone: z.string().max(50).optional(),
    is_primary: z.boolean().optional()
  })).max(50).optional(),
  addresses: z.array(z.object({
    address_type: z.enum(['billing', 'shipping', 'office', 'warehouse']).optional(),
    line1: z.string().min(1).max(500),
    line2: z.string().max(500).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(100).optional(),
    postal_code: z.string().max(30).optional(),
    country: z.string().length(2).optional(),
    is_primary: z.boolean().optional()
  })).max(50).optional()
});
const tradeLineSchema = z.object({
  product_id: z.coerce.number().int().positive(),
  variant_id: z.coerce.number().int().positive().nullable().optional(),
  description: z.string().max(1000).optional(),
  quantity: z.coerce.number().positive(),
  unit_price: z.coerce.number().nonnegative(),
  discount: z.coerce.number().nonnegative().default(0),
  tax_rate: z.coerce.number().min(0).max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});
const tradeSchema = z.object({
  document_no: z.string().max(100).optional(),
  party_id: z.coerce.number().int().positive().optional(),
  warehouse_id: z.coerce.number().int().positive().optional(),
  currency: z.string().length(3).default('INR'),
  discount: z.coerce.number().nonnegative().default(0),
  source_document_id: z.coerce.number().int().positive().optional(),
  expected_at: z.string().datetime().optional(),
  notes: z.string().max(10000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  lines: z.array(tradeLineSchema).min(1).max(500)
});
const conversionSchema = z.object({
  target_type: z.enum(['sales_order', 'pro_forma_invoice', 'delivery_challan', 'packing_list', 'invoice', 'goods_receipt']),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expected_at: z.string().datetime().optional(),
  notes: z.string().max(10000).optional(),
  items: z.array(z.object({
    line_id: z.coerce.number().int().positive(),
    quantity: z.coerce.number().positive(),
    batch_no: z.string().max(100).optional(),
    expires_at: z.string().datetime().optional()
  })).max(500).optional()
});
const fiscalAdjustmentSchema = z.object({
  invoice_id: z.coerce.number().int().positive().optional(),
  trade_document_id: z.coerce.number().int().positive().optional(),
  warehouse_id: z.coerce.number().int().positive().optional(),
  reason: z.string().trim().min(1).max(2000),
  affects_stock: z.boolean().default(false),
  lines: z.array(z.object({
    product_id: z.coerce.number().int().positive().optional(),
    variant_id: z.coerce.number().int().positive().optional(),
    description: z.string().trim().min(1).max(500),
    quantity: z.coerce.number().positive(),
    unit: z.string().trim().min(1).max(50).default('piece'),
    rate: z.coerce.number().nonnegative(),
    discount: z.coerce.number().nonnegative().default(0),
    tax_rate: z.coerce.number().min(0).max(100).default(0),
    metadata: z.record(z.string(), z.unknown()).optional()
  })).min(1).max(500)
});
const documentTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  document_type: z.string().trim().min(1).max(100),
  format: z.enum(['A4', 'THERMAL']).default('A4'),
  configuration: z.record(z.string(), z.unknown()).default({}),
  is_default: z.boolean().default(false),
  status: z.enum(['active', 'inactive']).default('active')
});
const financeAccountSchema = z.object({
  code: z.string().trim().min(1).max(30),
  name: z.string().trim().min(1).max(200),
  account_type: z.enum(['asset', 'liability', 'income', 'expense', 'equity']),
  parent_id: z.coerce.number().int().positive().optional(),
  opening_balance: z.coerce.number().default(0),
  currency: z.string().trim().length(3).default('INR')
});
const journalSchema = z.object({
  journal_type: z.string().trim().min(1).max(50).default('GENERAL'),
  journal_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reference: z.string().trim().max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  entries: z.array(z.object({
    account_id: z.coerce.number().int().positive(),
    debit: z.coerce.number().nonnegative().default(0),
    credit: z.coerce.number().nonnegative().default(0),
    party_type: z.enum(['customer', 'supplier']).optional(),
    party_id: z.coerce.number().int().positive().optional(),
    project_id: z.coerce.number().int().positive().optional(),
    description: z.string().max(1000).optional()
  })).min(2).max(200)
});
const bankAccountSchema = z.object({
  account_id: z.coerce.number().int().positive().optional(),
  code: z.string().trim().max(30).optional(),
  name: z.string().trim().min(1).max(200),
  account_number: z.string().trim().min(4).max(100),
  ifsc: z.string().trim().max(30).optional(),
  upi_id: z.string().trim().max(200).optional(),
  opening_balance: z.coerce.number().default(0),
  currency: z.string().trim().length(3).default('INR')
});
const bankTransactionSchema = z.object({
  direction: z.enum(['IN', 'OUT', 'in', 'out']).transform(value => value.toUpperCase()),
  amount: z.coerce.number().positive(),
  offset_account_id: z.coerce.number().int().positive(),
  method: z.string().trim().max(50).optional(),
  reference: z.string().trim().max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});
const expenseSchema = z.object({
  supplier_id: z.coerce.number().int().positive().optional(),
  expense_account_id: z.coerce.number().int().positive(),
  payment_account_id: z.coerce.number().int().positive().optional(),
  subtotal: z.coerce.number().nonnegative(), tax: z.coerce.number().nonnegative().default(0),
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  description: z.string().trim().max(2000).optional(),
  reference: z.string().trim().max(200).optional(),
  status: z.enum(['DRAFT', 'POSTED', 'PAID']).default('DRAFT'),
  project_id: z.coerce.number().int().positive().optional()
});
const paymentLinkSchema = z.object({
  invoice_id: z.coerce.number().int().positive(),
  amount: z.coerce.number().positive().optional(),
  expires_at: z.string().datetime()
});
const reminderSchema = z.object({
  reminder_type: z.string().trim().min(1).max(100),
  entity_type: z.enum(['invoice', 'customer', 'supplier', 'project', 'trade_document']),
  entity_id: z.union([z.string().trim().min(1).max(100), z.coerce.number().int().positive()]),
  recipient_type: z.enum(['user', 'customer', 'supplier', 'organization']),
  recipient_id: z.string().trim().max(100).optional(),
  channel: z.enum(['IN_APP', 'EMAIL', 'SMS', 'WHATSAPP']).default('IN_APP'),
  scheduled_at: z.string().datetime(),
  subject: z.string().trim().max(300).optional(),
  message: z.string().trim().min(1).max(5000)
});
const projectSchema = z.object({
  name: z.string().trim().min(1).max(300),
  customer_id: z.coerce.number().int().positive().optional(),
  status: z.enum(['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).default('PLANNED'),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  budget_revenue: z.coerce.number().nonnegative().default(0),
  budget_cost: z.coerce.number().nonnegative().default(0),
  description: z.string().trim().max(5000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});
const projectUpdateSchema = projectSchema.partial();
const projectDocumentSchema = z.object({
  entity_type: z.enum(['invoice', 'trade_document', 'expense']),
  entity_id: z.union([z.string().trim().min(1).max(100), z.coerce.number().int().positive()]),
  relationship_type: z.string().trim().min(1).max(100).default('related')
});
const subscriptionItemSchema = z.object({
  product_id: z.coerce.number().int().positive(),
  variant_id: z.coerce.number().int().positive().optional(),
  quantity: z.coerce.number().positive(),
  unit_price: z.coerce.number().nonnegative().optional()
});
const subscriptionSchema = z.object({
  name: z.string().trim().min(1).max(300),
  customer_id: z.coerce.number().int().positive(), warehouse_id: z.coerce.number().int().positive(),
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']),
  interval_count: z.coerce.number().int().min(1).max(120).default(1),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  due_days: z.coerce.number().int().min(0).max(3650).default(0),
  price_policy: z.enum(['SNAPSHOT', 'CURRENT_APPROVED']).default('SNAPSHOT'),
  items: z.array(subscriptionItemSchema).min(1).max(200),
  invoice_details: z.record(z.string(), z.unknown()).optional(),
  delivery_channels: z.array(z.enum(['IN_APP', 'EMAIL'])).min(1).max(2).default(['IN_APP']),
  notes: z.string().trim().max(5000).optional()
});
const subscriptionUpdateSchema = subscriptionSchema.partial();
const complianceDocumentSchema = z.object({
  invoice_id: z.coerce.number().int().positive().optional(),
  trade_document_id: z.coerce.number().int().positive().optional(),
  transport: z.object({
    transporter_id: z.string().trim().max(100).optional(), transporter_name: z.string().trim().max(300).optional(),
    vehicle_number: z.string().trim().max(30).optional(), distance_km: z.coerce.number().min(0).max(4000).optional(),
    transport_mode: z.string().trim().max(50).optional()
  }).optional()
}).refine(value => value.invoice_id || value.trade_document_id, { message: 'Invoice or trade document is required.' });
const gstr2bImportSchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  rows: z.array(z.object({
    gstin: z.string().trim().max(30).optional(), document_number: z.string().trim().min(1).max(100),
    document_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    taxable: z.coerce.number().nonnegative(), tax: z.coerce.number().nonnegative()
  })).max(10000)
});
const storeSettingsSchema = z.object({
  store_slug: z.string().regex(/^[a-z0-9-]{2,80}$/),
  status: z.enum(['DRAFT', 'PUBLISHED', 'PAUSED']),
  mode: z.enum(['CATALOG_ONLY', 'DIRECT_ORDER']),
  stock_policy: z.enum(['HIDE_QUANTITY', 'SHOW_AVAILABLE', 'IN_STOCK_ONLY']),
  contact_details: z.record(z.string(), z.unknown()).default({}),
  terms: z.string().max(20000).optional()
});
const catalogProductSchema = z.object({
  published: z.boolean(), price: z.coerce.number().nonnegative().nullable().optional(),
  show_stock: z.boolean().default(false), max_order_quantity: z.coerce.number().positive().nullable().optional(),
  sort_order: z.coerce.number().int().min(0).max(100000).default(0),
  metadata: z.record(z.string(), z.unknown()).default({})
});
const publicOrderSchema = z.object({
  customer: z.object({
    name: z.string().trim().min(2).max(300), phone: z.string().trim().min(5).max(50),
    email: z.string().email().optional(), address: z.string().trim().min(5).max(2000),
    gstin: z.string().trim().max(30).optional(), notes: z.string().max(2000).optional()
  }),
  items: z.array(z.object({ product_id: z.coerce.number().int().positive(), quantity: z.coerce.number().positive().max(100000) })).min(1).max(200),
  payment: z.record(z.string(), z.unknown()).optional()
});
const integrationConfigSchema = z.object({
  enabled: z.boolean().default(true), config: z.record(z.string(), z.unknown())
});
const integrationSyncSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});
const apiKeySchema = z.object({
  name: z.string().trim().min(2).max(200),
  scopes: z.array(z.enum(['catalog.read', 'orders.read', 'orders.write', 'webhooks.read'])).min(1).max(20),
  expires_at: z.string().datetime().optional()
});
const webhookSubscriptionSchema = z.object({
  name: z.string().trim().min(2).max(200), endpoint_url: z.string().url().refine(value => value.startsWith('https://') || process.env.NODE_ENV !== 'production', 'HTTPS is required in production.'),
  events: z.array(z.string().trim().min(1).max(100)).min(1).max(100), secret: z.string().min(16).max(500).optional()
});
const webhookUpdateSchema = webhookSubscriptionSchema.omit({ secret: true }).extend({ status: z.enum(['ACTIVE', 'PAUSED', 'REVOKED']) });

router.post('/auth/login', validate(loginSchema), asyncRoute(async (req, res) => {
  const result = await loginPlatform({
    organizationSlug: req.body.organization_slug,
    username: req.body.username,
    password: req.body.password,
    userAgent: req.headers['user-agent'],
    ipAddress: req.ip
  });
  res.json(result);
}));

router.post('/auth/refresh', validate(refreshSchema), asyncRoute(async (req, res) => {
  res.json(await refreshPlatformSession(req.body.refresh_token, {
    userAgent: req.headers['user-agent'],
    ipAddress: req.ip
  }));
}));

router.post('/auth/logout', validate(refreshSchema), asyncRoute(async (req, res) => {
  await logoutPlatformSession(req.body.refresh_token);
  res.status(204).end();
}));

router.get('/payment-links/public/:organizationId/:token', asyncRoute(async (req, res) => {
  const tenantDb = await getTenantDatabase(req.params.organizationId);
  res.json(await resolvePublicPaymentLink(tenantDb, req.params.token));
}));

router.get('/public/store/:organizationSlug/catalog', asyncRoute(async (req, res) => {
  const organization = await getControlDatabase().one(
    `SELECT id, slug, name FROM organizations WHERE slug = ? AND status = 'active'`,
    [req.params.organizationSlug]
  );
  if (!organization) throw httpError(404, 'store_not_found', 'The store was not found.');
  res.json(await getPublicCatalog(await getTenantDatabase(organization.id), organization));
}));

router.post('/public/store/:organizationSlug/orders', validate(publicOrderSchema), asyncRoute(async (req, res) => {
  const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
  if (!idempotencyKey) throw httpError(400, 'idempotency_key_required', 'Idempotency-Key is required.');
  const organization = await getControlDatabase().one(
    `SELECT id, slug, name FROM organizations WHERE slug = ? AND status = 'active'`,
    [req.params.organizationSlug]
  );
  if (!organization) throw httpError(404, 'store_not_found', 'The store was not found.');
  const order = await createPublicOrder(await getTenantDatabase(organization.id), organization.id, req.body, idempotencyKey);
  res.status(order.duplicate ? 200 : 201).json(order);
}));

router.use(authenticateV1);

router.get('/organizations', asyncRoute(async (req, res) => {
  res.json({ organizations: await listPlatformOrganizations(req.user.id), active_organization_id: req.user.organization_id });
}));

router.post('/organizations/:id/switch', asyncRoute(async (req, res) => {
  const result = await executeIdempotent(req, async () => ({
    body: await (async () => {
      const session = await switchPlatformOrganization(req.user.id, req.params.id, {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip
      });
      await getControlDatabase().run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [now(), req.user.session_id]);
      return session;
    })()
  }));
  sendMutation(res, result);
}));

router.post('/organizations', requirePermission('*'), validate(z.object({
  slug: z.string().regex(/^[a-z0-9-]{2,80}$/),
  name: z.string().trim().min(2).max(200)
})), asyncRoute(async (req, res) => {
  const result = await executeIdempotent(req, async () => {
    const control = getControlDatabase();
    const id = crypto.randomUUID();
    await control.transaction(async tx => {
      await tx.run(
        `INSERT INTO organizations (id, slug, name, status, settings, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?)`,
        [id, req.body.slug, req.body.name, JSON.stringify({ valuation_method: 'weighted_average' }), now(), now()]
      );
      await tx.run(
        `INSERT INTO memberships
          (id, organization_id, user_id, role, permissions, status, created_at, updated_at)
         VALUES (?, ?, ?, 'admin', ?, 'active', ?, ?)`,
        [crypto.randomUUID(), id, req.user.id, JSON.stringify(rolePermissions('admin')), now(), now()]
      );
    });
    await provisionOrganizationDatabase({ organizationId: id, slug: req.body.slug });
    await writeControlAudit({
      organizationId: id,
      userId: req.user.id,
      eventType: 'organization.created',
      requestId: req.requestId,
      ipAddress: req.ip,
      metadata: { slug: req.body.slug, name: req.body.name }
    });
    return { status: 201, body: { id, slug: req.body.slug, name: req.body.name } };
  });
  sendMutation(res, result);
}));

router.get('/products', requirePermission('products.read'), asyncRoute(async (req, res) => {
  res.json({ products: await listProducts(req.tenantDb, req.query) });
}));
router.get('/products/export', requirePermission('products.read'), asyncRoute(async (req, res) => {
  const items = await listProducts(req.tenantDb, { ...req.query, limit: 500, status: 'all' });
  if (req.query.format === 'json') return res.json({ products: items });
  const columns = ['id', 'sku', 'barcode', 'name', 'uom', 'hsn_code', 'gst_rate', 'cost_price', 'selling_price', 'quantity_on_hand'];
  const csv = [columns.join(','), ...items.map(item => columns.map(column => csvValue(item[column])).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="inventia-products-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));
router.get('/products/:id', requirePermission('products.read'), asyncRoute(async (req, res) => {
  res.json(await getProduct(req.tenantDb, req.params.id));
}));
router.post('/products', requirePermission('products.create'), validate(productSchema), mutation(async req => ({
  status: 201,
  body: await createProduct(req.tenantDb, req.body, req)
})));
router.put('/products/:id', requirePermission('products.update'), validate(productSchema), mutation(async req => ({
  body: await updateProduct(req.tenantDb, req.params.id, req.body, req)
})));
router.delete('/products/:id', requirePermission('products.delete'), mutation(async req => ({
  body: await archiveProduct(req.tenantDb, req.params.id, req)
})));
const variantSchema = z.object({
  sku: z.string().trim().min(1).max(100),
  barcode: z.string().max(100).nullable().optional(),
  name: z.string().trim().min(1).max(200),
  attributes: z.record(z.string(), z.unknown()).optional(),
  cost_price: z.coerce.number().nonnegative().default(0),
  selling_price: z.coerce.number().nonnegative().default(0),
  status: z.enum(['active', 'inactive']).default('active')
});
router.post('/products/:id/variants', requirePermission('products.update'), validate(variantSchema), mutation(async req => {
  await getProduct(req.tenantDb, req.params.id);
  const inserted = await insertWithId(req.tenantDb,
    `INSERT INTO product_variants
      (product_id, sku, barcode, name, attributes, cost_price, selling_price, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.params.id, req.body.sku, req.body.barcode || null, req.body.name,
      JSON.stringify(req.body.attributes || {}), req.body.cost_price, req.body.selling_price,
      req.body.status, now(), now()]
  );
  const id = inserted.id || inserted.rows?.[0]?.id;
  await ensureProductBarcodesTx(req.tenantDb, Number(req.params.id), [req.body], req.user.id);
  const variant = await req.tenantDb.one('SELECT * FROM product_variants WHERE id = ?', [id]);
  await writeTenantAudit(req.tenantDb, req, { eventType: 'product.variant_created', entityType: 'product_variant', entityId: id, after: variant });
  return { status: 201, body: variant };
}));
router.put('/variants/:id', requirePermission('products.update'), validate(variantSchema), mutation(async req => {
  const before = await req.tenantDb.one('SELECT * FROM product_variants WHERE id = ?', [req.params.id]);
  if (!before) throw httpError(404, 'variant_not_found', 'Product variant was not found.');
  if (before.barcode && req.body.barcode !== undefined && req.body.barcode !== before.barcode) {
    throw httpError(
      409,
      'barcode_regeneration_required',
      'Use the Barcode & Label Center regeneration action to change a persistent variant barcode.'
    );
  }
  await req.tenantDb.run(
    `UPDATE product_variants SET sku = ?, barcode = ?, name = ?, attributes = ?,
     cost_price = ?, selling_price = ?, status = ?, updated_at = ? WHERE id = ?`,
    [req.body.sku, before.barcode || req.body.barcode || null, req.body.name, JSON.stringify(req.body.attributes || {}),
      req.body.cost_price, req.body.selling_price, req.body.status, now(), req.params.id]
  );
  const after = await req.tenantDb.one('SELECT * FROM product_variants WHERE id = ?', [req.params.id]);
  await writeTenantAudit(req.tenantDb, req, { eventType: 'product.variant_updated', entityType: 'product_variant', entityId: req.params.id, before, after });
  return { body: after };
}));
router.delete('/variants/:id', requirePermission('products.update'), mutation(async req => {
  const before = await req.tenantDb.one('SELECT * FROM product_variants WHERE id = ?', [req.params.id]);
  if (!before) throw httpError(404, 'variant_not_found', 'Product variant was not found.');
  await req.tenantDb.run(`UPDATE product_variants SET status = 'inactive', updated_at = ? WHERE id = ?`, [now(), req.params.id]);
  await writeTenantAudit(req.tenantDb, req, { eventType: 'product.variant_archived', entityType: 'product_variant', entityId: req.params.id, before, after: { ...before, status: 'inactive' } });
  return { body: { ...before, status: 'inactive' } };
}));

router.get('/barcodes/overview', requirePermission('barcode.view'), asyncRoute(async (req, res) => {
  res.json(await getBarcodeOverview(req.tenantDb));
}));
router.get('/barcodes/products', requirePermission('barcode.view'), asyncRoute(async (req, res) => {
  res.json({ products: await listBarcodeProducts(req.tenantDb, req.query) });
}));
router.post('/barcodes/generate', requirePermission('barcode.generate'), validate(z.object({
  product_ids: z.array(z.coerce.number().int().positive()).min(1).max(500).optional(),
  barcode_type: barcodeTypeSchema.optional()
})), mutation(async req => ({
  status: 201,
  body: await generateMissingBarcodes(req.tenantDb, req.body, req)
})));
router.post('/barcodes/assign', requirePermission('barcode.assign'), validate(z.object({
  product_id: z.coerce.number().int().positive(),
  variant_id: z.coerce.number().int().positive().nullable().optional(),
  barcode_value: z.string().trim().min(1).max(2000),
  barcode_type: barcodeTypeSchema.default('CODE128'),
  source: z.enum(['MANUAL', 'SCANNER']).default('MANUAL')
})), mutation(async req => ({
  status: 201,
  body: await assignBarcode(req.tenantDb, req.body, req)
})));
router.post('/barcodes/validate', requirePermission('barcode.view'), validate(z.object({
  barcode_value: z.string().trim().min(1).max(2000),
  barcode_type: barcodeTypeSchema.default('CODE128')
})), asyncRoute(async (req, res) => {
  res.json(await validateBarcodeInput(req.tenantDb, req.body));
}));
router.post('/barcodes/:id/regenerate', requirePermission('barcode.regenerate'), validate(z.object({
  reason: z.string().trim().min(3).max(1000),
  barcode_value: z.string().trim().min(1).max(2000).nullable().optional(),
  barcode_type: barcodeTypeSchema.optional()
})), mutation(async req => ({
  body: await regenerateBarcode(req.tenantDb, req.params.id, req.body, req)
})));
router.get('/barcodes/:id/render', requirePermission('barcode.download'), asyncRoute(async (req, res) => {
  const output = await renderAssignedBarcode(req.tenantDb, req.params.id, req.query.format);
  res.setHeader('Content-Type', output.contentType);
  res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${output.filename}"`);
  res.send(output.content);
}));

router.get('/barcode-templates', requirePermission('barcode.view'), asyncRoute(async (req, res) => {
  res.json(await listBarcodeTemplates(req.tenantDb));
}));
router.post('/barcode-templates', requirePermission('barcode.template.manage'), validate(barcodeTemplateSchema), mutation(async req => ({
  status: 201,
  body: await createBarcodeTemplate(req.tenantDb, req.body, req)
})));
router.put('/barcode-templates/:id', requirePermission('barcode.template.manage'), validate(
  barcodeTemplateSchema.partial().refine(value => Object.keys(value).length > 0)
), mutation(async req => ({
  body: await updateBarcodeTemplate(req.tenantDb, req.params.id, req.body, req)
})));
router.delete('/barcode-templates/:id', requirePermission('barcode.template.manage'), mutation(async req => ({
  body: await archiveBarcodeTemplate(req.tenantDb, req.params.id, req)
})));

const printJobSchema = z.object({
  template_id: z.coerce.number().int().positive().optional(),
  layout_id: z.coerce.number().int().positive().optional(),
  output_type: z.enum(['PDF', 'ZIP']).default('PDF'),
  printer_type: z.enum(['browser', 'laser', 'thermal', 'inkjet']).default('browser'),
  copies: z.coerce.number().int().min(1).max(100).default(1),
  starting_position: z.coerce.number().int().min(1).max(200).default(1),
  items: z.array(z.object({
    assignment_id: z.coerce.number().int().positive(),
    quantity: z.coerce.number().int().min(1).max(10000).default(1)
  })).min(1).max(500)
}).superRefine((value, context) => {
  const labels = value.items.reduce((sum, item) => sum + item.quantity, 0) * value.copies;
  if (labels > 10000) context.addIssue({
    code: 'custom',
    path: ['items'],
    message: 'A print job may contain at most 10,000 labels.'
  });
});
router.post('/barcode-print-jobs', requirePermission('barcode.print'), validate(printJobSchema), mutation(async req => ({
  status: 201,
  body: await createPrintJob(req.tenantDb, req.body, req)
})));
router.get('/barcode-print-jobs', requirePermission('barcode.history.view'), asyncRoute(async (req, res) => {
  res.json({ jobs: await listPrintJobs(req.tenantDb, req.query) });
}));
router.get('/barcode-print-jobs/:id/download', requirePermission('barcode.download'), asyncRoute(async (req, res) => {
  const output = await downloadPrintJob(req.tenantDb, req.user.organization_id, req.params.id);
  res.setHeader('Content-Type', output.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${output.filename}"`);
  res.send(output.content);
}));
router.post('/barcode-print-jobs/:id/retry', requirePermission('barcode.print'), mutation(async req => ({
  body: await retryPrintJob(req.tenantDb, req.params.id, req)
})));
router.post('/barcode-print-jobs/:id/cancel', requirePermission('barcode.print'), mutation(async req => ({
  body: await cancelPrintJob(req.tenantDb, req.params.id, req)
})));

router.post('/barcode-scans/resolve', requirePermission('barcode.scan'), validate(z.object({
  barcode_value: z.string().trim().min(1).max(2000),
  source: z.enum(['HID', 'BLUETOOTH', 'CAMERA', 'MANUAL', 'POS']).default('MANUAL'),
  action: z.enum(['RESOLVE', 'ADD_TO_POS', 'STOCK_IN', 'STOCK_OUT', 'TRANSFER', 'COUNT', 'ASSIGN']).default('RESOLVE'),
  device: z.string().max(200).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
})), asyncRoute(async (req, res) => {
  const result = await resolveBarcodeScan(req.tenantDb, req.body, req);
  res.status(result.resolved ? 200 : 404).json(result);
}));
router.get('/barcode-scans/history', requirePermission('barcode.history.view'), asyncRoute(async (req, res) => {
  res.json({ scans: await listScanHistory(req.tenantDb, req.query) });
}));
router.get('/barcode-analytics', requirePermission('barcode.view'), asyncRoute(async (req, res) => {
  res.json(await getBarcodeAnalytics(req.tenantDb));
}));
router.get('/barcode-recommendations', requirePermission('barcode.view'), asyncRoute(async (req, res) => {
  res.json(await getBarcodeRecommendations(req.tenantDb));
}));
router.get('/barcode-settings', requirePermission('barcode.view'), asyncRoute(async (req, res) => {
  res.json(await getBarcodeSettings(req.tenantDb));
}));
router.put('/barcode-settings', requirePermission('barcode.settings.manage'), validate(barcodeSettingsSchema), mutation(async req => ({
  body: await updateBarcodeSettings(req.tenantDb, req.body, req)
})));

router.post('/products/:id/suppliers', requirePermission('products.update'), validate(z.object({
  supplier_id: z.coerce.number().int().positive(),
  supplier_sku: z.string().max(100).optional(),
  lead_time_days: z.coerce.number().int().nonnegative().default(0),
  minimum_order_quantity: z.coerce.number().positive().default(1),
  last_cost: z.coerce.number().nonnegative().default(0),
  preferred: z.boolean().default(false)
})), mutation(async req => {
  await Promise.all([getProduct(req.tenantDb, req.params.id), getParty(req.tenantDb, 'supplier', req.body.supplier_id)]);
  await req.tenantDb.run(
    `INSERT INTO supplier_products
      (supplier_id, product_id, supplier_sku, lead_time_days, minimum_order_quantity, last_cost, preferred)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (supplier_id, product_id) DO UPDATE SET
       supplier_sku = excluded.supplier_sku, lead_time_days = excluded.lead_time_days,
       minimum_order_quantity = excluded.minimum_order_quantity, last_cost = excluded.last_cost,
       preferred = excluded.preferred`,
    [req.body.supplier_id, req.params.id, req.body.supplier_sku || null, req.body.lead_time_days,
      req.body.minimum_order_quantity, req.body.last_cost, req.body.preferred ? 1 : 0]
  );
  const mapping = await req.tenantDb.one('SELECT * FROM supplier_products WHERE supplier_id = ? AND product_id = ?', [req.body.supplier_id, req.params.id]);
  await writeTenantAudit(req.tenantDb, req, { eventType: 'product.supplier_mapped', entityType: 'supplier_product', entityId: mapping.id, after: mapping });
  return { status: 201, body: mapping };
}));
router.delete('/products/:productId/suppliers/:supplierId', requirePermission('products.update'), mutation(async req => {
  const before = await req.tenantDb.one('SELECT * FROM supplier_products WHERE supplier_id = ? AND product_id = ?', [req.params.supplierId, req.params.productId]);
  if (!before) throw httpError(404, 'supplier_mapping_not_found', 'Supplier product mapping was not found.');
  await req.tenantDb.run('DELETE FROM supplier_products WHERE id = ?', [before.id]);
  await writeTenantAudit(req.tenantDb, req, { eventType: 'product.supplier_unmapped', entityType: 'supplier_product', entityId: before.id, before });
  return { status: 204, body: null };
}));
router.post('/products/bulk', requirePermission('products.update'), validate(z.object({
  product_ids: z.array(z.coerce.number().int().positive()).min(1).max(500),
  changes: z.object({
    status: z.boolean().optional(),
    category_id: z.coerce.number().int().positive().nullable().optional(),
    brand_id: z.coerce.number().int().positive().nullable().optional(),
    gst_rate: z.coerce.number().min(0).max(100).optional(),
    valuation_method: z.enum(['weighted_average', 'fifo', 'lifo']).optional()
  }).refine(value => Object.keys(value).length > 0)
})), mutation(async req => {
  const before = [];
  for (const id of req.body.product_ids) before.push(await getProduct(req.tenantDb, id));
  await req.tenantDb.transaction(async tx => {
    for (const id of req.body.product_ids) {
      const changes = req.body.changes;
      if ('status' in changes || 'category_id' in changes || 'brand_id' in changes) {
        const product = before.find(item => Number(item.id) === Number(id));
        await tx.run(
          'UPDATE products SET status = ?, category_id = ?, brand_id = ?, updated_at = ? WHERE id = ?',
          [changes.status == null ? product.status : changes.status ? 1 : 0,
            changes.category_id === undefined ? product.category_id : changes.category_id,
            changes.brand_id === undefined ? product.brand_id : changes.brand_id, now(), id]
        );
      }
      if (changes.gst_rate != null || changes.valuation_method) {
        const product = before.find(item => Number(item.id) === Number(id));
        await tx.run(
          `UPDATE product_commerce SET gst_rate = ?, valuation_method = ?, updated_at = ? WHERE product_id = ?`,
          [changes.gst_rate ?? product.gst_rate ?? 0, changes.valuation_method || product.valuation_method || 'weighted_average', now(), id]
        );
      }
    }
  });
  await writeTenantAudit(req.tenantDb, req, {
    eventType: 'products.bulk_updated',
    entityType: 'product',
    metadata: { product_ids: req.body.product_ids, changes: req.body.changes }
  });
  return { body: { updated: req.body.product_ids.length } };
}));
router.get('/price-lists', requirePermission('products.read'), asyncRoute(async (req, res) => {
  const lists = await req.tenantDb.all('SELECT * FROM price_lists ORDER BY created_at DESC');
  for (const list of lists) {
    list.items = await req.tenantDb.all('SELECT * FROM price_list_items WHERE price_list_id = ? ORDER BY id', [list.id]);
  }
  res.json({ price_lists: lists });
}));
router.post('/price-lists', requirePermission('products.update'), validate(z.object({
  name: z.string().trim().min(1).max(200),
  currency: z.string().length(3).default('INR'),
  valid_from: z.string().datetime().optional(),
  valid_to: z.string().datetime().optional(),
  items: z.array(z.object({
    product_id: z.coerce.number().int().positive(),
    variant_id: z.coerce.number().int().positive().nullable().optional(),
    unit_price: z.coerce.number().nonnegative(),
    minimum_quantity: z.coerce.number().positive().default(1)
  })).max(1000).default([])
})), mutation(async req => {
  const id = await req.tenantDb.transaction(async tx => {
    const inserted = await insertWithId(tx,
      `INSERT INTO price_lists (name, currency, valid_from, valid_to, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
      [req.body.name, req.body.currency, req.body.valid_from || null, req.body.valid_to || null, now()]
    );
    const listId = inserted.id || inserted.rows?.[0]?.id;
    for (const item of req.body.items) {
      await tx.run(
        `INSERT INTO price_list_items
          (price_list_id, product_id, variant_id, unit_price, minimum_quantity)
         VALUES (?, ?, ?, ?, ?)`,
        [listId, item.product_id, item.variant_id || null, item.unit_price, item.minimum_quantity]
      );
    }
    return listId;
  });
  const priceList = await req.tenantDb.one('SELECT * FROM price_lists WHERE id = ?', [id]);
  priceList.items = await req.tenantDb.all('SELECT * FROM price_list_items WHERE price_list_id = ?', [id]);
  await writeTenantAudit(req.tenantDb, req, { eventType: 'price_list.created', entityType: 'price_list', entityId: id, after: priceList });
  return { status: 201, body: priceList };
}));
router.put('/price-lists/:id', requirePermission('products.update'), validate(z.object({
  name: z.string().trim().min(1).max(200),
  currency: z.string().length(3).default('INR'),
  valid_from: z.string().datetime().nullable().optional(),
  valid_to: z.string().datetime().nullable().optional(),
  status: z.enum(['active', 'inactive']).default('active')
})), mutation(async req => {
  const before = await req.tenantDb.one('SELECT * FROM price_lists WHERE id = ?', [req.params.id]);
  if (!before) throw httpError(404, 'price_list_not_found', 'Price list was not found.');
  await req.tenantDb.run(
    `UPDATE price_lists SET name = ?, currency = ?, valid_from = ?, valid_to = ?, status = ? WHERE id = ?`,
    [req.body.name, req.body.currency, req.body.valid_from || null, req.body.valid_to || null, req.body.status, req.params.id]
  );
  const after = await req.tenantDb.one('SELECT * FROM price_lists WHERE id = ?', [req.params.id]);
  await writeTenantAudit(req.tenantDb, req, { eventType: 'price_list.updated', entityType: 'price_list', entityId: req.params.id, before, after });
  return { body: after };
}));

router.get('/inventory/balances', requirePermission('inventory.read'), asyncRoute(async (req, res) => {
  res.json({ balances: await listInventoryBalances(req.tenantDb, req.query) });
}));
router.get('/inventory/movements', requirePermission('inventory.read'), asyncRoute(async (req, res) => {
  res.json({ movements: await listStockMovements(req.tenantDb, req.query) });
}));
router.post('/inventory/movements', requirePermission('inventory.adjust'), validate(movementSchema), mutation(async req => ({
  status: 201,
  body: await postStockMovement(req.tenantDb, req.body, req)
})));
router.post('/inventory/adjustments', requirePermission('inventory.adjust'), validate(movementSchema.omit({ movement_type: true }).extend({
  direction: z.enum(['increase', 'decrease']),
  reason: z.string().min(1).max(1000)
})), mutation(async req => ({
  status: 201,
  body: await postStockMovement(req.tenantDb, {
    ...req.body,
    movement_type: req.body.direction === 'increase' ? 'adjustment_in' : 'adjustment_out',
    notes: req.body.reason
  }, req)
})));
router.post('/inventory/damage', requirePermission('inventory.adjust'), validate(movementSchema.omit({ movement_type: true }).extend({
  reason: z.string().min(1).max(1000)
})), mutation(async req => ({
  status: 201,
  body: await postStockMovement(req.tenantDb, { ...req.body, movement_type: 'damage', notes: req.body.reason }, req)
})));
router.post('/inventory/transfers', requirePermission('inventory.transfer'), validate(transferSchema), mutation(async req => ({
  status: 201,
  body: await transferStock(req.tenantDb, req.body, req)
})));
router.get('/inventory/reservations', requirePermission('inventory.read'), asyncRoute(async (req, res) => {
  res.json({ reservations: await req.tenantDb.all('SELECT * FROM stock_reservations ORDER BY created_at DESC LIMIT 500') });
}));
router.post('/inventory/reservations', requirePermission('inventory.reserve'), validate(reserveSchema), mutation(async req => ({
  status: 201,
  body: await reserveStock(req.tenantDb, req.body, req)
})));
router.delete('/inventory/reservations/:id', requirePermission('inventory.reserve'), mutation(async req => {
  const before = await req.tenantDb.one('SELECT * FROM stock_reservations WHERE id = ?', [req.params.id]);
  if (!before) throw httpError(404, 'reservation_not_found', 'Stock reservation was not found.');
  if (before.status !== 'active') throw httpError(409, 'reservation_not_active', 'Only active reservations can be released.');
  await req.tenantDb.run('UPDATE stock_reservations SET status = ?, updated_at = ? WHERE id = ?', ['released', now(), req.params.id]);
  await writeTenantAudit(req.tenantDb, req, { eventType: 'inventory.reservation_released', entityType: 'stock_reservation', entityId: req.params.id, before, after: { ...before, status: 'released' } });
  return { body: { ...before, status: 'released' } };
}));
router.get('/inventory/batches', requirePermission('inventory.read'), asyncRoute(async (req, res) => {
  res.json({ batches: await req.tenantDb.all('SELECT * FROM inventory_batches ORDER BY expires_at, id DESC') });
}));
router.get('/inventory/serials', requirePermission('inventory.read'), asyncRoute(async (req, res) => {
  res.json({ serials: await req.tenantDb.all('SELECT * FROM inventory_serials ORDER BY id DESC LIMIT 1000') });
}));
router.get('/inventory/valuation', requirePermission('inventory.read'), asyncRoute(async (req, res) => {
  res.json({ valuation: await req.tenantDb.all(
    `SELECT v.*, p.sku, p.name AS product_name, w.name AS warehouse_name
     FROM inventory_valuation_state v JOIN products p ON p.id = v.product_id
     JOIN warehouses w ON w.id = v.warehouse_id ORDER BY w.name, p.name`
  ) });
}));
router.get('/inventory/reorder-recommendations', requirePermission('inventory.read'), asyncRoute(async (req, res) => {
  res.json({ recommendations: await listReorderRecommendations(req.tenantDb) });
}));
router.get('/inventory/reorder-rules', requirePermission('inventory.read'), asyncRoute(async (req, res) => {
  res.json({ rules: await req.tenantDb.all('SELECT * FROM reorder_rules ORDER BY warehouse_id, product_id') });
}));
router.put('/inventory/reorder-rules/:productId/:warehouseId', requirePermission('inventory.adjust'), validate(z.object({
  minimum_stock: z.coerce.number().nonnegative().default(0),
  reorder_point: z.coerce.number().nonnegative(),
  reorder_quantity: z.coerce.number().nonnegative(),
  safety_stock: z.coerce.number().nonnegative().default(0),
  preferred_supplier_id: z.coerce.number().int().positive().nullable().optional(),
  lead_time_days: z.coerce.number().int().nonnegative().default(0),
  status: z.enum(['active', 'inactive']).default('active')
})), mutation(async req => {
  await req.tenantDb.run(
    `INSERT INTO reorder_rules
      (product_id, warehouse_id, minimum_stock, reorder_point, reorder_quantity,
       safety_stock, preferred_supplier_id, lead_time_days, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (product_id, warehouse_id) DO UPDATE SET
       minimum_stock = excluded.minimum_stock, reorder_point = excluded.reorder_point,
       reorder_quantity = excluded.reorder_quantity, safety_stock = excluded.safety_stock,
       preferred_supplier_id = excluded.preferred_supplier_id,
       lead_time_days = excluded.lead_time_days, status = excluded.status, updated_at = excluded.updated_at`,
    [req.params.productId, req.params.warehouseId, req.body.minimum_stock, req.body.reorder_point,
      req.body.reorder_quantity, req.body.safety_stock, req.body.preferred_supplier_id || null,
      req.body.lead_time_days, req.body.status, now()]
  );
  const rule = await req.tenantDb.one('SELECT * FROM reorder_rules WHERE product_id = ? AND warehouse_id = ?', [req.params.productId, req.params.warehouseId]);
  await writeTenantAudit(req.tenantDb, req, { eventType: 'inventory.reorder_rule_updated', entityType: 'reorder_rule', entityId: rule.id, after: rule });
  return { body: rule };
}));
router.get('/inventory/cycle-counts', requirePermission('inventory.read'), asyncRoute(async (req, res) => {
  res.json({ cycle_counts: await req.tenantDb.all('SELECT * FROM cycle_counts ORDER BY created_at DESC LIMIT 500') });
}));
router.post('/inventory/cycle-counts', requirePermission('inventory.adjust'), validate(z.object({
  count_no: z.string().max(100).optional(),
  warehouse_id: z.coerce.number().int().positive(),
  scheduled_at: z.string().datetime().optional(),
  product_ids: z.array(z.coerce.number().int().positive()).max(1000).optional()
})), mutation(async req => ({ status: 201, body: await createCycleCount(req.tenantDb, req.body, req) })));
router.get('/inventory/cycle-counts/:id', requirePermission('inventory.read'), asyncRoute(async (req, res) => {
  res.json(await getCycleCount(req.tenantDb, req.params.id));
}));
router.post('/inventory/cycle-counts/:id/complete', requirePermission('inventory.adjust'), validate(z.object({
  items: z.array(z.object({
    item_id: z.coerce.number().int().positive(),
    counted_quantity: z.coerce.number().nonnegative(),
    notes: z.string().max(1000).optional()
  })).min(1)
})), mutation(async req => ({ body: await completeCycleCount(req.tenantDb, req.params.id, req.body, req) })));
router.post('/inventory/serials', requirePermission('inventory.adjust'), validate(z.object({
  product_id: z.coerce.number().int().positive(),
  warehouse_id: z.coerce.number().int().positive().optional(),
  batch_id: z.coerce.number().int().positive().optional(),
  serial_no: z.string().trim().min(1).max(200),
  status: z.enum(['available', 'reserved', 'sold', 'damaged', 'returned']).default('available'),
  reference_type: z.string().max(100).optional(),
  reference_id: z.union([z.string(), z.number()]).optional()
})), mutation(async req => {
  const inserted = await insertWithId(req.tenantDb,
    `INSERT INTO inventory_serials
      (product_id, warehouse_id, serial_no, batch_id, status, reference_type, reference_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.body.product_id, req.body.warehouse_id || null, req.body.serial_no, req.body.batch_id || null,
      req.body.status, req.body.reference_type || null, req.body.reference_id == null ? null : String(req.body.reference_id), now(), now()]
  );
  const id = inserted.id || inserted.rows?.[0]?.id;
  const serial = await req.tenantDb.one('SELECT * FROM inventory_serials WHERE id = ?', [id]);
  await writeTenantAudit(req.tenantDb, req, { eventType: 'inventory.serial_created', entityType: 'inventory_serial', entityId: id, after: serial });
  return { status: 201, body: serial };
}));
router.get('/inventory/forecast', requirePermission('inventory.read'), asyncRoute(async (req, res) => {
  const recommendations = await listReorderRecommendations(req.tenantDb);
  res.json({ days: Math.min(Math.max(Number(req.query.days || 30), 1), 365), method: 'deterministic_movement_velocity', recommendations });
}));

router.get('/customers', requirePermission('parties.customers.read'), asyncRoute(async (req, res) => {
  res.json({ customers: await listParties(req.tenantDb, 'customer', req.query) });
}));
router.post('/customers', requirePermission('parties.customers.create'), validate(partySchema), mutation(async req => ({
  status: 201,
  body: await createParty(req.tenantDb, 'customer', req.body, req)
})));
router.get('/customers/:id', requirePermission('parties.customers.read'), asyncRoute(async (req, res) => {
  res.json(await getParty(req.tenantDb, 'customer', req.params.id));
}));
router.put('/customers/:id', requirePermission('parties.customers.update'), validate(partySchema), mutation(async req => ({
  body: await updateParty(req.tenantDb, 'customer', req.params.id, req.body, req)
})));
router.delete('/customers/:id', requirePermission('parties.customers.delete'), mutation(async req => {
  const before = await getParty(req.tenantDb, 'customer', req.params.id);
  if (Math.abs(Number(before.balance || 0)) > 0.001) throw httpError(409, 'customer_has_balance', 'A customer with an outstanding balance cannot be deleted.');
  const documents = await req.tenantDb.one(`SELECT COUNT(*) AS count FROM trade_documents WHERE party_type = 'customer' AND party_id = ?`, [req.params.id]);
  if (Number(documents.count)) throw httpError(409, 'customer_has_history', 'A customer with transaction history cannot be deleted.');
  await req.tenantDb.transaction(async tx => {
    await tx.run(`DELETE FROM party_contacts WHERE party_type = 'customer' AND party_id = ?`, [req.params.id]);
    await tx.run(`DELETE FROM party_addresses WHERE party_type = 'customer' AND party_id = ?`, [req.params.id]);
    await tx.run(`DELETE FROM party_communications WHERE party_type = 'customer' AND party_id = ?`, [req.params.id]);
    await tx.run(`DELETE FROM party_profiles WHERE party_type = 'customer' AND party_id = ?`, [req.params.id]);
    await tx.run('DELETE FROM customers WHERE id = ?', [req.params.id]);
  });
  await writeTenantAudit(req.tenantDb, req, { eventType: 'customer.deleted', entityType: 'customer', entityId: req.params.id, before });
  return { status: 204, body: null };
}));
router.get('/customers/:id/ledger', requirePermission('parties.customers.read'), asyncRoute(async (req, res) => {
  res.json({ documents: await req.tenantDb.all(
    `SELECT * FROM trade_documents WHERE party_type = 'customer' AND party_id = ? ORDER BY created_at DESC`,
    [req.params.id]
  ) });
}));
router.get('/suppliers', requirePermission('parties.suppliers.read'), asyncRoute(async (req, res) => {
  res.json({ suppliers: await listParties(req.tenantDb, 'supplier', req.query) });
}));
router.post('/suppliers', requirePermission('parties.suppliers.create'), validate(partySchema), mutation(async req => ({
  status: 201,
  body: await createParty(req.tenantDb, 'supplier', req.body, req)
})));
router.get('/suppliers/:id', requirePermission('parties.suppliers.read'), asyncRoute(async (req, res) => {
  res.json(await getParty(req.tenantDb, 'supplier', req.params.id));
}));
router.put('/suppliers/:id', requirePermission('parties.suppliers.update'), validate(partySchema), mutation(async req => ({
  body: await updateParty(req.tenantDb, 'supplier', req.params.id, req.body, req)
})));
router.delete('/suppliers/:id', requirePermission('parties.suppliers.delete'), mutation(async req => {
  const before = await getParty(req.tenantDb, 'supplier', req.params.id);
  const documents = await req.tenantDb.one(`SELECT COUNT(*) AS count FROM trade_documents WHERE party_type = 'supplier' AND party_id = ?`, [req.params.id]);
  if (Number(documents.count)) throw httpError(409, 'supplier_has_history', 'A supplier with transaction history cannot be deleted.');
  await req.tenantDb.transaction(async tx => {
    await tx.run('DELETE FROM supplier_products WHERE supplier_id = ?', [req.params.id]);
    await tx.run(`DELETE FROM party_contacts WHERE party_type = 'supplier' AND party_id = ?`, [req.params.id]);
    await tx.run(`DELETE FROM party_addresses WHERE party_type = 'supplier' AND party_id = ?`, [req.params.id]);
    await tx.run(`DELETE FROM party_communications WHERE party_type = 'supplier' AND party_id = ?`, [req.params.id]);
    await tx.run(`DELETE FROM party_profiles WHERE party_type = 'supplier' AND party_id = ?`, [req.params.id]);
    await tx.run('DELETE FROM suppliers WHERE id = ?', [req.params.id]);
  });
  await writeTenantAudit(req.tenantDb, req, { eventType: 'supplier.deleted', entityType: 'supplier', entityId: req.params.id, before });
  return { status: 204, body: null };
}));
router.get('/suppliers/:id/analytics', requirePermission('parties.suppliers.read'), asyncRoute(async (req, res) => {
  const documents = await req.tenantDb.all(
    `SELECT status, COUNT(*) AS count, COALESCE(SUM(grand_total), 0) AS total
       FROM trade_documents WHERE party_type = 'supplier' AND party_id = ?
       GROUP BY status ORDER BY status`,
    [req.params.id]
  );
  res.json({ supplier_id: Number(req.params.id), performance: documents });
}));
const contactSchema = z.object({
  name: z.string().trim().min(1).max(200),
  title: z.string().max(100).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  is_primary: z.boolean().optional()
});
const addressSchema = z.object({
  address_type: z.enum(['billing', 'shipping', 'office', 'warehouse']).optional(),
  line1: z.string().min(1).max(500),
  line2: z.string().max(500).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  postal_code: z.string().max(30).optional(),
  country: z.string().length(2).optional(),
  is_primary: z.boolean().optional()
});
const communicationSchema = z.object({
  channel: z.enum(['email', 'phone', 'meeting', 'note', 'sms']),
  direction: z.enum(['inbound', 'outbound', 'internal']),
  subject: z.string().max(300).optional(),
  body: z.string().max(10000).optional(),
  occurred_at: z.string().datetime().optional()
});
for (const party of [
  { route: 'customers', type: 'customer', permission: 'parties.customers.update' },
  { route: 'suppliers', type: 'supplier', permission: 'parties.suppliers.update' }
]) {
  router.post(`/${party.route}/:id/contacts`, requirePermission(party.permission), validate(contactSchema), mutation(async req => ({
    status: 201, body: await addPartyDetail(req.tenantDb, party.type, req.params.id, 'contacts', req.body, req)
  })));
  router.post(`/${party.route}/:id/addresses`, requirePermission(party.permission), validate(addressSchema), mutation(async req => ({
    status: 201, body: await addPartyDetail(req.tenantDb, party.type, req.params.id, 'addresses', req.body, req)
  })));
  router.post(`/${party.route}/:id/communications`, requirePermission(party.permission), validate(communicationSchema), mutation(async req => ({
    status: 201, body: await addPartyDetail(req.tenantDb, party.type, req.params.id, 'communications', req.body, req)
  })));
  router.get(`/${party.route}/:id/activity`, requirePermission(party.permission.replace('.update', '.read')), asyncRoute(async (req, res) => {
    res.json({
      communications: await req.tenantDb.all(
        'SELECT * FROM party_communications WHERE party_type = ? AND party_id = ? ORDER BY occurred_at DESC LIMIT 500',
        [party.type, req.params.id]
      )
    });
  }));
}

router.get('/trade/:documentType', requirePermission('trade.read'), asyncRoute(async (req, res) => {
  res.json({ documents: await listTradeDocuments(req.tenantDb, req.params.documentType, req.query) });
}));
router.post('/trade/:documentType', requirePermission('trade.create'), validate(tradeSchema), mutation(async req => ({
  status: 201,
  body: await createTradeDocument(req.tenantDb, req.params.documentType, req.body, req)
})));
router.get('/trade/:documentType/:id', requirePermission('trade.read'), asyncRoute(async (req, res) => {
  const document = await getTradeDocument(req.tenantDb, req.params.id);
  const normalized = req.params.documentType.replace(/-/g, '_').replace(/s$/, '');
  if (document.document_type !== normalized && !documentTypeMatches(req.params.documentType, document.document_type)) {
    throw httpError(404, 'trade_document_not_found', 'Trade document was not found.');
  }
  res.json(document);
}));
router.post('/trade/:documentType/:id/transition', requirePermission('trade.transition'), validate(z.object({
  status: z.enum(['pending_approval', 'partially_fulfilled', 'fulfilled', 'completed', 'cancelled']),
  reason: z.string().max(2000).optional()
})), mutation(async req => ({
  body: await transitionTradeDocument(req.tenantDb, req.params.id, req.body.status, req.body, req)
})));
router.post('/trade/:documentType/:id/convert', requirePermission('trade.create'), validate(conversionSchema), mutation(async req => ({
  status: 201,
  body: await convertDocument(req.tenantDb, req.params.id, req.body, req)
})));
router.post('/trade/purchase-orders/:id/receive', requirePermission('trade.purchases.receive'), validate(z.object({
  warehouse_id: z.coerce.number().int().positive().optional(),
  notes: z.string().max(2000).optional(),
  items: z.array(z.object({
    line_id: z.coerce.number().int().positive(),
    quantity: z.coerce.number().positive(),
    batch_no: z.string().max(100).optional(),
    expires_at: z.string().datetime().optional()
  })).min(1)
})), mutation(async req => ({
  status: 201,
  body: await receivePurchaseOrder(req.tenantDb, req.params.id, req.body, req)
})));
router.post('/trade/sales-orders/:id/fulfill', requirePermission('trade.sales.fulfill'), validate(z.object({
  warehouse_id: z.coerce.number().int().positive().optional(),
  items: z.array(z.object({
    line_id: z.coerce.number().int().positive(),
    quantity: z.coerce.number().positive()
  })).min(1)
})), mutation(async req => ({
  body: await fulfillSalesOrder(req.tenantDb, req.params.id, req.body, req)
})));
router.get('/grns', requirePermission('trade.read'), asyncRoute(async (req, res) => {
  res.json({
    goods_receipts: await req.tenantDb.all(
      `SELECT gr.*, td.document_no AS purchase_order_no, s.name AS supplier_name, w.name AS warehouse_name
       FROM goods_receipts gr
       JOIN trade_documents td ON td.id = gr.purchase_order_id
       LEFT JOIN suppliers s ON s.id = gr.supplier_id
       JOIN warehouses w ON w.id = gr.warehouse_id
       ORDER BY gr.received_at DESC, gr.id DESC`
    )
  });
}));
router.get('/grns/:id', requirePermission('trade.read'), asyncRoute(async (req, res) => {
  const receipt = await req.tenantDb.one('SELECT * FROM goods_receipts WHERE id = ?', [req.params.id]);
  if (!receipt) throw httpError(404, 'goods_receipt_not_found', 'Goods receipt was not found.');
  receipt.items = await req.tenantDb.all('SELECT * FROM goods_receipt_items WHERE goods_receipt_id = ? ORDER BY id', [req.params.id]);
  res.json(receipt);
}));

router.get('/approvals', requirePermission('approvals.read'), asyncRoute(async (req, res) => {
  res.json({ approvals: await req.tenantDb.all('SELECT * FROM approval_requests ORDER BY created_at DESC LIMIT 500') });
}));
router.post('/approvals/:id/approve', requirePermission('approvals.approve'), validate(z.object({ notes: z.string().max(2000).optional() })), mutation(async req => ({
  body: await decideApproval(req.tenantDb, req.params.id, 'approve', req.body.notes, req)
})));
router.post('/approvals/:id/reject', requirePermission('approvals.reject'), validate(z.object({ notes: z.string().max(2000).optional() })), mutation(async req => ({
  body: await decideApproval(req.tenantDb, req.params.id, 'reject', req.body.notes, req)
})));

router.get('/document-links', requirePermission('trade.read'), asyncRoute(async (req, res) => {
  res.json({ links: await listDocumentLinks(req.tenantDb, req.query) });
}));
router.get('/document-templates', requirePermission('settings.manage'), asyncRoute(async (req, res) => {
  res.json({ templates: await listDocumentTemplates(req.tenantDb, req.query) });
}));
router.post('/document-templates', requirePermission('settings.manage'), validate(documentTemplateSchema), mutation(async req => ({
  status: 201,
  body: await saveDocumentTemplate(req.tenantDb, null, req.body, req)
})));
router.put('/document-templates/:id', requirePermission('settings.manage'), validate(documentTemplateSchema), mutation(async req => ({
  body: await saveDocumentTemplate(req.tenantDb, req.params.id, req.body, req)
})));
router.get('/fiscal-adjustments/:adjustmentType', requirePermission('trade.read'), asyncRoute(async (req, res) => {
  res.json({ adjustments: await listFiscalAdjustments(req.tenantDb, req.params.adjustmentType, req.query) });
}));
router.post('/fiscal-adjustments/:adjustmentType', requirePermission('trade.create'), validate(fiscalAdjustmentSchema), mutation(async req => ({
  status: 201,
  body: await createFiscalAdjustment(req.tenantDb, req.params.adjustmentType, req.body, req)
})));
router.get('/fiscal-adjustments/:adjustmentType/:id', requirePermission('trade.read'), asyncRoute(async (req, res) => {
  const adjustment = await getFiscalAdjustment(req.tenantDb, req.params.id);
  const requested = req.params.adjustmentType.replace(/-/g, '_').toUpperCase().replace(/S$/, '');
  if (adjustment.adjustment_type !== requested) throw httpError(404, 'fiscal_adjustment_not_found', 'The fiscal adjustment was not found.');
  res.json(adjustment);
}));
router.post('/fiscal-adjustments/:adjustmentType/:id/issue', requirePermission('trade.transition'), validate(z.object({})), mutation(async req => ({
  body: await transitionFiscalAdjustment(req.tenantDb, req.params.id, 'issue', req.body, req)
})));
router.post('/fiscal-adjustments/:adjustmentType/:id/cancel', requirePermission('trade.transition'), validate(z.object({
  reason: z.string().trim().min(1).max(2000)
})), mutation(async req => ({
  body: await transitionFiscalAdjustment(req.tenantDb, req.params.id, 'cancel', req.body, req)
})));

router.get('/finance/accounts', requirePermission('finance.read'), asyncRoute(async (req, res) => {
  res.json({ accounts: await listFinanceAccounts(req.tenantDb, req.query) });
}));
router.post('/finance/accounts', requirePermission('finance.manage'), validate(financeAccountSchema), mutation(async req => ({
  status: 201, body: await createFinanceAccount(req.tenantDb, req.body, req)
})));
router.get('/finance/accounts/:id/ledger', requirePermission('finance.read'), asyncRoute(async (req, res) => {
  res.json(await getAccountLedger(req.tenantDb, req.params.id, req.query));
}));
router.get('/finance/journals', requirePermission('finance.read'), asyncRoute(async (req, res) => {
  res.json({ journals: await listJournals(req.tenantDb, req.query) });
}));
router.post('/finance/journals', requirePermission('finance.manage'), validate(journalSchema), mutation(async req => ({
  status: 201, body: await createJournal(req.tenantDb, req.body, req)
})));
router.get('/finance/journals/:id', requirePermission('finance.read'), asyncRoute(async (req, res) => {
  res.json(await getJournal(req.tenantDb, req.params.id));
}));
router.get('/finance/banks', requirePermission('finance.read'), asyncRoute(async (req, res) => {
  res.json({ banks: await listBankAccounts(req.tenantDb) });
}));
router.post('/finance/banks', requirePermission('finance.manage'), validate(bankAccountSchema), mutation(async req => ({
  status: 201, body: await createBankAccount(req.tenantDb, req.body, req)
})));
router.post('/finance/banks/:id/transactions', requirePermission('finance.manage'), validate(bankTransactionSchema), mutation(async req => ({
  status: 201, body: await postBankTransaction(req.tenantDb, req.params.id, req.body, req)
})));
router.post('/finance/bank-transactions/:id/reconcile', requirePermission('finance.manage'), validate(z.object({})), mutation(async req => ({
  body: await reconcileBankTransaction(req.tenantDb, req.params.id, req)
})));
router.get('/finance/expenses', requirePermission('finance.read'), asyncRoute(async (req, res) => {
  res.json({ expenses: await listExpenses(req.tenantDb, req.query) });
}));
router.post('/finance/expenses', requirePermission('finance.manage'), validate(expenseSchema), mutation(async req => ({
  status: 201, body: await createExpense(req.tenantDb, req.body, req)
})));
router.get('/finance/summary', requirePermission('finance.read'), asyncRoute(async (req, res) => {
  res.json(await financeSummary(req.tenantDb));
}));
router.get('/finance/reconciliation', requirePermission('finance.read'), asyncRoute(async (req, res) => {
  res.json(await financeReconciliation(req.tenantDb));
}));
router.get('/payments/timeline', requirePermission('finance.read'), asyncRoute(async (req, res) => {
  res.json({ timeline: await paymentTimeline(req.tenantDb, req.query) });
}));
router.get('/payment-links', requirePermission('finance.read'), asyncRoute(async (req, res) => {
  res.json({ payment_links: await listPaymentLinks(req.tenantDb, req.query) });
}));
router.post('/payment-links', requirePermission('finance.manage'), validate(paymentLinkSchema), mutation(async req => ({
  status: 201, body: await createPaymentLink(req.tenantDb, req.body, req)
})));
router.post('/payment-links/:id/cancel', requirePermission('finance.manage'), validate(z.object({})), mutation(async req => ({
  body: await cancelPaymentLink(req.tenantDb, req.params.id, req)
})));

router.get('/reminders', requirePermission('reminders.read'), asyncRoute(async (req, res) => {
  res.json({ reminders: await listReminders(req.tenantDb, req.query) });
}));
router.post('/reminders', requirePermission('reminders.manage'), validate(reminderSchema), mutation(async req => ({
  status: 201, body: await createReminder(req.tenantDb, req.body, req)
})));
router.post('/reminders/:id/cancel', requirePermission('reminders.manage'), validate(z.object({})), mutation(async req => ({
  body: await cancelReminder(req.tenantDb, req.params.id, req)
})));
router.post('/reminders/process-due', requirePermission('reminders.manage'), validate(z.object({
  limit: z.coerce.number().int().min(1).max(500).optional()
})), mutation(async req => ({
  body: { results: await processDueReminders(req.tenantDb, req.user.organization_id, req.body.limit) }
})));
router.get('/notifications', requirePermission('dashboard.read'), asyncRoute(async (req, res) => {
  res.json({ notifications: await listTenantNotifications(req.tenantDb, req.user.tenant_user_id || req.user.id) });
}));
router.post('/notifications/:id/read', requirePermission('dashboard.read'), validate(z.object({})), mutation(async req => ({
  body: await markNotificationRead(req.tenantDb, req.params.id, req.user.tenant_user_id || req.user.id)
})));

router.get('/projects', requirePermission('projects.read'), asyncRoute(async (req, res) => {
  res.json({ projects: await listProjects(req.tenantDb, req.query) });
}));
router.post('/projects', requirePermission('projects.manage'), validate(projectSchema), mutation(async req => ({
  status: 201, body: await createProject(req.tenantDb, req.body, req)
})));
router.get('/projects/:id', requirePermission('projects.read'), asyncRoute(async (req, res) => {
  res.json(await getProject(req.tenantDb, req.params.id));
}));
router.put('/projects/:id', requirePermission('projects.manage'), validate(projectUpdateSchema), mutation(async req => ({
  body: await updateProject(req.tenantDb, req.params.id, req.body, req)
})));
router.get('/projects/:id/activity', requirePermission('projects.read'), asyncRoute(async (req, res) => {
  const project = await getProject(req.tenantDb, req.params.id);
  res.json({ entries: project.entries, documents: project.documents });
}));
router.get('/projects/:id/profitability', requirePermission('projects.read'), asyncRoute(async (req, res) => {
  res.json(await projectProfitability(req.tenantDb, req.params.id));
}));
router.post('/projects/:id/documents', requirePermission('projects.manage'), validate(projectDocumentSchema), mutation(async req => ({
  status: 201, body: await linkProjectDocument(req.tenantDb, req.params.id, req.body, req)
})));
router.delete('/projects/:id/documents/:documentId', requirePermission('projects.manage'), mutation(async req => ({
  body: await unlinkProjectDocument(req.tenantDb, req.params.id, req.params.documentId, req)
})));

router.get('/subscriptions', requirePermission('subscriptions.read'), asyncRoute(async (req, res) => {
  res.json({ subscriptions: await listSubscriptions(req.tenantDb, req.query) });
}));
router.post('/subscriptions', requirePermission('subscriptions.manage'), validate(subscriptionSchema), mutation(async req => ({
  status: 201, body: await createSubscription(req.tenantDb, req.body, req)
})));
router.post('/subscriptions/process-due', requirePermission('subscriptions.manage'), validate(z.object({
  limit: z.coerce.number().int().min(1).max(200).optional()
})), mutation(async req => ({
  body: { results: await processDueSubscriptions(req.tenantDb, req.user.organization_id, req.body.limit) }
})));
router.get('/subscriptions/:id', requirePermission('subscriptions.read'), asyncRoute(async (req, res) => {
  res.json(await getSubscription(req.tenantDb, req.params.id));
}));
router.put('/subscriptions/:id', requirePermission('subscriptions.manage'), validate(subscriptionUpdateSchema), mutation(async req => ({
  body: await updateSubscription(req.tenantDb, req.params.id, req.body, req)
})));
for (const action of ['activate', 'pause', 'resume', 'cancel']) {
  router.post(`/subscriptions/:id/${action}`, requirePermission('subscriptions.manage'), validate(z.object({})), mutation(async req => ({
    body: await transitionSubscription(req.tenantDb, req.params.id, action === 'resume' ? 'ACTIVE' : action, req)
  })));
}
router.get('/subscriptions/:id/runs', requirePermission('subscriptions.read'), asyncRoute(async (req, res) => {
  const subscription = await getSubscription(req.tenantDb, req.params.id);
  res.json({ runs: subscription.runs });
}));
router.post('/subscription-runs/:id/retry', requirePermission('subscriptions.manage'), validate(z.object({})), mutation(async req => ({
  body: await generateSubscriptionRun(req.tenantDb, req.user.organization_id, req.params.id)
})));

router.get('/compliance/:documentType(e-invoices|e-way-bills)', requirePermission('compliance.read'), asyncRoute(async (req, res) => {
  res.json({ documents: await listComplianceDocuments(req.tenantDb, req.params.documentType, req.query) });
}));
router.post('/compliance/:documentType(e-invoices|e-way-bills)', requirePermission('compliance.prepare'), validate(complianceDocumentSchema), mutation(async req => ({
  status: 201, body: await prepareComplianceDocument(req.tenantDb, req.params.documentType, req.body, req)
})));
router.get('/compliance/documents/:id', requirePermission('compliance.read'), asyncRoute(async (req, res) => {
  res.json(await getComplianceDocument(req.tenantDb, req.params.id));
}));
router.post('/compliance/documents/:id/generate', requirePermission('compliance.prepare'), validate(z.object({})), mutation(async req => ({
  body: await generateComplianceDocument(req.tenantDb, req.params.id, req)
})));
router.post('/compliance/documents/:id/cancel', requirePermission('compliance.file'), validate(z.object({
  reason: z.string().trim().min(1).max(500)
})), mutation(async req => ({
  body: await cancelComplianceDocument(req.tenantDb, req.params.id, req.body.reason, req)
})));
router.get('/compliance/returns/:returnType(gstr-1|gstr-2b|gstr-3b|gstr-7|ims)', requirePermission('compliance.read'), asyncRoute(async (req, res) => {
  res.json({ returns: await listGstReturns(req.tenantDb, req.params.returnType, req.query) });
}));
router.post('/compliance/returns/:returnType(gstr-1|gstr-3b|gstr-7|ims)/prepare', requirePermission('compliance.prepare'), validate(z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)
})), mutation(async req => ({
  body: await prepareGstReturn(req.tenantDb, req.params.returnType, req.body.period, req)
})));
router.post('/compliance/returns/gstr-2b/import', requirePermission('compliance.prepare'), validate(gstr2bImportSchema), mutation(async req => ({
  body: await importGstr2bRows(req.tenantDb, req.body.period, req.body.rows, req)
})));
router.get('/compliance/return-periods/:id', requirePermission('compliance.read'), asyncRoute(async (req, res) => {
  res.json(await getGstReturn(req.tenantDb, req.params.id));
}));
router.post('/compliance/return-periods/:id/request-approval', requirePermission('compliance.prepare'), validate(z.object({})), mutation(async req => ({
  body: await requestGstReturnApproval(req.tenantDb, req.params.id, req)
})));
for (const decision of ['approve', 'reject']) {
  router.post(`/compliance/return-periods/:id/${decision}`, requirePermission('compliance.file'), validate(z.object({})), mutation(async req => ({
    body: await decideGstReturnApproval(req.tenantDb, req.params.id, decision, req)
  })));
}
router.post('/compliance/return-periods/:id/file', requirePermission('compliance.file'), validate(z.object({})), mutation(async req => ({
  body: await fileGstReturn(req.tenantDb, req.params.id, req)
})));
router.post('/compliance/return-periods/:id/rows/:rowId/ims', requirePermission('compliance.prepare'), validate(z.object({
  action: z.enum(['ACCEPT', 'REJECT', 'PENDING'])
})), mutation(async req => ({
  body: await updateImsAction(req.tenantDb, req.params.id, req.params.rowId, req.body.action, req)
})));
router.get('/compliance/tds-tcs', requirePermission('compliance.read'), asyncRoute(async (req, res) => {
  res.json(await tdsTcsReport(req.tenantDb, req.query));
}));

router.get('/store/settings', requirePermission('store.read'), asyncRoute(async (req, res) => {
  res.json(await getStoreSettings(req.tenantDb));
}));
router.put('/store/settings', requirePermission('store.manage'), validate(storeSettingsSchema), mutation(async req => ({
  body: await updateStoreSettings(req.tenantDb, req.body, req)
})));
router.get('/store/catalog', requirePermission('store.read'), asyncRoute(async (req, res) => {
  res.json({ products: await listCatalogManagement(req.tenantDb) });
}));
router.put('/store/catalog/:productId', requirePermission('store.manage'), validate(catalogProductSchema), mutation(async req => ({
  body: await updateCatalogProduct(req.tenantDb, req.params.productId, req.body, req)
})));
router.get('/store/orders', requirePermission('store.read'), asyncRoute(async (req, res) => {
  res.json({ orders: await listOnlineOrders(req.tenantDb, req.query) });
}));
router.get('/store/orders/:id', requirePermission('store.read'), asyncRoute(async (req, res) => {
  res.json(await getOnlineOrder(req.tenantDb, req.params.id));
}));
for (const decision of ['accept', 'reject']) {
  router.post(`/store/orders/:id/${decision}`, requirePermission('store.manage'), validate(z.object({
    reason: z.string().trim().max(1000).optional()
  })), mutation(async req => ({ body: await reviewOnlineOrder(req.tenantDb, req.params.id, decision, req.body, req) })));
}

router.get('/integrations/api-keys', requirePermission('integrations.read'), asyncRoute(async (req, res) => {
  res.json({ api_keys: await listApiKeys(req.tenantDb) });
}));
router.post('/integrations/api-keys', requirePermission('integrations.manage'), validate(apiKeySchema), mutation(async req => ({
  status: 201, body: await createApiKey(req.tenantDb, req.body, req)
})));
router.delete('/integrations/api-keys/:id', requirePermission('integrations.manage'), mutation(async req => ({
  body: await revokeApiKey(req.tenantDb, req.params.id, req)
})));
router.get('/integrations', requirePermission('integrations.read'), asyncRoute(async (req, res) => {
  res.json({ integrations: await listIntegrations(req.tenantDb) });
}));
router.get('/integrations/:provider/runs', requirePermission('integrations.read'), asyncRoute(async (req, res) => {
  res.json({ runs: await listIntegrationRuns(req.tenantDb, req.params.provider) });
}));
router.get('/integrations/:provider', requirePermission('integrations.read'), asyncRoute(async (req, res) => {
  res.json(await getIntegration(req.tenantDb, req.params.provider));
}));
router.put('/integrations/:provider', requirePermission('integrations.manage'), validate(integrationConfigSchema), mutation(async req => ({
  body: await configureIntegration(req.tenantDb, req.params.provider, req.body, req)
})));
router.delete('/integrations/:provider', requirePermission('integrations.manage'), mutation(async req => ({
  body: await disableIntegration(req.tenantDb, req.params.provider, req)
})));
router.post('/integrations/:provider/test', requirePermission('integrations.manage'), validate(z.object({})), mutation(async req => ({
  body: await testIntegration(req.tenantDb, req.params.provider, req)
})));
router.post('/integrations/:provider/sync', requirePermission('integrations.manage'), validate(integrationSyncSchema), mutation(async req => ({
  body: await syncIntegration(req.tenantDb, req.params.provider, req.body, req)
})));
router.get('/webhook-subscriptions', requirePermission('integrations.read'), asyncRoute(async (req, res) => {
  res.json({ subscriptions: await listWebhookSubscriptions(req.tenantDb) });
}));
router.post('/webhook-subscriptions', requirePermission('integrations.manage'), validate(webhookSubscriptionSchema), mutation(async req => ({
  status: 201, body: await createWebhookSubscription(req.tenantDb, req.body, req)
})));
router.put('/webhook-subscriptions/:id', requirePermission('integrations.manage'), validate(webhookUpdateSchema), mutation(async req => ({
  body: await updateWebhookSubscription(req.tenantDb, req.params.id, req.body, req)
})));
router.get('/webhook-deliveries', requirePermission('integrations.read'), asyncRoute(async (req, res) => {
  res.json({ deliveries: await listWebhookDeliveries(req.tenantDb, req.query) });
}));
router.post('/webhook-deliveries/:id/retry', requirePermission('integrations.manage'), validate(z.object({})), mutation(async req => ({
  body: await deliverWebhook(req.tenantDb, req.params.id)
})));

router.get('/dashboard/summary', requirePermission('dashboard.read'), asyncRoute(async (req, res) => {
  res.json(await dashboardSummary(req.tenantDb, req.user.organization_id, req.query.refresh === 'true'));
}));
router.get('/dashboard/activity', requirePermission('dashboard.read'), asyncRoute(async (req, res) => {
  res.json({ activity: await dashboardActivity(req.tenantDb, req.query.limit) });
}));
router.get('/reports', requirePermission('reports.read'), asyncRoute(async (_req, res) => {
  res.json({ reports: listReportDefinitions() });
}));
router.get('/reports/:reportKey', requirePermission('reports.read'), asyncRoute(async (req, res) => {
  res.json(await runReport(req.tenantDb, req.params.reportKey, req.query));
}));
router.get('/reports/:reportKey/export', requirePermission('reports.read'), asyncRoute(async (req, res) => {
  const result = await runReport(req.tenantDb, req.params.reportKey, { ...req.query, limit: req.query.limit || 5000 });
  res.type('text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="inventia-${req.params.reportKey}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(reportToCsv(result));
}));
router.get('/sales', requirePermission('trade.sales.read'), asyncRoute(async (req, res) => {
  const sales = await req.tenantDb.all(
    `SELECT s.*, c.name AS customer_name, w.name AS warehouse_name
       FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN warehouses w ON w.id = s.warehouse_id
      ORDER BY s.sale_date DESC, s.id DESC LIMIT 500`
  );
  res.json({ sales });
}));
const paymentAllocationSchema = z.object({
  method: z.string().trim().min(1).max(40).transform(value => value.toUpperCase()),
  amount: z.coerce.number().positive(),
  reference: z.string().trim().max(200).optional(),
  reference_number: z.string().trim().max(200).optional(),
  provider_transaction_id: z.string().trim().max(200).optional(),
  notes: z.string().max(1000).optional()
});
const invoiceDetailsSchema = z.object({
  challan_number: z.string().trim().max(100).optional(),
  transport: z.string().trim().max(200).optional(),
  vehicle_number: z.string().trim().max(100).optional(),
  eway_bill_number: z.string().trim().max(100).optional(),
  supply_state: z.string().trim().max(100).optional(),
  supply_state_code: z.string().trim().max(10).optional(),
  customer_gstin: z.string().trim().max(30).optional(),
  customer_address: z.string().trim().max(2000).optional(),
  customer_state: z.string().trim().max(100).optional(),
  customer_state_code: z.string().trim().max(10).optional()
});
const checkoutSchema = z.object({
  customer_id: z.coerce.number().int().positive().nullable().optional(),
  warehouse_id: z.coerce.number().int().positive(),
  items: z.array(z.object({
    product_id: z.coerce.number().int().positive(),
    variant_id: z.coerce.number().int().positive().nullable().optional(),
    quantity: z.coerce.number().positive(),
    unit_price: z.coerce.number().nonnegative().optional()
  })).min(1).max(500),
  discount: z.coerce.number().nonnegative().default(0),
  payment_method: z.enum(['cash', 'card', 'upi', 'credit', 'razorpay', 'bank_transfer', 'cheque', 'other']).optional(),
  razorpay_payment_id: z.string().optional(),
  payment_reference: z.string().max(200).optional(),
  payments: z.array(paymentAllocationSchema).min(1).max(10).optional(),
  allow_partial_payment: z.boolean().default(false),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  invoice_details: invoiceDetailsSchema.optional(),
  notes: z.string().max(2000).optional()
}).superRefine((value, context) => {
  if (!value.payment_method && !value.payments?.length) {
    context.addIssue({
      code: 'custom',
      path: ['payments'],
      message: 'Provide payments[] or the compatibility payment_method field.'
    });
  }
});
router.post('/pos/checkout', requirePermission('trade.sales.create'), validate(checkoutSchema), mutation(async req => ({
  status: 201,
  body: await checkoutPos(req.tenantDb, req.body, req)
})));

router.get('/invoices', requirePermission('trade.sales.read'), asyncRoute(async (req, res) => {
  res.json({ invoices: await listInvoices(req.tenantDb, req.query) });
}));
router.get('/invoices/:id', requirePermission('trade.sales.read'), asyncRoute(async (req, res) => {
  res.json(await getInvoice(req.tenantDb, req.params.id));
}));
router.get('/invoices/:id/pdf', requirePermission('trade.sales.read'), asyncRoute(async (req, res) => {
  const pdf = await readInvoicePdf(req.tenantDb, req.params.id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${pdf.filename.replaceAll('"', '')}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(pdf.buffer);
}));
router.post('/invoices/:id/pdf/retry', requirePermission('trade.sales.update'), mutation(async req => ({
  body: await retryInvoicePdf(req.tenantDb, req.user.organization_id, req.params.id, req)
})));
router.post('/invoices/:id/payments', requirePermission('payments.create'), validate(z.object({
  payments: z.array(paymentAllocationSchema).min(1).max(10),
  allow_partial_payment: z.boolean().default(false),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
})), mutation(async req => ({
  status: 201,
  body: await collectInvoicePayment(req.tenantDb, req.params.id, req.body, req)
})));
router.post('/payment-allocations/:id/confirm', requirePermission('payments.confirm'), mutation(async req => ({
  body: await confirmPaymentAllocation(req.tenantDb, req.params.id, req)
})));
router.post('/payment-allocations/:id/refunds', requirePermission('payments.refund'), validate(z.object({
  amount: z.coerce.number().positive(),
  reason: z.string().trim().min(1).max(500)
})), mutation(async req => ({
  status: 201,
  body: await refundPaymentAllocation(req.tenantDb, req.params.id, req.body, req)
})));
router.get('/settings/payment-methods', requirePermission('payments.create'), asyncRoute(async (req, res) => {
  res.json({ methods: await getPaymentMethods(req.tenantDb) });
}));
router.put('/settings/payment-methods', requirePermission('payments.configure'), validate(z.object({
  methods: z.array(z.object({
    method: z.string().trim().min(1).max(40).transform(value => value.toUpperCase()),
    label: z.string().trim().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
    requires_reference: z.boolean().optional()
  })).min(1).max(20)
})), mutation(async req => ({
  body: await updatePaymentMethods(req.tenantDb, req.body.methods, req)
})));

// Concrete payment-method settings stay above the namespace router so the
// generic /settings/:namespace route cannot shadow them.
router.use(settingsFoundationRoutes);

router.get('/search', requirePermission('dashboard.read'), asyncRoute(async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) return res.json([]);
  res.json(await searchTenantBusiness(req.tenantDb, query));
}));

router.get('/ai/status', requirePermission('ai.read'), (_req, res) => {
  res.json({
    provider: process.env.OPENAI_API_KEY ? 'openai' : 'local',
    configured: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
    fallback_available: true,
    action_policy: 'preview_then_approve',
    tenant_scoped: true
  });
});
router.post('/ai/chat', requirePermission('ai.read'), validate(z.object({
  message: z.string().trim().min(1).max(4000),
  conversation_id: z.coerce.number().int().positive().optional(),
  source: z.string().max(100).optional()
})), mutation(async req => ({ body: await tenantAiChat(req.tenantDb, req.body, req) })));
router.get('/ai/conversations', requirePermission('ai.read'), asyncRoute(async (req, res) => {
  res.json(await listTenantAiConversations(req.tenantDb, req));
}));
router.get('/ai/conversations/:id', requirePermission('ai.read'), asyncRoute(async (req, res) => {
  res.json(await getTenantAiConversation(req.tenantDb, req.params.id, req));
}));
router.get('/ai/insights', requirePermission('ai.read'), asyncRoute(async (req, res) => {
  res.json(await tenantAiAnalytics(req.tenantDb, 'insights'));
}));
router.get('/ai/business-health', requirePermission('ai.read'), asyncRoute(async (req, res) => {
  res.json(await tenantAiAnalytics(req.tenantDb, 'health'));
}));
router.get('/ai/forecast/inventory', requirePermission('ai.read'), asyncRoute(async (req, res) => {
  res.json(await tenantAiAnalytics(req.tenantDb, 'forecast', Math.min(Math.max(Number(req.query.days || 30), 7), 180)));
}));
router.get('/ai/reorder-recommendations', requirePermission('ai.read'), asyncRoute(async (req, res) => {
  res.json(await tenantAiAnalytics(req.tenantDb, 'reorder', Number(req.query.days || 30)));
}));
router.get('/ai/actions', requirePermission('ai.read'), asyncRoute(async (req, res) => {
  res.json(await listTenantAiActions(req.tenantDb, req.query.status, req));
}));
router.post('/ai/actions/:id/approve', requirePermission('ai.approve'), mutation(async req => ({
  body: await approveTenantAiAction(req.tenantDb, req.params.id, req)
})));
router.post('/ai/actions/:id/reject', requirePermission('ai.approve'), validate(z.object({
  reason: z.string().max(500).optional()
})), mutation(async req => ({
  body: await rejectTenantAiAction(req.tenantDb, req.params.id, req.body.reason, req)
})));
const knowledgeSchema = z.object({
  title: z.string().trim().min(1).max(300),
  content: z.string().trim().min(1).max(100000),
  tags: z.union([z.string(), z.array(z.string())]).optional(),
  source_type: z.string().max(50).optional(),
  source_reference: z.string().max(1000).nullable().optional(),
  status: z.enum(['active', 'archived']).optional()
});
router.get('/ai/knowledge', requirePermission('ai.read'), asyncRoute(async (req, res) => {
  res.json(await listKnowledge(req.tenantDb, String(req.query.q || '')));
}));
router.post('/ai/knowledge', requirePermission('ai.manage'), validate(knowledgeSchema), mutation(async req => ({
  status: 201,
  body: await createKnowledge(req.tenantDb, req.body, req)
})));
router.put('/ai/knowledge/:id', requirePermission('ai.manage'), validate(knowledgeSchema.partial().refine(value => Object.keys(value).length > 0)), mutation(async req => ({
  body: await updateKnowledge(req.tenantDb, req.params.id, req.body)
})));
router.delete('/ai/knowledge/:id', requirePermission('ai.manage'), mutation(async req => {
  await deleteKnowledge(req.tenantDb, req.params.id);
  return { status: 204, body: null };
}));

router.post('/payments/razorpay/orders', requirePermission('payments.create'), validate(z.object({
  amount: z.coerce.number().positive(),
  currency: z.string().length(3).default('INR'),
  receipt: z.string().max(40).optional(),
  trade_document_id: z.coerce.number().int().positive().optional(),
  customer_id: z.coerce.number().int().positive().optional()
})), mutation(async req => ({
  status: 201,
  body: await createRazorpayOrder(req.tenantDb, req.body, req)
})));
router.post('/payments/razorpay/verify', requirePermission('payments.create'), validate(z.object({
  razorpay_order_id: z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature: z.string().min(1)
})), mutation(async req => ({ body: await verifyRazorpayPayment(req.tenantDb, req.body, req) })));
router.post('/payments/razorpay/refunds', requirePermission('payments.refund'), validate(z.object({
  payment_id: z.string().min(1),
  amount: z.coerce.number().positive(),
  speed: z.enum(['normal', 'optimum']).optional(),
  reason: z.string().max(500).optional()
})), mutation(async req => ({
  status: 201,
  body: await refundRazorpayPayment(req.tenantDb, req.body, req)
})));
router.get('/payments/reconciliation', requirePermission('payments.read'), asyncRoute(async (req, res) => {
  res.json(await paymentReconciliation(req.tenantDb, req.query));
}));

router.post('/attachments', requirePermission('trade.update'), upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw httpError(422, 'file_required', 'A file is required.');
  const entityType = String(req.body.entity_type || '');
  const entityId = String(req.body.entity_id || '');
  if (!entityType || !entityId) throw httpError(422, 'attachment_target_required', 'entity_type and entity_id are required.');
  await assertAttachmentTarget(req.tenantDb, entityType, entityId);
  const result = await executeIdempotent(req, async () => {
    const stored = await storage.put({
      organizationId: req.user.organization_id,
      originalName: req.file.originalname,
      contentType: req.file.mimetype,
      buffer: req.file.buffer
    });
    try {
      const inserted = await insertWithId(req.tenantDb,
        `INSERT INTO attachments
          (entity_type, entity_id, file_key, file_name, content_type, size_bytes,
           storage_provider, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [entityType, entityId, stored.key, req.file.originalname, req.file.mimetype,
          req.file.size, stored.provider, req.user.id, now()]
      );
      const id = inserted.id || inserted.rows?.[0]?.id;
      const attachment = await req.tenantDb.one('SELECT * FROM attachments WHERE id = ?', [id]);
      await writeTenantAudit(req.tenantDb, req, { eventType: 'attachment.created', entityType, entityId, after: attachment });
      return { status: 201, body: attachment };
    } catch (error) {
      await storage.remove(stored.key).catch(() => {});
      throw error;
    }
  });
  sendMutation(res, result);
}));

router.get('/files/:key', asyncRoute(async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  if (!key.startsWith(`${req.user.organization_id}/`)) throw httpError(403, 'file_access_denied', 'This file belongs to another organization.');
  const attachment = await req.tenantDb.one('SELECT * FROM attachments WHERE file_key = ?', [key]);
  if (!attachment) throw httpError(404, 'file_not_found', 'File was not found.');
  if (attachment.storage_provider === 'supabase') return res.redirect(await storage.signedUrl(key));
  res.type(attachment.content_type || 'application/octet-stream');
  res.send(await storage.read(key));
}));

router.get('/reference/:resource', requirePermission('products.read'), asyncRoute(async (req, res) => {
  const table = referenceTable(req.params.resource);
  res.json({ items: await req.tenantDb.all(`SELECT * FROM ${table} ORDER BY id DESC`) });
}));
router.post('/reference/:resource', requirePermission('products.update'), validate(z.object({
  name: z.string().trim().min(1).max(200),
  code: z.string().trim().max(50).optional(),
  rate: z.coerce.number().min(0).max(100).optional(),
  tax_type: z.string().max(50).optional(),
  address: z.string().max(1000).optional(),
  type: z.string().max(50).optional()
})), mutation(async req => {
  const table = referenceTable(req.params.resource);
  const input = req.body;
  let statement;
  let values;
  if (table === 'tax_profiles') {
    statement = `INSERT INTO tax_profiles (name, tax_type, rate, status, created_at) VALUES (?, ?, ?, 'active', ?)`;
    values = [input.name, input.tax_type || 'GST', input.rate || 0, now()];
  } else if (table === 'warehouses') {
    statement = `INSERT INTO warehouses (name, code, type, address, created_at) VALUES (?, ?, ?, ?, ?)`;
    values = [input.name, input.code || generateCode(input.name), input.type || 'warehouse', input.address || null, now()];
  } else if (table === 'units') {
    statement = `INSERT INTO units (code, name, status, created_at) VALUES (?, ?, 'active', ?)`;
    values = [input.code || generateCode(input.name), input.name, now()];
  } else if (table === 'categories') {
    statement = `INSERT INTO categories (name, description, created_at) VALUES (?, NULL, ?)`;
    values = [input.name, now()];
  } else {
    statement = `INSERT INTO ${table} (name, code, created_at) VALUES (?, ?, ?)`;
    values = [input.name, input.code || generateCode(input.name), now()];
  }
  const inserted = await insertWithId(req.tenantDb, statement, values);
  const id = inserted.id || inserted.rows?.[0]?.id;
  const item = await req.tenantDb.one(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  await writeTenantAudit(req.tenantDb, req, { eventType: `${req.params.resource}.created`, entityType: req.params.resource, entityId: id, after: item });
  return { status: 201, body: item };
}));
router.put('/reference/:resource/:id', requirePermission('products.update'), validate(z.object({
  name: z.string().trim().min(1).max(200),
  code: z.string().trim().max(50).optional(),
  rate: z.coerce.number().min(0).max(100).optional(),
  tax_type: z.string().max(50).optional(),
  address: z.string().max(1000).optional(),
  type: z.string().max(50).optional(),
  status: z.enum(['active', 'inactive']).optional()
})), mutation(async req => {
  const table = referenceTable(req.params.resource);
  const before = await req.tenantDb.one(`SELECT * FROM ${table} WHERE id = ?`, [req.params.id]);
  if (!before) throw httpError(404, 'reference_item_not_found', 'Reference item was not found.');
  if (table === 'tax_profiles') {
    await req.tenantDb.run('UPDATE tax_profiles SET name = ?, tax_type = ?, rate = ?, status = ? WHERE id = ?', [
      req.body.name, req.body.tax_type || before.tax_type, req.body.rate ?? before.rate, req.body.status || before.status, req.params.id
    ]);
  } else if (table === 'warehouses') {
    await req.tenantDb.run('UPDATE warehouses SET name = ?, code = ?, type = ?, address = ? WHERE id = ?', [
      req.body.name, req.body.code || before.code, req.body.type || before.type, req.body.address ?? before.address, req.params.id
    ]);
  } else if (table === 'units') {
    await req.tenantDb.run('UPDATE units SET name = ?, code = ?, status = ? WHERE id = ?', [
      req.body.name, req.body.code || before.code, req.body.status || before.status, req.params.id
    ]);
  } else if (table === 'categories') {
    await req.tenantDb.run('UPDATE categories SET name = ? WHERE id = ?', [req.body.name, req.params.id]);
  } else {
    await req.tenantDb.run(`UPDATE ${table} SET name = ?, code = ? WHERE id = ?`, [req.body.name, req.body.code || before.code, req.params.id]);
  }
  const after = await req.tenantDb.one(`SELECT * FROM ${table} WHERE id = ?`, [req.params.id]);
  await writeTenantAudit(req.tenantDb, req, { eventType: `${req.params.resource}.updated`, entityType: req.params.resource, entityId: req.params.id, before, after });
  return { body: after };
}));
router.delete('/reference/:resource/:id', requirePermission('products.update'), mutation(async req => {
  const table = referenceTable(req.params.resource);
  const before = await req.tenantDb.one(`SELECT * FROM ${table} WHERE id = ?`, [req.params.id]);
  if (!before) throw httpError(404, 'reference_item_not_found', 'Reference item was not found.');
  if (table === 'brands' || table === 'categories') {
    const column = table === 'brands' ? 'brand_id' : 'category_id';
    const used = await req.tenantDb.one(`SELECT COUNT(*) AS count FROM products WHERE ${column} = ?`, [req.params.id]);
    if (Number(used.count)) throw httpError(409, 'reference_item_in_use', 'This item is assigned to products and cannot be deleted.');
  }
  if (table === 'warehouses') {
    const used = await req.tenantDb.one('SELECT COUNT(*) AS count FROM warehouse_stock WHERE warehouse_id = ? AND quantity <> 0', [req.params.id]);
    if (Number(used.count)) throw httpError(409, 'warehouse_has_stock', 'A warehouse with stock cannot be deleted.');
  }
  if (['units', 'tax_profiles'].includes(table)) {
    await req.tenantDb.run(`UPDATE ${table} SET status = 'inactive' WHERE id = ?`, [req.params.id]);
  } else {
    await req.tenantDb.run(`DELETE FROM ${table} WHERE id = ?`, [req.params.id]);
  }
  await writeTenantAudit(req.tenantDb, req, { eventType: `${req.params.resource}.deleted`, entityType: req.params.resource, entityId: req.params.id, before });
  return { status: 204, body: null };
}));

export default router;

function mutation(handler) {
  return asyncRoute(async (req, res) => sendMutation(res, await executeIdempotent(req, () => handler(req))));
}

function insertWithId(db, sql, params) {
  return db.run(`${sql}${db.dialect === 'postgres' ? ' RETURNING id' : ''}`, params);
}

async function assertAttachmentTarget(db, entityType, entityId) {
  const masterTables = { product: 'products', customer: 'customers', supplier: 'suppliers' };
  if (masterTables[entityType]) {
    const target = await db.one(`SELECT id FROM ${masterTables[entityType]} WHERE id = ?`, [entityId]);
    if (!target) throw httpError(404, 'attachment_target_not_found', 'The attachment target was not found.');
    return;
  }
  const tradeTypes = new Set(['quotation', 'sales_order', 'purchase_order', 'delivery_challan', 'packing_list', 'invoice', 'sales_return', 'purchase_return']);
  if (!tradeTypes.has(entityType)) throw httpError(422, 'attachment_target_invalid', 'This attachment target type is not supported.');
  const target = await db.one('SELECT id FROM trade_documents WHERE id = ? AND document_type = ?', [entityId, entityType]);
  if (!target) throw httpError(404, 'attachment_target_not_found', 'The attachment target was not found.');
}

function referenceTable(resource) {
  const tables = { brands: 'brands', categories: 'categories', warehouses: 'warehouses', units: 'units', taxes: 'tax_profiles' };
  const table = tables[resource];
  if (!table) throw httpError(404, 'reference_resource_not_found', 'Reference resource was not found.');
  return table;
}

function documentTypeMatches(routeType, documentType) {
  const map = {
    quotations: 'quotation', 'sales-orders': 'sales_order', 'purchase-orders': 'purchase_order',
    deliveries: 'delivery_challan', 'packing-lists': 'packing_list', invoices: 'invoice',
    'sales-returns': 'sales_return', 'purchase-returns': 'purchase_return'
  };
  return map[routeType] === documentType;
}

function generateCode(name) {
  return `${String(name).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function csvValue(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function now() {
  return new Date().toISOString();
}

export { DEFAULT_ORGANIZATION_ID, getTenantDatabase, initializePhase5Platform, hashPlatformPassword };
