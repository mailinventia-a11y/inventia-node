# Inventia Phase 6 - Integrated Trade, Compliance, and Business Operations

## Document status

- Status: Implementation-ready product requirements document
- Source inputs:
  - Current Inventia `develop` branch architecture and source code
  - Existing Phase 4 and Phase 5 platform capabilities
  - Read-only walkthrough of the authenticated Swipe application
- Product rule: reproduce useful business capabilities and workflow quality, not Swipe branding or visual design
- UI rule: preserve Inventia's existing tokens, component classes, spacing, cards, buttons, dark mode, and responsive behavior

### Implementation progress

- Milestone 0 - Safety and modular foundation: implemented
- Milestone 1 - Sidebar and existing backend exposure: next

---

## 1. Executive summary

Inventia already contains a strong enterprise foundation:

- Express and vanilla JavaScript application
- SQLite local compatibility and PostgreSQL production support
- database-per-organization tenant isolation
- Argon2id authentication, JWT access tokens, rotating refresh sessions, RBAC, audit logs, and idempotency
- products, variants, price lists, inventory ledger, warehouses, reservations, batches, serials, transfers, cycle counts, and valuation
- customers, suppliers, contacts, addresses, communications, and activity history
- quotations, sales orders, purchase orders, deliveries, packing lists, invoices, returns, approvals, GRNs, and explicit workflow states
- GST POS checkout, immutable invoice snapshots, split and partial payments, refunds, Razorpay, customer ledgers, and retryable PDF generation
- dashboard aggregation, Redis-compatible caching, BullMQ-compatible jobs, and organization-scoped Socket.IO events
- Inventia AI, universal search, approval-gated AI actions, knowledge documents, forecasts, and deterministic fallback
- barcode assignment, label design, batch printing, scanning, history, analytics, and recommendations

The next release must expose and complete these capabilities through a coherent business information architecture, then add the missing high-value modules found during the Swipe audit:

- credit notes and debit notes
- pro forma invoices
- recurring subscriptions
- e-invoice and e-way bill operations
- GST filing and reconciliation
- payment links and automated reminders
- complete document configuration and numbering
- projects and document profitability
- online catalogue and order capture
- Tally, WhatsApp, API/webhook, and later commerce/shipping integrations

This is an extension of the current application, not a rewrite. New work must use `/api/v1`, tenant-aware services, immutable ledgers, domain events, and existing UI components.

---

## 2. Product objective

Create a complete Indian trade and business operations platform in which a user can:

1. Configure an organization, users, taxes, products, inventory, documents, payments, and integrations.
2. Move from quotation to sales order, fulfilment, invoice, payment, return, and credit note without re-entering data.
3. Move from purchase order to approval, GRN, supplier invoice, payment, return, and debit note.
4. Maintain reliable stock, accounting, GST, document, and payment histories.
5. Use one predictable sidebar, page structure, command palette, and settings centre.
6. Use Inventia AI for grounded analysis and approval-gated actions.
7. Operate fully without fake success paths when external integrations are unavailable.

---

## 3. Non-goals

- Do not copy Swipe's logo, wording, colours, layouts, illustrations, or proprietary visual assets.
- Do not introduce React, Vue, Angular, or a frontend rewrite.
- Do not replace Express, the current tenancy model, PostgreSQL, Redis, BullMQ, Socket.IO, or the SQLite fallback.
- Do not create alternative POS, invoice, payment, inventory, or authentication engines.
- Do not introduce new button, card, badge, input, or brand-colour systems.
- Do not let frontend calculations become authoritative for stock, tax, totals, balances, permissions, or payment status.
- Do not show simulated integration success.
- Do not implement every marketplace integration in the first release.

---

## 4. Product and UI guardrails

### 4.1 Visual system is locked

All new pages must reuse:

- `.page-architecture-header`
- `.workspace-page-hero`
- `.workspace-view-tabs`
- `.kpi-card`
- `.grid-panel`
- `.table-container` and `.table-responsive`
- `.inventory-table`
- `.action-btn`, `.action-btn.primary`, `.action-btn.secondary`, and `.action-btn-sm`
- existing status badges
- `.panel-form`, `.form-row`, and `.form-group`
- current modal, drawer, dropdown, toast, empty, loading, and error patterns

New components must use:

- `--primary-color`
- `--primary-color-hover`
- `--primary-color-light`
- `--bg`
- `--bg-card`
- `--border`
- `--border-focus`
- `--ink`
- `--ink-secondary`
- `--ink-muted`
- existing green, amber, red, violet, teal, radius, and shadow tokens

Core theme tokens and current button/card styling must not be changed for feature delivery. Feature-specific CSS may only define layout, responsive placement, table sizing, and state visibility.

### 4.2 Workflow system is server authoritative

- Client totals are previews only.
- Every mutation is validated by Zod.
- Every mutation requires an idempotency key.
- Every mutation records actor, organization, request ID, before/after state, result, and timestamp.
- Stock changes only through `stock_movements`.
- Financial balances change only through immutable ledger entries.
- External provider success requires verified provider evidence.
- Organization context always comes from the authenticated session.

---

## 5. Current Inventia structure analysis

### 5.1 Current backend

| Area | Current implementation | Decision |
|---|---|---|
| Application | `server.js`, Express ES modules | Retain |
| Versioned API | `src/routes/v1Routes.js` | Retain; split new domains into subrouters |
| Compatibility API | `routes/*.js` under `/api` | Preserve temporarily; no new features here |
| Tenant platform | `src/platform/phase5Database.js` | Extend with additive migrations |
| Authentication | `src/platform/phase5Auth.js` | Retain |
| Runtime | Redis, BullMQ, Socket.IO with local fallbacks | Retain |
| Trade services | `src/services/enterpriseTradeService.js` | Extract shared document services incrementally |
| Invoice/payments | `src/services/invoicePaymentService.js` | Keep as canonical fiscal invoice/payment engine |
| PDFs | Puppeteer HTML templates | Extend through document template service |
| AI | tenant-scoped OpenAI and local fallback | Retain and add new grounded tools |
| Barcode/labels | tenant-scoped persistent assignment and printing | Retain |
| OpenAPI | `src/platform/openapi.js` | Expand to cover every new interface |

### 5.2 Current frontend

The frontend is a large vanilla application:

- `public/index.html`: approximately 3,000 lines
- `public/app.js`: approximately 6,200 lines
- `public/style.css`: approximately 6,000 lines

The shell and design system are usable, but feature growth inside three monolithic files will increase regression risk. New modules must be introduced as native ES modules without changing the visible shell.

### 5.3 Existing sidebar problems to correct

- `Operations` mixes orders, sales, purchases, customers, suppliers, payments, and expenses.
- Several sidebar items open the same tab without selecting a distinct view.
- `Finance` duplicates Invoices and shares one screen for cash flow and reconciliation.
- `Inventory` maps Stock Movement and Stock Transfer to the same panel.
- Settings displays 13 categories, but many items currently show only a "ready to configure" toast.
- `Automation` is actually the AI workspace and should be named accordingly.
- `Marketplace` does not represent the desired Online Store and Integrations split.
- Local notification samples are stored in `localStorage`; production notifications must be tenant-backed.

### 5.4 Existing capabilities that need UI completion before new backend work

- trade document CRUD and transitions
- sales and purchase returns
- delivery challans and packing lists
- approvals
- GRNs
- product variants and supplier mappings
- price lists
- batches, serials, reservations, cycle counts, and reorder rules
- party contacts, addresses, communications, activity, and supplier analytics
- attachments
- payment method configuration
- organization-scoped activity and realtime events

---

## 6. Swipe capability analysis and Inventia decisions

| Capability | Inventia status | Required action |
|---|---|---|
| GST invoices and PDF | Implemented | Improve document settings and list/detail workflow |
| POS billing | Implemented | Add saved carts and POS preference controls |
| Split/partial payments | Implemented | Expose payment timeline and collection workflows |
| Quotations | Backend foundation | Build full list, form, detail, conversion, and timeline UI |
| Sales orders | Backend foundation | Complete UI, reservations, fulfilment, and conversions |
| Purchase orders and GRNs | Backend foundation | Complete UI, approvals, receipt, and supplier invoice linking |
| Delivery challans | Backend foundation | Complete UI and stock-policy settings |
| Packing lists | Backend foundation | Complete UI and shipment linkage |
| Sales/purchase returns | Backend foundation | Complete UI and fiscal adjustment linkage |
| Pro forma invoices | Missing document type | Add to trade-document engine |
| Credit/debit notes | Missing fiscal workflow | Add fiscal adjustment service and ledger effects |
| Recurring subscriptions | Missing | Add schedules, jobs, invoice generation, pause/resume |
| Product variants | Backend exists | Build management UI |
| Price lists | Backend exists | Build list, rules, assignment, and import UI |
| Batches/expiry/serials | Backend exists | Build operational UI and alerts |
| Product groups/combos/free quantity | Partial/missing | Add after core inventory UI |
| Customer/vendor groups and imports | Partial | Add grouping, custom fields, import validation, and recovery |
| Projects and profitability | Missing | Add project ledger and document linking |
| Payments timeline | Partial | Consolidate canonical payment and allocation views |
| Payment links | Missing | Add provider-backed links with expiry and status |
| Journals and reconciliation | Legacy API exists | Move to `/api/v1` and complete UI |
| Auto reminders | Missing | Add reminder rules and channel delivery jobs |
| E-invoice | Missing integration | Add IRN generation, cancellation, status, and audit |
| E-way bills | Missing integration | Add credential, generation, cancellation, and status workflow |
| GSTR reports and reconciliation | Partial GST summary only | Add return preparation, import, mismatch, and export modules |
| TDS/TCS | Basic invoice fields only | Add ledgers, certificates, reports, and configuration |
| Online catalogue/store | Missing | Add catalogue publishing and order intake |
| Tally integration | Missing | Add export/sync connector and reconciliation history |
| APIs and webhooks | Platform foundation only | Add tenant-managed credentials, subscriptions, and logs |
| WhatsApp | Missing | Add template, consent, delivery, and reminder integration |
| Shopify/Shiprocket | Missing | Defer until core store and integration framework are stable |
| AI chat and actions | Implemented | Add attachments, voice, custom instructions, and new domain tools |
| Document settings | Partial | Build complete tenant settings and template controls |
| User roles | Implemented backend | Complete role/permission and activity UI |

---

## 7. Target sidebar and information architecture

The sidebar must keep the existing `nav-btn`, `nav-dropdown-wrapper`, `nav-dropdown-trigger`, and `nav-dropdown-item` classes. Only labels, groups, destinations, permission visibility, and active-view routing change.

### 7.1 Proposed sidebar

```text
Workspace
  Home

Trade
  Sales
    Invoices
    POS Billing
    Credit Notes
    E-Invoices
    Subscriptions
  Purchases
    Purchase Invoices
    Purchase Orders
    Debit Notes
    GRNs
  Trade Documents
    Quotations
    Sales Orders
    Pro Forma Invoices
    Delivery Challans
    Packing Lists
    Sales Returns
    Purchase Returns

Inventory
  Products & Services
    Products
    Categories & Brands
    Variants
    Price Lists
    Supplier Mappings
  Stock
    Inventory Balances
    Stock Timeline
    Stock Adjustments
    Transfers
    Batches & Expiry
    Serial Numbers
    Reservations
    Cycle Counts
    Reorder Rules
  Barcode Management
    Existing barcode submenu remains unchanged

Parties
  Customers
  Suppliers
  Groups
  Projects

Finance
  Payments Timeline
  Payment Links
  Journals
  Bank Accounts
  Reconciliation
  Expenses
  Indirect Income

Insights & Compliance
  Insights
  Reports
  GST & Compliance
    E-way Bills
    GSTR-1
    GSTR-2B
    GSTR-3B
    GSTR-7
    IMS
    TDS/TCS

Tools
  Inventia AI
  Online Store
  Integrations
  Settings
```

### 7.2 Changes to the current sidebar

- Move the current top-level Invoices entry into Sales.
- Replace the mixed Operations group with Sales, Purchases, and Parties groups.
- Retain Barcode Management and all existing barcode views.
- Remove the duplicated Finance > Invoices entry.
- Give Payments, Expenses, Journals, and Reconciliation separate view keys.
- Give Stock Movement, Transfer, Batches, Serials, and Cycle Counts separate view keys.
- Rename `Automation` to `Inventia AI`.
- Replace `Marketplace` with Online Store and Integrations destinations.
- Move Team and Roles into Settings > Users & Permissions, while retaining a permission-controlled shortcut if required.
- Keep old `data-tab` values as compatibility aliases until bookmarks and quick-create actions are migrated.

### 7.3 Navigation implementation

Add a view-aware router while retaining `switchTab()`:

```text
switchWorkspace(module, view, parameters)
```

Each sidebar item receives:

```html
data-module="sales"
data-view="credit-notes"
data-permission="trade.sales.read"
```

The router must:

- activate the correct existing sidebar class
- open the parent dropdown
- mount or reveal the correct workspace view
- update browser history
- restore views on reload and back/forward
- enforce permission visibility
- avoid duplicate API loading
- support command-palette and quick-create navigation

---

## 8. Frontend technical architecture

### 8.1 Languages and tools

| Layer | Technology |
|---|---|
| Markup | Semantic HTML5 |
| Styling | Existing CSS custom properties and component classes |
| Application code | Vanilla JavaScript ES modules |
| HTTP | Native `fetch`, `AbortController`, centralized API client |
| Charts | Existing Chart.js |
| Icons | Existing Font Awesome |
| Tables | Existing responsive table components; no new UI framework |
| PDF preview/download | Authenticated API endpoints and browser Blob handling |
| Barcode scanning | Existing HID/manual/camera flow and native `BarcodeDetector` fallback rules |
| Realtime | Socket.IO client scoped to active organization |
| Accessibility | Native controls, ARIA labels, focus management, keyboard navigation |

### 8.2 New frontend module structure

```text
public/
  app.js                         # bootstrap and temporary compatibility globals
  index.html                     # shell and stable workspace mount points
  style.css                      # existing design system; no token redesign
  js/
    core/
      api.js
      auth.js
      router.js
      permissions.js
      realtime.js
      state.js
      errors.js
      idempotency.js
    components/
      data-table.js
      filters.js
      form-errors.js
      document-editor.js
      document-timeline.js
      payment-summary.js
      settings-registry.js
    modules/
      sales/
      purchases/
      trade-documents/
      inventory/
      parties/
      finance/
      compliance/
      projects/
      online-store/
      integrations/
      ai/
```

Migration is incremental. Existing global functions remain as wrappers until their screens move into modules.

### 8.3 Standard workspace composition

Every list page uses:

1. Existing page header and primary action.
2. Existing local view tabs where needed.
3. KPI cards only when they support a decision.
4. Search, date, status, party, and action filters.
5. Existing responsive table.
6. Existing loading, empty, permission-denied, integration-not-configured, and error states.
7. Detail drawer/page with summary, lines, payments, attachments, approvals, and timeline.

Every create/edit page uses the reusable document editor rather than a unique form implementation.

---

## 9. Backend technical architecture

### 9.1 Languages and tools

| Layer | Technology |
|---|---|
| Runtime | Node.js ES modules |
| API | Express REST under `/api/v1` |
| Validation | Zod |
| Production database | PostgreSQL, one tenant database per organization |
| Local fallback | SQLite |
| Money and quantity | Integer minor units plus `decimal.js` |
| Cache and event transport | Redis with in-process fallback |
| Jobs | BullMQ with inline/local fallback where safe |
| Realtime | Socket.IO organization rooms |
| Files | Existing local/Supabase-compatible storage adapter |
| PDFs | Semantic HTML and Puppeteer |
| Payments | Official Razorpay SDK |
| AI | OpenAI Responses API plus deterministic local fallback |
| Tests | Node test runner; add Playwright for browser regression |

### 9.2 Domain structure for new work

```text
src/
  domains/
    settings/
    documents/
    fiscal-adjustments/
    subscriptions/
    accounting/
    compliance/
    projects/
    communications/
    online-store/
    integrations/
  routes/
    v1/
      settingsRoutes.js
      documentRoutes.js
      subscriptionRoutes.js
      financeRoutes.js
      complianceRoutes.js
      projectRoutes.js
      storeRoutes.js
      integrationRoutes.js
```

Each domain contains:

- validation schemas
- service
- repository/query functions
- permission definitions
- events
- worker handlers where required
- tests

`src/routes/v1Routes.js` remains the composition point but should stop growing as one file.

### 9.3 Document model decision

Do not merge the existing `trade_documents` and canonical `invoices` tables during this release.

- `trade_documents` remains the workflow source for quotations, sales orders, purchase orders, pro forma invoices, delivery challans, packing lists, and returns.
- `invoices` remains the immutable legal GST invoice created by checkout or an approved conversion.
- Add `document_links` to connect source, converted, related, return, and adjustment documents.
- Add `fiscal_adjustments` and `fiscal_adjustment_lines` for credit/debit notes linked to an invoice.
- Add shared services for numbering, tax, totals, snapshots, conversions, templates, attachments, and timelines.

This avoids risking the existing checkout, payment, stock, ledger, and PDF guarantees.

---

## 10. Functional requirements

### 10.1 Sales and trade documents

- Complete list, create, edit, detail, approval, cancellation, conversion, attachment, and timeline flows.
- Add pro forma invoice to the supported trade-document types.
- Convert:
  - quotation to sales order
  - quotation to pro forma
  - sales order to delivery challan
  - sales order to packing list
  - sales order to invoice/POS checkout service
  - purchase order to GRN
- Preserve source links and conversion history.
- Add document-level duplicate submission protection.
- Use the existing explicit workflow states.
- Prevent conversion from cancelled or incompatible source states.
- Revalidate price, stock, tax, credit limit, period lock, and permission during conversion.

### 10.2 Credit and debit notes

- Create against an existing invoice or supplier document.
- Snapshot original tax and party information.
- Support quantity, price, discount, and tax corrections.
- Post stock movements only when goods physically return.
- Post customer or supplier ledger adjustments transactionally.
- Recalculate invoice outstanding state without rewriting original invoice values.
- Support approval, issue, PDF, cancellation rules, and GST reporting.

### 10.3 Subscriptions

- Create recurring invoice definitions with customer, items, price policy, tax, frequency, start/end dates, due-date rule, send time, and delivery channels.
- Support draft, active, paused, completed, and cancelled states.
- BullMQ generates invoices idempotently using schedule occurrence keys.
- Product price changes follow an organization preference: snapshot price or current approved price.
- Failed generation remains retryable and audited.

### 10.4 Document settings

Provide tenant-scoped settings for:

- document prefixes, suffixes, yearly sequences, and default series
- due-date defaults
- rounding
- discount basis
- cancellation remarks
- invoice, quotation, order, return, and purchase defaults
- PDF file naming with approved placeholders
- templates
- visible columns and sections
- quantity and price decimal precision
- HSN/SAC visibility and summaries
- language, font, orientation, margins, repeated headers, and striped rows
- company/brand visibility
- watermark, header, footer, banner, and signature assets
- notes and terms templates by document type
- email and WhatsApp message templates
- thermal receipt content

Financial snapshots remain immutable when display settings later change.

### 10.5 Products and inventory

- Expose existing variants, price lists, supplier mappings, batches, serials, reservations, cycle counts, valuation, and reorder endpoints.
- Add product groups and combo definitions after the existing foundation is fully usable.
- Add validated CSV/XLSX import jobs with preview, error rows, idempotency, and rollback.
- Add bulk export and bulk edit.
- Add archive and restore; do not hard-delete referenced master data.
- Add low stock, expiry, dead stock, and serial-status filters.

### 10.6 Customers, suppliers, and projects

- Expose contacts, addresses, communications, documents, ledger, outstanding, and activity.
- Add groups, tags, configurable custom fields, import, export, and archive/restore.
- Add project records with customer, status, dates, budget, owner, tags, and attachments.
- Allow invoices, quotations, sales orders, purchases, expenses, payments, and files to link to a project.
- Calculate project revenue, cost, outstanding, and profit from posted records.

### 10.7 Payments and accounting

- Build one canonical payment timeline from payments, allocations, refunds, and attempts.
- Add payment links with provider, amount policy, expiry, status, customer, and document allocation.
- Move journals, accounts, banks, expenses, and reconciliation to `/api/v1`.
- Add bank-statement import with preview and duplicate detection.
- Add reconciliation suggestions without automatically posting changes.
- Add indirect income as a posted accounting document.
- Preserve existing Razorpay verification and `integration_not_configured` behaviour.

### 10.8 Reminders and notifications

- Replace production `localStorage` notification samples with the tenant `notifications` table and realtime events.
- Add reminder rules for due invoices, quotations, outstanding balances, low stock, expiry, daily summary, weekly summary, monthly summary, and GST deadlines.
- Support in-app and email first.
- Add SMS and WhatsApp only after provider configuration.
- Record channel, template, recipient, attempt, provider response, error, and delivery status.
- Respect customer consent and organization quiet hours.

### 10.9 GST and compliance

- E-invoice:
  - credential configuration
  - IRN generation
  - signed QR and acknowledgement storage
  - cancellation window enforcement
  - status and error history
- E-way bill:
  - generation from eligible invoices/challans
  - transporter, vehicle, distance, document, validity, and cancellation
  - pending/success/failed/cancelled status tabs
- Returns:
  - GSTR-1
  - GSTR-2B import and mismatch reconciliation
  - GSTR-3B preparation
  - GSTR-7
  - IMS workflow
  - HSN B2B/B2C summaries
  - TDS/TCS receivable and payable reports
- Filing must always require authorized confirmation.
- Provider errors must never mark a return as filed.

### 10.10 Online store

- Publish selected products, prices, stock policy, images, terms, and contact details.
- Provide tenant-safe public catalogue URLs.
- Allow catalogue-only mode before direct ordering.
- Direct orders enter a reviewable sales-order queue.
- Online orders do not reserve or consume stock until the configured acceptance transition.
- Online payment requires verified provider capture.

### 10.11 Integrations

Create a shared integration framework with:

- encrypted tenant credentials
- provider status and health checks
- enable/disable controls
- webhook subscriptions
- idempotency
- rate-limit handling
- sync checkpoints
- retryable jobs
- sanitized request/response audit logs

Delivery order:

1. Razorpay hardening and payment links
2. email delivery
3. WhatsApp
4. Tally export/sync
5. public API keys and webhooks
6. Shopify
7. Shiprocket

### 10.12 Inventia AI

- Add file attachments using the existing storage adapter.
- Add browser voice-to-text where supported; keep text as the canonical submitted prompt.
- Add tenant custom instructions for chat, document extraction, notes/terms, and product descriptions.
- Add grounded tools for new documents, projects, compliance, payment links, and reminders.
- All write requests remain proposals requiring explicit approval and revalidation.
- Show provider, fallback state, evidence, tool audit, proposal preview, and final execution result.

---

## 11. Public API plan

### Settings

- `GET /api/v1/settings/:namespace`
- `PUT /api/v1/settings/:namespace`
- Namespaces: `organization`, `documents`, `pos`, `inventory`, `notifications`, `communications`, `ai`
- Existing payment-method and barcode settings remain compatible.

### Trade and documents

- Extend `GET/POST /api/v1/trade/:documentType`
- Extend `GET /api/v1/trade/:documentType/:id`
- Extend `POST /api/v1/trade/:documentType/:id/transition`
- `POST /api/v1/trade/:documentType/:id/convert`
- `GET /api/v1/documents/:id/links`
- `GET /api/v1/documents/:id/timeline`
- Add `pro-forma-invoices` to the document-type map.

### Fiscal adjustments

- `GET/POST /api/v1/credit-notes`
- `GET /api/v1/credit-notes/:id`
- `POST /api/v1/credit-notes/:id/issue`
- `GET/POST /api/v1/debit-notes`
- `GET /api/v1/debit-notes/:id`
- `POST /api/v1/debit-notes/:id/issue`

### Subscriptions

- `GET/POST /api/v1/subscriptions`
- `GET/PUT /api/v1/subscriptions/:id`
- `POST /api/v1/subscriptions/:id/activate`
- `POST /api/v1/subscriptions/:id/pause`
- `POST /api/v1/subscriptions/:id/resume`
- `POST /api/v1/subscriptions/:id/cancel`
- `GET /api/v1/subscriptions/:id/runs`

### Finance

- `/api/v1/accounts`
- `/api/v1/journals`
- `/api/v1/banks`
- `/api/v1/bank-transactions`
- `/api/v1/reconciliation`
- `/api/v1/expenses`
- `/api/v1/indirect-income`
- `/api/v1/payment-links`
- Existing invoice-payment and Razorpay routes remain canonical.

### Projects

- `GET/POST /api/v1/projects`
- `GET/PUT /api/v1/projects/:id`
- `GET /api/v1/projects/:id/activity`
- `GET /api/v1/projects/:id/profitability`
- `POST/DELETE /api/v1/projects/:id/documents`

### Compliance

- `/api/v1/compliance/e-invoices`
- `/api/v1/compliance/e-way-bills`
- `/api/v1/compliance/gstr-1`
- `/api/v1/compliance/gstr-2b`
- `/api/v1/compliance/gstr-3b`
- `/api/v1/compliance/gstr-7`
- `/api/v1/compliance/ims`
- `/api/v1/compliance/tds-tcs`

### Store and integrations

- `/api/v1/store/settings`
- `/api/v1/store/catalog`
- `/api/v1/store/orders`
- `/api/v1/integrations`
- `/api/v1/integrations/:provider`
- `/api/v1/integrations/:provider/test`
- `/api/v1/integrations/:provider/sync`
- `/api/v1/webhook-subscriptions`
- `/api/v1/webhook-deliveries`

All mutating routes require an `Idempotency-Key`.

---

## 12. Data and migration plan

Use additive, tenant-scoped migrations. Never rewrite an applied Phase 5 migration.

### Proposed migration sequence

1. `phase6-settings-documents-001`
   - settings namespaces
   - document series
   - notes/terms templates
   - message templates
   - document links
2. `phase6-fiscal-adjustments-002`
   - fiscal adjustments and lines
   - invoice adjustment links
3. `phase6-subscriptions-reminders-003`
   - subscriptions, occurrences, reminder rules, delivery attempts
4. `phase6-projects-party-groups-004`
   - projects, project links, party groups, custom fields
5. `phase6-accounting-links-005`
   - payment links, bank imports, reconciliation matches
6. `phase6-compliance-006`
   - e-invoice, e-way bill, GST return periods, reconciliation rows
7. `phase6-store-integrations-007`
   - catalogue publication, online orders, webhook subscriptions, sync checkpoints

Every migration must:

- support PostgreSQL and SQLite
- include indexes and constraints
- preserve existing IDs and totals
- include a dry-run verification
- record its migration version
- be covered by tenant-isolation tests

---

## 13. RBAC additions

Add permissions without trusting browser role headers:

- `documents.settings.manage`
- `trade.convert`
- `trade.credit_notes.*`
- `trade.debit_notes.*`
- `subscriptions.read`
- `subscriptions.manage`
- `projects.*`
- `payments.links.*`
- `accounting.journals.*`
- `accounting.reconcile`
- `compliance.read`
- `compliance.prepare`
- `compliance.file`
- `integrations.read`
- `integrations.manage`
- `notifications.manage`
- `store.read`
- `store.manage`

Filing, refund, void, write-off, payment confirmation, integration-secret changes, and fiscal-note issuance require manager/admin permissions.

---

## 14. Events and jobs

### Domain events

- `document.created`
- `document.transitioned`
- `document.converted`
- `fiscal_adjustment.issued`
- `subscription.invoice_generated`
- `payment_link.updated`
- `reminder.delivered`
- `compliance.status_changed`
- `project.profitability_changed`
- `store.order_received`
- `integration.sync_completed`

Every event includes organization ID, actor, entity, action, timestamp, and request ID.

### Jobs

- `subscription.invoice.generate`
- `reminder.dispatch`
- `document.pdf.generate`
- `compliance.einvoice.generate`
- `compliance.ewaybill.generate`
- `compliance.reconcile`
- `payment_link.refresh`
- `bank_statement.import`
- `integration.tally.sync`
- `integration.webhook.deliver`
- `store.catalog.publish`

Jobs require deterministic IDs or idempotency keys and must be safe to retry.

---

## 15. Exact current-file edit plan

### `public/index.html`

- Reorganize sidebar labels and groups using existing classes.
- Add `data-module`, `data-view`, and `data-permission`.
- Add stable workspace mount points for new modules.
- Keep current dashboard, POS, invoices, barcode centre, modals, and design classes.
- Remove or hide fake premium/referral/store actions until backed by real behaviour.

### `public/app.js`

- Retain bootstrap and compatibility globals.
- Add the view-aware router.
- Replace settings placeholder toasts with real module routes.
- Replace local notification samples with tenant API data.
- Move new feature logic into `public/js`.
- Migrate existing functions incrementally; do not perform a one-shot rewrite.

### `public/style.css`

- Do not change tokens, theme palettes, button styles, card styles, radii, shadows, or existing interaction states.
- Add only scoped structural styles required for new workspaces.
- Every new rule must have light/dark and responsive verification.

### `src/routes/v1Routes.js`

- Keep current endpoints.
- Mount domain subrouters.
- Add pro forma mapping and conversion routes.
- Do not add new production functionality to legacy `/api` routes.

### `src/services/enterpriseTradeService.js`

- Preserve current behaviour.
- Extract numbering, conversion, transition, tax, party validation, and timeline helpers behind stable interfaces.
- Add document links rather than duplicating conversion logic.

### `src/services/invoicePaymentService.js`

- Keep canonical invoice/payment-state authority.
- Add fiscal-adjustment and payment-link integration points.
- Do not allow document settings to mutate financial snapshots.

### `src/platform/phase5Database.js`

- Register additive Phase 6 migrations.
- Do not edit previously applied migration definitions except for compatible bug fixes with dedicated migration markers.

### `src/platform/openapi.js`

- Document every new route, error code, permission requirement, idempotency rule, and integration-not-configured response.

### `src/workers/phase5Worker.js`

- Register the new job handlers while retaining current PDF and barcode job behaviour.

### `test/`

- Add dedicated settings, document-conversion, subscriptions, accounting, compliance, projects, store, and integration suites.

---

## 16. Implementation sequence

### Milestone 0 - Safety and modular foundation

- Add frontend API, router, permission, realtime, state, and error modules.
- Add versioned settings service and namespace API.
- Add feature flags.
- Add browser E2E harness.
- Preserve current appearance and behaviour.

Exit criteria:

- Existing tests pass.
- Current localhost workflows are unchanged.
- New module loader works in light/dark and desktop/mobile.

### Milestone 1 - Sidebar and existing backend exposure

- Implement the target sidebar.
- Add view-aware routing.
- Complete UI for trade documents, approvals, GRNs, variants, price lists, batches, serials, cycle counts, party details, and attachments.
- Replace settings placeholder cards for already-supported capabilities.

Exit criteria:

- No sidebar entry opens an unrelated generic page.
- Permission-hidden entries cannot be reached by URL.
- Existing backend capability has a usable UI.

### Milestone 2 - Document engine completion

- Pro forma invoices
- conversions and document links
- document settings and numbering
- notes/terms, templates, signatures, PDF controls
- credit and debit notes

Exit criteria:

- End-to-end sales and purchase document chains are auditable.
- Conversion never duplicates stock, invoices, or accounting entries.

### Milestone 3 - Payments, accounting, reminders, and projects

- canonical payment timeline
- payment links
- `/api/v1` journals, banking, expenses, and reconciliation
- reminders and tenant notifications
- projects and profitability

Exit criteria:

- Balances reconcile across invoice, payment, refund, customer ledger, journals, and bank views.

### Milestone 4 - Subscriptions and compliance

- recurring invoices
- e-invoice
- e-way bill
- GSTR-1, GSTR-2B, GSTR-3B, GSTR-7, IMS, and TDS/TCS

Exit criteria:

- Missing credentials never produce success.
- Retry and duplicate events remain safe.
- Filing always requires authorized confirmation.

### Milestone 5 - Online store and integrations

- catalogue publishing
- online order intake
- WhatsApp
- Tally
- tenant API keys and webhooks
- later Shopify and Shiprocket adapters

Exit criteria:

- External events are authenticated, deduplicated, tenant-scoped, auditable, and retryable.

### Milestone 6 - Reporting, AI, and release hardening

- unified report centre
- new AI tools and custom instructions
- import/export coverage
- accessibility and keyboard verification
- performance, dependency, and security review

---

## 17. Test and acceptance plan

### Unit tests

- document transitions and conversions
- numbering and duplicate allocation
- GST and adjustment calculations
- subscription schedules
- reminder eligibility
- permission rules
- reconciliation matching
- project profitability
- provider payload sanitization

### Integration tests

- cross-tenant denial
- idempotency replay and conflicts
- concurrent document numbering
- stock reservation, fulfilment, release, and return
- invoice, credit note, ledger, payment, and refund consistency
- failed PDF/provider/job retries
- duplicate webhook events
- migration dry runs and rollback verification

### Browser tests

- every sidebar destination
- quick-create and Ctrl+K navigation
- list filters and action menus
- document creation and conversion
- POS checkout and invoice result
- payment collection and reconciliation
- settings persistence
- loading, empty, permission, error, and integration-not-configured states
- desktop, tablet, and mobile
- light and dark modes
- keyboard and focus navigation

### Visual acceptance

- No new hard-coded brand colours.
- No change to current primary button, secondary button, card, table, badge, radius, or theme appearance.
- No horizontal page overflow.
- Existing navigation, POS, invoice, barcode, AI, and settings screens remain visually consistent.

### Operational acceptance

- `npm run check`
- `npm test`
- OpenAPI validation
- `npm audit --audit-level=high`
- migration dry run
- localhost smoke test
- Docker PostgreSQL/Redis smoke test
- no simulated production success
- no cross-tenant data access

---

## 18. Rollout strategy

- Deliver each milestone behind organization feature flags.
- Add migrations before enabling UI routes.
- Enable for the default organization in a staging/local environment first.
- Back up tenant databases before compliance and accounting migrations.
- Compare record counts, stock totals, invoice totals, customer balances, and journal balances.
- Keep compatibility aliases for old sidebar tabs and `/api` reads during migration.
- Do not dual-write financial or stock mutations.
- Roll back by disabling the feature flag and restoring the prior route/view; database rollback uses the documented backup process.

---

## 19. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Monolithic frontend regression | Incremental ES modules and compatibility wrappers |
| Duplicate invoice/document concepts | Keep fiscal invoices canonical and link trade documents |
| Settings fragmentation | One tenant-scoped namespace service and settings registry |
| Sidebar overload | Collapsible permission-aware groups and view routing |
| Integration inconsistency | Shared encrypted integration framework and audit logs |
| GST provider failure | Explicit pending/failed states, retries, and no simulated success |
| Accounting drift | Immutable entries and reconciliation invariants |
| Stock drift | Movement ledger only; transactional reservations and returns |
| Tenant leakage | Session-derived tenant database and cross-tenant tests |
| Styling regression | Locked tokens/classes plus visual regression checks |

---

## 20. Definition of done

A feature is complete only when:

1. Its data model and migrations support PostgreSQL and SQLite.
2. Its API is validated, tenant-scoped, permission-controlled, idempotent, audited, and documented.
3. Its UI uses the current Inventia design system without introducing new visual primitives.
4. Loading, empty, permission, provider-unavailable, validation, and server-error states are implemented.
5. Realtime/cache/job behaviour is connected where applicable.
6. Unit, integration, browser, and regression tests pass.
7. No existing workflow, theme, responsive layout, or business total is changed unexpectedly.

---

## 21. Final product decision

Inventia should adopt Swipe's useful product completeness and workflow discoverability while retaining Inventia's stronger tenant, approval, inventory-ledger, invoice-payment, AI-governance, and barcode foundations.

The correct implementation order is:

1. expose what already exists,
2. remove navigation and settings placeholders,
3. complete the shared document experience,
4. add fiscal and accounting capabilities,
5. add GST compliance,
6. add store and integrations,
7. harden reporting, AI, and operations.

This order delivers feature depth without destabilizing the current UI or duplicating core business engines.
