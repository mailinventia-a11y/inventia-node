const VIEWS = {
  'store:overview': ['Online Store', 'Publish a tenant-safe catalogue and control whether direct orders are accepted.', 'Store settings', 'fa-store'],
  'store:catalog': ['Online Catalogue', 'Select products, authoritative prices, and stock visibility for the public catalogue.', 'Catalogue products', 'fa-box-open'],
  'store:orders': ['Online Orders', 'Review direct catalogue orders before they enter operational workflows.', 'Review queue', 'fa-cart-shopping'],
  'integrations:overview': ['Integrations', 'Configure encrypted provider credentials and inspect real provider health.', 'Provider registry', 'fa-plug'],
  'integrations:api-keys': ['Developer API Keys', 'Issue scoped tenant keys; secrets are visible only once.', 'API keys', 'fa-key'],
  'integrations:webhooks': ['Webhooks', 'Sign, deliver, retry, and audit tenant event notifications.', 'Webhook subscriptions', 'fa-code-branch']
};

let activeLoader;

export function installMilestone5({ router, api }) {
  for (const view of ['overview', 'catalog', 'orders']) {
    router.register({ module: 'store', view, legacyTab: 'milestone5-workspace', permission: 'store.read', featureFlag: 'online_store_v2', load: () => openWorkspace('store', view, api) });
  }
  for (const view of ['overview', 'api-keys', 'webhooks']) {
    router.register({ module: 'integrations', view, legacyTab: 'milestone5-workspace', permission: 'integrations.read', featureFlag: 'integrations_v2', load: () => openWorkspace('integrations', view, api) });
  }
  document.getElementById('m5Refresh')?.addEventListener('click', () => activeLoader?.());
  document.getElementById('m5WorkspaceTable')?.addEventListener('click', event => handleAction(event, api));
}

async function openWorkspace(module, view, api) {
  const config = VIEWS[`${module}:${view}`];
  const [, , panel, icon] = config;
  setText('m5WorkspaceTitle', config[0]); setText('m5WorkspaceDescription', config[1]); setText('m5PanelTitle', panel);
  document.getElementById('m5WorkspaceIcon').innerHTML = `<i class="fa-solid ${icon}"></i>`;
  document.getElementById('m5WorkspaceForm').hidden = true;
  document.getElementById('m5WorkspaceForm').innerHTML = '';
  document.getElementById('m5WorkspaceKpis').hidden = true;
  renderNavigation(module, view);
  if (module === 'store' && view === 'overview') return loadStoreSettings(api);
  if (module === 'store' && view === 'catalog') return loadCatalog(api);
  if (module === 'store') return loadOrders(api);
  if (view === 'api-keys') return loadApiKeys(api);
  if (view === 'webhooks') return loadWebhooks(api);
  return loadIntegrations(api);
}

function renderNavigation(module, view) {
  const items = module === 'store'
    ? [['overview', 'Settings'], ['catalog', 'Catalogue'], ['orders', 'Orders']]
    : [['overview', 'Providers'], ['api-keys', 'API Keys'], ['webhooks', 'Webhooks']];
  document.getElementById('m5WorkspaceActions').innerHTML = items.map(([target, label]) =>
    `<button class="action-btn ${target === view ? 'primary' : 'secondary'} compact" type="button" data-m5-route="${module}:${target}">${label}</button>`).join('');
  document.querySelectorAll('[data-m5-route]').forEach(button => {
    button.onclick = () => { const [routeModule, routeView] = button.dataset.m5Route.split(':'); window.InventiaCore.router.navigate(routeModule, routeView); };
  });
}

async function loadStoreSettings(api) {
  activeLoader = () => loadStoreSettings(api); setLoading();
  try {
    const settings = await api.get('/store/settings');
    renderKpis([['Status', humanize(settings.status)], ['Mode', humanize(settings.mode)], ['Stock policy', humanize(settings.stock_policy)]]);
    const publicUrl = `${location.origin}/api/v1/public/store/${encodeURIComponent(localStorage.getItem('activeOrganizationSlug') || 'northwind-interiors')}/catalog`;
    renderTable(['Store slug', 'Public catalogue', 'Terms', 'Action'], [[settings.store_slug, `<a href="${publicUrl}" target="_blank" rel="noopener">Open catalogue API</a>`, settings.terms || '—', '<button class="action-btn primary compact" data-m5-action="edit-store">Edit settings</button>']]);
    document.getElementById('m5WorkspaceTable').dataset.settings = JSON.stringify(settings);
  } catch (error) { setError(error); }
}

async function showStoreForm(api) {
  const settings = JSON.parse(document.getElementById('m5WorkspaceTable').dataset.settings || '{}');
  showForm(`<form id="m5CreateForm" class="workspace-settings-form"><div class="workspace-form-grid">
    ${input('store_slug', 'Store slug', settings.store_slug, true)}
    ${select('status', 'Status', ['DRAFT', 'PUBLISHED', 'PAUSED'], settings.status)}
    ${select('mode', 'Mode', ['CATALOG_ONLY', 'DIRECT_ORDER'], settings.mode)}
    ${select('stock_policy', 'Stock policy', ['HIDE_QUANTITY', 'SHOW_AVAILABLE', 'IN_STOCK_ONLY'], settings.stock_policy)}
    ${input('phone', 'Contact phone', settings.contact_details?.phone || '')}
    <div class="form-group full"><label>Terms</label><textarea name="terms" rows="4">${escapeHtml(settings.terms || '')}</textarea></div>
    </div><div class="panel-actions"><button class="action-btn secondary" type="button" data-m5-close>Cancel</button><button class="action-btn primary" type="submit">Save settings</button></div></form>`);
  bindClose();
  document.getElementById('m5CreateForm').onsubmit = async event => {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.target));
    if (!await mutate(() => api.put('/store/settings', { store_slug: data.store_slug, status: data.status, mode: data.mode, stock_policy: data.stock_policy, contact_details: { phone: data.phone }, terms: data.terms }), 'Store settings saved.')) return;
    closeForm(); await loadStoreSettings(api);
  };
}

async function loadCatalog(api) {
  activeLoader = () => loadCatalog(api); setLoading();
  try {
    const result = await api.get('/store/catalog'); const rows = result.products || [];
    renderKpis([['Products', rows.length], ['Published', rows.filter(row => row.published).length], ['In stock', rows.filter(row => Number(row.available_stock) > 0).length]]);
    renderTable(['Product', 'Price', 'Available', 'Published', 'Action'], rows.map(row => [
      `${escapeHtml(row.sku)} · ${escapeHtml(row.name)}`, moneyMinor(row.price_minor == null ? Math.round(Number(row.selling_price) * 100) : row.price_minor), row.available_stock,
      badge(row.published ? 'PUBLISHED' : 'DRAFT'), `<button class="action-btn ${row.published ? 'secondary' : 'primary'} compact" data-m5-action="toggle-product" data-id="${row.product_id}" data-published="${row.published}" data-price="${row.price_minor == null ? Number(row.selling_price) : Number(row.price_minor) / 100}">${row.published ? 'Unpublish' : 'Publish'}</button>`
    ]));
  } catch (error) { setError(error); }
}

async function loadOrders(api) {
  activeLoader = () => loadOrders(api); setLoading();
  try {
    const result = await api.get('/store/orders'); const rows = result.orders || [];
    renderKpis([['Pending review', rows.filter(row => row.status === 'PENDING_REVIEW').length], ['Accepted', rows.filter(row => row.status === 'ACCEPTED').length], ['Rejected', rows.filter(row => row.status === 'REJECTED').length]]);
    renderTable(['Order', 'Customer', 'Total', 'Created', 'Status', 'Actions'], rows.map(row => [
      row.order_number, row.customer_snapshot?.name || '—', moneyMinor(row.grand_total_minor), date(row.created_at), badge(row.status), row.status === 'PENDING_REVIEW' ? `${action('accept-order', row.id, 'Accept', true)} ${action('reject-order', row.id, 'Reject')}` : '—'
    ]));
  } catch (error) { setError(error); }
}

async function loadIntegrations(api) {
  activeLoader = () => loadIntegrations(api); setLoading();
  try {
    const result = await api.get('/integrations'); const rows = result.integrations || [];
    renderKpis([['Providers', rows.length], ['Configured', rows.filter(row => row.configured).length], ['Ready', rows.filter(row => row.status === 'READY').length]]);
    renderTable(['Provider', 'Category', 'Configured', 'Health', 'Actions'], rows.map(row => [
      row.display_name, humanize(row.category), row.configured ? 'Yes' : 'No', badge(row.status),
      ['shopify', 'shiprocket'].includes(row.provider) ? '<span class="status-badge">Coming later</span>' : `${action('configure-provider', row.provider, 'Configure', true)} ${row.configured ? action('test-provider', row.provider, 'Test') : ''}`
    ]));
  } catch (error) { setError(error); }
}

function showIntegrationForm(provider, api) {
  showForm(`<form id="m5CreateForm" class="workspace-settings-form"><div class="workspace-form-grid">
    ${input('base_url', 'Provider URL', '', true, 'url')}${input('api_key', 'API key / token', '', true, 'password')}
    </div><p>Secrets are encrypted in the tenant database and are never returned by the API.</p><div class="panel-actions"><button class="action-btn secondary" type="button" data-m5-close>Cancel</button><button class="action-btn primary" type="submit">Save configuration</button></div></form>`);
  bindClose();
  document.getElementById('m5CreateForm').onsubmit = async event => {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.target));
    if (!await mutate(() => api.put(`/integrations/${provider}`, { enabled: true, config: { base_url: data.base_url, api_key: data.api_key } }), 'Integration configuration encrypted and saved.')) return;
    closeForm(); await loadIntegrations(api);
  };
}

async function loadApiKeys(api) {
  activeLoader = () => loadApiKeys(api); setLoading();
  try {
    const result = await api.get('/integrations/api-keys'); const rows = result.api_keys || [];
    renderKpis([['Active', rows.filter(row => row.status === 'ACTIVE').length], ['Revoked', rows.filter(row => row.status === 'REVOKED').length], ['Total', rows.length]]);
    renderTable(['Name', 'Prefix', 'Scopes', 'Created', 'Status', 'Action'], rows.map(row => [row.name, row.key_prefix, row.scopes.join(', '), date(row.created_at), badge(row.status), row.status === 'ACTIVE' ? action('revoke-key', row.id, 'Revoke') : '—']));
    appendPrimaryAction('Create API key', () => showApiKeyForm(api));
  } catch (error) { setError(error); }
}

function showApiKeyForm(api) {
  showForm(`<form id="m5CreateForm" class="workspace-settings-form"><div class="workspace-form-grid">${input('name', 'Key name', '', true)}${select('scope', 'Scope', ['catalog.read', 'orders.read', 'orders.write', 'webhooks.read'], 'orders.read')}</div><div class="panel-actions"><button class="action-btn secondary" type="button" data-m5-close>Cancel</button><button class="action-btn primary" type="submit">Create key</button></div></form>`);
  bindClose(); document.getElementById('m5CreateForm').onsubmit = async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); let created; if (!await mutate(async () => { created = await api.post('/integrations/api-keys', { name: data.name, scopes: [data.scope] }); }, 'API key created.')) return; document.getElementById('m5CreateForm').innerHTML = `<p><strong>Copy this secret now:</strong></p><code>${escapeHtml(created.secret)}</code><div class="panel-actions"><button class="action-btn primary" type="button" data-m5-close>Done</button></div>`; bindClose(); };
}

async function loadWebhooks(api) {
  activeLoader = () => loadWebhooks(api); setLoading();
  try {
    const [subscriptions, deliveries] = await Promise.all([api.get('/webhook-subscriptions'), api.get('/webhook-deliveries')]); const rows = subscriptions.subscriptions || []; const attempts = deliveries.deliveries || [];
    renderKpis([['Active subscriptions', rows.filter(row => row.status === 'ACTIVE').length], ['Delivered', attempts.filter(row => row.status === 'DELIVERED').length], ['Failed', attempts.filter(row => row.status === 'FAILED').length]]);
    renderTable(['Name', 'Endpoint', 'Events', 'Status'], rows.map(row => [row.name, row.endpoint_url, row.events.join(', '), badge(row.status)]));
    appendPrimaryAction('Add webhook', () => showWebhookForm(api));
  } catch (error) { setError(error); }
}

function showWebhookForm(api) {
  showForm(`<form id="m5CreateForm" class="workspace-settings-form"><div class="workspace-form-grid">${input('name', 'Name', '', true)}${input('endpoint_url', 'HTTPS endpoint', '', true, 'url')}${input('event', 'Event', 'store.order_received', true)}</div><div class="panel-actions"><button class="action-btn secondary" type="button" data-m5-close>Cancel</button><button class="action-btn primary" type="submit">Create webhook</button></div></form>`);
  bindClose(); document.getElementById('m5CreateForm').onsubmit = async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); let created; if (!await mutate(async () => { created = await api.post('/webhook-subscriptions', { name: data.name, endpoint_url: data.endpoint_url, events: [data.event] }); }, 'Webhook created.')) return; document.getElementById('m5CreateForm').innerHTML = `<p><strong>Copy the signing secret now:</strong></p><code>${escapeHtml(created.secret)}</code><div class="panel-actions"><button class="action-btn primary" type="button" data-m5-close>Done</button></div>`; bindClose(); };
}

async function handleAction(event, api) {
  const button = event.target.closest('[data-m5-action]'); if (!button) return;
  const id = button.dataset.id; const name = button.dataset.m5Action;
  if (name === 'edit-store') return showStoreForm(api);
  if (name === 'toggle-product') { if (await mutate(() => api.put(`/store/catalog/${id}`, { published: button.dataset.published !== 'true', price: Number(button.dataset.price), show_stock: true, sort_order: 0, metadata: {} }), 'Catalogue publication updated.')) await loadCatalog(api); }
  if (name === 'accept-order' && await mutate(() => api.post(`/store/orders/${id}/accept`, {}), 'Online order accepted.')) await loadOrders(api);
  if (name === 'reject-order' && await mutate(() => api.post(`/store/orders/${id}/reject`, { reason: 'Rejected during review' }), 'Online order rejected.')) await loadOrders(api);
  if (name === 'configure-provider') showIntegrationForm(id, api);
  if (name === 'test-provider' && await mutate(() => api.post(`/integrations/${id}/test`, {}), 'Provider health confirmed.')) await loadIntegrations(api);
  if (name === 'revoke-key' && await mutate(() => api.delete(`/integrations/api-keys/${id}`), 'API key revoked.')) await loadApiKeys(api);
}

function appendPrimaryAction(label, callback) { const target = document.getElementById('m5WorkspaceActions'); const button = document.createElement('button'); button.className = 'action-btn primary compact'; button.type = 'button'; button.textContent = label; button.onclick = callback; target.append(button); }
function action(name, id, label, primary = false) { return `<button class="action-btn ${primary ? 'primary' : 'secondary'} compact" data-m5-action="${name}" data-id="${id}">${label}</button>`; }
function badge(status) { return `<span class="status-badge ${String(status).toLowerCase().replaceAll('_', '-')}">${escapeHtml(humanize(status))}</span>`; }
function input(name, label, value = '', required = false, type = 'text') { return `<div class="form-group"><label>${label}</label><input name="${name}" type="${type}" value="${escapeHtml(value)}" ${required ? 'required' : ''}></div>`; }
function select(name, label, values, selected) { return `<div class="form-group"><label>${label}</label><select name="${name}">${values.map(value => `<option value="${value}" ${value === selected ? 'selected' : ''}>${escapeHtml(humanize(value))}</option>`).join('')}</select></div>`; }
function renderTable(headers, rows) { setState(rows.length ? '' : 'No records yet.'); document.getElementById('m5WorkspaceTable').innerHTML = rows.length ? `<table><thead><tr>${headers.map(value => `<th>${escapeHtml(value)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(value => `<td>${value ?? '—'}</td>`).join('')}</tr>`).join('')}</tbody></table>` : ''; }
function renderKpis(items) { const target = document.getElementById('m5WorkspaceKpis'); target.hidden = false; target.innerHTML = items.map(([label, value]) => `<div class="kpi-card"><div><span>${escapeHtml(label)}</span><h3>${escapeHtml(value)}</h3></div></div>`).join(''); }
function showForm(html) { const target = document.getElementById('m5WorkspaceForm'); target.innerHTML = html; target.hidden = false; }
function closeForm() { const target = document.getElementById('m5WorkspaceForm'); target.hidden = true; target.innerHTML = ''; }
function bindClose() { document.querySelectorAll('[data-m5-close]').forEach(button => { button.onclick = closeForm; }); }
function setLoading() { setState('Loading…'); document.getElementById('m5WorkspaceTable').innerHTML = ''; }
function setError(error) { setState(error.message || 'Unable to load this workspace.'); toast(error.message, 'error'); }
function setState(message) { const target = document.getElementById('m5WorkspaceState'); target.hidden = !message; target.textContent = message || ''; }
function setText(id, value) { const target = document.getElementById(id); if (target) target.textContent = value; }
function date(value) { return value ? new Date(value).toLocaleDateString() : '—'; }
async function mutate(operation, success) { try { await operation(); toast(success, 'success'); return true; } catch (error) { toast(error.message, 'error'); return false; } }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character])); }
function humanize(value) { return String(value || '').replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase()); }
function moneyMinor(value) { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(value || 0) / 100); }
function toast(message, type) { globalThis.showToast?.(message, type); }
