const WORKSPACES = Object.freeze({
  'finance:payment-links': {
    title: 'Payment Links', description: 'Create secure, expiring payment requests bounded by invoice outstanding balances.',
    panel: 'Payment requests', icon: 'fa-link', action: 'New payment link'
  },
  'reminders:overview': {
    title: 'Reminders', description: 'Schedule audited tenant notifications without simulated external delivery.',
    panel: 'Reminder schedule', icon: 'fa-bell', action: 'New reminder'
  },
  'projects:overview': {
    title: 'Projects', description: 'Track customer work, budgets, linked documents, costs, revenue, and profitability.',
    panel: 'Project portfolio', icon: 'fa-diagram-project', action: 'New project'
  }
});

let activeLoader = null;

export function installMilestone3({ router, api }) {
  router.register({ module: 'finance', view: 'payment-links', legacyTab: 'milestone3-workspace', permission: 'finance.read', featureFlag: 'finance_v2', load: () => openWorkspace('finance:payment-links', api) });
  router.register({ module: 'reminders', view: 'overview', legacyTab: 'milestone3-workspace', permission: 'reminders.read', featureFlag: 'reminders_v2', load: () => openWorkspace('reminders:overview', api) });
  router.register({ module: 'projects', view: 'overview', legacyTab: 'milestone3-workspace', permission: 'projects.read', featureFlag: 'projects_v2', load: () => openWorkspace('projects:overview', api) });
  document.getElementById('m3Refresh')?.addEventListener('click', () => activeLoader?.());
  document.getElementById('m3WorkspaceTable')?.addEventListener('click', event => handleTableAction(event, api));
}

async function openWorkspace(key, api) {
  const config = WORKSPACES[key];
  setup(config);
  if (key === 'finance:payment-links') return loadPaymentLinks(api);
  if (key === 'reminders:overview') return loadReminders(api);
  return loadProjects(api);
}

function setup(config) {
  const workspace = document.getElementById('milestone3-workspace');
  const breadcrumb = workspace?.querySelector('.page-breadcrumb');
  const current = breadcrumb?.querySelector('strong');
  if (current) current.textContent = config.title;
  breadcrumb?.setAttribute('aria-label', `${config.title} breadcrumb`);
  setText('m3WorkspaceTitle', config.title);
  setText('m3WorkspaceDescription', config.description);
  setText('m3PanelTitle', config.panel);
  document.getElementById('m3WorkspaceIcon').innerHTML = `<i class="fa-solid ${config.icon}"></i>`;
  document.getElementById('m3WorkspaceKpis').hidden = true;
  const form = document.getElementById('m3WorkspaceForm');
  form.hidden = true;
  form.innerHTML = '';
  const actions = document.getElementById('m3WorkspaceActions');
  actions.innerHTML = `<button class="action-btn primary" id="m3PrimaryAction" type="button"><i class="fa-solid fa-plus"></i> ${escapeHtml(config.action)}</button>`;
}

async function loadPaymentLinks(api) {
  activeLoader = () => loadPaymentLinks(api);
  setLoading();
  try {
    const result = await api.get('/payment-links');
    const rows = result.payment_links || [];
    renderKpis([
      ['Active', rows.filter(row => row.status === 'ACTIVE').length],
      ['Paid', rows.filter(row => row.status === 'PAID').length],
      ['Expired', rows.filter(row => row.status === 'EXPIRED').length]
    ]);
    renderTable(['Invoice', 'Customer', 'Amount', 'Expires', 'Status', 'Action'], rows.map(row => [
      row.invoice_number || `#${row.invoice_id}`, row.customer_name || 'Walk-in', money(row.amount), date(row.expires_at), badge(row.status),
      row.status === 'ACTIVE' ? `<button class="action-btn secondary compact" data-m3-action="cancel-link" data-id="${row.id}">Cancel</button>` : '—'
    ]));
    document.getElementById('m3PrimaryAction').onclick = () => showPaymentLinkForm(api);
  } catch (error) { setError(error); }
}

async function showPaymentLinkForm(api) {
  try {
    const result = await api.get('/invoices?limit=500');
    const invoices = (result.invoices || []).filter(invoice => !['PAID', 'VOID', 'WRITTEN_OFF'].includes(invoice.payment_status));
    showForm(`
      <form id="m3CreateForm" class="workspace-settings-form">
        <div class="workspace-form-grid">
          <div class="form-group"><label>Invoice</label><select name="invoice_id" required><option value="">Select invoice</option>${invoices.map(invoice => `<option value="${invoice.id}">${escapeHtml(invoice.invoice_number)} — ${money(invoice.grand_total)}</option>`).join('')}</select></div>
          <div class="form-group"><label>Amount (optional)</label><input name="amount" type="number" min="0.01" step="0.01"></div>
          <div class="form-group"><label>Expires at</label><input name="expires_at" type="datetime-local" required></div>
        </div>
        <div class="panel-actions"><button class="action-btn secondary" type="button" data-m3-form-close>Cancel</button><button class="action-btn primary" type="submit">Create secure link</button></div>
      </form>`);
    bindFormClose();
    document.getElementById('m3CreateForm').onsubmit = async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target));
      const body = { invoice_id: Number(data.invoice_id), expires_at: new Date(data.expires_at).toISOString() };
      if (data.amount) body.amount = Number(data.amount);
      try {
        const created = await api.post('/payment-links', body);
        await navigator.clipboard?.writeText(created.url).catch(() => {});
        globalThis.showToast?.('Payment link created and copied. The secret URL is shown only once.', 'success');
        closeForm();
        await loadPaymentLinks(api);
      } catch (error) { globalThis.showToast?.(error.message, 'error'); }
    };
  } catch (error) { globalThis.showToast?.(error.message, 'error'); }
}

async function loadReminders(api) {
  activeLoader = () => loadReminders(api);
  setLoading();
  try {
    const result = await api.get('/reminders');
    const rows = result.reminders || [];
    renderKpis([
      ['Scheduled', rows.filter(row => row.status === 'SCHEDULED').length],
      ['Sent', rows.filter(row => row.status === 'SENT').length],
      ['Failed', rows.filter(row => row.status === 'FAILED').length]
    ]);
    renderTable(['Type', 'Entity', 'Channel', 'Scheduled', 'Status', 'Action'], rows.map(row => [
      humanize(row.reminder_type), `${humanize(row.entity_type)} #${escapeHtml(row.entity_id)}`, humanize(row.channel),
      date(row.scheduled_at), badge(row.status), row.status === 'SCHEDULED' ? `<button class="action-btn secondary compact" data-m3-action="cancel-reminder" data-id="${row.id}">Cancel</button>` : '—'
    ]));
    document.getElementById('m3PrimaryAction').onclick = () => showReminderForm(api);
  } catch (error) { setError(error); }
}

function showReminderForm(api) {
  showForm(`
    <form id="m3CreateForm" class="workspace-settings-form">
      <div class="workspace-form-grid">
        <div class="form-group"><label>Reminder type</label><input name="reminder_type" value="payment_due" required></div>
        <div class="form-group"><label>Entity</label><select name="entity_type"><option value="invoice">Invoice</option><option value="customer">Customer</option><option value="supplier">Supplier</option><option value="project">Project</option><option value="trade_document">Trade document</option></select></div>
        <div class="form-group"><label>Entity ID</label><input name="entity_id" required></div>
        <div class="form-group"><label>Recipient</label><select name="recipient_type"><option value="organization">Organization</option><option value="user">User</option><option value="customer">Customer</option><option value="supplier">Supplier</option></select></div>
        <div class="form-group"><label>Channel</label><select name="channel"><option value="IN_APP">In app</option><option value="EMAIL">Email</option><option value="SMS">SMS</option><option value="WHATSAPP">WhatsApp</option></select></div>
        <div class="form-group"><label>Scheduled at</label><input name="scheduled_at" type="datetime-local" required></div>
        <div class="form-group"><label>Subject</label><input name="subject" maxlength="300"></div>
        <div class="form-group"><label>Message</label><textarea name="message" rows="3" required></textarea></div>
      </div>
      <div class="panel-actions"><button class="action-btn secondary" type="button" data-m3-form-close>Cancel</button><button class="action-btn primary" type="submit">Schedule reminder</button></div>
    </form>`);
  bindFormClose();
  document.getElementById('m3CreateForm').onsubmit = async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    data.scheduled_at = new Date(data.scheduled_at).toISOString();
    try {
      const reminder = await api.post('/reminders', data);
      const type = reminder.status === 'FAILED' ? 'error' : 'success';
      globalThis.showToast?.(reminder.status === 'FAILED' ? reminder.last_error : 'Reminder scheduled.', type);
      closeForm();
      await loadReminders(api);
    } catch (error) { globalThis.showToast?.(error.message, 'error'); }
  };
}

async function loadProjects(api) {
  activeLoader = () => loadProjects(api);
  setLoading();
  try {
    const result = await api.get('/projects');
    const rows = result.projects || [];
    renderKpis([
      ['Active', rows.filter(row => row.status === 'ACTIVE').length],
      ['Revenue', money(rows.reduce((sum, row) => sum + Number(row.revenue || 0), 0))],
      ['Profit', money(rows.reduce((sum, row) => sum + Number(row.profit || 0), 0))]
    ]);
    renderTable(['Project', 'Customer', 'Status', 'Revenue', 'Cost', 'Profit'], rows.map(row => [
      `<button class="action-btn secondary compact" data-m3-action="project-detail" data-id="${row.id}">${escapeHtml(row.project_no)} · ${escapeHtml(row.name)}</button>`,
      row.customer_name || '—', badge(row.status), money(row.revenue), money(row.cost), money(row.profit)
    ]));
    document.getElementById('m3PrimaryAction').onclick = () => showProjectForm(api);
  } catch (error) { setError(error); }
}

async function showProjectForm(api) {
  try {
    const result = await api.get('/customers?limit=500');
    const customers = result.customers || [];
    showForm(`
      <form id="m3CreateForm" class="workspace-settings-form">
        <div class="workspace-form-grid">
          <div class="form-group"><label>Name</label><input name="name" required></div>
          <div class="form-group"><label>Customer</label><select name="customer_id"><option value="">No customer</option>${customers.map(customer => `<option value="${customer.id}">${escapeHtml(customer.name)}</option>`).join('')}</select></div>
          <div class="form-group"><label>Status</label><select name="status"><option>PLANNED</option><option>ACTIVE</option><option>ON_HOLD</option></select></div>
          <div class="form-group"><label>Start date</label><input name="start_date" type="date"></div>
          <div class="form-group"><label>End date</label><input name="end_date" type="date"></div>
          <div class="form-group"><label>Budget revenue</label><input name="budget_revenue" type="number" min="0" step="0.01" value="0"></div>
          <div class="form-group"><label>Budget cost</label><input name="budget_cost" type="number" min="0" step="0.01" value="0"></div>
          <div class="form-group"><label>Description</label><textarea name="description" rows="3"></textarea></div>
        </div>
        <div class="panel-actions"><button class="action-btn secondary" type="button" data-m3-form-close>Cancel</button><button class="action-btn primary" type="submit">Create project</button></div>
      </form>`);
    bindFormClose();
    document.getElementById('m3CreateForm').onsubmit = async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target));
      ['budget_revenue', 'budget_cost'].forEach(key => { data[key] = Number(data[key] || 0); });
      if (data.customer_id) data.customer_id = Number(data.customer_id); else delete data.customer_id;
      if (!data.start_date) delete data.start_date;
      if (!data.end_date) delete data.end_date;
      try {
        await api.post('/projects', data);
        globalThis.showToast?.('Project created.', 'success');
        closeForm();
        await loadProjects(api);
      } catch (error) { globalThis.showToast?.(error.message, 'error'); }
    };
  } catch (error) { globalThis.showToast?.(error.message, 'error'); }
}

async function handleTableAction(event, api) {
  const button = event.target.closest('[data-m3-action]');
  if (!button) return;
  try {
    if (button.dataset.m3Action === 'cancel-link') await api.post(`/payment-links/${button.dataset.id}/cancel`, {});
    if (button.dataset.m3Action === 'cancel-reminder') await api.post(`/reminders/${button.dataset.id}/cancel`, {});
    if (button.dataset.m3Action === 'project-detail') {
      const [project, profitability] = await Promise.all([api.get(`/projects/${button.dataset.id}`), api.get(`/projects/${button.dataset.id}/profitability`)]);
      showForm(`<div class="workspace-detail-grid"><div><span>Project</span><strong>${escapeHtml(project.project_no)} · ${escapeHtml(project.name)}</strong></div><div><span>Status</span>${badge(project.status)}</div><div><span>Revenue</span><strong>${money(profitability.revenue)}</strong></div><div><span>Cost</span><strong>${money(profitability.cost)}</strong></div><div><span>Profit</span><strong>${money(profitability.profit)}</strong></div><div><span>Margin</span><strong>${profitability.margin_percent}%</strong></div></div><button class="action-btn secondary" type="button" data-m3-form-close>Close</button>`);
      bindFormClose();
      return;
    }
    globalThis.showToast?.('Record updated.', 'success');
    await activeLoader?.();
  } catch (error) { globalThis.showToast?.(error.message, 'error'); }
}

function showForm(html) { const target = document.getElementById('m3WorkspaceForm'); target.innerHTML = html; target.hidden = false; }
function closeForm() { const target = document.getElementById('m3WorkspaceForm'); target.hidden = true; target.innerHTML = ''; }
function bindFormClose() { document.querySelectorAll('[data-m3-form-close]').forEach(button => { button.onclick = closeForm; }); }
function setLoading() { setState('Loading…'); document.getElementById('m3WorkspaceTable').innerHTML = ''; }
function setError(error) { setState(error?.message || 'The workspace could not be loaded.'); }
function setState(message) { const target = document.getElementById('m3WorkspaceState'); target.hidden = !message; target.textContent = message || ''; }
function renderTable(headers, rows) { setState(rows.length ? '' : 'No records yet.'); document.getElementById('m3WorkspaceTable').innerHTML = rows.length ? `<table><thead><tr>${headers.map(value => `<th>${escapeHtml(value)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(value => `<td>${value ?? '—'}</td>`).join('')}</tr>`).join('')}</tbody></table>` : ''; }
function renderKpis(items) { const target = document.getElementById('m3WorkspaceKpis'); target.hidden = false; target.innerHTML = items.map(([label, value]) => `<div class="kpi-card"><div><span>${escapeHtml(label)}</span><h3>${escapeHtml(value)}</h3></div></div>`).join(''); }
function badge(value) { return `<span class="status-badge ${escapeHtml(String(value || '').toLowerCase())}">${escapeHtml(humanize(value))}</span>`; }
function money(value) { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(value || 0)); }
function date(value) { return value ? new Date(value).toLocaleString('en-IN') : '—'; }
function humanize(value) { return String(value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()); }
function setText(id, value) { const target = document.getElementById(id); if (target) target.textContent = value; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }
