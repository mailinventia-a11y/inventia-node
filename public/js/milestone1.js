const TRADE_VIEWS = Object.freeze({
  quotations: { title: 'Quotations', singular: 'Quotation', party: 'customer', icon: 'fa-file-signature' },
  'sales-orders': { title: 'Sales Orders', singular: 'Sales order', party: 'customer', icon: 'fa-boxes-packing', fulfill: true },
  'purchase-orders': { title: 'Purchase Orders', singular: 'Purchase order', party: 'supplier', icon: 'fa-file-circle-check', receive: true },
  deliveries: { title: 'Delivery Challans', singular: 'Delivery challan', party: 'customer', icon: 'fa-truck' },
  'packing-lists': { title: 'Packing Lists', singular: 'Packing list', party: 'customer', icon: 'fa-box-open' },
  'sales-returns': { title: 'Sales Returns', singular: 'Sales return', party: 'customer', icon: 'fa-arrow-rotate-left', return: true },
  'purchase-returns': { title: 'Purchase Returns', singular: 'Purchase return', party: 'supplier', icon: 'fa-arrow-right-arrow-left', return: true }
});

const INVENTORY_VIEWS = Object.freeze({
  variants: ['Variants', 'Product variants with independent SKU, barcode, and pricing.'],
  'price-lists': ['Price Lists', 'Tenant price policies and quantity breaks.'],
  'supplier-mappings': ['Supplier Mappings', 'Supplier codes, lead times, cost, and preferred sources.'],
  balances: ['Inventory Balances', 'Current on-hand, reserved, and available stock by warehouse.'],
  movements: ['Stock Timeline', 'Immutable receipts, sales, returns, transfers, and adjustments.'],
  adjustments: ['Adjustments & Damage', 'Post audited stock corrections without direct quantity edits.'],
  batches: ['Batches & Expiry', 'Batch quantities and expiry visibility.'],
  serials: ['Serial Numbers', 'Track uniquely identified inventory.'],
  reservations: ['Reservations', 'Active and released stock commitments.'],
  'cycle-counts': ['Cycle Counts', 'Count physical stock and post controlled variances.'],
  'reorder-rules': ['Reorder Rules', 'Minimums, reorder points, quantities, and lead times.'],
  valuation: ['Inventory Valuation', 'Warehouse valuation state and costing method.']
});

const SETTINGS_NAMESPACES = ['organization', 'documents', 'pos', 'inventory', 'notifications', 'communications', 'ai'];
const SETTING_OPTIONS = Object.freeze({
  discount_type: ['UNIT_PRICE', 'PRICE_WITH_TAX', 'NET_AMOUNT', 'TOTAL_AMOUNT'], orientation: ['portrait', 'landscape'],
  default_item_type: ['PRODUCT', 'SERVICE'], expiry_date_format: ['DD-MM-YYYY', 'MM-YYYY', 'MM-YY'],
  sender_name_source: ['BRAND_NAME', 'COMPANY_NAME', 'CUSTOM']
});
const STATUS_OPTIONS = ['draft', 'pending_approval', 'approved', 'partially_fulfilled', 'fulfilled', 'completed', 'cancelled'];

export function installMilestone1({ router, api, store }) {
  router.permissions = () => readPermissions();
  registerLegacyRoutes(router);
  Object.keys(TRADE_VIEWS).forEach(view => router.register({
    module: 'trade', view, legacyTab: 'milestone1-workspace', permission: 'trade.read',
    featureFlag: 'trade_workspaces', load: () => openTradeWorkspace(view, api)
  }));
  router.register({ module: 'trade', view: 'grns', legacyTab: 'milestone1-workspace', permission: 'trade.read', featureFlag: 'trade_workspaces', load: () => openGrns(api) });
  router.register({ module: 'trade', view: 'approvals', legacyTab: 'milestone1-workspace', permission: 'approvals.read', featureFlag: 'trade_workspaces', load: () => openApprovals(api) });
  Object.keys(INVENTORY_VIEWS).forEach(view => router.register({
    module: 'inventory', view, legacyTab: 'milestone1-workspace', permission: inventoryPermission(view),
    load: () => openInventoryWorkspace(view, api)
  }));
  SETTINGS_NAMESPACES.forEach(view => router.register({
    module: 'settings', view, legacyTab: 'milestone1-workspace', permission: 'settings.manage',
    load: () => openSettingsWorkspace(view, api)
  }));
  bindWorkspaceShell(api);
  window.InventiaMilestone1 = Object.freeze({ openTradeWorkspace, openInventoryWorkspace, openProductDetail, openPartyDetail, openSettingsWorkspace, store });
}

function registerLegacyRoutes(router) {
  [
    ['workspace', 'home', 'dashboard', 'dashboard.read'],
    ['sales', 'invoices', 'invoices', 'trade.sales.read'],
    ['sales', 'pos', 'pos', 'trade.sales.create'],
    ['inventory', 'products', 'inventory', 'products.read'],
    ['inventory', 'categories-brands', 'brands-categories', 'products.read'],
    ['inventory', 'transfers', 'transfers', 'inventory.transfer'],
    ['parties', 'customers', 'customers', 'parties.customers.read'],
    ['parties', 'suppliers', 'suppliers', 'parties.suppliers.read'],
    ['finance', 'overview', 'finance', 'finance.read'],
    ['insights', 'analytics', 'reports', 'reports.read'],
    ['ai', 'copilot', 'automation', 'ai.read']
  ].forEach(([module, view, legacyTab, permission]) => router.register({ module, view, legacyTab, permission }));
}

function bindWorkspaceShell(api) {
  document.getElementById('m1Refresh')?.addEventListener('click', () => currentLoader?.());
  document.getElementById('m1Search')?.addEventListener('input', applyClientFilters);
  document.getElementById('m1StatusFilter')?.addEventListener('change', applyClientFilters);
  document.getElementById('m1DetailClose')?.addEventListener('click', closeDetail);
  document.addEventListener('click', event => {
    const row = event.target.closest('[data-m1-detail]');
    const action = event.target.closest('[data-m1-action]');
    if (row && !action) openConfiguredDetail(row.dataset.m1Detail, row.dataset.id, api);
    if (action) runConfiguredAction(action, api);
  });
}

let currentRows = [];
let currentColumns = [];
let currentLoader = null;
let currentDetail = null;

async function openTradeWorkspace(view, api) {
  const config = TRADE_VIEWS[view];
  setupWorkspace({ title: config.title, description: `Create and progress ${config.title.toLowerCase()} through audited workflow states.`, icon: config.icon, panel: config.title });
  setPrimaryAction(hasPermission('trade.create') ? `New ${config.singular}` : '', () => openTradeCreate(config, view, api));
  setStatusOptions(STATUS_OPTIONS);
  currentLoader = async () => {
    setLoading();
    try {
      const result = await api.get(`/trade/${view}`);
      currentRows = result.documents || [];
      currentColumns = [
        ['document_no', 'Document'], ['party_name', config.party === 'customer' ? 'Customer' : 'Supplier'],
        ['grand_total', 'Total', money], ['status', 'Status', statusBadge], ['created_at', 'Created', date],
        ['actions', 'Actions', (_value, row) => tradeActions(row, config)]
      ];
      renderRows(currentRows, currentColumns, row => `${row.document_no} ${row.party_name || ''} ${row.status}`);
    } catch (error) { setError(error); }
  };
  await currentLoader();
}

async function openGrns(api) {
  setupWorkspace({ title: 'Goods Receipt Notes', description: 'Receipts posted from approved purchase orders and linked stock movements.', icon: 'fa-clipboard-check', panel: 'GRNs' });
  setPrimaryAction('', null);
  setStatusOptions([]);
  currentLoader = async () => {
    setLoading();
    try {
      const result = await api.get('/grns');
      currentRows = result.goods_receipts || [];
      currentColumns = [['receipt_no', 'GRN'], ['purchase_order_no', 'Purchase Order'], ['supplier_name', 'Supplier'], ['warehouse_name', 'Warehouse'], ['status', 'Status', statusBadge], ['received_at', 'Received', date]];
      renderRows(currentRows, currentColumns, row => JSON.stringify(row), row => ({ type: 'grn', id: row.id }));
    } catch (error) { setError(error); }
  };
  await currentLoader();
}

async function openApprovals(api) {
  setupWorkspace({ title: 'Approvals', description: 'Manager decisions for tenant-scoped business documents.', icon: 'fa-user-check', panel: 'Approval queue' });
  setPrimaryAction('', null);
  setStatusOptions(['pending', 'approved', 'rejected']);
  currentLoader = async () => {
    setLoading();
    try {
      const result = await api.get('/approvals');
      currentRows = result.approvals || [];
      currentColumns = [['entity_type', 'Type', humanize], ['entity_id', 'Record'], ['status', 'Status', statusBadge], ['reason', 'Reason'], ['created_at', 'Requested', date], ['actions', 'Actions', approvalActions]];
      renderRows(currentRows, currentColumns, row => JSON.stringify(row));
    } catch (error) { setError(error); }
  };
  await currentLoader();
}

async function openInventoryWorkspace(view, api) {
  const [title, description] = INVENTORY_VIEWS[view];
  setupWorkspace({ title, description, icon: 'fa-boxes-stacked', panel: title });
  setStatusOptions([]);
  const primary = inventoryPrimaryAction(view, api);
  setPrimaryAction(primary?.label || '', primary?.handler);
  currentLoader = async () => {
    setLoading();
    try {
      const dataset = await loadInventoryDataset(view, api);
      currentRows = dataset.rows;
      currentColumns = dataset.columns;
      renderRows(currentRows, currentColumns, row => JSON.stringify(row), dataset.detail);
      if (dataset.kpis) renderKpis(dataset.kpis);
    } catch (error) { setError(error); }
  };
  await currentLoader();
}

async function loadInventoryDataset(view, api) {
  if (['variants', 'supplier-mappings'].includes(view)) {
    const result = await api.get('/products?limit=500');
    const products = result.products || [];
    const details = await Promise.all(products.map(product => api.get(`/products/${product.id}`)));
    if (view === 'variants') return {
      rows: details.flatMap(product => (product.variants || []).map(item => ({ ...item, product_name: product.name }))),
      columns: [['product_name', 'Product'], ['sku', 'Variant SKU'], ['name', 'Variant'], ['barcode', 'Barcode'], ['selling_price', 'Price', money], ['status', 'Status', statusBadge]]
    };
    return {
      rows: details.flatMap(product => (product.suppliers || []).map(item => ({ ...item, product_name: product.name }))),
      columns: [['product_name', 'Product'], ['supplier_name', 'Supplier'], ['supplier_sku', 'Supplier SKU'], ['last_cost', 'Last Cost', money], ['lead_time_days', 'Lead Time', value => `${value || 0} days`], ['preferred', 'Preferred', yesNo]]
    };
  }
  const endpoints = {
    'price-lists': ['/price-lists', 'price_lists'], balances: ['/inventory/balances', 'balances'], movements: ['/inventory/movements', 'movements'],
    batches: ['/inventory/batches', 'batches'], serials: ['/inventory/serials', 'serials'], reservations: ['/inventory/reservations', 'reservations'],
    'cycle-counts': ['/inventory/cycle-counts', 'cycle_counts'], 'reorder-rules': ['/inventory/reorder-rules', 'rules'], valuation: ['/inventory/valuation', 'valuation']
  };
  if (view === 'adjustments') return { rows: [], columns: [], kpis: [['Safe corrections', 'Use the action above'], ['Stock authority', 'Movement ledger']] };
  const [path, key] = endpoints[view];
  const result = await api.get(path);
  const rows = result[key] || [];
  const columns = inventoryColumns(view);
  const detail = view === 'cycle-counts' ? row => ({ type: 'cycle-count', id: row.id }) : null;
  return { rows, columns, detail };
}

function inventoryColumns(view) {
  const map = {
    'price-lists': [['name', 'Name'], ['currency', 'Currency'], ['valid_from', 'Valid From', date], ['valid_to', 'Valid To', date], ['status', 'Status', statusBadge], ['items', 'Items', items => items?.length || 0]],
    balances: [['sku', 'SKU'], ['product_name', 'Product'], ['warehouse_name', 'Warehouse'], ['on_hand', 'On Hand', number], ['reserved', 'Reserved', number], ['available', 'Available', number]],
    movements: [['movement_no', 'Movement'], ['movement_type', 'Type', humanize], ['product_name', 'Product'], ['warehouse_name', 'Warehouse'], ['quantity', 'Quantity', number], ['unit_cost', 'Unit Cost', money], ['occurred_at', 'Occurred', date]],
    batches: [['batch_no', 'Batch'], ['product_id', 'Product ID'], ['warehouse_id', 'Warehouse ID'], ['quantity', 'Quantity', number], ['expires_at', 'Expiry', date], ['status', 'Status', statusBadge]],
    serials: [['serial_no', 'Serial'], ['product_id', 'Product ID'], ['warehouse_id', 'Warehouse ID'], ['batch_id', 'Batch ID'], ['status', 'Status', statusBadge], ['updated_at', 'Updated', date]],
    reservations: [['reservation_no', 'Reservation'], ['product_id', 'Product ID'], ['warehouse_id', 'Warehouse ID'], ['quantity', 'Quantity', number], ['reference_type', 'Reference', humanize], ['status', 'Status', statusBadge], ['actions', 'Actions', reservationActions]],
    'cycle-counts': [['count_no', 'Count'], ['warehouse_id', 'Warehouse ID'], ['status', 'Status', statusBadge], ['scheduled_at', 'Scheduled', date], ['created_at', 'Created', date]],
    'reorder-rules': [['product_id', 'Product ID'], ['warehouse_id', 'Warehouse ID'], ['minimum_stock', 'Minimum', number], ['reorder_point', 'Reorder Point', number], ['reorder_quantity', 'Quantity', number], ['lead_time_days', 'Lead Time', value => `${value || 0} days`], ['status', 'Status', statusBadge]],
    valuation: [['sku', 'SKU'], ['product_name', 'Product'], ['warehouse_name', 'Warehouse'], ['on_hand', 'Quantity', number], ['average_cost', 'Average Cost', money], ['total_value', 'Value', money], ['valuation_method', 'Method', humanize]]
  };
  return map[view] || [];
}

async function openPartyDetail(type, id, api) {
  const route = type === 'customer' ? 'customers' : 'suppliers';
  try {
    const party = await api.get(`/${route}/${id}`);
    currentDetail = { type: 'party', route, id, party };
    const ledger = type === 'customer' ? await api.get(`/customers/${id}/ledger`).catch(() => null) : await api.get(`/suppliers/${id}/analytics`).catch(() => null);
    openDetail(party.name, `
      ${detailSection('Profile', detailGrid({ 'Legal name': party.legal_name, GSTIN: party.profile_gstin || party.gstin, Phone: party.phone, Email: party.email, Address: party.address, Terms: `${party.payment_terms_days || 0} days`, Balance: money(party.balance || 0) }))}
      ${detailSection('Contacts', listCards(party.contacts, item => `<strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.email || item.phone || '—')}</span>`))}
      ${detailSection('Addresses', listCards(party.addresses, item => `<strong>${humanize(item.address_type)}</strong><span>${escapeHtml([item.line1, item.city, item.state, item.postal_code].filter(Boolean).join(', '))}</span>`))}
      ${detailSection(type === 'customer' ? 'Ledger' : 'Analytics', `<pre>${escapeHtml(JSON.stringify(ledger || {}, null, 2))}</pre>`)}
      ${detailSection('Documents', listCards(party.documents, item => `<strong>${escapeHtml(item.document_no)}</strong><span>${humanize(item.document_type)} · ${statusBadge(item.status)}</span>`))}
      ${detailSection('Attachments', attachmentPanel(party.attachments, type, id))}
      ${detailSection('Communications', listCards(party.communications, item => `<strong>${humanize(item.channel)}</strong><span>${escapeHtml(item.subject || item.body || '—')}</span>`))}
      ${partyDetailActions(route, id)}
    `);
  } catch (error) { notify(error.message, 'error'); }
}

async function openProductDetail(id, api) {
  try {
    const product = await api.get(`/products/${id}`);
    currentDetail = { type: 'product', id, product };
    openDetail(product.name, `
      ${detailSection('Product', detailGrid({ SKU: product.sku, Barcode: product.barcode, HSN: product.hsn_code, GST: `${number(product.gst_rate)}%`, Unit: product.uom, Cost: money(product.cost_price), Price: money(product.selling_price), 'Valuation method': humanize(product.valuation_method) }))}
      ${detailSection('Warehouse balances', smallTable(product.balances, [['warehouse_name', 'Warehouse'], ['quantity', 'Quantity', number]]))}
      ${detailSection('Variants', `${smallTable(product.variants, [['sku', 'SKU'], ['name', 'Variant'], ['barcode', 'Barcode'], ['cost_price', 'Cost', money], ['selling_price', 'Price', money], ['status', 'Status', statusBadge]])}${hasPermission('products.update') ? '<button class="action-btn secondary compact" data-m1-action="add-variant" data-id="' + id + '">Add variant</button>' : ''}`)}
      ${detailSection('Supplier mappings', `${smallTable(product.suppliers, [['supplier_name', 'Supplier'], ['supplier_sku', 'Supplier SKU'], ['last_cost', 'Cost', money], ['lead_time_days', 'Lead Time'], ['preferred', 'Preferred', yesNo]])}${hasPermission('products.update') ? '<button class="action-btn secondary compact" data-m1-action="map-supplier" data-id="' + id + '">Map supplier</button>' : ''}`)}
      ${detailSection('Attachments', attachmentPanel(product.attachments, 'product', id))}
    `);
  } catch (error) { notify(error.message, 'error'); }
}

async function openSettingsWorkspace(namespace, api) {
  setupWorkspace({ title: `${humanize(namespace)} Settings`, description: 'Organization-scoped settings with audited changes.', icon: 'fa-gear', panel: 'Configuration' });
  document.getElementById('m1WorkspaceActions').innerHTML = `<select id="m1SettingsNamespace" aria-label="Settings section">${SETTINGS_NAMESPACES.map(item => `<option value="${item}" ${item === namespace ? 'selected' : ''}>${humanize(item)}</option>`).join('')}</select>`;
  document.getElementById('m1SettingsNamespace').addEventListener('change', event => window.InventiaCore.router.navigate('settings', event.target.value));
  setStatusOptions([]);
  currentLoader = async () => {
    setLoading();
    try {
      const result = await api.get(`/settings/${namespace}`);
      renderSettingsForm(namespace, result.settings || {}, api);
    } catch (error) { setError(error); }
  };
  await currentLoader();
}

function setupWorkspace({ title, description, icon, panel }) {
  closeDetail();
  setText('m1WorkspaceTitle', title);
  setText('m1WorkspaceDescription', description);
  setText('m1PanelTitle', panel);
  document.getElementById('m1WorkspaceIcon').innerHTML = `<i class="fa-solid ${icon}"></i>`;
  document.getElementById('m1WorkspaceKpis').hidden = true;
  document.getElementById('m1Search').value = '';
  document.getElementById('m1WorkspaceTable').innerHTML = '';
}

function setPrimaryAction(label, handler) {
  const target = document.getElementById('m1WorkspaceActions');
  target.innerHTML = label ? `<button class="action-btn primary" id="m1PrimaryAction"><i class="fa-solid fa-plus"></i> ${escapeHtml(label)}</button>` : '';
  if (label) document.getElementById('m1PrimaryAction').addEventListener('click', handler);
}

function setStatusOptions(values) {
  const select = document.getElementById('m1StatusFilter');
  select.innerHTML = '<option value="">All statuses</option>' + values.map(value => `<option value="${value}">${humanize(value)}</option>`).join('');
  select.hidden = values.length === 0;
}

function setLoading() {
  const state = document.getElementById('m1WorkspaceState');
  state.hidden = false;
  state.textContent = 'Loading…';
  document.getElementById('m1WorkspaceTable').innerHTML = '';
}

function setError(error) {
  const state = document.getElementById('m1WorkspaceState');
  state.hidden = false;
  state.textContent = error?.message || 'The workspace could not be loaded.';
}

function renderRows(rows, columns, searchText, detail) {
  currentRows = rows;
  currentColumns = columns;
  currentRows._searchText = searchText;
  currentRows._detail = detail;
  applyClientFilters();
}

function applyClientFilters() {
  const query = document.getElementById('m1Search')?.value.trim().toLowerCase() || '';
  const status = document.getElementById('m1StatusFilter')?.value || '';
  const searchText = currentRows._searchText || (row => JSON.stringify(row));
  const rows = currentRows.filter(row => (!query || searchText(row).toLowerCase().includes(query)) && (!status || row.status === status));
  const state = document.getElementById('m1WorkspaceState');
  state.hidden = rows.length > 0;
  state.textContent = rows.length ? '' : 'No matching records.';
  const target = document.getElementById('m1WorkspaceTable');
  if (!currentColumns.length) { target.innerHTML = ''; return; }
  target.innerHTML = `<table><thead><tr>${currentColumns.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => {
    const descriptor = currentRows._detail?.(row);
    const attrs = descriptor ? ` data-m1-detail="${descriptor.type}" data-id="${descriptor.id}"` : (TRADE_VIEWS[currentView()] ? ` data-m1-detail="trade" data-id="${row.id}"` : '');
    return `<tr${attrs}>${currentColumns.map(([key,, formatter]) => `<td>${formatCell(formatter ? formatter(row[key], row) : row[key])}</td>`).join('')}</tr>`;
  }).join('')}</tbody></table>`;
}

function renderKpis(items) {
  const target = document.getElementById('m1WorkspaceKpis');
  target.hidden = false;
  target.innerHTML = items.map(([label, value]) => `<div class="kpi-card"><div><span>${escapeHtml(label)}</span><h3>${escapeHtml(value)}</h3></div></div>`).join('');
}

async function openConfiguredDetail(type, id, api) {
  if (type === 'trade') return openTradeDetail(currentView(), id, api);
  if (type === 'grn') return openGrnDetail(id, api);
  if (type === 'cycle-count') return openCycleCountDetail(id, api);
}

async function openTradeDetail(view, id, api) {
  try {
    const document = await api.get(`/trade/${view}/${id}`);
    currentDetail = { type: 'trade', view, id, document };
    openDetail(document.document_no, `
      ${detailSection('Summary', detailGrid({ Type: humanize(document.document_type), Status: statusBadge(document.status), Party: document.party_id ? `#${document.party_id}` : '—', Warehouse: document.warehouse_id ? `#${document.warehouse_id}` : '—', Subtotal: money(document.subtotal), Tax: money(document.tax_total), Discount: money(document.discount), Total: money(document.grand_total) }))}
      ${detailSection('Line items', smallTable(document.lines, [['description', 'Description'], ['product_id', 'Product'], ['quantity', 'Qty'], ['fulfilled_quantity', 'Fulfilled'], ['unit_price', 'Rate', money], ['tax_rate', 'GST %'], ['line_total', 'Total', money]]))}
      ${detailSection('Workflow', tradeDetailActions(document, view))}
      ${detailSection('Approvals', listCards(document.approvals, item => `<strong>${statusBadge(item.status)}</strong><span>${escapeHtml(item.reason || item.decision_notes || 'No note')}</span>`))}
      ${detailSection('Attachments', attachmentPanel(document.attachments, document.document_type, id))}
      ${detailSection('Timeline', timeline(document.timeline))}
    `);
  } catch (error) { notify(error.message, 'error'); }
}

async function openGrnDetail(id, api) {
  try {
    const grn = await api.get(`/grns/${id}`);
    openDetail(grn.receipt_no, `${detailSection('Receipt', detailGrid({ Status: statusBadge(grn.status), 'Purchase order': `#${grn.purchase_order_id}`, Warehouse: `#${grn.warehouse_id}`, Supplier: `#${grn.supplier_id}`, Received: date(grn.received_at), Notes: grn.notes }))}${detailSection('Items', smallTable(grn.items, [['product_id', 'Product'], ['quantity', 'Quantity'], ['unit_cost', 'Unit Cost', money], ['batch_no', 'Batch'], ['expires_at', 'Expiry', date]]))}`);
  } catch (error) { notify(error.message, 'error'); }
}

async function openCycleCountDetail(id, api) {
  try {
    const count = await api.get(`/inventory/cycle-counts/${id}`);
    currentDetail = { type: 'cycle-count', id, count };
    const editable = ['draft', 'in_progress'].includes(count.status) && hasPermission('inventory.adjust');
    openDetail(count.count_no, `${detailSection('Count', detailGrid({ Warehouse: `#${count.warehouse_id}`, Status: statusBadge(count.status), Scheduled: date(count.scheduled_at) }))}${detailSection('Items', `<form id="cycleCountForm">${smallTable(count.items, [['product_id', 'Product'], ['expected_quantity', 'Expected'], ['counted_quantity', 'Counted', (value, row) => editable ? `<input type="number" min="0" step="0.001" name="counted-${row.id}" value="${value ?? row.expected_quantity}">` : number(value)], ['variance', 'Variance', number]])}${editable ? '<button class="action-btn primary" type="submit">Complete count</button>' : ''}</form>`)}`);
    document.getElementById('cycleCountForm')?.addEventListener('submit', event => completeCycleCount(event, api));
  } catch (error) { notify(error.message, 'error'); }
}

async function completeCycleCount(event, api) {
  event.preventDefault();
  const { id, count } = currentDetail;
  const items = count.items.map(item => ({ item_id: item.id, counted_quantity: Number(event.target.elements[`counted-${item.id}`].value) }));
  await mutate(() => api.post(`/inventory/cycle-counts/${id}/complete`, { items }), 'Cycle count completed.');
  closeDetail();
  await currentLoader();
}

function tradeActions(row, config) {
  const actions = [`<button class="action-btn secondary compact" data-m1-detail="trade" data-id="${row.id}">View</button>`];
  if (row.status === 'draft' && hasPermission('trade.transition')) actions.push(actionButton('submit', row.id, 'Submit'));
  if (['approved', 'partially_fulfilled'].includes(row.status) && config.receive && hasPermission('trade.purchases.receive')) actions.push(actionButton('receive', row.id, 'Receive'));
  if (['approved', 'partially_fulfilled'].includes(row.status) && config.fulfill && hasPermission('trade.sales.fulfill')) actions.push(actionButton('fulfill', row.id, 'Fulfil'));
  return `<div class="panel-actions">${actions.join('')}</div>`;
}

function tradeDetailActions(document, view) {
  const buttons = [];
  if (document.status === 'draft' && hasPermission('trade.transition')) buttons.push(actionButton('submit', document.id, 'Submit for approval'));
  if (['draft', 'pending_approval', 'approved', 'partially_fulfilled'].includes(document.status) && hasPermission('trade.transition')) buttons.push(actionButton('cancel', document.id, 'Cancel'));
  if (document.status === 'approved' && TRADE_VIEWS[view]?.return && hasPermission('trade.transition')) buttons.push(actionButton('post-return', document.id, 'Post return'));
  return `<div class="panel-actions">${buttons.join('') || '<span>No actions available.</span>'}</div>`;
}

function approvalActions(_value, row) {
  if (row.status !== 'pending') return '—';
  const actions = [];
  if (hasPermission('approvals.approve')) actions.push(actionButton('approve', row.id, 'Approve'));
  if (hasPermission('approvals.reject')) actions.push(actionButton('reject', row.id, 'Reject'));
  return `<div class="panel-actions">${actions.join('') || '—'}</div>`;
}

function reservationActions(_value, row) {
  return row.status === 'active' && hasPermission('inventory.reserve') ? actionButton('release-reservation', row.id, 'Release') : '—';
}

function actionButton(action, id, label) {
  return `<button class="action-btn secondary compact" data-m1-action="${action}" data-id="${id}">${escapeHtml(label)}</button>`;
}

async function runConfiguredAction(button, api) {
  const action = button.dataset.m1Action;
  const id = button.dataset.id;
  const view = currentView();
  if (action.startsWith('party-')) return openPartyDetailForm(action, button.dataset.route, id, api);
  if (action === 'download-file') return downloadAttachment(button.dataset.key, button.dataset.name, api);
  if (action === 'add-variant') return openVariantForm(id, api);
  if (action === 'map-supplier') return openSupplierMappingForm(id, api);
  const actions = {
    submit: () => api.post(`/trade/${view}/${id}/transition`, { status: 'pending_approval' }),
    cancel: () => api.post(`/trade/${view}/${id}/transition`, { status: 'cancelled', reason: 'Cancelled by user.' }),
    'post-return': () => api.post(`/trade/${view}/${id}/transition`, { status: 'fulfilled' }),
    approve: () => api.post(`/approvals/${id}/approve`, {}),
    reject: () => api.post(`/approvals/${id}/reject`, { notes: 'Rejected by reviewer.' }),
    'release-reservation': () => api.delete(`/inventory/reservations/${id}`)
  };
  if (action === 'receive' || action === 'fulfill') return receiveOrFulfill(view, id, action, api);
  if (!actions[action]) return;
  await mutate(actions[action], `${humanize(action)} completed.`);
  closeDetail();
  await currentLoader();
}

function openVariantForm(productId, api) {
  openDetail('Add product variant', `<form id="m1VariantForm" class="workspace-settings-form"><div class="workspace-form-grid"><div class="form-group"><label>Name</label><input name="name" required></div><div class="form-group"><label>SKU</label><input name="sku" required></div><div class="form-group"><label>Barcode</label><input name="barcode"></div><div class="form-group"><label>Cost</label><input name="cost_price" type="number" min="0" step="0.01" value="0"></div><div class="form-group"><label>Selling price</label><input name="selling_price" type="number" min="0" step="0.01" value="0"></div></div><button class="action-btn primary" type="submit">Save variant</button></form>`);
  document.getElementById('m1VariantForm').addEventListener('submit', async event => {
    event.preventDefault(); const body = Object.fromEntries(new FormData(event.target)); body.cost_price = Number(body.cost_price); body.selling_price = Number(body.selling_price); if (!body.barcode) delete body.barcode;
    await mutate(() => api.post(`/products/${productId}/variants`, body), 'Variant saved.'); await openProductDetail(productId, api);
  });
}

async function openSupplierMappingForm(productId, api) {
  const result = await api.get('/suppliers');
  openDetail('Map supplier', `<form id="m1SupplierMappingForm" class="workspace-settings-form"><div class="workspace-form-grid">${selectField('supplier_id', 'Supplier', result.suppliers, true)}<div class="form-group"><label>Supplier SKU</label><input name="supplier_sku"></div><div class="form-group"><label>Lead time (days)</label><input name="lead_time_days" type="number" min="0" value="0"></div><div class="form-group"><label>Minimum order</label><input name="minimum_order_quantity" type="number" min="0.001" step="0.001" value="1"></div><div class="form-group"><label>Last cost</label><input name="last_cost" type="number" min="0" step="0.01" value="0"></div><label class="form-check"><input name="preferred" type="checkbox"> Preferred supplier</label></div><button class="action-btn primary" type="submit">Save mapping</button></form>`);
  document.getElementById('m1SupplierMappingForm').addEventListener('submit', async event => {
    event.preventDefault(); const data = new FormData(event.target); const body = { supplier_id: Number(data.get('supplier_id')), supplier_sku: data.get('supplier_sku') || undefined, lead_time_days: Number(data.get('lead_time_days')), minimum_order_quantity: Number(data.get('minimum_order_quantity')), last_cost: Number(data.get('last_cost')), preferred: data.get('preferred') === 'on' };
    await mutate(() => api.post(`/products/${productId}/suppliers`, body), 'Supplier mapping saved.'); await openProductDetail(productId, api);
  });
}

async function receiveOrFulfill(view, id, action, api) {
  const document = await api.get(`/trade/${view}/${id}`);
  const remaining = document.lines.map(line => ({ ...line, remaining: Number(line.quantity) - Number(line.fulfilled_quantity) })).filter(item => item.remaining > 0);
  if (!remaining.length) return notify('No remaining quantity is available.', 'info');
  const path = action === 'receive' ? `/trade/purchase-orders/${id}/receive` : `/trade/sales-orders/${id}/fulfill`;
  openDetail(action === 'receive' ? 'Receive purchase order' : 'Fulfil sales order', `<form id="m1FulfilmentForm" class="workspace-settings-form">${smallTable(remaining, [['description', 'Item', (value, row) => escapeHtml(value || `Product #${row.product_id}`)], ['remaining', 'Remaining', number], ['quantity', 'Post quantity', (_value, row) => `<input name="quantity-${row.id}" type="number" min="0" max="${row.remaining}" step="0.001" value="${row.remaining}" required>`], ...(action === 'receive' ? [['batch_no', 'Batch', (_value, row) => `<input name="batch-${row.id}" maxlength="100">`], ['expires_at', 'Expiry', (_value, row) => `<input name="expiry-${row.id}" type="date">`]] : [])])}<button class="action-btn primary" type="submit">${action === 'receive' ? 'Post GRN' : 'Post fulfilment'}</button></form>`);
  document.getElementById('m1FulfilmentForm').addEventListener('submit', async event => {
    event.preventDefault();
    const items = remaining.map(line => ({ line_id: line.id, quantity: Number(event.target.elements[`quantity-${line.id}`].value), ...(action === 'receive' ? { batch_no: event.target.elements[`batch-${line.id}`].value || undefined, expires_at: event.target.elements[`expiry-${line.id}`].value ? new Date(event.target.elements[`expiry-${line.id}`].value).toISOString() : undefined } : {}) })).filter(item => item.quantity > 0);
    if (!items.length) return notify('Enter at least one quantity to post.', 'error');
    await mutate(() => api.post(path, { warehouse_id: document.warehouse_id, items }), action === 'receive' ? 'Goods receipt posted.' : 'Sales order fulfilled.');
    closeDetail(); await currentLoader();
  });
}

function inventoryPrimaryAction(view, api) {
  if (view === 'adjustments' && hasPermission('inventory.adjust')) return { label: 'Post adjustment', handler: () => openAdjustmentForm(api) };
  if (view === 'serials' && hasPermission('inventory.adjust')) return { label: 'Add serial', handler: () => openSimpleInventoryForm('serials', api) };
  if (view === 'reservations' && hasPermission('inventory.reserve')) return { label: 'Reserve stock', handler: () => openSimpleInventoryForm('reservations', api) };
  if (view === 'cycle-counts' && hasPermission('inventory.adjust')) return { label: 'New cycle count', handler: () => openSimpleInventoryForm('cycle-counts', api) };
  if (view === 'price-lists' && hasPermission('products.update')) return { label: 'New price list', handler: () => openSimpleInventoryForm('price-lists', api) };
  if (view === 'reorder-rules' && hasPermission('inventory.adjust')) return { label: 'Configure rule', handler: () => openSimpleInventoryForm('reorder-rules', api) };
  return null;
}

async function openTradeCreate(config, view, api) {
  const [partiesResult, productsResult, warehousesResult] = await Promise.all([
    api.get(config.party === 'customer' ? '/customers' : '/suppliers'), api.get('/products?limit=500'), api.get('/reference/warehouses')
  ]);
  const parties = partiesResult[config.party === 'customer' ? 'customers' : 'suppliers'] || [];
  const products = productsResult.products || [];
  const warehouses = warehousesResult.items || [];
  openDetail(`New ${config.singular}`, `<form id="m1TradeForm" class="workspace-settings-form"><div class="workspace-form-grid">
    ${selectField('party_id', humanize(config.party), parties, true)}${selectField('warehouse_id', 'Warehouse', warehouses, false)}
    <div class="form-group full"><label>Notes</label><textarea name="notes" rows="3"></textarea></div></div>
    <div id="m1TradeLines">${tradeLineMarkup(products)}</div><div class="panel-actions"><button class="action-btn secondary" id="m1AddTradeLine" type="button"><i class="fa-solid fa-plus"></i> Add line</button><button class="action-btn primary" type="submit">Save draft</button></div></form>`);
  const form = document.getElementById('m1TradeForm');
  const bindLines = () => form.querySelectorAll('.workspace-line-editor').forEach((line, index) => {
    line.querySelector('[data-remove-line]').hidden = index === 0 && form.querySelectorAll('.workspace-line-editor').length === 1;
    line.querySelector('[name="product_id"]').onchange = () => { const product = products.find(item => String(item.id) === line.querySelector('[name="product_id"]').value); const price = config.party === 'supplier' ? product?.cost_price : product?.selling_price; line.querySelector('[name="unit_price"]').value = Number(price || 0).toFixed(2); };
    line.querySelector('[data-remove-line]').onclick = () => { line.remove(); bindLines(); };
    if (!line.querySelector('[name="unit_price"]').value) line.querySelector('[name="product_id"]').dispatchEvent(new Event('change'));
  });
  document.getElementById('m1AddTradeLine').addEventListener('click', () => { document.getElementById('m1TradeLines').insertAdjacentHTML('beforeend', tradeLineMarkup(products)); bindLines(); });
  bindLines();
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(form);
    const lines = [...form.querySelectorAll('.workspace-line-editor')].map(line => ({ product_id: Number(line.querySelector('[name="product_id"]').value), quantity: Number(line.querySelector('[name="quantity"]').value), unit_price: Number(line.querySelector('[name="unit_price"]').value), discount: Number(line.querySelector('[name="discount"]').value || 0) }));
    const body = { party_id: Number(data.get('party_id')) || undefined, warehouse_id: Number(data.get('warehouse_id')) || undefined, notes: data.get('notes') || undefined, lines };
    await mutate(() => api.post(`/trade/${view}`, body), `${config.singular} draft created.`);
    closeDetail();
    await currentLoader();
  });
}

function tradeLineMarkup(products) {
  return `<div class="workspace-line-editor"><div class="form-group"><label>Product</label><select name="product_id" required>${options(products, item => `${item.sku} — ${item.name}`)}</select></div><div class="form-group"><label>Quantity</label><input name="quantity" type="number" min="0.001" step="0.001" value="1" required></div><div class="form-group"><label>Unit price</label><input name="unit_price" type="number" min="0" step="0.01" required></div><div class="form-group"><label>Discount</label><input name="discount" type="number" min="0" step="0.01" value="0"></div><button class="action-btn secondary compact" data-remove-line type="button" aria-label="Remove line"><i class="fa-solid fa-xmark"></i></button></div>`;
}

async function openAdjustmentForm(api) {
  const [products, warehouses] = await Promise.all([api.get('/products?limit=500'), api.get('/reference/warehouses')]);
  openDetail('Post stock adjustment', `<form id="m1AdjustmentForm" class="workspace-settings-form"><div class="workspace-form-grid">${selectField('product_id', 'Product', products.products, true)}${selectField('warehouse_id', 'Warehouse', warehouses.items, true)}<div class="form-group"><label>Type</label><select name="kind"><option value="adjustments">Adjustment</option><option value="damage">Damage</option></select></div><div class="form-group"><label>Direction</label><select name="direction"><option value="increase">Increase</option><option value="decrease">Decrease</option></select></div><div class="form-group"><label>Quantity</label><input name="quantity" type="number" min="0.001" step="0.001" required></div><div class="form-group"><label>Unit cost</label><input name="unit_cost" type="number" min="0" step="0.01" value="0"></div><div class="form-group full"><label>Reason</label><textarea name="reason" required></textarea></div></div><button class="action-btn primary" type="submit">Post movement</button></form>`);
  document.getElementById('m1AdjustmentForm').addEventListener('submit', async event => {
    event.preventDefault(); const data = new FormData(event.target); const kind = data.get('kind');
    const body = { product_id: Number(data.get('product_id')), warehouse_id: Number(data.get('warehouse_id')), quantity: Number(data.get('quantity')), unit_cost: Number(data.get('unit_cost')), reason: data.get('reason') };
    if (kind === 'adjustments') body.direction = data.get('direction');
    await mutate(() => api.post(`/inventory/${kind}`, body), 'Stock movement posted.'); closeDetail(); await currentLoader();
  });
}

async function openSimpleInventoryForm(view, api) {
  const [products, warehouses] = await Promise.all([api.get('/products?limit=500'), api.get('/reference/warehouses')]);
  const common = `${selectField('product_id', 'Product', products.products, true)}${selectField('warehouse_id', 'Warehouse', warehouses.items, true)}`;
  const fields = {
    serials: `${common}<div class="form-group"><label>Serial number</label><input name="serial_no" required></div>`,
    reservations: `${common}<div class="form-group"><label>Quantity</label><input name="quantity" type="number" min="0.001" step="0.001" required></div><div class="form-group"><label>Reference type</label><input name="reference_type" value="manual" required></div><div class="form-group"><label>Reference ID</label><input name="reference_id" required></div>`,
    'cycle-counts': `${selectField('warehouse_id', 'Warehouse', warehouses.items, true)}<div class="form-group"><label>Scheduled date</label><input name="scheduled_at" type="date"></div>`,
    'price-lists': `<div class="form-group"><label>Name</label><input name="name" required></div><div class="form-group"><label>Currency</label><input name="currency" value="INR" maxlength="3" required></div>${selectField('product_id', 'Product', products.products, true)}<div class="form-group"><label>Unit price</label><input name="unit_price" type="number" min="0" step="0.01" required></div><div class="form-group"><label>Minimum quantity</label><input name="minimum_quantity" type="number" min="0.001" step="0.001" value="1" required></div>`,
    'reorder-rules': `${common}<div class="form-group"><label>Minimum stock</label><input name="minimum_stock" type="number" min="0" step="0.001" value="0"></div><div class="form-group"><label>Reorder point</label><input name="reorder_point" type="number" min="0" step="0.001" required></div><div class="form-group"><label>Reorder quantity</label><input name="reorder_quantity" type="number" min="0" step="0.001" required></div><div class="form-group"><label>Safety stock</label><input name="safety_stock" type="number" min="0" step="0.001" value="0"></div><div class="form-group"><label>Lead time (days)</label><input name="lead_time_days" type="number" min="0" value="0"></div>`
  };
  openDetail(`New ${humanize(view).replace(/s$/, '')}`, `<form id="m1InventoryCreate" class="workspace-settings-form"><div class="workspace-form-grid">${fields[view]}</div><button class="action-btn primary" type="submit">Save</button></form>`);
  document.getElementById('m1InventoryCreate').addEventListener('submit', async event => {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); let path = `/inventory/${view}`; let body = data;
    ['product_id', 'warehouse_id', 'quantity', 'unit_price', 'minimum_quantity', 'minimum_stock', 'reorder_point', 'reorder_quantity', 'safety_stock', 'lead_time_days'].forEach(key => { if (body[key] !== undefined && body[key] !== '') body[key] = Number(body[key]); });
    if (view === 'cycle-counts') { body = { warehouse_id: body.warehouse_id, scheduled_at: body.scheduled_at ? new Date(body.scheduled_at).toISOString() : undefined }; }
    if (view === 'price-lists') { path = '/price-lists'; body = { name: body.name, currency: body.currency, items: [{ product_id: body.product_id, unit_price: body.unit_price, minimum_quantity: body.minimum_quantity }] }; }
    if (view === 'reorder-rules') { path = `/inventory/reorder-rules/${body.product_id}/${body.warehouse_id}`; body = { minimum_stock: body.minimum_stock, reorder_point: body.reorder_point, reorder_quantity: body.reorder_quantity, safety_stock: body.safety_stock, lead_time_days: body.lead_time_days, status: 'active' }; }
    await mutate(() => view === 'reorder-rules' ? api.put(path, body) : api.post(path, body), `${humanize(view)} saved.`); closeDetail(); await currentLoader();
  });
}

function renderSettingsForm(namespace, settings, api) {
  const target = document.getElementById('m1WorkspaceTable');
  document.getElementById('m1WorkspaceState').hidden = true;
  target.innerHTML = `<form id="m1SettingsForm" class="workspace-settings-form"><div class="workspace-settings-fields">${Object.entries(settings).map(([key, value]) => settingField(key, value)).join('')}</div><div><button class="action-btn primary" type="submit">Save settings</button></div></form>`;
  document.getElementById('m1SettingsForm').addEventListener('submit', async event => {
    event.preventDefault();
    const changes = {};
    event.target.querySelectorAll('[data-setting-key]').forEach(input => assignNested(changes, input.dataset.settingKey, readInput(input)));
    await mutate(() => api.put(`/settings/${namespace}`, changes), 'Settings saved.');
    await currentLoader();
  });
}

function settingField(key, value, prefix = '') {
  const path = prefix ? `${prefix}.${key}` : key;
  if (value && typeof value === 'object' && !Array.isArray(value)) return `<fieldset class="workspace-detail-section"><legend>${humanize(key)}</legend>${Object.entries(value).map(([child, childValue]) => settingField(child, childValue, path)).join('')}</fieldset>`;
  const label = humanize(key);
  if (typeof value === 'boolean') return `<label class="form-check"><input type="checkbox" data-setting-key="${path}" ${value ? 'checked' : ''}> ${label}</label>`;
  if (Array.isArray(value)) return `<div class="form-group"><label>${label}</label><input data-setting-key="${path}" data-value-type="array" value="${escapeHtml(value.join(', '))}"></div>`;
  if (SETTING_OPTIONS[key]) return `<div class="form-group"><label>${label}</label><select data-setting-key="${path}">${SETTING_OPTIONS[key].map(option => `<option value="${option}" ${option === value ? 'selected' : ''}>${humanize(option)}</option>`).join('')}</select></div>`;
  if (/(instructions|notes|terms|address)$/.test(key)) return `<div class="form-group"><label>${label}</label><textarea data-setting-key="${path}" rows="4">${escapeHtml(value ?? '')}</textarea></div>`;
  const type = typeof value === 'number' || value === null && /(days|month|rate|percent|decimal|margin)/.test(key) ? 'number' : 'text';
  return `<div class="form-group"><label>${label}</label><input type="${type}" ${type === 'number' ? 'step="any"' : ''} data-setting-key="${path}" data-value-type="${typeof value}" value="${escapeHtml(value ?? '')}"></div>`;
}

function partyDetailActions(route, id) {
  return `<div class="workspace-detail-section"><h4>Add party detail</h4><div class="panel-actions"><button class="action-btn secondary compact" data-m1-action="party-contact" data-route="${route}" data-id="${id}">Contact</button><button class="action-btn secondary compact" data-m1-action="party-address" data-route="${route}" data-id="${id}">Address</button><button class="action-btn secondary compact" data-m1-action="party-note" data-route="${route}" data-id="${id}">Communication</button></div></div>`;
}

function attachmentPanel(items, entityType, entityId) {
  return `${listCards(items, item => `<button class="action-btn secondary compact" data-m1-action="download-file" data-key="${escapeHtml(item.file_key)}" data-name="${escapeHtml(item.file_name)}">${escapeHtml(item.file_name)}</button><span>${number(item.size_bytes)} bytes</span>`)}${hasPermission('trade.update') ? `<form id="m1AttachmentForm"><input type="file" name="file" required><input type="hidden" name="entity_type" value="${entityType}"><input type="hidden" name="entity_id" value="${entityId}"><button class="action-btn secondary compact" type="submit">Upload</button></form>` : ''}`;
}

async function downloadAttachment(key, name, api) {
  try {
    const blob = await api.get(`/files/${encodeURIComponent(key)}`, { responseType: 'blob' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = name || 'attachment'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { notify(error.message, 'error'); }
}

function openPartyDetailForm(action, route, id, api) {
  const forms = {
    'party-contact': `<div class="form-group"><label>Name</label><input name="name" required></div><div class="form-group"><label>Email</label><input name="email" type="email"></div><div class="form-group"><label>Phone</label><input name="phone"></div>`,
    'party-address': `<div class="form-group"><label>Type</label><select name="address_type"><option value="billing">Billing</option><option value="shipping">Shipping</option><option value="office">Office</option><option value="warehouse">Warehouse</option></select></div><div class="form-group"><label>Address</label><input name="line1" required></div><div class="form-group"><label>City</label><input name="city"></div><div class="form-group"><label>State</label><input name="state"></div><div class="form-group"><label>Postal code</label><input name="postal_code"></div>`,
    'party-note': `<div class="form-group"><label>Channel</label><select name="channel"><option value="note">Note</option><option value="email">Email</option><option value="phone">Phone</option><option value="meeting">Meeting</option><option value="sms">SMS</option></select></div><div class="form-group"><label>Direction</label><select name="direction"><option value="internal">Internal</option><option value="outbound">Outbound</option><option value="inbound">Inbound</option></select></div><div class="form-group"><label>Subject</label><input name="subject"></div><div class="form-group full"><label>Details</label><textarea name="body" required></textarea></div>`
  };
  const endpoint = { 'party-contact': 'contacts', 'party-address': 'addresses', 'party-note': 'communications' }[action];
  openDetail(`Add ${humanize(endpoint).replace(/s$/, '')}`, `<form id="m1PartyDetailForm" class="workspace-settings-form"><div class="workspace-form-grid">${forms[action]}</div><button class="action-btn primary" type="submit">Save</button></form>`);
  document.getElementById('m1PartyDetailForm').addEventListener('submit', async event => {
    event.preventDefault();
    await mutate(() => api.post(`/${route}/${id}/${endpoint}`, Object.fromEntries(new FormData(event.target))), 'Party detail saved.');
    await openPartyDetail(route === 'customers' ? 'customer' : 'supplier', id, api);
  });
}

function openDetail(title, html) {
  setText('m1DetailTitle', title);
  document.getElementById('m1DetailBody').innerHTML = html;
  const drawer = document.getElementById('m1DetailDrawer');
  drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false');
  const form = document.getElementById('m1AttachmentForm');
  if (form) form.addEventListener('submit', uploadAttachment);
}

async function uploadAttachment(event) {
  event.preventDefault();
  const api = window.InventiaCore.api;
  await mutate(() => api.post('/attachments', new FormData(event.target)), 'Attachment uploaded.');
  if (currentDetail?.type === 'trade') await openTradeDetail(currentDetail.view, currentDetail.id, api);
  else if (currentDetail?.type === 'product') await openProductDetail(currentDetail.id, api);
  else if (currentDetail?.type === 'party') await openPartyDetail(currentDetail.route === 'customers' ? 'customer' : 'supplier', currentDetail.id, api);
}

function closeDetail() {
  const drawer = document.getElementById('m1DetailDrawer');
  drawer?.classList.remove('open'); drawer?.setAttribute('aria-hidden', 'true'); currentDetail = null;
}

async function mutate(work, success) {
  try { const result = await work(); notify(success, 'success'); return result; } catch (error) { notify(error.message, 'error'); throw error; }
}

function currentView() { return window.InventiaCore?.store?.getState()?.workspace?.view || ''; }
function readPermissions() { try { return JSON.parse(localStorage.getItem('permissions') || '[]'); } catch { return []; } }
function hasPermission(permission) { const grants = readPermissions(); return grants.some(grant => grant === '*' || grant === permission || grant.endsWith('.*') && permission.startsWith(grant.slice(0, -1))); }
function inventoryPermission(view) { return view === 'adjustments' ? 'inventory.adjust' : 'inventory.read'; }
function setText(id, value) { const node = document.getElementById(id); if (node) node.textContent = value; }
function notify(message, type) { window.showToast?.(message, type); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function humanize(value) { return escapeHtml(String(value ?? '—').replace(/[_-]/g, ' ').replace(/\b\w/g, char => char.toUpperCase())); }
function money(value) { return `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function number(value) { return Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 }); }
function date(value) { return value ? new Date(value).toLocaleDateString('en-IN') : '—'; }
function yesNo(value) { return value ? 'Yes' : 'No'; }
function statusBadge(value) { return `<span class="status-badge ${escapeHtml(value || '')}">${humanize(value)}</span>`; }
function formatCell(value) { return value == null || value === '' ? '—' : String(value); }
function detailSection(title, body) { return `<section class="workspace-detail-section"><h4>${escapeHtml(title)}</h4>${body || '<p>No records.</p>'}</section>`; }
function detailGrid(values) { return `<div class="workspace-detail-grid">${Object.entries(values).map(([label, value]) => `<div><span>${escapeHtml(label)}</span><div>${formatCell(value)}</div></div>`).join('')}</div>`; }
function listCards(items, renderer) { return items?.length ? `<div class="workspace-timeline">${items.map(item => `<div>${renderer(item)}</div>`).join('')}</div>` : '<p>No records.</p>'; }
function timeline(items) { return listCards(items, item => `<strong>${humanize(item.event_type)}</strong><small>${date(item.created_at)}</small><p>${escapeHtml(item.message || '')}</p>`); }
function smallTable(rows, columns) { return rows?.length ? `<div class="table-container"><table><thead><tr>${columns.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map(([key,, formatter]) => `<td>${formatCell(formatter ? formatter(row[key], row) : row[key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p>No records.</p>'; }
function options(items, label = item => item.name) { return (items || []).map(item => `<option value="${item.id}">${escapeHtml(label(item))}</option>`).join(''); }
function selectField(name, label, items, required) { return `<div class="form-group"><label>${escapeHtml(label)}</label><select name="${name}" ${required ? 'required' : ''}><option value="">Select</option>${options(items)}</select></div>`; }
function readInput(input) { if (input.type === 'checkbox') return input.checked; if (input.dataset.valueType === 'array') return input.value.split(',').map(item => item.trim()).filter(Boolean); if (input.dataset.valueType === 'number') return input.value === '' ? null : Number(input.value); return input.value; }
function assignNested(target, path, value) { const parts = path.split('.'); let cursor = target; parts.slice(0, -1).forEach(part => { cursor[part] ||= {}; cursor = cursor[part]; }); cursor[parts.at(-1)] = value; }
