const RETURN_VIEWS = new Set(['gstr-1', 'gstr-2b', 'gstr-3b', 'gstr-7', 'ims']);
const VIEW_CONFIG = Object.freeze({
  subscriptions: ['Subscriptions', 'Create retry-safe recurring invoice schedules with controlled lifecycle states.', 'Subscription schedules', 'fa-arrows-rotate'],
  'e-invoices': ['E-Invoices', 'Prepare GST e-invoice payloads and generate IRNs only through a configured provider.', 'E-invoice operations', 'fa-file-circle-check'],
  'e-way-bills': ['E-Way Bills', 'Prepare transport documents with provider-confirmed generation and cancellation.', 'E-way bill operations', 'fa-truck-fast'],
  'gstr-1': ['GSTR-1', 'Prepare outward-supply data from immutable invoice snapshots.', 'Return periods', 'fa-table-list'],
  'gstr-2b': ['GSTR-2B', 'Import portal rows and review book mismatches before IMS decisions.', 'Reconciliation periods', 'fa-code-compare'],
  'gstr-3b': ['GSTR-3B', 'Prepare tax liability summaries for authorized review and filing.', 'Return periods', 'fa-calculator'],
  'gstr-7': ['GSTR-7', 'Prepare TDS return periods with explicit approval before filing.', 'Return periods', 'fa-building-columns'],
  ims: ['IMS', 'Review invoice matching and controlled accept, reject, or pending decisions.', 'IMS periods', 'fa-list-check'],
  'tds-tcs': ['TDS/TCS', 'Review deduction and collection exposure from posted tenant records.', 'TDS/TCS summary', 'fa-percent']
});

let activeView = '';
let activeLoader = null;

export function installMilestone4({ router, api }) {
  router.register({ module: 'subscriptions', view: 'overview', legacyTab: 'milestone4-workspace', permission: 'subscriptions.read', featureFlag: 'subscriptions_v2', load: () => openWorkspace('subscriptions', api) });
  for (const view of ['e-invoices', 'e-way-bills', 'gstr-1', 'gstr-2b', 'gstr-3b', 'gstr-7', 'ims', 'tds-tcs']) {
    router.register({ module: 'compliance', view, legacyTab: 'milestone4-workspace', permission: 'compliance.read', featureFlag: 'compliance_v2', load: () => openWorkspace(view, api) });
  }
  document.getElementById('m4Refresh')?.addEventListener('click', () => activeLoader?.());
  document.getElementById('m4WorkspaceTable')?.addEventListener('click', event => handleAction(event, api));
}

async function openWorkspace(view, api) {
  activeView = view;
  setup(view);
  if (view === 'subscriptions') return loadSubscriptions(api);
  if (view === 'e-invoices' || view === 'e-way-bills') return loadComplianceDocuments(view, api);
  if (RETURN_VIEWS.has(view)) return loadReturns(view, api);
  return loadTdsTcs(api);
}

function setup(view) {
  const [title, description, panel, icon] = VIEW_CONFIG[view];
  const workspace = document.getElementById('milestone4-workspace');
  const breadcrumb = workspace?.querySelector('.page-breadcrumb');
  const current = breadcrumb?.querySelector('strong');
  if (current) current.textContent = title;
  breadcrumb?.setAttribute('aria-label', `${title} breadcrumb`);
  setText('m4WorkspaceTitle', title); setText('m4WorkspaceDescription', description); setText('m4PanelTitle', panel);
  document.getElementById('m4WorkspaceIcon').innerHTML = `<i class="fa-solid ${icon}"></i>`;
  document.getElementById('m4WorkspaceKpis').hidden = true;
  closeForm();
  const label = view === 'subscriptions' ? 'New subscription' : view === 'e-invoices' ? 'Prepare e-invoice' : view === 'e-way-bills' ? 'Prepare e-way bill' : RETURN_VIEWS.has(view) ? (view === 'gstr-2b' ? 'Import GSTR-2B' : 'Prepare period') : '';
  document.getElementById('m4WorkspaceActions').innerHTML = label ? `<button class="action-btn primary" id="m4PrimaryAction" type="button"><i class="fa-solid fa-plus"></i> ${escapeHtml(label)}</button>` : '';
}

async function loadSubscriptions(api) {
  activeLoader = () => loadSubscriptions(api); setLoading();
  try {
    const result = await api.get('/subscriptions'); const rows = result.subscriptions || [];
    renderKpis([['Active', count(rows, 'ACTIVE')], ['Paused', count(rows, 'PAUSED')], ['Failed runs', rows.reduce((sum, row) => sum + Number(row.failed_runs || 0), 0)]]);
    renderTable(['Subscription', 'Customer', 'Frequency', 'Next run', 'Status', 'Actions'], rows.map(row => [
      `${escapeHtml(row.subscription_no)} · ${escapeHtml(row.name)}`, row.customer_name, humanize(row.frequency), date(row.next_run_at), badge(row.status), subscriptionActions(row)
    ]));
    document.getElementById('m4PrimaryAction').onclick = () => showSubscriptionForm(api);
  } catch (error) { setError(error); }
}

async function showSubscriptionForm(api) {
  try {
    const [customers, warehouses, products] = await Promise.all([api.get('/customers?limit=500'), api.get('/reference/warehouses'), api.get('/products?limit=500')]);
    showForm(`<form id="m4CreateForm" class="workspace-settings-form"><div class="workspace-form-grid">
      ${select('customer_id', 'Customer', customers.customers || [])}${select('warehouse_id', 'Warehouse', warehouses.items || [])}${select('product_id', 'Product', products.products || [])}
      <div class="form-group"><label>Name</label><input name="name" required></div>
      <div class="form-group"><label>Frequency</label><select name="frequency"><option>MONTHLY</option><option>WEEKLY</option><option>QUARTERLY</option><option>YEARLY</option><option>DAILY</option></select></div>
      <div class="form-group"><label>Start date</label><input name="start_date" type="date" required></div>
      <div class="form-group"><label>End date</label><input name="end_date" type="date"></div>
      <div class="form-group"><label>Quantity</label><input name="quantity" type="number" min="0.001" step="0.001" value="1" required></div>
      <div class="form-group"><label>Unit price (optional)</label><input name="unit_price" type="number" min="0" step="0.01"></div>
      <div class="form-group"><label>Due days</label><input name="due_days" type="number" min="0" value="7"></div>
      <div class="form-group"><label>Price policy</label><select name="price_policy"><option value="SNAPSHOT">Snapshot price</option><option value="CURRENT_APPROVED">Current approved price</option></select></div>
    </div><div class="panel-actions"><button class="action-btn secondary" type="button" data-m4-close>Cancel</button><button class="action-btn primary" type="submit">Save draft</button></div></form>`);
    bindClose();
    document.getElementById('m4CreateForm').onsubmit = async event => {
      event.preventDefault(); const data = Object.fromEntries(new FormData(event.target));
      const item = { product_id: Number(data.product_id), quantity: Number(data.quantity) }; if (data.unit_price) item.unit_price = Number(data.unit_price);
      const body = { name: data.name, customer_id: Number(data.customer_id), warehouse_id: Number(data.warehouse_id), frequency: data.frequency, interval_count: 1, start_date: data.start_date, due_days: Number(data.due_days || 0), price_policy: data.price_policy, items: [item], delivery_channels: ['IN_APP'] };
      if (data.end_date) body.end_date = data.end_date;
      if (!await mutate(() => api.post('/subscriptions', body), 'Subscription draft created.')) return; closeForm(); await loadSubscriptions(api);
    };
  } catch (error) { toast(error.message, 'error'); }
}

async function loadComplianceDocuments(view, api) {
  activeLoader = () => loadComplianceDocuments(view, api); setLoading();
  try {
    const result = await api.get(`/compliance/${view}`); const rows = result.documents || [];
    renderKpis([['Prepared', count(rows, 'PREPARED')], ['Generated', count(rows, 'GENERATED')], ['Failed', count(rows, 'FAILED')]]);
    renderTable(['Document', 'Source', 'Provider reference', 'Created', 'Status', 'Action'], rows.map(row => [
      row.document_number, row.invoice_number || row.trade_document_number || '—', row.provider_reference || '—', date(row.created_at), badge(row.status), row.status === 'PREPARED' || row.status === 'FAILED' ? `<button class="action-btn primary compact" data-m4-action="generate-compliance" data-id="${row.id}">Generate</button>` : '—'
    ]));
    document.getElementById('m4PrimaryAction').onclick = () => showComplianceForm(view, api);
  } catch (error) { setError(error); }
}

async function showComplianceForm(view, api) {
  try {
    const invoices = await api.get('/invoices?limit=500');
    showForm(`<form id="m4CreateForm" class="workspace-settings-form"><div class="workspace-form-grid">
      <div class="form-group"><label>Invoice</label><select name="invoice_id" required><option value="">Select invoice</option>${(invoices.invoices || []).map(row => `<option value="${row.id}">${escapeHtml(row.invoice_number)} · ${money(row.grand_total)}</option>`).join('')}</select></div>
      ${view === 'e-way-bills' ? '<div class="form-group"><label>Vehicle number</label><input name="vehicle_number" maxlength="30"></div><div class="form-group"><label>Distance (km)</label><input name="distance_km" type="number" min="1" max="4000" required></div>' : ''}
    </div><p>Preparation stores a local immutable snapshot. Generation requires configured GST provider credentials.</p><div class="panel-actions"><button class="action-btn secondary" type="button" data-m4-close>Cancel</button><button class="action-btn primary" type="submit">Prepare</button></div></form>`);
    bindClose();
    document.getElementById('m4CreateForm').onsubmit = async event => {
      event.preventDefault(); const data = Object.fromEntries(new FormData(event.target));
      const body = { invoice_id: Number(data.invoice_id) }; if (view === 'e-way-bills') body.transport = { vehicle_number: data.vehicle_number || undefined, distance_km: Number(data.distance_km) };
      if (!await mutate(() => api.post(`/compliance/${view}`, body), 'Compliance document prepared.')) return; closeForm(); await loadComplianceDocuments(view, api);
    };
  } catch (error) { toast(error.message, 'error'); }
}

async function loadReturns(view, api) {
  activeLoader = () => loadReturns(view, api); setLoading();
  try {
    const result = await api.get(`/compliance/returns/${view}`); const rows = result.returns || [];
    renderKpis([['Prepared', count(rows, 'PREPARED')], ['Awaiting approval', count(rows, 'PENDING_APPROVAL')], ['Filed', count(rows, 'FILED')]]);
    renderTable(['Period', 'Invoices', 'Taxable', 'Tax', 'Status', 'Actions'], rows.map(row => [
      row.period, row.summary.invoice_count ?? row.summary.imported_rows ?? 0, moneyMinor(row.summary.taxable_minor), moneyMinor(Number(row.summary.cgst_minor || 0) + Number(row.summary.sgst_minor || 0) + Number(row.summary.igst_minor || 0)), badge(row.status), returnActions(row)
    ]));
    document.getElementById('m4PrimaryAction').onclick = () => showReturnForm(view, api);
  } catch (error) { setError(error); }
}

function showReturnForm(view, api) {
  const isImport = view === 'gstr-2b';
  showForm(`<form id="m4CreateForm" class="workspace-settings-form"><div class="workspace-form-grid"><div class="form-group"><label>Period</label><input name="period" type="month" required></div>${isImport ? '<div class="form-group"><label>Supplier GSTIN</label><input name="gstin" maxlength="30"></div><div class="form-group"><label>Document number</label><input name="document_number" required></div><div class="form-group"><label>Taxable amount</label><input name="taxable" type="number" min="0" step="0.01" required></div><div class="form-group"><label>Tax amount</label><input name="tax" type="number" min="0" step="0.01" required></div>' : ''}</div><div class="panel-actions"><button class="action-btn secondary" type="button" data-m4-close>Cancel</button><button class="action-btn primary" type="submit">${isImport ? 'Import row' : 'Prepare return'}</button></div></form>`);
  bindClose();
  document.getElementById('m4CreateForm').onsubmit = async event => {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.target));
    const action = isImport ? () => api.post('/compliance/returns/gstr-2b/import', { period: data.period, rows: [{ gstin: data.gstin || undefined, document_number: data.document_number, taxable: Number(data.taxable), tax: Number(data.tax) }] }) : () => api.post(`/compliance/returns/${view}/prepare`, { period: data.period });
    if (!await mutate(action, isImport ? 'GSTR-2B row imported.' : 'GST return prepared.')) return; closeForm(); await loadReturns(view, api);
  };
}

async function loadTdsTcs(api) {
  activeLoader = () => loadTdsTcs(api); setLoading();
  try {
    const report = await api.get('/compliance/tds-tcs');
    renderKpis([['Invoices', report.invoice_count], ['Taxable', moneyMinor(report.taxable_minor)], ['GST', moneyMinor(report.gst_minor)]]);
    renderTable(['TDS receivable', 'TDS payable', 'TCS receivable', 'TCS payable', 'Status'], [[moneyMinor(report.tds_receivable_minor), moneyMinor(report.tds_payable_minor), moneyMinor(report.tcs_receivable_minor), moneyMinor(report.tcs_payable_minor), report.warning]]);
  } catch (error) { setError(error); }
}

async function handleAction(event, api) {
  const button = event.target.closest('[data-m4-action]'); if (!button) return;
  const id = button.dataset.id; const action = button.dataset.m4Action;
  try {
    if (action === 'subscription-activate') await api.post(`/subscriptions/${id}/activate`, {});
    if (action === 'subscription-pause') await api.post(`/subscriptions/${id}/pause`, {});
    if (action === 'subscription-resume') await api.post(`/subscriptions/${id}/resume`, {});
    if (action === 'subscription-cancel') await api.post(`/subscriptions/${id}/cancel`, {});
    if (action === 'generate-compliance') await api.post(`/compliance/documents/${id}/generate`, {});
    if (action === 'return-request') await api.post(`/compliance/return-periods/${id}/request-approval`, {});
    if (action === 'return-approve') await api.post(`/compliance/return-periods/${id}/approve`, {});
    if (action === 'return-file') await api.post(`/compliance/return-periods/${id}/file`, {});
    toast('Record updated.', 'success'); await activeLoader?.();
  } catch (error) { toast(error.message, 'error'); await activeLoader?.(); }
}

function subscriptionActions(row) { if (row.status === 'DRAFT') return action('subscription-activate', row.id, 'Activate', true); if (row.status === 'ACTIVE') return `${action('subscription-pause', row.id, 'Pause')}${action('subscription-cancel', row.id, 'Cancel')}`; if (row.status === 'PAUSED') return `${action('subscription-resume', row.id, 'Resume', true)}${action('subscription-cancel', row.id, 'Cancel')}`; return '—'; }
function returnActions(row) { if (row.status === 'PREPARED') return action('return-request', row.id, 'Request approval', true); if (row.status === 'PENDING_APPROVAL') return action('return-approve', row.id, 'Approve', true); if (row.status === 'APPROVED') return action('return-file', row.id, 'File', true); return '—'; }
function action(name, id, label, primary = false) { return `<button class="action-btn ${primary ? 'primary' : 'secondary'} compact" data-m4-action="${name}" data-id="${id}">${label}</button>`; }
async function mutate(operation, success) { try { await operation(); toast(success, 'success'); return true; } catch (error) { toast(error.message, 'error'); return false; } }
function showForm(html) { const target = document.getElementById('m4WorkspaceForm'); target.innerHTML = html; target.hidden = false; }
function closeForm() { const target = document.getElementById('m4WorkspaceForm'); if (target) { target.hidden = true; target.innerHTML = ''; } }
function bindClose() { document.querySelectorAll('[data-m4-close]').forEach(button => { button.onclick = closeForm; }); }
function setLoading() { setState('Loading…'); document.getElementById('m4WorkspaceTable').innerHTML = ''; }
function setError(error) { setState(error?.message || 'The workspace could not be loaded.'); }
function setState(message) { const target = document.getElementById('m4WorkspaceState'); target.hidden = !message; target.textContent = message || ''; }
function renderTable(headers, rows) { setState(rows.length ? '' : 'No records yet.'); document.getElementById('m4WorkspaceTable').innerHTML = rows.length ? `<table><thead><tr>${headers.map(value => `<th>${escapeHtml(value)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(value => `<td>${value ?? '—'}</td>`).join('')}</tr>`).join('')}</tbody></table>` : ''; }
function renderKpis(items) { const target = document.getElementById('m4WorkspaceKpis'); target.hidden = false; target.innerHTML = items.map(([label, value]) => `<div class="kpi-card"><div><span>${escapeHtml(label)}</span><h3>${escapeHtml(value)}</h3></div></div>`).join(''); }
function select(name, label, rows) { return `<div class="form-group"><label>${label}</label><select name="${name}" required><option value="">Select</option>${rows.map(row => `<option value="${row.id}">${escapeHtml(row.name || row.sku)}</option>`).join('')}</select></div>`; }
function count(rows, status) { return rows.filter(row => row.status === status).length; }
function badge(value) { return `<span class="status-badge ${escapeHtml(String(value || '').toLowerCase())}">${escapeHtml(humanize(value))}</span>`; }
function money(value) { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(value || 0)); }
function moneyMinor(value) { return money(Number(value || 0) / 100); }
function date(value) { return value ? new Date(value).toLocaleString('en-IN') : '—'; }
function humanize(value) { return String(value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()); }
function setText(id, value) { const target = document.getElementById(id); if (target) target.textContent = value; }
function toast(message, type) { globalThis.showToast?.(message, type); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }
