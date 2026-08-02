// State Management
let currentTab = 'dashboard';
let cart = [];

function apiHeaders(includeJson = false) {
  const headers = {
    'Authorization': `Bearer ${localStorage.getItem('token') || ''}`,
    'x-user-role': localStorage.getItem('role') || '',
    'x-user-id': localStorage.getItem('userId') || ''
  };
  if (includeJson) headers['Content-Type'] = 'application/json';
  return headers;
}

function v1Headers(includeJson = false) {
  const headers = { 'Authorization': `Bearer ${localStorage.getItem('phase5AccessToken') || ''}` };
  if (includeJson) headers['Content-Type'] = 'application/json';
  return headers;
}
let calculatorMode = 'dims';
let activeCalculatorProduct = null;

const INVENTIA_VISUAL_PALETTES = [
  ['#2563eb', '#1d4ed8'],
  ['#0891b2', '#0f766e'],
  ['#8b5cf6', '#6d28d9'],
  ['#f59e0b', '#d97706'],
  ['#22c55e', '#15803d']
];

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getInitials(label = '') {
  const words = String(label).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'IN';
  return words.slice(0, 2).map(word => word[0]).join('').toUpperCase();
}

function buildProductFallbackImage(label = 'Inventia') {
  const safeLabel = String(label || 'Inventia');
  const paletteIndex = safeLabel.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0) % INVENTIA_VISUAL_PALETTES.length;
  const [from, to] = INVENTIA_VISUAL_PALETTES[paletteIndex];
  const initials = getInitials(safeLabel);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="560" height="360" viewBox="0 0 560 360">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${from}"/>
          <stop offset="100%" stop-color="${to}"/>
        </linearGradient>
      </defs>
      <rect width="560" height="360" rx="44" fill="url(#g)"/>
      <circle cx="452" cy="74" r="48" fill="rgba(255,255,255,0.16)"/>
      <circle cx="112" cy="296" r="72" fill="rgba(255,255,255,0.10)"/>
      <text x="280" y="200" text-anchor="middle" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-weight="800" font-size="118">${initials}</text>
    </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function resolveProductImage(imageUrl, label) {
  if (!imageUrl || /images\.unsplash\.com/i.test(imageUrl)) {
    return buildProductFallbackImage(label);
  }
  return imageUrl;
}

function renderTableProductLabel(label) {
  const safeLabel = escapeHtml(label);
  return `<span class="table-product-chip" aria-hidden="true">${escapeHtml(getInitials(label))}</span><strong>${safeLabel}</strong>`;
}

function syncThemeIndicators() {
  const currentMode = document.documentElement.getAttribute('data-theme-mode') || 'light';
  const isDark = currentMode === 'dark';
  const statusEl = document.getElementById('themeSwitchStatus');
  const iconEl = document.getElementById('themeToggleIcon');
  const topIconEl = document.getElementById('topThemeToggleIcon');

  if (statusEl) statusEl.innerText = isDark ? 'Dark' : 'Light';
  if (iconEl) iconEl.className = isDark ? 'fa-solid fa-sun text-amber' : 'fa-solid fa-moon text-indigo';
  if (topIconEl) topIconEl.className = isDark ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
}

function restoreInterfacePreferences() {
  const themeMode = localStorage.getItem('themeMode') || 'light';
  const themeColor = localStorage.getItem('themeColor') || 'blue';
  changeThemeModePreview(themeMode);
  changeThemeColorPreview(themeColor);
  syncThemeIndicators();

  const shouldCollapseSidebar = localStorage.getItem('inventia_sidebar_collapsed') === 'true';
  const sidebar = document.querySelector('aside.sidebar');
  const main = document.querySelector('main.main-content');
  if (sidebar) sidebar.classList.toggle('collapsed', shouldCollapseSidebar);
  if (main) main.classList.toggle('expanded', shouldCollapseSidebar);
}

function initializeWorkspaceArchitecture() {
  document.querySelectorAll('.workspace-page-hero').forEach(hero => {
    if (hero.dataset.architectureReady === 'true') return;
    const copy = hero.children[1];
    const title = copy?.querySelector('h2')?.textContent?.trim();
    if (!copy || !title) return;

    const breadcrumb = document.createElement('nav');
    breadcrumb.className = 'page-breadcrumb';
    breadcrumb.setAttribute('aria-label', `${title} breadcrumb`);
    breadcrumb.innerHTML = '<span>Workspace</span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i>';
    const current = document.createElement('strong');
    current.textContent = title;
    breadcrumb.appendChild(current);
    copy.prepend(breadcrumb);
    hero.dataset.architectureReady = 'true';
  });
}

const settingsModules = {
  organization: { icon: 'fa-building', title: 'Organization', description: 'Company identity, operating locations, and regional defaults for this workspace.', items: ['Company Profile', 'Branches', 'Warehouses', 'Financial Year', 'Currency', 'Time Zone'] },
  users: { icon: 'fa-users-gear', title: 'Users & Permissions', description: 'Control who can access the workspace and what they can do.', items: ['Users', 'Roles', 'Permissions', 'Teams', 'Activity Logs'] },
  products: { icon: 'fa-boxes-stacked', title: 'Products & Inventory', description: 'Standardize the product information and inventory rules your team uses every day.', items: ['Units of Measure', 'Categories', 'Brands', 'Taxes', 'Barcode & QR', 'Batch & Expiry', 'Serial Numbers', 'Reorder Rules'] },
  sales: { icon: 'fa-cart-shopping', title: 'Sales', description: 'Set the defaults behind quotations, orders, invoicing, payments, and returns.', items: ['Invoice Settings', 'Quotation Settings', 'Order Settings', 'Payment Terms', 'Delivery Settings', 'Return Policy'] },
  purchases: { icon: 'fa-bag-shopping', title: 'Purchases', description: 'Configure purchase-order controls, vendor defaults, approvals, and returns.', items: ['Purchase Order Settings', 'Vendor Defaults', 'Approval Workflow', 'Purchase Returns'] },
  finance: { icon: 'fa-wallet', title: 'Finance', description: 'Manage tax, payments, banking, numbering, and accounting defaults.', items: ['Tax & GST', 'Bank Accounts', 'Payment Methods', 'Payment Gateways', 'Number Series', 'Accounting Defaults'] },
  documents: { icon: 'fa-file-lines', title: 'Documents & Printing', description: 'Make every printed or digital document match your business.', items: ['Invoice Templates', 'Thermal Printing', 'Barcode Labels', 'Packing Slips', 'Delivery Challans', 'Company Logo', 'Digital Signature', 'Terms & Conditions'] },
  notifications: { icon: 'fa-bell', title: 'Notifications', description: 'Choose where important business events should reach your customers and team.', items: ['Email', 'SMS', 'WhatsApp', 'Push Notifications', 'Payment Reminders', 'Low Stock Alerts'] },
  integrations: { icon: 'fa-plug', title: 'Integrations', description: 'Connect payment, commerce, accounting, messaging, and developer tools.', items: ['WhatsApp', 'Razorpay', 'PhonePe', 'Tally', 'Shopify', 'WooCommerce', 'API Keys', 'Webhooks'] },
  ai: { icon: 'fa-sparkles', title: 'AI', description: 'Tune your AI assistant, automation rules, access controls, and audit history.', items: ['AI Assistant', 'Automation Rules', 'AI Permissions', 'AI History'] },
  security: { icon: 'fa-shield-halved', title: 'Security', description: 'Protect workspace access, sessions, backups, exports, and audit trails.', items: ['Change Password', 'Two-Factor Authentication', 'Login Sessions', 'Backup & Restore', 'Data Export', 'Audit Logs'] },
  subscription: { icon: 'fa-credit-card', title: 'Subscription', description: 'Review plan details, billing, limits, invoices, and upgrade options.', items: ['Current Plan', 'Billing', 'Usage', 'Invoices', 'Upgrade Plan'] },
  help: { icon: 'fa-circle-question', title: 'Help & About', description: 'Find support, product updates, guidance, and information about Inventia.', items: ['Help Center', 'Contact Support', 'Report a Bug', 'Feature Requests', 'Keyboard Shortcuts', 'Changelog', 'About Inventia'] }
};

const settingsDestinations = {
  'Users': 'staff', 'Roles': 'staff', 'Permissions': 'staff', 'Teams': 'staff', 'Activity Logs': 'staff',
  'Warehouses': 'warehouses-locations', 'Categories': 'brands-categories', 'Brands': 'brands-categories',
  'Barcode & QR': 'barcodes', 'Barcode Labels': 'barcodes', 'Batch & Expiry': 'inventory', 'Reorder Rules': 'inventory',
  'Invoice Settings': 'sales-page', 'Order Settings': 'sales-page', 'Backup & Restore': 'backup-tab',
  'Invoices': 'invoices'
};
let settingsNavigationInitialized = false;
let currencySymbol = '₹';
let currencyCode = 'INR';
let posPaymentMode = 'single';
let posPaymentMethods = [
  { method: 'CASH', label: 'Cash', enabled: true, requires_reference: false },
  { method: 'CARD', label: 'Terminal Card', enabled: true, requires_reference: true },
  { method: 'UPI', label: 'UPI', enabled: true, requires_reference: true },
  { method: 'BANK_TRANSFER', label: 'Bank Transfer', enabled: true, requires_reference: true },
  { method: 'CHEQUE', label: 'Cheque', enabled: true, requires_reference: true },
  { method: 'CUSTOMER_CREDIT', label: 'Pay Later', enabled: true, requires_reference: false }
];
let posPaymentRows = [{ method: 'CASH', amount: 0, reference: '' }];
let activeInvoiceDetail = null;
let invoiceSearchTimer = null;

// ================================================================
// TOAST & NOTIFICATION SYSTEM IMPLEMENTATION
// ================================================================
let systemNotifications = [];

function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let icon = 'fa-circle-check';
  if (type === 'error') icon = 'fa-circle-xmark';
  if (type === 'info') icon = 'fa-circle-info';
  
  toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${message}</span>`;
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.remove();
  }, 3000);
}

async function executeAction(btn, actionFn, successMsg, notificationMsg = null) {
  if (!btn) {
    try {
      await actionFn();
      showToast(successMsg, 'success');
      if (notificationMsg) addSystemNotification(notificationMsg);
    } catch (err) {
      showToast(err.message || 'Action failed', 'error');
      throw err;
    }
    return;
  }

  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Processing...`;

  try {
    await actionFn();
    showToast(successMsg, 'success');
    if (notificationMsg) addSystemNotification(notificationMsg);
  } catch (err) {
    showToast(err.message || 'Action failed', 'error');
    throw err;
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

function initNotifications() {
  const stored = localStorage.getItem('system_notifications');
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
      systemNotifications = parsed.filter(n => new Date(n.timestamp).getTime() > threeDaysAgo);
      localStorage.setItem('system_notifications', JSON.stringify(systemNotifications));
    } catch (e) {
      systemNotifications = [];
    }
  } else {
    systemNotifications = [];
  }
  updateNotificationsUI();
}

function addSystemNotification(message) {
  const notif = {
    id: Date.now() + Math.random().toString(36).substring(2, 7),
    message: message,
    timestamp: new Date().toISOString(),
    unread: true
  };
  systemNotifications.unshift(notif);
  localStorage.setItem('system_notifications', JSON.stringify(systemNotifications));
  updateNotificationsUI();
}

function updateNotificationsUI() {
  const badge = document.getElementById('notificationBadge');
  const list = document.getElementById('notificationList');
  
  // 3-day retention check
  const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
  systemNotifications = systemNotifications.filter(n => new Date(n.timestamp).getTime() > threeDaysAgo);
  localStorage.setItem('system_notifications', JSON.stringify(systemNotifications));

  const unreadCount = systemNotifications.filter(n => n.unread).length;
  
  if (badge) {
    if (unreadCount > 0) {
      badge.innerText = unreadCount;
      badge.style.display = 'block';
    } else {
      badge.style.display = 'none';
    }
  }
  
  if (list) {
    list.innerHTML = '';
    
    let displayNotifs = [...systemNotifications];
    if (typeof currentNotifFilter !== 'undefined') {
      if (currentNotifFilter === 'sales') {
        displayNotifs = displayNotifs.filter(n => n.message.toLowerCase().includes('sale') || n.message.toLowerCase().includes('payment'));
      } else if (currentNotifFilter === 'stock') {
        displayNotifs = displayNotifs.filter(n => n.message.toLowerCase().includes('stock') || n.message.toLowerCase().includes('product'));
      } else if (currentNotifFilter === 'dues') {
        displayNotifs = displayNotifs.filter(n => n.message.toLowerCase().includes('due') || n.message.toLowerCase().includes('overdue'));
      }
    }

    // Seed 3-day sample feed if list is empty to provide a rich feed
    if (displayNotifs.length === 0 && systemNotifications.length === 0) {
      displayNotifs = [
        { id: '1', message: '• New Sales Today: 14 Orders Processed', timestamp: new Date(Date.now() - 20 * 60000).toISOString(), unread: true },
        { id: '2', message: '• Payment Received: ₹14,500 from Apex Builders', timestamp: new Date(Date.now() - 2 * 3600000).toISOString(), unread: true },
        { id: '3', message: '• Payment Due Reminder: Invoice #INV-2026-004 due tomorrow', timestamp: new Date(Date.now() - 5 * 3600000).toISOString(), unread: false },
        { id: '4', message: '• Low Stock Alert: Coffee Beans (3 units left)', timestamp: new Date(Date.now() - 12 * 3600000).toISOString(), unread: false },
        { id: '5', message: '• Purchase Order Approved: PO-9912 by Admin', timestamp: new Date(Date.now() - 24 * 3600000).toISOString(), unread: false },
        { id: '6', message: '• Invoice Overdue: #INV-2026-001 is 2 days overdue', timestamp: new Date(Date.now() - 36 * 3600000).toISOString(), unread: false },
        { id: '7', message: '• Customer Activity: John Doe updated billing profile', timestamp: new Date(Date.now() - 48 * 3600000).toISOString(), unread: false },
        { id: '8', message: '• System Updates: GST PDF Generator upgraded to v2.1', timestamp: new Date(Date.now() - 60 * 3600000).toISOString(), unread: false }
      ];
    }

    displayNotifs.forEach(n => {
      const timeAgo = formatTimeAgo(n.timestamp);
      const div = document.createElement('div');
      div.className = `notification-item ${n.unread ? 'unread' : ''}`;
      div.style.cssText = `padding: 8px 10px; border-radius: var(--radius-xs); background: ${n.unread ? 'var(--primary-color-light)' : 'var(--bg)'}; border-left: 3px solid ${n.unread ? 'var(--primary-color)' : 'var(--border)'}; font-size: 0.78rem; color: var(--ink-secondary); line-height: 1.35; cursor: pointer; transition: all var(--transition);`;
      
      div.innerHTML = `
        <div style="font-weight: ${n.unread ? '700' : '500'}; color: var(--ink);">${n.message}</div>
        <div style="font-size: 0.68rem; color: var(--ink-muted); margin-top: 4px; text-align: right;"><i class="fa-regular fa-clock"></i> ${timeAgo}</div>
      `;
      
      div.onclick = () => {
        n.unread = false;
        localStorage.setItem('system_notifications', JSON.stringify(systemNotifications));
        updateNotificationsUI();
      };
      
      list.appendChild(div);
    });
  }
}

let currentNotifFilter = 'all';

function filterNotifications(category, event) {
  if (event) event.stopPropagation();
  currentNotifFilter = category;
  document.querySelectorAll('.notif-pill').forEach(pill => pill.classList.remove('active'));
  if (event && event.target) event.target.classList.add('active');
  updateNotificationsUI();
}

function viewAllNotifications() {
  closeAllHeaderDropdowns();
  switchTab('reports');
  showToast('Showing complete 3-day notification audit trail in Analytics', 'info');
}

function markAllNotificationsAsRead(event) {
  if (event) event.stopPropagation();
  systemNotifications.forEach(n => n.unread = false);
  localStorage.setItem('system_notifications', JSON.stringify(systemNotifications));
  updateNotificationsUI();
  showToast("All notifications marked as read", "info");
}

function toggleNotificationsDropdown(event) {
  if (event) event.stopPropagation();
  const dropdown = document.getElementById('notificationDropdown');
  if (dropdown) {
    const isHidden = dropdown.style.display === 'none';
    closeAllHeaderDropdowns();
    dropdown.style.display = isHidden ? 'block' : 'none';
  }
}

function closeAllHeaderDropdowns() {
  const notif = document.getElementById('notificationDropdown');
  if (notif) notif.style.display = 'none';
  
  const create = document.getElementById('createMenuDropdown');
  if (create) create.style.display = 'none';

  const profile = document.getElementById('profileDropdown');
  if (profile) profile.style.display = 'none';
}

document.addEventListener('click', () => {
  closeAllHeaderDropdowns();
});

// + Create Dropdown Logic
function toggleCreateMenu(event) {
  if (event) event.stopPropagation();
  const dropdown = document.getElementById('createMenuDropdown');
  if (dropdown) {
    const isHidden = dropdown.style.display === 'none';
    closeAllHeaderDropdowns();
    if (isHidden) {
      dropdown.style.display = 'block';
      const filterInput = document.getElementById('createMenuFilterInput');
      if (filterInput) {
        filterInput.value = '';
        filterCreateMenuOptions();
        setTimeout(() => filterInput.focus(), 50);
      }
    }
  }
}

function filterCreateMenuOptions() {
  const query = (document.getElementById('createMenuFilterInput')?.value || '').toLowerCase().trim();
  const items = document.querySelectorAll('#createMenuGrid .create-item');
  items.forEach(item => {
    const text = item.textContent.toLowerCase();
    item.style.display = text.includes(query) ? 'flex' : 'none';
  });
}

function handleCreateAction(actionType) {
  closeAllHeaderDropdowns();
  switch (actionType) {
    case 'invoice':
    case 'pro_forma_invoice':
    case 'quotation':
      switchTab('pos');
      showToast(`Switched to POS for ${actionType.replace(/_/g, ' ').toUpperCase()}`, 'info');
      break;
    case 'purchase_invoice':
    case 'purchase_order':
    case 'delivery_challan':
    case 'purchase_return':
    case 'stock_in':
      switchTab('inventory');
      showToast(`Initiated ${actionType.replace(/_/g, ' ').toUpperCase()} workflow in Inventory`, 'info');
      break;
    case 'sales_order':
    case 'sales_return':
      switchTab('sales');
      showToast(`Opened Sales History for ${actionType.replace(/_/g, ' ').toUpperCase()}`, 'info');
      break;
    case 'expense':
    case 'pay_out':
      switchTab('finance');
      showToast(`Opened Finance for ${actionType.replace(/_/g, ' ').toUpperCase()}`, 'info');
      break;
    case 'customer':
    case 'pay_in':
      openCustomerModal();
      break;
    case 'vendor':
      switchTab('crm');
      showToast('Opened Vendor & CRM Management', 'info');
      break;
    case 'product':
      openProductModal();
      break;
    default:
      showToast(`Action ${actionType} triggered`, 'success');
  }
}

// AI Global Search & Shortcuts
let universalSearchTimer = null;
let universalSearchItems = [];
let universalSearchIndex = -1;

function handleUniversalSearchInput(event) {
  clearTimeout(universalSearchTimer);
  const query = event.target.value.trim();
  if (query.length < 2) {
    closeUniversalSearch();
    return;
  }
  universalSearchTimer = setTimeout(() => loadUniversalSearch(query), 180);
}

async function loadUniversalSearch(query) {
  const resultsBox = document.getElementById('universalSearchResults');
  if (!resultsBox) return;
  resultsBox.innerHTML = '<div class="universal-search-group">Searching your business...</div>';
  resultsBox.classList.add('open');
  try {
    const response = await fetch(`/api/v1/search?q=${encodeURIComponent(query)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Search failed.');
    universalSearchItems = [
      {
        type: 'ai_command',
        title: `Ask Copilot: “${query}”`,
        subtitle: 'Grounded answer · actions require approval',
        tab: 'automation',
        query
      },
      ...(payload.results || [])
    ];
    universalSearchIndex = -1;
    renderUniversalSearch();
  } catch (error) {
    universalSearchItems = [];
    resultsBox.innerHTML = `<div class="universal-search-group">${escapeHtml(error.message)}</div>`;
  }
}

function renderUniversalSearch() {
  const resultsBox = document.getElementById('universalSearchResults');
  if (!resultsBox) return;
  const iconByType = {
    ai_command: 'fa-sparkles',
    product: 'fa-box',
    customer: 'fa-user',
    supplier: 'fa-truck-field',
    invoice: 'fa-file-invoice',
    payment: 'fa-money-bill-transfer',
    warehouse: 'fa-warehouse'
  };
  resultsBox.innerHTML = universalSearchItems.length
    ? `<div class="universal-search-group">Commands &amp; records</div>${universalSearchItems.map((item, index) => `
      <button type="button" class="universal-search-item ${index === universalSearchIndex ? 'active' : ''}" role="option" aria-selected="${index === universalSearchIndex}" onclick="activateUniversalSearchResult(${index})">
        <i class="fa-solid ${iconByType[item.type] || 'fa-magnifying-glass'}"></i>
        <span class="universal-search-copy"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.subtitle || '')}</span></span>
        <span class="universal-search-type">${escapeHtml(String(item.type || '').replace('_', ' '))}</span>
      </button>`).join('')}`
    : '<div class="universal-search-group">No matching records</div>';
  resultsBox.classList.add('open');
  resultsBox.querySelector('.universal-search-item.active')?.scrollIntoView({ block: 'nearest' });
}

function activateUniversalSearchResult(index) {
  const item = universalSearchItems[index];
  if (!item) return;
  closeUniversalSearch();
  const input = document.getElementById('globalAISearchInput');
  if (input) input.value = '';
  if (item.type === 'ai_command') {
    askSuggestedQuestion(item.query);
    return;
  }
  switchTab(item.tab || 'dashboard');
  showToast(`${item.title} opened in ${String(item.type || 'record').replace('_', ' ')} workspace.`, 'success');
}

function closeUniversalSearch() {
  const resultsBox = document.getElementById('universalSearchResults');
  if (resultsBox) {
    resultsBox.classList.remove('open');
    resultsBox.innerHTML = '';
  }
  universalSearchItems = [];
  universalSearchIndex = -1;
}

function handleGlobalAISearch(event) {
  if (event.key === 'ArrowDown' && universalSearchItems.length) {
    event.preventDefault();
    universalSearchIndex = Math.min(universalSearchIndex + 1, universalSearchItems.length - 1);
    renderUniversalSearch();
  } else if (event.key === 'ArrowUp' && universalSearchItems.length) {
    event.preventDefault();
    universalSearchIndex = Math.max(universalSearchIndex - 1, 0);
    renderUniversalSearch();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const query = event.target.value.trim();
    if (!query) return;
    if (universalSearchIndex >= 0) activateUniversalSearchResult(universalSearchIndex);
    else askSuggestedQuestion(query);
  } else if (event.key === 'Escape') {
    closeUniversalSearch();
    event.target.blur();
  }
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    const input = document.getElementById('globalAISearchInput');
    if (input) input.focus();
  }
  if (e.key === 'Escape') closeUniversalSearch();
  if (e.altKey && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    toggleThemeMode();
  }
  if (e.altKey && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    toggleCalculatorModal();
  }
  if (e.key === 'F2') {
    e.preventDefault();
    switchTab('pos');
    document.getElementById('posSearchInput')?.focus();
  }
  if (e.key === 'F4') {
    e.preventDefault();
    if (currentTab === 'barcodes') openBarcodeWorkspaceView('scanner');
    else openScannerModal();
  }
  if (e.key === 'F8') {
    e.preventDefault();
    if (currentTab === 'pos') submitPOSCheckout();
    else openCustomerModal();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && currentTab === 'pos') {
    e.preventDefault();
    submitPOSCheckout();
  }
  if (e.altKey && e.key.toLowerCase() === 'i') {
    e.preventDefault();
    switchTab('invoices');
  }
});

document.addEventListener('click', event => {
  if (!event.target.closest('.header-ai-search-box')) closeUniversalSearch();
});

// Profile Dropdown & Profile Data Updates
function toggleProfileDropdown(event) {
  if (event) event.stopPropagation();
  const dropdown = document.getElementById('profileDropdown');
  if (dropdown) {
    const isHidden = dropdown.style.display === 'none';
    closeAllHeaderDropdowns();
    if (isHidden) {
      dropdown.style.display = 'block';
      updateProfileHeaderData();
    }
  }
}

function updateProfileHeaderData() {
  const role = (localStorage.getItem('role') || 'Admin').toUpperCase();
  const username = localStorage.getItem('username') || 'admin';
  const displayName = localStorage.getItem('fullName') || username || 'Aman';
  
  const nameEl = document.getElementById('menuHeaderName');
  const emailEl = document.getElementById('menuHeaderEmail');
  const phoneEl = document.getElementById('menuHeaderPhone');
  const roleEl = document.getElementById('menuHeaderRole');
  const avatarEl = document.getElementById('menuHeaderAvatar');
  
  const hAvatar = document.getElementById('headerAvatar');
  const hName = document.getElementById('headerProfileName');
  const hRole = document.getElementById('headerProfileRole');

  if (nameEl) nameEl.innerText = username === 'admin' ? 'System Admin' : displayName;
  if (emailEl) emailEl.innerText = `${username.toLowerCase()}@inventia.com`;
  if (phoneEl) phoneEl.innerText = username === 'admin' ? '+91 98765 43210' : '+91 91234 56789';
  if (roleEl) roleEl.innerText = role;
  if (avatarEl) avatarEl.innerText = displayName.charAt(0).toUpperCase();

  if (hAvatar) hAvatar.innerText = displayName.charAt(0).toUpperCase();
  if (hName) hName.innerText = username === 'admin' ? 'Admin' : displayName;
  if (hRole) hRole.innerText = role;
}

function toggleThemeMode() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme-mode') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme-mode', next);
  localStorage.setItem('themeMode', next);
  syncThemeIndicators();
  
  showToast(`Switched to ${next === 'dark' ? 'Dark' : 'Light'} Daily Mode`, 'info');
}

function toggleSidebarMenu() {
  const sidebar = document.querySelector('aside.sidebar');
  const main = document.querySelector('main.main-content');
  if (window.matchMedia('(max-width: 768px)').matches) {
    sidebar?.classList.toggle('mobile-open');
    document.body.classList.toggle('sidebar-open', sidebar?.classList.contains('mobile-open'));
    return;
  }
  if (sidebar) sidebar.classList.toggle('collapsed');
  if (main) main.classList.toggle('expanded');
  localStorage.setItem('inventia_sidebar_collapsed', String(sidebar?.classList.contains('collapsed')));
}

async function ensureRazorpayLoaded() {
  if (window.Razorpay) return true;

  const existing = document.querySelector('script[data-razorpay-sdk="true"]');
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve(true), { once: true });
      existing.addEventListener('error', () => reject(new Error('Razorpay SDK failed to load.')), { once: true });
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.dataset.razorpaySdk = 'true';
    script.onload = () => resolve(true);
    script.onerror = () => reject(new Error('Razorpay SDK failed to load.'));
    document.head.appendChild(script);
  });
}

// Profile Modal Actions
function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.style.display = 'none';
}
function openKeyboardShortcutsModal() {
  closeAllHeaderDropdowns();
  const m = document.getElementById('shortcutsModal');
  if (m) m.style.display = 'grid';
}
function openHelpSupportModal() {
  closeAllHeaderDropdowns();
  const m = document.getElementById('helpModal');
  if (m) m.style.display = 'grid';
}
function openPremiumOfferModal() {
  closeAllHeaderDropdowns();
  const m = document.getElementById('premiumModal');
  if (m) m.style.display = 'grid';
}
function openSubscriptionModal() {
  closeAllHeaderDropdowns();
  const m = document.getElementById('premiumModal');
  if (m) m.style.display = 'grid';
}
function openReferralModal() {
  closeAllHeaderDropdowns();
  const m = document.getElementById('referralModal');
  if (m) m.style.display = 'grid';
}
function openAppDownloadModal() {
  closeAllHeaderDropdowns();
  const m = document.getElementById('appDownloadModal');
  if (m) m.style.display = 'grid';
}
function copyReferralLink() {
  const input = document.getElementById('referralLinkInput');
  if (input) {
    input.select();
    navigator.clipboard.writeText(input.value);
    showToast('Referral link copied to clipboard!', 'success');
  }
}

function formatTimeAgo(timestamp) {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// UI data mirrors; all production mutations are committed by the backend.
let brands = [];
let categories = [];
let products = [];
let customers = [];
let suppliers = [];
let sales = [];
let transfers = [];
let warehouses = [];
let staff = [];
let barcodeProducts = [];
let barcodeTemplates = [];
let barcodeLayouts = [];
let barcodeSettings = null;
let activeBarcodeView = 'overview';
let selectedBarcodeAssignments = new Set();
let barcodeProductSearchTimer = null;
let barcodeCameraStream = null;
let barcodeCameraTimer = null;

const BARCODE_VIEW_ROUTES = Object.freeze({
  overview: '/barcodes',
  products: '/barcodes/products',
  generate: '/barcodes/generate',
  designer: '/barcodes/templates',
  batch: '/barcodes/batch-print',
  scanner: '/barcodes/scanner',
  queue: '/barcodes/print-queue',
  history: '/barcodes/history',
  analytics: '/barcodes/analytics',
  recommendations: '/barcodes/recommendations',
  settings: '/barcodes/settings'
});

const BARCODE_ROUTE_VIEWS = new Map(
  Object.entries(BARCODE_VIEW_ROUTES).map(([view, route]) => [route, view])
);

function normalizeClientPath(pathname = window.location.pathname) {
  const normalized = String(pathname || '/').replace(/\/+$/, '');
  return normalized || '/';
}

function barcodeViewForRoute(pathname = window.location.pathname) {
  return BARCODE_ROUTE_VIEWS.get(normalizeClientPath(pathname)) || null;
}

function syncBarcodeClientRoute(view, { replace = false } = {}) {
  const route = BARCODE_VIEW_ROUTES[view];
  if (!route || normalizeClientPath() === route) return;
  window.history[replace ? 'replaceState' : 'pushState'](
    { tab: 'barcodes', barcodeView: view },
    '',
    route
  );
}

function restoreBarcodeClientRoute() {
  const view = barcodeViewForRoute();
  if (!view) return false;
  openBarcodeWorkspaceView(view, null, { syncHistory: false })
    .catch(error => showToast(error.message, 'error'));
  return true;
}

window.addEventListener('popstate', () => {
  const view = barcodeViewForRoute();
  if (view) {
    openBarcodeWorkspaceView(view, null, { syncHistory: false })
      .catch(error => showToast(error.message, 'error'));
  } else if (currentTab === 'barcodes') {
    switchTab('dashboard');
  }
});

// Inject the appropriate compatibility or Phase 5 access token and rotate sessions.
const originalFetch = window.fetch;
window.fetch = async function (url, options = {}) {
  const cleanUrl = typeof url === 'string' ? url : (url.url || '');
  const isV1 = cleanUrl.startsWith('/api/v1/');
  const isAuthRequest = cleanUrl.includes('/auth/login') || cleanUrl.includes('/auth/refresh');
  if (cleanUrl.startsWith('/api/') && !isAuthRequest) {
    const token = localStorage.getItem(isV1 ? 'phase5AccessToken' : 'token');
    const role = localStorage.getItem('role');
    const userId = localStorage.getItem('userId');

    if (token) {
      const headers = new Headers(options.headers || {});
      headers.set('Authorization', `Bearer ${token}`);
      if (!isV1 && role) headers.set('x-user-role', role);
      if (!isV1 && userId) headers.set('x-user-id', userId);
      if (!isV1 && localStorage.getItem('activeOrganizationId')) {
        headers.set('x-inventia-organization', localStorage.getItem('activeOrganizationId'));
      }
      if (isV1 && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(options.method || 'GET').toUpperCase()) && !headers.has('Idempotency-Key')) {
        headers.set('Idempotency-Key', crypto.randomUUID());
      }
      options.headers = headers;
    }
  }
  let response = await originalFetch(url, options);
  if (isV1 && response.status === 401 && !isAuthRequest && localStorage.getItem('phase5RefreshToken')) {
    const refreshResponse = await originalFetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: localStorage.getItem('phase5RefreshToken') })
    });
    if (refreshResponse.ok) {
      const session = await refreshResponse.json();
      savePhase5Session(session);
      const retryHeaders = new Headers(options.headers || {});
      retryHeaders.set('Authorization', `Bearer ${session.access_token}`);
      response = await originalFetch(url, { ...options, headers: retryHeaders });
    }
  }
  return response;
};

// Auth and Session Helper Functions
function getAuthHeaders(extraHeaders = {}) {
  const token = localStorage.getItem('token') || '';
  const role = localStorage.getItem('role') || '';
  const userId = localStorage.getItem('userId') || '';
  return {
    'Authorization': `Bearer ${token}`,
    'x-user-role': role,
    'x-user-id': userId,
    'Content-Type': 'application/json',
    ...extraHeaders
  };
}

function updateProfileUI() {
  const name = localStorage.getItem('fullName') || 'Admin';
  const role = (localStorage.getItem('role') || 'admin').toLowerCase();
  
  // Update Header Profile
  const profileNameEl = document.querySelector('.profile-name');
  const profileRoleEl = document.querySelector('.profile-role');
  const profileAvatarEl = document.querySelector('.profile-avatar');
  if (profileNameEl) profileNameEl.innerText = name;
  if (profileRoleEl) profileRoleEl.innerText = role.charAt(0).toUpperCase() + role.slice(1);
  if (profileAvatarEl && name) profileAvatarEl.innerText = name.charAt(0).toUpperCase();

  // Update the executive dashboard greeting without disturbing its layout.
  const dashboardUserName = document.getElementById('dashboardUserName');
  const dashboardGreeting = document.getElementById('dashboardGreeting');
  if (dashboardUserName) dashboardUserName.innerText = name.split(' ')[0];
  if (dashboardGreeting) {
    const hour = new Date().getHours();
    dashboardGreeting.innerText = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  }

  const welcomeEl = document.querySelector('.dashboard-welcome');
  if (welcomeEl) {
    const timeSpan = document.getElementById('liveTimestamp');
    welcomeEl.innerHTML = `Here is your business at a glance · <span id="liveTimestamp">${timeSpan ? timeSpan.innerHTML : ''}</span>`;
  }

  // Role-based navigation button visibility
  const navButtons = document.querySelectorAll('.nav-menu > .nav-btn, .nav-menu > .nav-dropdown-wrapper');
  navButtons.forEach(btn => {
    btn.style.display = '';

    const tab = btn.getAttribute('data-tab');
    const containsRestrictedTeamTools = btn.querySelector?.('[data-tab="staff"]');
    const isAnalytics = tab === 'reports';

    if (role === 'manager') {
      if (tab === 'settings-tab' || containsRestrictedTeamTools) {
        btn.style.display = 'none';
      }
    } else if (role === 'cashier' || role === 'warehouse_staff') {
      if (tab === 'settings-tab' || containsRestrictedTeamTools || isAnalytics) {
        btn.style.display = 'none';
      }
    }
  });

  // Redirect to dashboard if trying to access restricted tab
  if (role === 'manager' && (currentTab === 'staff' || currentTab === 'settings-tab' || currentTab === 'backup-tab')) {
    switchTab('dashboard');
  } else if ((role === 'cashier' || role === 'warehouse_staff') && (currentTab === 'staff' || currentTab === 'settings-tab' || currentTab === 'backup-tab' || currentTab === 'reports')) {
    switchTab('dashboard');
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const usernameEl = document.getElementById('loginUsername');
  const passwordEl = document.getElementById('loginPassword');
  const errorEl = document.getElementById('loginErrorMessage');
  
  if (!usernameEl || !passwordEl) return;
  
  const username = usernameEl.value.trim();
  const password = passwordEl.value;
  const organizationSlug = document.getElementById('loginOrganization')?.value.trim() || 'northwind-interiors';
  
  if (errorEl) {
    errorEl.style.display = 'none';
    errorEl.innerText = '';
  }

  try {
    const res = await originalFetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization_slug: organizationSlug, username, password })
    });

    const contentType = res.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const text = await res.text();
      console.error('Non-JSON response:', text);
      throw new Error('Database connection error. Please verify your Supabase configuration in Vercel environment variables.');
    }

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error?.message || 'Invalid organization, username, or password.');
    }

    savePhase5Session(data);
    localStorage.setItem('userId', data.user.id);
    localStorage.setItem('username', data.user.username);
    localStorage.setItem('fullName', data.user.full_name);
    localStorage.setItem('role', data.user.role);
    localStorage.setItem('activeOrganizationId', data.organization.id);
    localStorage.setItem('activeOrganizationSlug', data.organization.slug);
    localStorage.setItem('activeOrganizationName', data.organization.name);

    // Keep Phase 1-4 compatibility routes active for the default tenant during migration.
    const legacyResponse = await originalFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (legacyResponse.ok) {
      const legacy = await legacyResponse.json();
      if (legacy.success && legacy.token) localStorage.setItem('token', legacy.token);
    } else {
      localStorage.setItem('token', data.access_token);
    }

    // Hide Login container
    const loginContainer = document.getElementById('loginContainer');
    if (loginContainer) loginContainer.style.display = 'none';

    // Clear login inputs
    usernameEl.value = '';
    passwordEl.value = '';

    // Update Profile and Initialize POS App
    updateProfileUI();
    initializePOSApp();
  } catch (err) {
    console.error('Login error:', err);
    if (errorEl) {
      errorEl.innerText = err.message || 'Login failed. Please try again.';
      errorEl.style.display = 'block';
    }
  }
}

async function logout() {
  currentAiConversationId = null;
  const refreshToken = localStorage.getItem('phase5RefreshToken');
  if (refreshToken) {
    await originalFetch('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken })
    }).catch(() => {});
  }
  localStorage.clear();
  window.dispatchEvent(new CustomEvent('inventia:session-changed', { detail: { authenticated: false } }));
  
  // Show Login Overlay
  const loginContainer = document.getElementById('loginContainer');
  if (loginContainer) loginContainer.style.display = 'flex';
  
  // Reset active panel to dashboard
  currentTab = 'dashboard';
}

function initializePOSApp() {
  setupNavigation();
  initializeSettingsNavigation();
  initializeWorkspaceSwitcher();
  initializeWorkspaceArchitecture();
  loadDashboardData();
  loadPOSCatalog();
  renderPOSCategoryFilters();
  loadInventoryTable();
  loadTransferLogs();
  loadCustomerLedger();
  loadBrandsAndCategories();
  loadStaffList();
  switchReportTab('sales');
  loadSalesPage();
  loadCategoryManagement();
  loadBrandManagement();
  loadWarehouseManagement();
  populateDropdowns();
  switchSubTab('categories-manager');
  startLiveTimestamp();
  loadDashboardAi();
  loadAiStatus();
  loadEnterpriseWorkspaces();
  loadPosPaymentMethods();
  restoreBarcodeClientRoute();
  
  // Connect APIs if online
  fetch('/api/status')
    .then(r => r.json())
    .then(status => {
      console.log('Backend server is alive, loading live database records...');
      syncWithBackend();
    })
    .catch(() => {
      showToast('The backend is unavailable. Changes are disabled until the connection recovers.', 'error');
  });
}

function initializeSettingsNavigation() {
  if (!settingsNavigationInitialized) {
    document.querySelectorAll('.settings-nav-item').forEach(button => {
      button.addEventListener('click', () => selectSettingsSection(button.dataset.settingsSection));
    });
    settingsNavigationInitialized = true;
  }
  selectSettingsSection(document.querySelector('.settings-nav-item.active')?.dataset.settingsSection || 'organization');
}

function selectSettingsSection(section) {
  const module = settingsModules[section] || settingsModules.organization;
  const overview = document.getElementById('settingsModuleOverview');
  if (!overview) return;

  document.querySelectorAll('.settings-nav-item').forEach(button => {
    button.classList.toggle('active', button.dataset.settingsSection === section);
  });

  overview.innerHTML = `
    <div class="settings-module-header">
      <div class="settings-module-heading">
        <span class="settings-module-icon"><i class="fa-solid ${module.icon}"></i></span>
        <div><h3>${module.title}</h3><p>${module.description}</p></div>
      </div>
      <span class="settings-module-count">${module.items.length} settings</span>
    </div>
    <div class="settings-link-grid">
      ${module.items.map(item => `<button class="settings-link-card" type="button" data-setting-name="${item}"><i class="fa-solid fa-arrow-up-right-from-square"></i><span>${item}</span><small>Configure ${item.toLowerCase()} for this workspace.</small></button>`).join('')}
    </div>`;

  overview.querySelectorAll('[data-setting-name]').forEach(button => {
    button.addEventListener('click', () => openSettingsItem(button.dataset.settingName));
  });

  document.getElementById('settingsOrganizationForm')?.classList.toggle('active', section === 'organization');
  document.getElementById('settingsAiForm')?.classList.toggle('active', section === 'ai');
}

function openSettingsItem(item) {
  const target = settingsDestinations[item];
  if (target) {
    switchTab(target);
    return;
  }
  showToast(`${item} is ready to configure in this workspace.`, 'info');
}

function openSettingsSection(section) {
  switchTab('settings-tab');
  selectSettingsSection(section);
}

function initializeWorkspaceSwitcher() {
  const activeName = localStorage.getItem('activeOrganizationName');
  if (activeName) updateWorkspaceLabel(activeName, 'Active organization');
  loadOrganizationMenu();
  if (!document.body.dataset.workspaceListenerReady) {
    document.addEventListener('click', event => {
      if (!event.target.closest('.workspace-switcher') && !event.target.closest('.workspace-menu')) {
        closeWorkspaceMenu();
      }
    });
    document.body.dataset.workspaceListenerReady = 'true';
  }
}

function toggleWorkspaceMenu(event) {
  event.stopPropagation();
  const menu = document.getElementById('workspaceMenu');
  const trigger = document.querySelector('.workspace-switcher');
  if (!menu || !trigger) return;
  const opening = !menu.classList.contains('active');
  menu.classList.toggle('active', opening);
  trigger.setAttribute('aria-expanded', String(opening));
}

function closeWorkspaceMenu() {
  document.getElementById('workspaceMenu')?.classList.remove('active');
  document.querySelector('.workspace-switcher')?.setAttribute('aria-expanded', 'false');
}

async function selectOrganization(organizationId) {
  if (organizationId === localStorage.getItem('activeOrganizationId')) return closeWorkspaceMenu();
  try {
    const response = await fetch(`/api/v1/organizations/${encodeURIComponent(organizationId)}/switch`, { method: 'POST' });
    const session = await response.json();
    if (!response.ok) throw new Error(session.error?.message || 'Organization switch failed.');
    savePhase5Session(session);
    localStorage.setItem('activeOrganizationId', session.organization.id);
    localStorage.setItem('activeOrganizationSlug', session.organization.slug);
    localStorage.setItem('activeOrganizationName', session.organization.name);
    updateWorkspaceLabel(session.organization.name, 'Active organization');
    closeWorkspaceMenu();
    await loadEnterpriseWorkspaces();
    showToast(`Switched to ${session.organization.name}.`, 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function updateWorkspaceLabel(name, description) {
  const copy = document.querySelector('.workspace-copy');
  const avatar = document.querySelector('.workspace-avatar');
  if (copy) copy.innerHTML = `<strong>${name}</strong><small>${description}</small>`;
  if (avatar) avatar.textContent = name.split(/\s+/).map(word => word[0]).join('').slice(0, 2).toUpperCase();
}

function savePhase5Session(session) {
  localStorage.setItem('phase5AccessToken', session.access_token);
  localStorage.setItem('phase5RefreshToken', session.refresh_token);
  if (session.user) {
    localStorage.setItem('userId', session.user.id);
    localStorage.setItem('username', session.user.username);
    localStorage.setItem('fullName', session.user.full_name);
    localStorage.setItem('role', session.user.role);
    localStorage.setItem('permissions', JSON.stringify(session.user.permissions || []));
  }
  window.dispatchEvent(new CustomEvent('inventia:session-changed', {
    detail: {
      authenticated: true,
      organizationId: session.organization?.id || localStorage.getItem('activeOrganizationId')
    }
  }));
}

async function loadOrganizationMenu() {
  const container = document.getElementById('organizationMenuItems');
  if (!container || !localStorage.getItem('phase5AccessToken')) return;
  try {
    const response = await fetch('/api/v1/organizations');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Could not load organizations.');
    container.innerHTML = data.organizations.map(organization => `
      <button type="button" class="${organization.id === data.active_organization_id ? 'active' : ''}" onclick="selectOrganization('${organization.id}')">
        <span>${escapeHtml(getInitials(organization.name))}</span>
        ${escapeHtml(organization.name)}
        ${organization.id === data.active_organization_id ? '<i class="fa-solid fa-check"></i>' : ''}
      </button>`).join('');
  } catch (error) {
    container.innerHTML = `<button type="button"><span>!</span> ${escapeHtml(error.message)}</button>`;
  }
}

async function createOrganization() {
  const name = window.prompt('Organization name');
  if (!name) return;
  const suggested = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const slug = window.prompt('Organization slug', suggested);
  if (!slug) return;
  try {
    const response = await fetch('/api/v1/organizations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, slug })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Organization creation failed.');
    await loadOrganizationMenu();
    showToast(`${data.name} was provisioned with an isolated database.`, 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

const enterpriseWorkspace = {
  suppliers: [],
  purchaseOrders: [],
  approvals: []
};

async function loadEnterpriseWorkspaces() {
  if (!localStorage.getItem('phase5AccessToken')) return;
  try {
    const [supplierResponse, orderResponse, approvalResponse, productResponse, warehouseResponse] = await Promise.all([
      fetch('/api/v1/suppliers'),
      fetch('/api/v1/trade/purchase-orders'),
      fetch('/api/v1/approvals'),
      fetch('/api/v1/products?limit=500'),
      fetch('/api/v1/reference/warehouses')
    ]);
    const responses = [supplierResponse, orderResponse, approvalResponse, productResponse, warehouseResponse];
    const payloads = await Promise.all(responses.map(response => response.json()));
    const failedIndex = responses.findIndex(response => !response.ok);
    if (failedIndex >= 0) throw new Error(payloads[failedIndex].error?.message || 'Enterprise workspace could not be loaded.');
    enterpriseWorkspace.suppliers = payloads[0].suppliers;
    enterpriseWorkspace.purchaseOrders = payloads[1].documents;
    enterpriseWorkspace.approvals = payloads[2].approvals;
    suppliers = enterpriseWorkspace.suppliers;
    products = payloads[3].products.map(product => ({ ...product, stock: Number(product.quantity_on_hand || 0) }));
    warehouses = payloads[4].items;
    renderEnterpriseSuppliers();
    renderEnterprisePurchases();
    await loadEnterpriseDashboard();
  } catch (error) {
    const purchaseTable = document.getElementById('purchaseOrdersTable');
    const supplierTable = document.getElementById('suppliersTable');
    if (purchaseTable) purchaseTable.innerHTML = `<tr><td colspan="6">${escapeHtml(error.message)}</td></tr>`;
    if (supplierTable) supplierTable.innerHTML = `<tr><td colspan="6">${escapeHtml(error.message)}</td></tr>`;
  }
}

async function loadEnterpriseDashboard() {
  const response = await fetch('/api/v1/dashboard/summary');
  const summary = await response.json();
  if (!response.ok) throw new Error(summary.error?.message || 'Dashboard summary could not be loaded.');
  const values = {
    kpiSales: summary.today_sale_count,
    kpiRevenue: `${currencySymbol}${Number(summary.today_revenue || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    kpiProfit: `${currencySymbol}${Number(summary.gross_profit || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    kpiLowStock: summary.low_stock_count,
    kpiCustomers: summary.customer_count,
    kpiOutstanding: `${currencySymbol}${Number(summary.customer_outstanding || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    dashboardCustomerCount: summary.customer_count,
    dashboardOrderCount: summary.sale_count,
    dashboardProductCount: summary.product_count,
    kpiValuation: `${currencySymbol}${Number(summary.inventory_value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  };
  Object.entries(values).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  });
}

function renderEnterpriseSuppliers() {
  const table = document.getElementById('suppliersTable');
  if (!table) return;
  if (!enterpriseWorkspace.suppliers.length) {
    table.innerHTML = '<tr><td colspan="6">No suppliers yet. Add the first supplier to begin purchasing.</td></tr>';
    return;
  }
  table.innerHTML = enterpriseWorkspace.suppliers.map(supplier => `
    <tr>
      <td><strong>${escapeHtml(supplier.name)}</strong><small>${escapeHtml(supplier.legal_name || '')}</small></td>
      <td>${escapeHtml(supplier.email || supplier.phone || '—')}</td>
      <td>${escapeHtml(supplier.profile_gstin || supplier.gstin || '—')}</td>
      <td>${Number(supplier.payment_terms_days || supplier.payment_terms || 0)} days</td>
      <td>${Number(supplier.lead_time_days || 0)} days</td>
      <td>${supplier.rating == null ? '—' : `${Number(supplier.rating).toFixed(1)} / 5`}</td>
    </tr>`).join('');
}

function renderEnterprisePurchases() {
  const table = document.getElementById('purchaseOrdersTable');
  if (!table) return;
  if (!enterpriseWorkspace.purchaseOrders.length) {
    table.innerHTML = '<tr><td colspan="6">No purchase orders yet. New orders remain drafts until submitted and approved.</td></tr>';
    return;
  }
  table.innerHTML = enterpriseWorkspace.purchaseOrders.map(order => {
    const approval = enterpriseWorkspace.approvals.find(item => item.entity_type === 'purchase_order' && String(item.entity_id) === String(order.id) && item.status === 'pending');
    const actions = [];
    if (order.status === 'draft') actions.push(`<button class="action-btn secondary compact" onclick="submitPurchaseForApproval(${order.id})">Submit</button>`);
    if (order.status === 'pending_approval' && approval && ['admin', 'manager'].includes(localStorage.getItem('role'))) {
      actions.push(`<button class="action-btn primary compact" onclick="approvePurchaseOrder(${approval.id})">Approve</button>`);
    }
    if (['approved', 'partially_fulfilled'].includes(order.status)) actions.push(`<button class="action-btn secondary compact" onclick="receivePurchaseOrder(${order.id})">Receive</button>`);
    return `<tr>
      <td><strong>${escapeHtml(order.document_no)}</strong></td>
      <td>${escapeHtml(order.party_name || `Supplier #${order.party_id}`)}</td>
      <td>${currencySymbol}${Number(order.grand_total || 0).toFixed(2)}</td>
      <td><span class="status-badge ${escapeHtml(order.status)}">${escapeHtml(order.status.replace(/_/g, ' '))}</span></td>
      <td>${new Date(order.created_at).toLocaleDateString()}</td>
      <td><div class="panel-actions">${actions.join('') || '—'}</div></td>
    </tr>`;
  }).join('');
}

function openSupplierModal() {
  document.getElementById('supplierModal').style.display = 'grid';
}

async function submitEnterpriseSupplier(event) {
  event.preventDefault();
  const submit = event.submitter;
  await executeAction(submit, async () => {
    const payload = {
      name: document.getElementById('supplierName').value.trim(),
      legal_name: document.getElementById('supplierLegalName').value.trim() || undefined,
      email: document.getElementById('supplierEmail').value.trim() || undefined,
      phone: document.getElementById('supplierPhone').value.trim() || undefined,
      gstin: document.getElementById('supplierGstin').value.trim() || undefined,
      payment_terms_days: Number(document.getElementById('supplierTerms').value || 0),
      lead_time_days: Number(document.getElementById('supplierLeadTime').value || 0),
      rating: document.getElementById('supplierRating').value ? Number(document.getElementById('supplierRating').value) : undefined
    };
    const response = await fetch('/api/v1/suppliers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Supplier creation failed.');
    closeModal('supplierModal');
    event.target.reset();
    await loadEnterpriseWorkspaces();
  }, 'Supplier saved successfully.');
}

function openPurchaseOrderModal() {
  const supplierSelect = document.getElementById('purchaseSupplier');
  const warehouseSelect = document.getElementById('purchaseWarehouse');
  const productSelect = document.getElementById('purchaseProduct');
  supplierSelect.innerHTML = enterpriseWorkspace.suppliers.map(item => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('');
  warehouseSelect.innerHTML = warehouses.map(item => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('');
  productSelect.innerHTML = products.map(item => `<option value="${item.id}">${escapeHtml(item.sku)} — ${escapeHtml(item.name)}</option>`).join('');
  if (!supplierSelect.options.length || !warehouseSelect.options.length || !productSelect.options.length) {
    showToast('Add a supplier, warehouse, and product before creating a purchase order.', 'info');
    return;
  }
  prefillPurchaseCost();
  document.getElementById('purchaseOrderModal').style.display = 'grid';
}

function prefillPurchaseCost() {
  const productId = Number(document.getElementById('purchaseProduct')?.value);
  const product = products.find(item => Number(item.id) === productId);
  if (product) document.getElementById('purchaseUnitCost').value = Number(product.cost_price || 0).toFixed(2);
}

async function submitEnterprisePurchaseOrder(event) {
  event.preventDefault();
  await executeAction(event.submitter, async () => {
    const expectedValue = document.getElementById('purchaseExpectedAt').value;
    const payload = {
      party_id: Number(document.getElementById('purchaseSupplier').value),
      warehouse_id: Number(document.getElementById('purchaseWarehouse').value),
      expected_at: expectedValue ? new Date(expectedValue).toISOString() : undefined,
      notes: document.getElementById('purchaseNotes').value.trim() || undefined,
      lines: [{
        product_id: Number(document.getElementById('purchaseProduct').value),
        quantity: Number(document.getElementById('purchaseQuantity').value),
        unit_price: Number(document.getElementById('purchaseUnitCost').value)
      }]
    };
    const response = await fetch('/api/v1/trade/purchase-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Purchase order creation failed.');
    closeModal('purchaseOrderModal');
    event.target.reset();
    await loadEnterpriseWorkspaces();
  }, 'Purchase order draft created.');
}

async function submitPurchaseForApproval(orderId) {
  await runEnterpriseMutation(`/api/v1/trade/purchase-orders/${orderId}/transition`, { status: 'pending_approval' }, 'Purchase order submitted for approval.');
}

async function approvePurchaseOrder(approvalId) {
  await runEnterpriseMutation(`/api/v1/approvals/${approvalId}/approve`, {}, 'Purchase order approved.');
}

async function receivePurchaseOrder(orderId) {
  try {
    const response = await fetch(`/api/v1/trade/purchase-orders/${orderId}`);
    const order = await response.json();
    if (!response.ok) throw new Error(order.error?.message || 'Could not load the purchase order.');
    const items = order.lines
      .map(line => ({ line_id: line.id, quantity: Number(line.quantity) - Number(line.fulfilled_quantity) }))
      .filter(item => item.quantity > 0);
    if (!items.length) throw new Error('This purchase order is already fully received.');
    await runEnterpriseMutation(`/api/v1/trade/purchase-orders/${orderId}/receive`, {
      warehouse_id: order.warehouse_id,
      items
    }, 'Goods receipt posted and stock updated.');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function runEnterpriseMutation(url, body, successMessage) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'The operation failed.');
    await loadEnterpriseWorkspaces();
    showToast(successMessage, 'success');
    return data;
  } catch (error) {
    showToast(error.message, 'error');
    throw error;
  }
}

// Initialize UI
document.addEventListener('DOMContentLoaded', () => {
  restoreInterfacePreferences();
  initNotifications();
  const token = localStorage.getItem('phase5AccessToken');
  if (token) {
    // Hide login screen
    const loginContainer = document.getElementById('loginContainer');
    if (loginContainer) loginContainer.style.display = 'none';
    
    // Update profile info
    updateProfileUI();
    
    // Run normal initialization
    initializePOSApp();
  } else {
    // Show login screen
    const loginContainer = document.getElementById('loginContainer');
    if (loginContainer) loginContainer.style.display = 'flex';
  }
});



// Sync data from database APIs if available
async function syncWithBackend() {
  try {
    const headers = apiHeaders();

    const pRes = await fetch('/api/v1/products?limit=500');
    if (pRes.ok) {
      const data = await pRes.json();
      products = data.products.map(product => ({ ...product, stock: Number(product.quantity_on_hand || 0) }));
    }

    const cRes = await fetch('/api/v1/customers');
    if (cRes.ok) customers = (await cRes.json()).customers;

    const bRes = await fetch('/api/v1/reference/brands');
    if (bRes.ok) brands = (await bRes.json()).items;

    const catRes = await fetch('/api/v1/reference/categories');
    if (catRes.ok) categories = (await catRes.json()).items;

    const wRes = await fetch('/api/v1/reference/warehouses');
    if (wRes.ok) warehouses = (await wRes.json()).items;

    const sRes = await fetch('/api/v1/sales');
    if (sRes.ok) sales = (await sRes.json()).sales;

    const stRes = await fetch('/api/users', { headers });
    if (stRes.ok) staff = await stRes.json();

    const setRes = await fetch('/api/settings', { headers });
    if (setRes.ok) {
      const settingsData = await setRes.json();
      settingsData.forEach(item => {
        const inputId = getSettingInputId(item.setting_key);
        const inputEl = document.getElementById(inputId);
        if (inputEl) {
          if (item.setting_key === 'tax_rate') {
            inputEl.value = (parseFloat(item.setting_value) * 100).toFixed(2);
          } else {
            inputEl.value = item.setting_value;
          }
        }
        if (item.setting_key === 'company_name') {
          const logo = document.querySelector('.logo-title');
          if (logo) logo.innerText = item.setting_value.toUpperCase();
        }
        if (item.setting_key === 'currency_symbol') {
          currencySymbol = item.setting_value;
        }
        if (item.setting_key === 'currency_code') {
          currencyCode = item.setting_value;
        }
        if (item.setting_key === 'theme_mode') {
          changeThemeModePreview(item.setting_value);
        }
        if (item.setting_key === 'theme_color') {
          changeThemeColorPreview(item.setting_value);
        }
      });
    }

    const tRes = await fetch('/api/inventory/stock/transfers', { headers });
    if (tRes.ok) {
      const transferList = await tRes.json();
      transfers = transferList.map(t => {
        const fromWhName = warehouses.find(w => w.id === t.from_warehouse_id)?.name || 'Main Warehouse';
        const toWhName = warehouses.find(w => w.id === t.to_warehouse_id)?.name || 'City Showroom';
        return {
          id: t.id,
          from: fromWhName,
          to: toWhName,
          product: t.products?.name || 'Unknown Product',
          qty: t.quantity,
          status: t.status
        };
      });
    }

    loadDashboardData();
    loadPOSCatalog();
    renderPOSCategoryFilters();
    loadInventoryTable();
    loadCustomerLedger();
    loadBrandsAndCategories();
    loadStaffList();
    loadSalesPage();
    loadCategoryManagement();
    loadBrandManagement();
    loadWarehouseManagement();
    populateDropdowns();
  } catch (err) {
    console.error('API sync error:', err);
  }
}

function getSettingInputId(key) {
  switch (key) {
    case 'company_name': return 'setCompanyName';
    case 'company_email': return 'setCompanyEmail';
    case 'company_address': return 'setCompanyAddress';
    case 'company_phone': return 'setCompanyPhone';
    case 'currency_symbol': return 'setCurrencySymbol';
    case 'currency_code': return 'setCurrencyCode';
    case 'tax_rate': return 'setTaxRate';
    case 'theme_mode': return 'setThemeMode';
    case 'theme_color': return 'setThemeColor';
    default: return '';
  }
}

function changeThemeModePreview(mode) {
  document.documentElement.setAttribute('data-theme-mode', mode);
  const setEl = document.getElementById('setThemeMode');
  if (setEl) setEl.value = mode;
}

function changeThemeColorPreview(color) {
  document.documentElement.setAttribute('data-theme-color', color);
  const setEl = document.getElementById('setThemeColor');
  if (setEl) setEl.value = color;
}

function applyCurrencyPreset(val) {
  if (!val) return;
  const parts = val.split('|');
  const code = parts[0];
  const symbol = parts[1];
  
  const symbolInput = document.getElementById('setCurrencySymbol');
  const codeInput = document.getElementById('setCurrencyCode');
  
  if (symbolInput) symbolInput.value = symbol;
  if (codeInput) codeInput.value = code;
}

function clearSidebarActiveStates() {
  document.querySelectorAll('.sidebar .nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.sidebar .nav-dropdown-item').forEach(i => i.classList.remove('active'));
  document.querySelectorAll('.sidebar .nav-dropdown-wrapper').forEach(w => w.classList.remove('active'));
}

// Sidebar Navigation Router
function setupNavigation() {
  // Setup top-level direct buttons
  const buttons = document.querySelectorAll('.sidebar .nav-btn[data-tab]');
  buttons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tabName = btn.getAttribute('data-tab');
      switchTab(tabName);
    });
  });

  // Setup dropdown triggers (expand/collapse menu without turning blue)
  const triggers = document.querySelectorAll('.nav-dropdown-trigger');
  triggers.forEach(trigger => {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const wrapper = trigger.closest('.nav-dropdown-wrapper');
      
      // Close other dropdown wrappers
      document.querySelectorAll('.nav-dropdown-wrapper').forEach(w => {
        if (w !== wrapper) w.classList.remove('open');
      });
      
      // Toggle open state on current dropdown wrapper
      wrapper.classList.toggle('open');
    });
  });

  // Setup dropdown sub-items
  const subItems = document.querySelectorAll('.nav-dropdown-item');
  subItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const tabName = item.getAttribute('data-tab');
      const reportType = item.getAttribute('data-report-type');
      const barcodeView = item.getAttribute('data-barcode-view');

      switchTab(tabName, reportType, item);

      if (reportType) {
        switchReportTab(reportType);
      }
      if (barcodeView) openBarcodeWorkspaceView(barcodeView);
    });
  });
}

// Global switchTab helper
function switchTab(tabName, reportType = null, sourceItem = null) {
  const targetPanel = document.getElementById(tabName);
  if (!targetPanel) return;

  // 1. Clear active selection color from ALL items in sidebar
  clearSidebarActiveStates();

  // 2. Identify the active element
  let activeElement = sourceItem;

  if (!activeElement) {
    if (tabName === 'reports' && reportType) {
      activeElement = document.querySelector(`.nav-dropdown-item[data-tab="reports"][data-report-type="${reportType}"]`);
    }
    if (!activeElement) {
      activeElement = document.querySelector(`.sidebar .nav-btn[data-tab="${tabName}"]`);
    }
    if (!activeElement) {
      activeElement = document.querySelector(`.nav-dropdown-item[data-tab="${tabName}"]`);
    }
  }

  // 3. Highlight ONLY the active element and expand its parent wrapper if needed
  if (activeElement) {
    activeElement.classList.add('active');
    const wrapper = activeElement.closest('.nav-dropdown-wrapper');
    if (wrapper) {
      wrapper.classList.add('open');
    }
  }

  // 4. Activate panel view
  document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
  targetPanel.classList.add('active');
  currentTab = tabName;
  if (tabName !== 'barcodes' && barcodeViewForRoute()) {
    window.history.pushState({ tab: tabName }, '', '/');
  }
  document.querySelector('aside.sidebar')?.classList.remove('mobile-open');
  document.body.classList.remove('sidebar-open');
  window.scrollTo(0, 0);
  if (tabName === 'finance') loadFinanceWorkspace();
  if (tabName === 'automation') loadAiWorkspace();
  if (tabName === 'invoices') loadInvoices();
  if (tabName === 'barcodes') loadBarcodeWorkspace();
}

// ================= MODULE 1: DASHBOARD =================
function loadDashboardData() {
  // KPI calculations
  const totalValuation = products.reduce((acc, p) => acc + ((p.cost_price || 0) * (p.stock || 0)), 0);
  const lowStockCount = products.filter(p => (p.stock || 0) < p.min_stock_alert).length;
  
  // Calculate Today's Sales & Revenue
  const todayStr = new Date().toDateString();
  const todaySales = sales.filter(s => new Date(s.sale_date).toDateString() === todayStr);
  const todaySalesCount = todaySales.length;
  const todayRevenue = todaySales.reduce((acc, s) => acc + (s.total || 0), 0);
  const estimatedProfit = sales.reduce((acc, sale) => acc + Number(sale.profit || (sale.total || 0) * 0.527), 0);
  const outstandingBalance = customers.reduce((acc, customer) => acc + Math.max(0, Number(customer.balance || 0)), 0);

  // Update Top Cards
  const elSales = document.getElementById('kpiSales');
  if (elSales) elSales.innerText = todaySalesCount;
  
  const elRev = document.getElementById('kpiRevenue');
  if (elRev) elRev.innerText = `${currencySymbol}${todayRevenue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;

  const elVal = document.getElementById('kpiValuation');
  if (elVal) elVal.innerText = `${currencySymbol}${totalValuation.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;

  const elProfit = document.getElementById('kpiProfit');
  if (elProfit) elProfit.innerText = `${currencySymbol}${estimatedProfit.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;

  const elOutstanding = document.getElementById('kpiOutstanding');
  if (elOutstanding) elOutstanding.innerText = `${currencySymbol}${outstandingBalance.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
  
  const elLow = document.getElementById('kpiLowStock');
  if (elLow) elLow.innerText = lowStockCount;
  
  const elCustKpi = document.getElementById('kpiCustomers');
  if (elCustKpi) elCustKpi.innerText = customers.length;

  // Overall Information Info Grid
  const elCust = document.getElementById('dashboardCustomerCount');
  if (elCust) elCust.innerText = customers.length;
  const elOrd = document.getElementById('dashboardOrderCount');
  if (elOrd) elOrd.innerText = sales.length;
  const elProd = document.getElementById('dashboardProductCount');
  if (elProd) elProd.innerText = products.length;
  
  // Render recent sales
  const recentTable = document.getElementById('recentSalesTable');
  if (recentTable) {
    recentTable.innerHTML = '';
    sales.forEach(sale => {
      const cust = customers.find(c => c.id === sale.customer_id)?.name || 'Walk-in';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${sale.invoice_no}</strong></td>
        <td>${cust}</td>
        <td><span class="badge-pay">${sale.payment_method}</span></td>
        <td>${currencySymbol}${(sale.total || 0).toFixed(2)}</td>
        <td>
          <button class="action-btn-sm" onclick="downloadInvoice(${sale.id})"><i class="fa-solid fa-file-pdf"></i> PDF</button>
        </td>
      `;
      recentTable.appendChild(tr);
    });
  }

  // Render Best Selling Products Table dynamically
  const bestTable = document.getElementById('bestSellingTable');
  if (bestTable) {
    bestTable.innerHTML = '';
    // Sort products by sales_count descending
    const bestSelling = products
      .filter(p => (p.sales_count || 0) > 0)
      .sort((a, b) => (b.sales_count || 0) - (a.sales_count || 0));

    if (bestSelling.length === 0) {
      bestTable.innerHTML = `
        <tr>
          <td colspan="4" style="text-align: center; color: var(--text-muted); padding: 20px;">
            No sales recorded yet.
          </td>
        </tr>
      `;
    } else {
      bestSelling.slice(0, 5).forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="table-product-cell">
            ${renderTableProductLabel(p.name)}
          </td>
          <td>${currencySymbol}${(p.selling_price || 0).toFixed(2)}</td>
          <td>${p.sales_count || 0}</td>
          <td><span class="badge-growth">↑ 100%</span></td>
        `;
        bestTable.appendChild(tr);
      });
    }
  }

  // Render Low Stock Products Table dynamically
  const lowStockTable = document.getElementById('lowStockTable');
  if (lowStockTable) {
    lowStockTable.innerHTML = '';
    const lowStockProducts = products.filter(p => (p.stock || 0) < p.min_stock_alert);
    
    if (lowStockProducts.length === 0) {
      lowStockTable.innerHTML = `
        <tr>
          <td colspan="4" style="text-align: center; color: var(--text-muted); padding: 20px;">
            No low stock alerts.
          </td>
        </tr>
      `;
    } else {
      lowStockProducts.forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="table-product-cell">
            ${renderTableProductLabel(p.name)}
          </td>
          <td>#${p.id}</td>
          <td>${p.stock || 0}</td>
          <td><span class="stock-pill low">Low Stock</span></td>
        `;
        lowStockTable.appendChild(tr);
      });
    }
  }

  // Render stock alerts list
  const alertList = document.getElementById('lowStockAlertList');
  if (alertList) {
    alertList.innerHTML = '';
    products.filter(p => (p.stock || 0) < p.min_stock_alert).forEach(p => {
      const div = document.createElement('div');
      div.className = 'alert-item';
      div.innerHTML = `
        <div>
          <strong>${p.name}</strong>
          <span style="display:block; font-size:0.75rem; color:var(--text-muted)">SKU: ${p.sku} | Warehouse A</span>
        </div>
        <div style="text-align:right">
          <span class="stock-qty-low">${p.stock || 0} / ${p.min_stock_alert}</span>
          <span style="display:block; font-size:0.7rem; color:var(--alert); font-weight:700">REORDER</span>
        </div>
      `;
      alertList.appendChild(div);
    });
  }

  renderDashboardCharts();
  loadCustomerLedger();
}

async function downloadInvoice(saleId) {
  try {
    const response = await fetch('/api/v1/invoices');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Invoice could not be resolved.');
    const invoice = (data.invoices || []).find(item => Number(item.sale_id) === Number(saleId));
    if (!invoice) throw new Error('This legacy sale does not have a migrated GST invoice yet.');
    await downloadInvoicePdf(Number(invoice.id));
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// ================= MODULE 2: POS CATALOG & CART =================
function renderPOSCategoryFilters() {
  const container = document.getElementById('posCategoryFilters');
  if (!container) return;

  let html = `<button class="filter-btn active" data-cat="all" onclick="handleCategoryFilterClick(this, 'all')">All Products</button>`;
  
  categories.forEach(cat => {
    html += `<button class="filter-btn" data-cat="${cat.id}" onclick="handleCategoryFilterClick(this, ${cat.id})">${cat.name}</button>`;
  });
  
  container.innerHTML = html;
}

function handleCategoryFilterClick(btn, categoryId) {
  const filterBtns = document.querySelectorAll('#posCategoryFilters .filter-btn');
  filterBtns.forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  if (categoryId === 'all') {
    loadPOSCatalog();
  } else {
    const filtered = products.filter(p => p.category_id === categoryId);
    loadPOSCatalog(filtered);
  }
}

function loadPOSCatalog(filteredList = null) {
  const grid = document.getElementById('posProductGrid');
  grid.innerHTML = '';
  
  const listToRender = filteredList || products;
  
  if (listToRender.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);">
        <i class="fa-solid fa-box-open" style="font-size: 2.5rem; margin-bottom: 10px;"></i>
        <p>No products match your search or filter criteria.</p>
      </div>
    `;
    return;
  }

  listToRender.forEach(p => {
    const catName = categories.find(c => c.id === p.category_id)?.name || 'General';
    const card = document.createElement('div');
    card.className = 'pos-item-card';
    card.onclick = () => addToCart(p.id);
    const photoUrl = resolveProductImage(p.image_url, p.name);
    const fallbackPhoto = buildProductFallbackImage(p.name);

    card.innerHTML = `
      <div class="pos-item-content">
        <div class="pos-item-media">
          <img src="${photoUrl}" alt="${escapeHtml(p.name)}" onerror="this.onerror=null;this.src='${fallbackPhoto}';">
        </div>
        <h5 class="pos-item-title">${escapeHtml(p.name)}</h5>
        <span class="pos-item-category">${escapeHtml(catName)}</span>
        <div class="pos-item-price">${currencySymbol}${p.selling_price.toFixed(2)}</div>
        <span class="pos-item-stock ${(p.stock || 0) < p.min_stock_alert ? 'is-low' : ''}">Stock: ${p.stock || 0}</span>
      </div>
      <button class="action-btn primary pos-item-action">
        <i class="fa-solid fa-cart-shopping"></i> Add to Cart
      </button>
    `;
    grid.appendChild(card);
  });
}

// Live Search & Category Filter Handler
function handlePOSSearch(query) {
  const q = query.toLowerCase().trim();
  if (!q) {
    loadPOSCatalog();
    return;
  }
  const filtered = products.filter(p => 
    p.name.toLowerCase().includes(q) || 
    p.sku.toLowerCase().includes(q) || 
    (p.barcode && p.barcode.toLowerCase().includes(q))
  );
  loadPOSCatalog(filtered);
}

// Scanner Simulation Modal Logic
function openScannerModal() {
  document.getElementById('scannerModal').classList.add('active');
  setTimeout(() => {
    document.getElementById('manualScanInput').focus();
  }, 100);
}

function closeScannerModal() {
  document.getElementById('scannerModal').classList.remove('active');
}

async function handleScanSubmit(event) {
  event.preventDefault();
  const code = document.getElementById('manualScanInput').value.trim();
  if (!code) return;
  try {
    const response = await fetch('/api/v1/barcode-scans/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ barcode_value: code, source: 'POS', action: 'ADD_TO_POS' })
    });
    const result = await response.json();
    if (!response.ok && !result.resolved) {
      showToast(`Unknown barcode: ${code}`, 'error');
      if (confirm('This barcode is not assigned. Open the Barcode & Label Center to map it?')) {
        closeScannerModal();
        switchTab('barcodes');
        openBarcodeWorkspaceView('generate');
        const manual = document.getElementById('barcodeAssignValue');
        if (manual) manual.value = code;
      }
      return;
    }
    if (!result.product) throw new Error('The barcode did not resolve to an active product.');
    if (Number(result.product.available_stock || 0) <= 0) {
      throw new Error(`${result.product.name} is out of stock.`);
    }
    addToCart(Number(result.product.id));
    showToast(`${result.product.name} added by barcode.`, 'success');
    document.getElementById('manualScanInput').value = '';
    document.getElementById('manualScanInput').focus();
  } catch (error) {
    showToast(error.message || 'Barcode scan failed.', 'error');
  }
}

function addToCart(productId) {
  const product = products.find(p => p.id === productId);
  if (!product) return;

  // Check if product is already in cart
  const cartItem = cart.find(item => item.product_id === productId);
  if (cartItem) {
    cartItem.quantity += 1;
  } else {
    cart.push({
      product_id: product.id,
      name: product.name,
      sku: product.sku,
      unit_price: product.selling_price,
      quantity: 1,
      uom: product.uom,
      coverage_per_box: product.coverage_per_box
    });
  }
  
  recalculateCart();
}

function recalculateCart() {
  const list = document.getElementById('cartItemsList');
  if (!list) return;
  list.innerHTML = '';
  
  const totalItemCount = cart.reduce((sum, i) => sum + i.quantity, 0);
  const itemCountBadge = document.getElementById('cartItemCount');
  if (itemCountBadge) itemCountBadge.innerText = `${totalItemCount} item${totalItemCount === 1 ? '' : 's'}`;

  if (cart.length === 0) {
    list.innerHTML = `
      <div class="empty-cart-placeholder" style="text-align: center; padding: 40px 20px; color: var(--ink-muted);">
        <i class="fa-solid fa-cart-flatbed" style="font-size: 3rem; margin-bottom: 12px; opacity: 0.4;"></i>
        <p style="font-weight: 600; font-size: 0.95rem;">Your cart is empty</p>
      </div>
    `;
    document.getElementById('cartSubtotal').innerText = `${currencySymbol}0.00`;
    document.getElementById('cartTax').innerText = `${currencySymbol}0.00`;
    document.getElementById('cartGrandTotal').innerText = `${currencySymbol}0.00`;
    syncPosPaymentAmounts();
    return;
  }

  let subtotal = 0;
  cart.forEach((item, index) => {
    const rowTotal = item.quantity * item.unit_price;
    subtotal += rowTotal;

    const row = document.createElement('div');
    row.style.cssText = 'display: grid; grid-template-columns: 2fr 1fr 1fr 1fr 32px; gap: 4px; align-items: center; padding: 10px 6px; border-bottom: 1px solid #e2e8f0; font-size: 0.85rem; background: #ffffff; margin-bottom: 2px; border-radius: 4px;';
    
    let coverageText = '';
    if (item.uom === 'box' && item.coverage_per_box) {
      coverageText = `<span style="display:block; font-size:0.7rem; color:#2563eb; font-weight:600; margin-top:2px;">Cov: ${(item.quantity * item.coverage_per_box).toFixed(1)} SqFt</span>`;
    }

    row.innerHTML = `
      <div style="overflow: hidden; padding-right: 4px;">
        <strong style="font-weight: 700; color: #0f172a; display: block; font-size: 0.85rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${item.name}">${item.name}</strong>
        <span style="font-size: 0.7rem; color: #64748b; font-family: monospace;">SKU: ${item.sku || 'N/A'}</span>
        ${coverageText}
      </div>
      <div style="text-align: right; color: #334155; font-weight: 600; font-size: 0.85rem;">${currencySymbol}${item.unit_price.toFixed(2)}</div>
      <div style="text-align: center;">
        <input type="number" value="${item.quantity}" min="1" onchange="updateCartQty(${index}, this.value)" style="width: 42px; text-align: center; padding: 4px 2px; border-radius: 4px; border: 1px solid #cbd5e1; font-weight: 700; font-size: 0.85rem; color: #0f172a; background: #f8fafc;">
      </div>
      <div style="text-align: right; font-weight: 800; color: #2563eb; font-size: 0.85rem;">${currencySymbol}${rowTotal.toFixed(2)}</div>
      <div style="text-align: right;">
        <button onclick="removeFromCart(${index})" style="background: #fef2f2; border: 1px solid #fee2e2; color: #dc2626; cursor: pointer; padding: 5px 7px; border-radius: 4px; transition: all 0.2s;" title="Remove Item"><i class="fa-solid fa-trash-can" style="font-size: 0.75rem;"></i></button>
      </div>
    `;
    list.appendChild(row);
  });

  const preview = calculatePosInvoicePreview();

  document.getElementById('cartSubtotal').innerText = `${currencySymbol}${subtotal.toFixed(2)}`;
  document.getElementById('cartTax').innerText = `${currencySymbol}${preview.tax.toFixed(2)}`;
  document.getElementById('cartGrandTotal').innerText = `${currencySymbol}${preview.total.toFixed(2)}`;
  syncPosPaymentAmounts();
}

function updateCartQty(index, value) {
  cart[index].quantity = parseInt(value) || 1;
  recalculateCart();
}

function removeFromCart(index) {
  cart.splice(index, 1);
  recalculateCart();
}

function clearCart() {
  cart = [];
  recalculateCart();
}

function calculatePosInvoicePreview() {
  const grossMinor = cart.map(item => Math.round(Number(item.quantity) * Number(item.unit_price) * 100));
  const subtotalMinor = grossMinor.reduce((sum, value) => sum + value, 0);
  const discountMinor = Math.min(Math.max(Math.round((Number(document.getElementById('cartDiscount')?.value) || 0) * 100), 0), subtotalMinor);
  const exactDiscounts = grossMinor.map(value => subtotalMinor ? discountMinor * value / subtotalMinor : 0);
  const lineDiscounts = exactDiscounts.map(value => Math.floor(value));
  let remainder = discountMinor - lineDiscounts.reduce((sum, value) => sum + value, 0);
  exactDiscounts
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
    .forEach(entry => {
      if (remainder > 0) {
        lineDiscounts[entry.index] += 1;
        remainder -= 1;
      }
    });
  const taxMinor = cart.reduce((sum, item, index) => {
    const product = products.find(entry => Number(entry.id) === Number(item.product_id));
    const taxableMinor = grossMinor[index] - lineDiscounts[index];
    return sum + Math.round(taxableMinor * Number(product?.gst_rate || 0) / 100);
  }, 0);
  return {
    subtotal: subtotalMinor / 100,
    discount: discountMinor / 100,
    tax: taxMinor / 100,
    total: (subtotalMinor - discountMinor + taxMinor) / 100,
    totalMinor: subtotalMinor - discountMinor + taxMinor
  };
}

async function loadPosPaymentMethods() {
  try {
    const response = await fetch('/api/v1/settings/payment-methods');
    const data = await response.json();
    if (response.ok && Array.isArray(data.methods)) {
      posPaymentMethods = data.methods.filter(method => method.enabled);
    }
  } catch {
    // Keep the safe local display list; the server remains authoritative.
  }
  if (!posPaymentMethods.some(method => method.method === posPaymentRows[0]?.method)) {
    posPaymentRows = [{ method: posPaymentMethods[0]?.method || 'CASH', amount: 0, reference: '' }];
  }
  renderPosPaymentRows();
}

function setPosPaymentMode(mode) {
  posPaymentMode = mode;
  document.querySelectorAll('[data-payment-mode]').forEach(button => {
    button.classList.toggle('active', button.dataset.paymentMode === mode);
  });
  const total = calculatePosInvoicePreview().total;
  if (mode === 'single') posPaymentRows = [{ method: posPaymentRows[0]?.method || 'CASH', amount: total, reference: posPaymentRows[0]?.reference || '' }];
  if (mode === 'split' && posPaymentRows.length < 2) {
    const first = Math.floor(total * 50) / 100;
    posPaymentRows = [
      { method: posPaymentRows[0]?.method || 'CASH', amount: first, reference: posPaymentRows[0]?.reference || '' },
      { method: nextAvailablePaymentMethod(posPaymentRows[0]?.method || 'CASH'), amount: Number((total - first).toFixed(2)), reference: '' }
    ];
  }
  if (mode === 'partial') {
    const partialAmount = Math.min(Number(posPaymentRows[0]?.amount || 0), total);
    posPaymentRows = [{ method: posPaymentRows[0]?.method || 'CUSTOMER_CREDIT', amount: partialAmount || total, reference: posPaymentRows[0]?.reference || '' }];
    ensurePosDueDate();
  }
  renderPosPaymentRows();
}

function addPosPaymentRow() {
  if (posPaymentRows.length >= 10) return;
  posPaymentMode = posPaymentMode === 'single' ? 'split' : posPaymentMode;
  posPaymentRows.push({ method: nextAvailablePaymentMethod(), amount: 0, reference: '' });
  renderPosPaymentRows();
}

function removePosPaymentRow(index) {
  if (posPaymentRows.length === 1) return;
  posPaymentRows.splice(index, 1);
  renderPosPaymentRows();
}

function updatePosPaymentRow(index, field, value) {
  if (!posPaymentRows[index]) return;
  posPaymentRows[index][field] = field === 'amount' ? Number(value || 0) : value;
  if (field === 'method' && value === 'CUSTOMER_CREDIT') {
    posPaymentMode = 'partial';
    ensurePosDueDate();
  }
  renderPosPaymentRows(false);
}

function renderPosPaymentRows(rebuild = true) {
  const container = document.getElementById('posPaymentRows');
  if (!container) return;
  if (rebuild) {
    const options = posPaymentMethods.map(method => `<option value="${escapeHtml(method.method)}">${escapeHtml(method.label)}</option>`).join('');
    container.innerHTML = posPaymentRows.map((row, index) => {
      const method = posPaymentMethods.find(item => item.method === row.method);
      const referenceRequired = method?.requires_reference;
      return `
        <div class="payment-allocation-row">
          <label>Method<select onchange="updatePosPaymentRow(${index}, 'method', this.value)">${options.replace(`value="${escapeHtml(row.method)}"`, `value="${escapeHtml(row.method)}" selected`)}</select></label>
          <label>Amount<input type="number" min="0.01" step="0.01" value="${Number(row.amount || 0).toFixed(2)}" onchange="updatePosPaymentRow(${index}, 'amount', this.value)" ${posPaymentMode === 'single' ? 'readonly' : ''}></label>
          <label class="payment-reference-field">Reference ${referenceRequired ? '<span aria-hidden="true">*</span>' : ''}<input value="${escapeHtml(row.reference || '')}" maxlength="200" placeholder="${referenceRequired ? 'Required' : 'Optional'}" oninput="posPaymentRows[${index}].reference = this.value"></label>
          <button type="button" class="payment-allocation-remove" onclick="removePosPaymentRow(${index})" aria-label="Remove allocation" ${posPaymentRows.length === 1 ? 'disabled' : ''}><i class="fa-solid fa-xmark"></i></button>
        </div>`;
    }).join('');
  }
  syncPosPaymentAmounts(false);
}

function syncPosPaymentAmounts(updateRows = true) {
  const preview = calculatePosInvoicePreview();
  if (posPaymentMode === 'single' && posPaymentRows[0]) posPaymentRows[0].amount = preview.total;
  if (updateRows) renderPosPaymentRows();
  const collected = posPaymentRows
    .filter(row => row.method !== 'CUSTOMER_CREDIT')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const remaining = Math.max(preview.total - collected, 0);
  const collectedElement = document.getElementById('posCollectedTotal');
  const remainingElement = document.getElementById('posRemainingTotal');
  const dueWrap = document.getElementById('posDueDateWrap');
  const addButton = document.getElementById('addPosPaymentBtn');
  if (collectedElement) collectedElement.textContent = `${currencySymbol}${collected.toFixed(2)}`;
  if (remainingElement) remainingElement.textContent = `${currencySymbol}${remaining.toFixed(2)}`;
  if (dueWrap) dueWrap.hidden = posPaymentMode !== 'partial' && remaining <= 0 && !posPaymentRows.some(row => ['CHEQUE', 'OTHER', 'CUSTOMER_CREDIT'].includes(row.method));
  if (addButton) addButton.hidden = posPaymentMode === 'single';
}

function nextAvailablePaymentMethod(excluded) {
  const used = new Set(posPaymentRows.map(row => row.method));
  if (excluded) used.add(excluded);
  return posPaymentMethods.find(method => !used.has(method.method))?.method || posPaymentMethods[0]?.method || 'CASH';
}

function ensurePosDueDate() {
  const input = document.getElementById('posDueDate');
  if (input && !input.value) {
    const date = new Date(Date.now() + 30 * 86400000);
    input.value = date.toISOString().slice(0, 10);
  }
}

function validatePosPaymentRows(total) {
  const allocationTotal = posPaymentRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  if (posPaymentRows.some(row => Number(row.amount || 0) <= 0)) throw new Error('Every payment allocation must be greater than zero.');
  if (allocationTotal > total + 0.001) throw new Error('Payment allocations cannot exceed the invoice total.');
  if (posPaymentMode !== 'partial' && Math.abs(allocationTotal - total) > 0.001) {
    throw new Error('Payment allocations must equal the invoice total. Choose Pay later / Partial to leave a balance.');
  }
  for (const row of posPaymentRows) {
    const method = posPaymentMethods.find(item => item.method === row.method);
    if (method?.requires_reference && !String(row.reference || '').trim() && row.method !== 'RAZORPAY') {
      throw new Error(`${method.label} requires a reference.`);
    }
  }
}

async function submitPOSCheckout() {
  if (!cart.length) {
    showToast('Billing cart is empty.', 'error');
    return;
  }
  const preview = calculatePosInvoicePreview();
  try {
    validatePosPaymentRows(preview.total);
  } catch (error) {
    showToast(error.message, 'error');
    return;
  }
  const customerId = document.getElementById('cartCustomerSelect').value;
  const hasOutstanding = posPaymentRows
    .filter(row => !['CUSTOMER_CREDIT'].includes(row.method))
    .reduce((sum, row) => sum + Number(row.amount || 0), 0) < preview.total - 0.001
    || posPaymentRows.some(row => ['CHEQUE', 'OTHER', 'CUSTOMER_CREDIT'].includes(row.method));
  if (hasOutstanding && !customerId) {
    showToast('Select a customer for partial, pending, or pay-later checkout.', 'error');
    return;
  }
  if (hasOutstanding) ensurePosDueDate();
  const payload = {
    customer_id: customerId ? Number(customerId) : null,
    warehouse_id: Number(document.getElementById('cartWarehouseSelect').value),
    items: cart.map(item => ({ product_id: item.product_id, quantity: item.quantity, unit_price: item.unit_price })),
    discount: Number(document.getElementById('cartDiscount').value) || 0,
    payments: posPaymentRows.map(row => ({
      method: row.method,
      amount: Number(row.amount),
      reference: String(row.reference || '').trim() || undefined
    })),
    allow_partial_payment: hasOutstanding || posPaymentMode === 'partial',
    due_date: hasOutstanding || posPaymentMode === 'partial' ? document.getElementById('posDueDate').value : undefined,
    invoice_details: {
      customer_gstin: document.getElementById('posCustomerGstin').value.trim() || undefined,
      customer_address: document.getElementById('posCustomerAddress').value.trim() || undefined,
      supply_state: document.getElementById('posSupplyState').value.trim() || undefined,
      supply_state_code: document.getElementById('posSupplyStateCode').value.trim() || undefined,
      customer_state: document.getElementById('posSupplyState').value.trim() || undefined,
      customer_state_code: document.getElementById('posSupplyStateCode').value.trim() || undefined,
      challan_number: document.getElementById('posChallanNumber').value.trim() || undefined,
      transport: document.getElementById('posTransport').value.trim() || undefined,
      vehicle_number: document.getElementById('posVehicleNumber').value.trim() || undefined,
      eway_bill_number: document.getElementById('posEwayBill').value.trim() || undefined
    }
  };
  const razorpayIndex = payload.payments.findIndex(payment => payment.method === 'RAZORPAY');
  if (razorpayIndex >= 0) {
    try {
      const capture = await collectRazorpayAllocation(payload.payments[razorpayIndex].amount);
      payload.payments[razorpayIndex].reference = capture.payment_id;
      payload.payments[razorpayIndex].provider_transaction_id = capture.payment_id;
    } catch (error) {
      showToast(error.message || 'Razorpay is not configured.', 'error');
      return;
    }
  }
  await executeFinalCheckoutPayload(payload, preview.total);
}

async function collectRazorpayAllocation(amount) {
  const orderResponse = await fetch('/api/v1/payments/razorpay/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, receipt: `pos-${Date.now()}` })
  });
  const orderData = await orderResponse.json();
  if (!orderResponse.ok) throw new Error(orderData.error?.message || 'Razorpay is unavailable.');
  await ensureRazorpayLoaded();
  return new Promise((resolve, reject) => {
    const checkout = new window.Razorpay({
      key: orderData.key_id,
      amount: orderData.order.amount,
      currency: orderData.order.currency || 'INR',
      name: 'Inventia POS Terminal',
      description: `POS collection for ${cart.length} item(s)`,
      order_id: orderData.order.id,
      prefill: { name: document.getElementById('cartCustomerSearchInput').value || 'Walk-in Customer' },
      theme: { color: getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim() },
      handler: async response => {
        try {
          const verificationResponse = await fetch('/api/v1/payments/razorpay/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(response)
          });
          const verification = await verificationResponse.json();
          if (!verificationResponse.ok || !verification.verified) {
            throw new Error(verification.error?.message || 'Payment signature verification failed.');
          }
          resolve(verification);
        } catch (error) {
          reject(error);
        }
      },
      modal: { ondismiss: () => reject(new Error('Razorpay checkout was cancelled.')) }
    });
    checkout.open();
  });
}

async function executeFinalCheckoutPayload(payload, total) {
  const button = document.querySelector('.checkout-btn');
  const original = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Completing sale…';
  }
  try {
    const response = await fetch('/api/v1/pos/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error?.message || data.message || 'Checkout failed.');
    }
    clearCart();
    showCheckoutResult(data);
    showToast(`Invoice ${data.invoiceNumber} created.`, 'success');
    addSystemNotification(`Created ${data.invoiceNumber} for ${currencySymbol}${Number(total).toFixed(2)}`);
    await syncWithBackend();
  } catch (error) {
    showToast(error.message || 'Checkout failed. No business data changed.', 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = original;
    }
  }
}

function showCheckoutResult(data) {
  const card = document.getElementById('posCheckoutResult');
  if (!card) return;
  const payment = data.paymentSummary || data.payment_summary || {};
  const pdf = data.pdf || {};
  card.hidden = false;
  card.innerHTML = `
    <h4><i class="fa-solid fa-circle-check"></i> ${escapeHtml(data.invoiceNumber)} completed</h4>
    <p>Payment status: <strong>${escapeHtml(data.paymentStatus)}</strong></p>
    <p>Outstanding: <strong>${currencySymbol}${Number(payment.outstanding || 0).toFixed(2)}</strong></p>
    <p>PDF: <strong>${escapeHtml(pdf.status || 'PENDING')}</strong>${pdf.error ? ` · ${escapeHtml(pdf.error)}` : ''}</p>
    <div class="checkout-result-actions">
      ${pdf.status === 'READY' ? `<button class="action-btn primary compact" onclick="downloadInvoicePdf(${Number(data.invoiceId)})"><i class="fa-solid fa-download"></i> Download PDF</button>` : `<button class="action-btn secondary compact" onclick="retryInvoicePdf(${Number(data.invoiceId)})"><i class="fa-solid fa-rotate"></i> Retry PDF</button>`}
      <button class="action-btn secondary compact" onclick="openInvoiceDetail(${Number(data.invoiceId)})"><i class="fa-solid fa-eye"></i> View invoice</button>
    </div>`;
}

function scheduleInvoiceSearch() {
  clearTimeout(invoiceSearchTimer);
  invoiceSearchTimer = setTimeout(loadInvoices, 250);
}

async function loadInvoices() {
  const table = document.getElementById('invoicesTable');
  if (!table) return;
  const params = new URLSearchParams();
  const search = document.getElementById('invoiceSearch')?.value.trim();
  const from = document.getElementById('invoiceDateFrom')?.value;
  const to = document.getElementById('invoiceDateTo')?.value;
  const status = document.getElementById('invoicePaymentStatus')?.value;
  if (search) params.set('q', search);
  if (from) params.set('date_from', from);
  if (to) params.set('date_to', to);
  if (status) params.set('payment_status', status);
  table.innerHTML = '<tr><td colspan="9"><i class="fa-solid fa-spinner fa-spin"></i> Loading invoices…</td></tr>';
  try {
    const response = await fetch(`/api/v1/invoices?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Invoices could not be loaded.');
    const invoices = data.invoices || [];
    if (!invoices.length) {
      table.innerHTML = '<tr><td colspan="9">No invoices match these filters.</td></tr>';
      return;
    }
    table.innerHTML = invoices.map(invoice => {
      const statusClass = invoice.payment_status === 'PAID'
        ? 'completed'
        : invoice.payment_status.includes('REFUND') ? 'cancelled' : 'pending';
      const pdfClass = invoice.pdf_status === 'READY' ? 'completed' : invoice.pdf_status === 'FAILED' ? 'cancelled' : 'pending';
      return `<tr>
        <td><strong>${escapeHtml(invoice.invoice_number)}</strong></td>
        <td>${escapeHtml(invoice.customer_name || 'Walk-in Customer')}</td>
        <td>${new Date(invoice.issued_at).toLocaleDateString()}</td>
        <td>${currencySymbol}${Number(invoice.grand_total || 0).toFixed(2)}</td>
        <td>${currencySymbol}${Number(invoice.collected || 0).toFixed(2)}</td>
        <td>${currencySymbol}${Number(invoice.outstanding || 0).toFixed(2)}</td>
        <td><span class="status-badge ${statusClass}">${escapeHtml(invoice.payment_status.replaceAll('_', ' '))}</span></td>
        <td><span class="status-badge ${pdfClass}">${escapeHtml(invoice.pdf_status)}</span></td>
        <td><div class="invoice-row-actions">
          <button class="action-btn secondary compact" onclick="openInvoiceDetail(${Number(invoice.id)})"><i class="fa-solid fa-eye"></i></button>
          ${invoice.pdf_status === 'READY'
            ? `<button class="action-btn secondary compact" onclick="downloadInvoicePdf(${Number(invoice.id)})"><i class="fa-solid fa-download"></i></button>`
            : `<button class="action-btn secondary compact" onclick="retryInvoicePdf(${Number(invoice.id)})"><i class="fa-solid fa-rotate"></i></button>`}
          ${Number(invoice.outstanding || 0) > 0 ? `<button class="action-btn primary compact" onclick="openInvoiceCollection(${Number(invoice.id)}, ${Number(invoice.outstanding || 0)})">Collect</button>` : ''}
        </div></td>
      </tr>`;
    }).join('');
  } catch (error) {
    table.innerHTML = `<tr><td colspan="9">${escapeHtml(error.message)}</td></tr>`;
    showToast(error.message, 'error');
  }
}

async function openInvoiceDetail(invoiceId) {
  const modal = document.getElementById('invoiceDetailModal');
  const body = document.getElementById('invoiceDetailBody');
  const footer = document.getElementById('invoiceDetailFooter');
  if (!modal || !body || !footer) return;
  modal.style.display = 'grid';
  body.innerHTML = '<p><i class="fa-solid fa-spinner fa-spin"></i> Loading invoice…</p>';
  footer.innerHTML = '';
  try {
    const response = await fetch(`/api/v1/invoices/${invoiceId}`);
    const invoice = await response.json();
    if (!response.ok) throw new Error(invoice.error?.message || 'Invoice could not be loaded.');
    activeInvoiceDetail = invoice;
    document.getElementById('invoiceDetailTitle').textContent = invoice.invoice_number;
    const seller = invoice.seller_snapshot || {};
    const customer = invoice.customer_snapshot || {};
    const summary = invoice.payment_summary || {};
    body.innerHTML = `
      <div class="invoice-detail-summary">
        ${invoiceSummaryCard('Grand total', summary.total)}
        ${invoiceSummaryCard('Net received', summary.net_collected)}
        ${invoiceSummaryCard('Outstanding', summary.outstanding)}
        ${invoiceSummaryCard('Payment status', invoice.payment_status, false)}
      </div>
      <div class="invoice-party-grid">
        <div class="invoice-party-card"><h4>${escapeHtml(seller.name || 'Organization')}</h4><p>${escapeHtml(seller.address || '')}</p><p>GSTIN: ${escapeHtml(seller.gstin || '—')}</p><p>State: ${escapeHtml(seller.state || '—')} (${escapeHtml(seller.state_code || '—')})</p></div>
        <div class="invoice-party-card"><h4>${escapeHtml(customer.name || 'Walk-in Customer')}</h4><p>${escapeHtml(customer.address || '')}</p><p>GSTIN: ${escapeHtml(customer.gstin || 'URP')}</p><p>Due: ${invoice.due_date ? new Date(invoice.due_date).toLocaleDateString() : '—'}</p></div>
      </div>
      <h4>Invoice items</h4>
      <div class="table-container"><table><thead><tr><th>Item</th><th>HSN/SAC</th><th>Qty</th><th>Rate</th><th>Taxable</th><th>GST</th><th>Total</th></tr></thead><tbody>
        ${invoice.items.map(item => `<tr><td>${escapeHtml(item.description)}</td><td>${escapeHtml(item.hsn_sac || '—')}</td><td>${escapeHtml(item.quantity)} ${escapeHtml(item.unit)}</td><td>${formatMinorCurrency(item.rate_minor)}</td><td>${formatMinorCurrency(item.taxable_minor)}</td><td>${escapeHtml(item.gst_rate)}%</td><td>${formatMinorCurrency(item.line_total_minor)}</td></tr>`).join('')}
      </tbody></table></div>
      <h4 style="margin-top:16px;">Collection history</h4>
      <div class="table-container"><table><thead><tr><th>Payment</th><th>Method</th><th>Reference</th><th>Amount</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        ${invoice.allocations.length ? invoice.allocations.map(allocation => `<tr>
          <td>${escapeHtml(allocation.payment_number || '—')}</td><td>${escapeHtml(allocation.method.replaceAll('_', ' '))}</td>
          <td>${escapeHtml(allocation.reference_number || '—')}</td><td>${formatMinorCurrency(allocation.amount_minor)}</td>
          <td><span class="status-badge ${allocation.status === 'SUCCESS' ? 'completed' : 'pending'}">${escapeHtml(allocation.status)}</span></td>
          <td><div class="invoice-row-actions">
            ${allocation.status === 'PENDING' && ['CHEQUE', 'OTHER'].includes(allocation.method) ? `<button class="action-btn secondary compact" onclick="confirmInvoiceAllocation(${Number(allocation.id)})">Confirm</button>` : ''}
            ${allocation.status === 'SUCCESS' && allocation.method !== 'RAZORPAY' ? `<button class="action-btn secondary compact" onclick="refundInvoiceAllocation(${Number(allocation.id)}, ${Number(allocation.amount_minor) / 100})">Refund</button>` : ''}
          </div></td>
        </tr>`).join('') : '<tr><td colspan="6">No collection recorded.</td></tr>'}
      </tbody></table></div>`;
    footer.innerHTML = `
      ${summary.outstanding > 0 ? `<button class="action-btn primary" onclick="openInvoiceCollection(${Number(invoice.id)}, ${Number(summary.outstanding)})">Collect outstanding</button>` : ''}
      ${invoice.pdf_status === 'READY'
        ? `<button class="action-btn secondary" onclick="downloadInvoicePdf(${Number(invoice.id)})"><i class="fa-solid fa-download"></i> Download PDF</button>`
        : `<button class="action-btn secondary" onclick="retryInvoicePdf(${Number(invoice.id)})"><i class="fa-solid fa-rotate"></i> Retry PDF</button>`}
      <button class="action-btn secondary" onclick="closeModal('invoiceDetailModal')">Close</button>`;
  } catch (error) {
    body.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  }
}

function invoiceSummaryCard(label, value, currency = true) {
  const display = currency ? `${currencySymbol}${Number(value || 0).toFixed(2)}` : escapeHtml(value || '—');
  return `<div class="kpi-card"><span class="kpi-label">${escapeHtml(label)}</span><h3 class="kpi-value">${display}</h3></div>`;
}

function formatMinorCurrency(value) {
  return `${currencySymbol}${(Number(value || 0) / 100).toFixed(2)}`;
}

async function downloadInvoicePdf(invoiceId) {
  try {
    const response = await fetch(`/api/v1/invoices/${invoiceId}/pdf`);
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Invoice PDF is not ready.');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${activeInvoiceDetail?.id === invoiceId ? activeInvoiceDetail.invoice_number : `invoice-${invoiceId}`}.pdf`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function retryInvoicePdf(invoiceId) {
  try {
    const response = await fetch(`/api/v1/invoices/${invoiceId}/pdf/retry`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'PDF retry failed.');
    showToast(data.pdf?.status === 'READY' ? 'Invoice PDF is ready.' : 'PDF retry was queued.', data.pdf?.status === 'READY' ? 'success' : 'info');
    await loadInvoices();
    if (activeInvoiceDetail?.id === invoiceId) await openInvoiceDetail(invoiceId);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function openInvoiceCollection(invoiceId, outstanding) {
  const modal = document.getElementById('invoiceCollectionModal');
  document.getElementById('collectionInvoiceId').value = invoiceId;
  document.getElementById('collectionOutstanding').value = `${currencySymbol}${Number(outstanding).toFixed(2)}`;
  document.getElementById('collectionAmount').value = Number(outstanding).toFixed(2);
  const select = document.getElementById('collectionMethod');
  select.innerHTML = posPaymentMethods
    .filter(method => !['CUSTOMER_CREDIT', 'RAZORPAY', 'STORE_CREDIT'].includes(method.method))
    .map(method => `<option value="${escapeHtml(method.method)}">${escapeHtml(method.label)}</option>`)
    .join('');
  updateCollectionReferenceState();
  modal.style.display = 'grid';
}

function updateCollectionReferenceState() {
  const method = document.getElementById('collectionMethod')?.value;
  const setting = posPaymentMethods.find(item => item.method === method);
  const input = document.getElementById('collectionReference');
  if (!input) return;
  input.required = Boolean(setting?.requires_reference);
  input.placeholder = setting?.requires_reference ? 'Required' : 'Optional';
}

async function submitInvoiceCollection(event) {
  event.preventDefault();
  const invoiceId = Number(document.getElementById('collectionInvoiceId').value);
  const method = document.getElementById('collectionMethod').value;
  const payload = {
    payments: [{
      method,
      amount: Number(document.getElementById('collectionAmount').value),
      reference: document.getElementById('collectionReference').value.trim() || undefined
    }],
    allow_partial_payment: false
  };
  try {
    const response = await fetch(`/api/v1/invoices/${invoiceId}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Collection could not be recorded.');
    closeModal('invoiceCollectionModal');
    showToast('Collection recorded.', 'success');
    await loadInvoices();
    await openInvoiceDetail(invoiceId);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function confirmInvoiceAllocation(allocationId) {
  try {
    const response = await fetch(`/api/v1/payment-allocations/${allocationId}/confirm`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Payment could not be confirmed.');
    showToast('Pending payment confirmed.', 'success');
    await loadInvoices();
    if (activeInvoiceDetail) await openInvoiceDetail(activeInvoiceDetail.id);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function refundInvoiceAllocation(allocationId, maximum) {
  const amount = window.prompt(`Refund amount (maximum ${maximum.toFixed(2)})`, maximum.toFixed(2));
  if (amount == null) return;
  const reason = window.prompt('Refund reason');
  if (!reason) return;
  try {
    const response = await fetch(`/api/v1/payment-allocations/${allocationId}/refunds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: Number(amount), reason })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Refund could not be recorded.');
    showToast('Refund recorded.', 'success');
    await loadInvoices();
    if (activeInvoiceDetail) await openInvoiceDetail(activeInvoiceDetail.id);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// ================= TILE & AREA CALCULATOR =================
function toggleCalculatorModal() {
  const modal = document.getElementById('calculatorModal');
  modal.classList.toggle('active');

  // Set target tile product (default to Carrara Tile)
  activeCalculatorProduct = products.find(p => p.uom === 'box') || products[0];
  if (activeCalculatorProduct && activeCalculatorProduct.coverage_per_box) {
    document.getElementById('calcBoxCoverage').value = activeCalculatorProduct.coverage_per_box;
  }
  calculateBoxes();
}

let calculatorType = 'floor';

function switchCalcType(type) {
  calculatorType = type;
  document.getElementById('calcTypeFloor').style.display = type === 'floor' ? 'block' : 'none';
  document.getElementById('calcTypeWall').style.display = type === 'wall' ? 'block' : 'none';

  const btnFloor = document.getElementById('btnCalcFloor');
  const btnWall = document.getElementById('btnCalcWall');

  if (type === 'floor') {
    btnFloor.classList.add('active');
    btnFloor.style.borderBottomColor = 'var(--blue-600)';
    btnFloor.style.fontWeight = '700';
    btnFloor.style.color = 'var(--blue-600)';

    btnWall.classList.remove('active');
    btnWall.style.borderBottomColor = 'transparent';
    btnWall.style.fontWeight = '600';
    btnWall.style.color = 'var(--ink-secondary)';
  } else {
    btnWall.classList.add('active');
    btnWall.style.borderBottomColor = 'var(--blue-600)';
    btnWall.style.fontWeight = '700';
    btnWall.style.color = 'var(--blue-600)';

    btnFloor.classList.remove('active');
    btnFloor.style.borderBottomColor = 'transparent';
    btnFloor.style.fontWeight = '600';
    btnFloor.style.color = 'var(--ink-secondary)';
  }
  calculateBoxes();
}

function calculateBoxes() {
  if (calculatorType === 'floor') {
    const length = Number(document.getElementById('calcLength').value) || 0;
    const width = Number(document.getElementById('calcWidth').value) || 0;
    const wastage = Number(document.getElementById('calcWastage').value) || 0;
    const boxCoverage = Number(document.getElementById('calcBoxCoverage').value) || 14.4;

    const netArea = length * width;
    const grossArea = netArea + (netArea * (wastage / 100));
    const boxesNeeded = Math.ceil(grossArea / boxCoverage);

    document.getElementById('resNetArea').innerText = `${netArea.toFixed(1)} Sq. Ft.`;
    document.getElementById('resGrossArea').innerText = `${grossArea.toFixed(1)} Sq. Ft.`;
    document.getElementById('resBoxesNeeded').innerText = `${boxesNeeded} Boxes`;
  } else {
    const wallWidth = Number(document.getElementById('calcWallWidth').value) || 0;
    const wallHeight = Number(document.getElementById('calcWallHeight').value) || 0;
    const panelWidthInches = Number(document.getElementById('calcPanelWidth').value) || 0;
    const panelHeightFt = Number(document.getElementById('calcPanelHeight').value) || 0;
    const wastage = Number(document.getElementById('calcWallWastage').value) || 0;
    const panelsPerPack = Number(document.getElementById('calcPanelsPerPack').value) || 10;

    const panelWidthFt = panelWidthInches / 12;
    const wallArea = wallWidth * wallHeight;
    const singlePanelArea = panelWidthFt * panelHeightFt;

    const columns = Math.ceil(wallWidth / panelWidthFt) || 0;
    const verticalMultiplier = Math.ceil(wallHeight / panelHeightFt) || 0;
    
    const basePanels = columns * verticalMultiplier;
    const panelsNeeded = Math.ceil(basePanels * (1 + (wastage / 100)));
    const packsNeeded = Math.ceil(panelsNeeded / panelsPerPack) || 0;

    document.getElementById('resWallNetArea').innerText = `${wallArea.toFixed(1)} Sq. Ft.`;
    document.getElementById('resSinglePanelArea').innerText = `${singlePanelArea.toFixed(2)} Sq. Ft.`;
    document.getElementById('resPanelsNeeded').innerText = `${panelsNeeded} Panels`;
    document.getElementById('resWallPacksNeeded').innerText = `${packsNeeded} Pack${packsNeeded !== 1 ? 's' : ''}`;
  }
}

function copyCalculatorResultToCart() {
  if (calculatorType === 'floor') {
    const boxCount = parseInt(document.getElementById('resBoxesNeeded').innerText) || 1;
    if (activeCalculatorProduct) {
      const cartItem = cart.find(item => item.product_id === activeCalculatorProduct.id);
      if (cartItem) {
        cartItem.quantity = boxCount;
      } else {
        cart.push({
          product_id: activeCalculatorProduct.id,
          name: activeCalculatorProduct.name,
          sku: activeCalculatorProduct.sku,
          unit_price: activeCalculatorProduct.selling_price,
          quantity: boxCount,
          uom: activeCalculatorProduct.uom,
          coverage_per_box: activeCalculatorProduct.coverage_per_box
        });
      }
      recalculateCart();
      toggleCalculatorModal();
      document.querySelector('.nav-btn[data-tab="pos"]').click();
    }
  } else {
    const packCount = parseInt(document.getElementById('resWallPacksNeeded').innerText) || 1;
    if (activeCalculatorProduct) {
      const cartItem = cart.find(item => item.product_id === activeCalculatorProduct.id);
      if (cartItem) {
        cartItem.quantity = packCount;
      } else {
        cart.push({
          product_id: activeCalculatorProduct.id,
          name: activeCalculatorProduct.name,
          sku: activeCalculatorProduct.sku,
          unit_price: activeCalculatorProduct.selling_price,
          quantity: packCount,
          uom: activeCalculatorProduct.uom,
          coverage_per_box: activeCalculatorProduct.coverage_per_box
        });
      }
      recalculateCart();
      toggleCalculatorModal();
      document.querySelector('.nav-btn[data-tab="pos"]').click();
    }
  }
}

// ================= MODULE 3: PRODUCT CATALOG TABLE =================
function loadInventoryTable() {
  const table = document.getElementById('inventoryListTable');
  table.innerHTML = '';
  
  products.forEach(p => {
    const brand = brands.find(b => b.id === p.brand_id)?.name || 'N/A';
    const cat = categories.find(c => c.id === p.category_id)?.name || 'N/A';
    const tr = document.createElement('tr');
    
    tr.innerHTML = `
      <td>
        <strong>${p.name}</strong><br>
        <span style="font-size:0.75rem; color:var(--text-muted)">
          SKU: ${p.sku} | Barcode: <span style="cursor:pointer; color:var(--primary); font-weight:600; text-decoration:underline" onclick="openBarcodeModal(${p.id})"><i class="fa-solid fa-barcode"></i> ${p.barcode || p.sku}</span>
        </span>
      </td>
      <td>${brand}</td>
      <td>${cat}</td>
      <td><span class="tag">${p.material || 'N/A'}</span> <span class="tag">${p.finish || 'N/A'}</span></td>
      <td><code>${p.shade_lot_number || 'N/A'}</code></td>
      <td>Cost: ${currencySymbol}${(p.cost_price || 0).toFixed(2)}<br><span style="font-weight:700">Sell: ${currencySymbol}${(p.selling_price || 0).toFixed(2)}</span></td>
      <td>
        <span class="stock-pill ${(p.stock || 0) < p.min_stock_alert ? 'low' : 'ok'}">${p.stock || 0} ${p.uom}s</span>
      </td>
      <td>
        <button class="action-btn-sm" onclick="openBarcodeModal(${p.id})" title="View and print barcode">
          <i class="fa-solid fa-barcode"></i> ${p.barcode ? 'Print' : 'Assign'}
        </button>
        <button class="action-btn-sm" style="background:#fef2f2; border:1px solid #fee2e2; color:#dc2626; padding: 6px 10px; border-radius: 4px; font-weight:700; cursor:pointer;" onclick="deleteProduct(${p.id})">
          <i class="fa-solid fa-trash-can"></i> Delete
        </button>
      </td>
    `;
    table.appendChild(tr);
  });
}

async function deleteProduct(productId) {
  if (!confirm('Are you sure you want to delete this product? This will also remove any related stock information.')) {
    return;
  }

  const p = products.find(prod => prod.id === productId);
  const pName = p ? p.name : 'Product';

  const actionFn = async () => {
    const res = await fetch(`/api/v1/products/${productId}`, { method: 'DELETE' });

    if (!res.ok) {
      throw new Error(`Server error: ${res.status}`);
    }

    await res.json();
    await syncWithBackend();
  };

  await executeAction(null, actionFn, "Product deleted successfully.", `Product "${pName}" removed from catalog.`);
}

function openProductModal() {
  document.getElementById('productModal').classList.add('active');
}

function closeProductModal() {
  document.getElementById('productModal').classList.remove('active');
}

function toggleBoxCoverageField() {
  const uom = document.getElementById('pUom').value;
  const coverageGroup = document.getElementById('pBoxCoverageGroup');
  if (uom === 'box') {
    coverageGroup.style.display = 'block';
  } else {
    coverageGroup.style.display = 'none';
  }
}

function toggleProductBarcodeFields() {
  const auto = document.getElementById('pAutoBarcode')?.checked !== false;
  const input = document.getElementById('pBarcode');
  if (!input) return;
  input.disabled = auto;
  input.placeholder = auto ? 'Organization sequence will be used' : 'Enter a valid persistent barcode';
  if (auto) input.value = '';
}

async function submitNewProduct(event) {
  event.preventDefault();

  const fileInput = document.getElementById('pImageFile');
  let imageUrl = '';

  try {
    // If a file is selected, convert to Base64 and use directly (perfect for serverless Vercel)
    if (fileInput && fileInput.files && fileInput.files[0]) {
      const file = fileInput.files[0];
      imageUrl = await toBase64(file);
    }
  } catch (err) {
    console.error('Image processing failed:', err);
  }
  
  const payload = {
    name: document.getElementById('pName').value,
    sku: document.getElementById('pSku').value,
    brand_id: parseInt(document.getElementById('pBrand').value),
    category_id: parseInt(document.getElementById('pCategory').value),
    uom: document.getElementById('pUom').value,
    coverage_per_box: parseFloat(document.getElementById('pBoxCoverage').value) || null,
    cost_price: parseFloat(document.getElementById('pCost').value),
    selling_price: parseFloat(document.getElementById('pPrice').value),
    material: document.getElementById('pMaterial').value,
    finish: document.getElementById('pFinish').value,
    dimensions: document.getElementById('pDimensions').value,
    shade_lot_number: document.getElementById('pLot').value,
    image_url: imageUrl,
    min_stock_alert: 5,
    stock: 0,
    barcode: document.getElementById('pAutoBarcode')?.checked
      ? null
      : (document.getElementById('pBarcode')?.value.trim() || null),
    barcode_type: document.getElementById('pBarcodeType')?.value || 'CODE128'
  };

  try {
    const response = await fetch('/api/v1/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Product creation failed.');
    closeProductModal();
    document.getElementById('productForm').reset();
    await loadEnterpriseWorkspaces();
    loadInventoryTable();
    loadPOSCatalog();
    showToast(data.barcode
      ? `Product created with barcode ${data.barcode}.`
      : 'Product created; barcode assignment is pending retry.', data.barcode ? 'success' : 'info');
    if (data.barcode) openBarcodeModal(Number(data.id));
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// Base64 File Helper
function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result);
    reader.onerror = error => reject(error);
  });
}

// ================= MODULE 4: STOCK TRANSFERS =================
function loadTransferLogs() {
  const table = document.getElementById('transferLogTable');
  if (!table) return;
  table.innerHTML = '';
  
  if (transfers.length === 0) {
    table.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center; color: var(--ink-muted); padding: 24px; font-weight: 500;">
          <i class="fa-solid fa-circle-info" style="margin-right: 6px;"></i> No stock transfers logged yet.
        </td>
      </tr>
    `;
    return;
  }
  
  transfers.forEach(t => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${t.product}</strong></td>
      <td>${t.from} <i class="fa-solid fa-arrow-right-long" style="margin:0 4px;font-size:0.8rem"></i> ${t.to}</td>
      <td>${t.qty}</td>
      <td><span class="badge-status ${t.status}">${t.status}</span></td>
    `;
    table.appendChild(tr);
  });
}

async function submitStockTransfer(event) {
  event.preventDefault();
  const btn = event.target.querySelector('button[type="submit"]') || event.target.querySelector('.submit-form-btn');

  const pId = parseInt(document.getElementById('transferProductSelect').value);
  const fromWhId = parseInt(document.getElementById('transferFromSelect').value);
  const toWhId = parseInt(document.getElementById('transferToSelect').value);
  const qty = parseInt(document.getElementById('transferQty').value);

  const payload = {
    from_warehouse_id: fromWhId,
    to_warehouse_id: toWhId,
    product_id: pId,
    quantity: qty
  };

  const product = products.find(p => p.id === pId);
  const pName = product ? product.name : 'Product';

  const actionFn = async () => {
    const res = await fetch('/api/inventory/stock/transfer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('token') || ''}`,
        'x-user-role': 'manager',
        'x-user-id': '1'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Server error');
    }

    document.getElementById('transferForm').reset();
    await syncWithBackend();
  };

  await executeAction(btn, actionFn, "Stock transfer completed successfully!", `Transferred ${qty} of ${pName} between warehouses.`);
}



// Helper dropdown loaders
function populateDropdowns() {
  const transferProd = document.getElementById('transferProductSelect');
  const transferFrom = document.getElementById('transferFromSelect');
  const transferTo = document.getElementById('transferToSelect');
  
  const formBrand = document.getElementById('pBrand');
  const formCat = document.getElementById('pCategory');

  // Clear
  if (transferProd) transferProd.innerHTML = '';
  if (transferFrom) transferFrom.innerHTML = '';
  if (transferTo) transferTo.innerHTML = '';
  if (formBrand) formBrand.innerHTML = '';
  if (formCat) formCat.innerHTML = '';

  // Populate products
  if (transferProd) {
    products.forEach(p => {
      transferProd.innerHTML += `<option value="${p.id}">${p.name} (${p.sku})</option>`;
    });
  }

  // Populate warehouses dynamically
  if (transferFrom && transferTo) {
    warehouses.forEach(w => {
      transferFrom.innerHTML += `<option value="${w.id}">${w.name} (${w.code})</option>`;
      transferTo.innerHTML += `<option value="${w.id}">${w.name} (${w.code})</option>`;
    });
  }

  // Populate brands
  if (formBrand) {
    brands.forEach(b => {
      formBrand.innerHTML += `<option value="${b.id}">${b.name}</option>`;
    });
  }

  // Populate categories
  if (formCat) {
    categories.forEach(c => {
      formCat.innerHTML += `<option value="${c.id}">${c.name}</option>`;
    });
  }

  // Populate adjust product dropdown
  const adjProd = document.getElementById('adjProduct');
  if (adjProd) {
    adjProd.innerHTML = '';
    products.forEach(p => {
      adjProd.innerHTML += `<option value="${p.id}">${p.name} (${p.sku})</option>`;
    });
  }

  // Populate adjust warehouse dropdown
  const adjWh = document.getElementById('adjWarehouse');
  if (adjWh) {
    adjWh.innerHTML = '';
    warehouses.forEach(w => {
      adjWh.innerHTML += `<option value="${w.id}">${w.name}</option>`;
    });
  }

  // Populate POS warehouse dropdown
  const cartWh = document.getElementById('cartWarehouseSelect');
  if (cartWh) {
    cartWh.innerHTML = '';
    warehouses.forEach(w => {
      cartWh.innerHTML += `<option value="${w.id}">${w.name}</option>`;
    });
  }

  // Populate POS Customer dropdown search helper
  const cartCustInput = document.getElementById('cartCustomerSearchInput');
  const cartCustSelect = document.getElementById('cartCustomerSelect');
  if (cartCustInput && !cartCustInput.value) {
    cartCustInput.value = 'Walk-in Customer';
    if (cartCustSelect) cartCustSelect.value = '';
  }
}

// Modal Controllers
function openTransferModal() {
  switchTab('transfers');
  const form = document.getElementById('transferForm');
  if (form) {
    form.scrollIntoView({ behavior: 'smooth' });
    const sel = document.getElementById('transferProductSelect');
    if (sel) sel.focus();
  }
}

function openStockInwardModal() {
  document.getElementById('stockInwardModal').classList.add('active');
  populateDropdowns();
}

function closeStockInwardModal() {
  document.getElementById('stockInwardModal').classList.remove('active');
}

function openCustomerModal() {
  document.getElementById('customerModal').classList.add('active');
}

function closeCustomerModal() {
  document.getElementById('customerModal').classList.remove('active');
}

// Submit Stock Adjustment Form
async function submitStockAdjustment(event) {
  event.preventDefault();
  const pId = parseInt(document.getElementById('adjProduct').value);
  const wId = parseInt(document.getElementById('adjWarehouse').value);
  const qty = parseInt(document.getElementById('adjQty').value);
  const reason = document.getElementById('adjReason').value;
  const notes = document.getElementById('adjNotes').value;

  try {
    const response = await fetch('/api/v1/inventory/adjustments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id: pId,
        warehouse_id: wId,
        quantity: Math.abs(qty),
        direction: qty >= 0 ? 'increase' : 'decrease',
        reason,
        notes
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Stock adjustment failed.');
    closeStockInwardModal();
    document.getElementById('stockInwardForm').reset();
    await loadEnterpriseWorkspaces();
    loadInventoryTable();
    loadPOSCatalog();
    loadDashboardData();
    loadTransferLogs();
    showToast('Stock adjustment posted to the movement ledger.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function exportCustomersCSV() {
  if (customers.length === 0) {
    alert("No customer records found to export.");
    return;
  }

  const headers = ["Customer ID", "Name", "Phone", "Email", "Address", "Credit Limit", "Current Balance", "Loyalty Points", "Tier"];
  const rows = customers.map(c => [
    `CUST-${c.id}`,
    c.name,
    c.phone || '',
    c.email || '',
    c.address ? c.address.replace(/\n/g, " ") : '',
    (c.credit_limit || 0).toFixed(2),
    (c.balance || 0).toFixed(2),
    c.loyalty_points || 0,
    c.tier || 'bronze'
  ]);

  const csvContent = [
    headers.join(","),
    ...rows.map(row => row.map(val => `"${val.toString().replace(/"/g, '""')}"`).join(","))
  ].join("\n");

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `inventia_customers_export_${new Date().toISOString().split('T')[0]}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Submit Customer Form
async function submitNewCustomer(event) {
  event.preventDefault();
  const btn = event.target.querySelector('button[type="submit"]') || event.target.querySelector('.submit-form-btn');
  
  const payload = {
    id: customers.length + 1,
    name: document.getElementById('cName').value,
    phone: document.getElementById('cPhone').value,
    email: document.getElementById('cEmail').value,
    address: document.getElementById('cAddress').value,
    credit_limit: parseFloat(document.getElementById('cLimit').value) || 0,
    balance: parseFloat(document.getElementById('cBalance').value) || 0,
    loyalty_points: 0,
    tier: 'bronze'
  };

  const actionFn = async () => {
    const res = await fetch('/api/sales/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    customers.push(payload);
    closeCustomerModal();
    document.getElementById('customerForm').reset();
    loadCustomerLedger();
    populateDropdowns();
  };

  await executeAction(btn, actionFn, "Customer profile created successfully!", `Customer ${payload.name} registered successfully.`);
}

// Setup Event Listeners for Filtering & Search
document.addEventListener('DOMContentLoaded', () => {

  // Search filter keyup
  const searchInput = document.getElementById('globalSearch');
  if (searchInput) {
    searchInput.addEventListener('keyup', (e) => {
      const val = e.target.value.toLowerCase();
      
      // Filter inventory table
      const filteredProds = products.filter(p => 
        p.name.toLowerCase().includes(val) || 
        p.sku.toLowerCase().includes(val) ||
        (p.barcode && p.barcode.toLowerCase().includes(val))
      );
      renderFilteredInventoryTable(filteredProds);
      
      // Filter POS Grid
      loadPOSCatalog(filteredProds);
    });
  }
});

// POS category catalog filtering
function filterPOSCatalog(categoryName) {
  if (categoryName === 'all') {
    loadPOSCatalog();
    return;
  }
  
  const cat = categories.find(c => c.name.toLowerCase().includes(categoryName.toLowerCase()));
  if (!cat) {
    loadPOSCatalog([]);
    return;
  }
  
  const filtered = products.filter(p => p.category_id === cat.id);
  loadPOSCatalog(filtered);
}

function renderFilteredInventoryTable(filteredProducts) {
  const table = document.getElementById('inventoryListTable');
  table.innerHTML = '';
  filteredProducts.forEach(p => {
    const brand = brands.find(b => b.id === p.brand_id)?.name || 'N/A';
    const cat = categories.find(c => c.id === p.category_id)?.name || 'N/A';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <strong>${p.name}</strong><br>
        <span style="font-size:0.75rem; color:var(--text-muted)">SKU: ${p.sku} | Barcode: ${p.barcode || 'N/A'}</span>
      </td>
      <td>${brand}</td>
      <td>${cat}</td>
      <td><span class="tag">${p.material || 'N/A'}</span> <span class="tag">${p.finish || 'N/A'}</span></td>
      <td><code>${p.shade_lot_number || 'N/A'}</code></td>
      <td>Cost: ${currencySymbol}${(p.cost_price || 0).toFixed(2)}<br><span style="font-weight:700">Sell: ${currencySymbol}${(p.selling_price || 0).toFixed(2)}</span></td>
      <td>
        <span class="stock-pill ${(p.stock || 0) < p.min_stock_alert ? 'low' : 'ok'}">${p.stock || 0} ${p.uom}s</span>
      </td>
    `;
    table.appendChild(tr);
  });
}

// ================= BRANDS & CATEGORIES OPERATIONS =================
function loadBrandsAndCategories() {
  // Brand Table
  const brandTable = document.getElementById('brandListTable');
  if (brandTable) {
    brandTable.innerHTML = '';
    brands.forEach(b => {
      brandTable.innerHTML += `
        <tr>
          <td><strong>${b.name}</strong></td>
          <td><code>${b.code}</code></td>
        </tr>
      `;
    });
  }

  // Category Table
  const catTable = document.getElementById('categoryListTable');
  const catDropdown = document.getElementById('catParentInput');
  if (catTable) {
    catTable.innerHTML = '';
    if (catDropdown) catDropdown.innerHTML = '<option value="">None (Top Level)</option>';
    
    categories.forEach(c => {
      const parentName = categories.find(parent => parent.id === c.parent_id)?.name || 'Top Level';
      catTable.innerHTML += `
        <tr>
          <td><strong>${c.name}</strong></td>
          <td><span class="tag">${parentName}</span></td>
        </tr>
      `;
      if (catDropdown) {
        catDropdown.innerHTML += `<option value="${c.id}">${c.name}</option>`;
      }
    });
  }
}

async function submitNewBrand(event) {
  event.preventDefault();
  const name = document.getElementById('bNameInput').value;
  const code = document.getElementById('bCodeInput').value;

  const payload = { name, code };

  try {
    const res = await fetch('/api/v1/reference/brands', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || 'Server error');
    }

    alert('Brand added successfully!');
    document.getElementById('brandForm').reset();
    await syncWithBackend();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function submitNewCategory(event) {
  event.preventDefault();
  const name = document.getElementById('catNameInput').value;
  const parentVal = document.getElementById('catParentInput').value;
  const parentId = parentVal ? parseInt(parentVal) : null;

  const payload = { name, parent_id: parentId };

  try {
    const res = await fetch('/api/v1/reference/categories', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || 'Server error');
    }

    alert('Category added successfully!');
    document.getElementById('categoryForm').reset();
    await syncWithBackend();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ================= STAFF & USER MANAGEMENT =================
function loadStaffList() {
  const table = document.getElementById('staffListTable');
  if (table) {
    table.innerHTML = '';
    staff.forEach(s => {
      const isActive = s.status !== 0;
      table.innerHTML += `
        <tr>
          <td>
            <strong>${s.full_name}</strong><br>
            <span class="badge-status ${s.role === 'admin' ? 'completed' : 'pending'}">${s.role.toUpperCase()}</span>
          </td>
          <td>${s.username}<br><span style="font-size:0.75rem; color:var(--text-muted)">${s.email}</span></td>
          <td>
            <button class="action-btn-sm" style="background-color:${isActive ? 'var(--success)' : 'var(--text-muted)'}; color:#fff; border:none; padding:4px 8px; border-radius:4px; cursor:pointer;" onclick="toggleUserStatus(${s.id}, ${isActive ? 1 : 0})">
              ${isActive ? 'Active' : 'Inactive'}
            </button>
          </td>
        </tr>
      `;
    });
  }
}

async function submitNewStaff(event) {
  event.preventDefault();
  const btn = event.target.querySelector('button[type="submit"]') || event.target.querySelector('.submit-form-btn');

  const full_name = document.getElementById('sFullName').value;
  const username = document.getElementById('sUsername').value;
  const role = document.getElementById('sRole').value;
  const email = document.getElementById('sEmail').value;
  const password = document.getElementById('sPassword').value;

  const payload = { username, password, full_name, email, role };

  const actionFn = async () => {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('token') || ''}`,
        'x-user-role': 'admin'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Server error');
    }

    document.getElementById('staffForm').reset();
    await syncWithBackend();
  };

  await executeAction(btn, actionFn, "Staff account registered successfully!", `New staff user "${full_name}" registered.`);
}

async function toggleUserStatus(userId, currentStatus) {
  const member = staff.find(s => s.id === userId);
  if (member) {
    const newStatus = currentStatus === 1 ? 0 : 1;
    try {
      const res = await fetch(`/api/users/${userId}/status`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token') || ''}`,
          'x-user-role': 'admin'
        },
        body: JSON.stringify({ status: newStatus })
      });

      if (!res.ok) {
        throw new Error('Server error');
      }

      alert(`Staff account status updated!`);
      await syncWithBackend();
    } catch (err) {
      showToast(err.message || 'Staff status was not changed.', 'error');
    }
  }
}

// ================= APP SETTINGS MANAGEMENT =================
async function submitSettings(event) {
  event.preventDefault();
  const btn = event.target.querySelector('button[type="submit"]') || event.target.querySelector('.submit-form-btn');
  
  const companyName = document.getElementById('setCompanyName').value;
  const companyEmail = document.getElementById('setCompanyEmail').value;
  const companyAddress = document.getElementById('setCompanyAddress').value;
  const companyPhone = document.getElementById('setCompanyPhone').value;
  const currencySymbol = document.getElementById('setCurrencySymbol').value;
  const currencyCode = document.getElementById('setCurrencyCode').value;
  const taxRate = parseFloat(document.getElementById('setTaxRate').value) / 100;
  const themeMode = document.getElementById('setThemeMode').value;
  const themeColor = document.getElementById('setThemeColor').value;

  const payload = [
    { setting_key: 'company_name', setting_value: companyName },
    { setting_key: 'company_email', setting_value: companyEmail },
    { setting_key: 'company_address', setting_value: companyAddress },
    { setting_key: 'company_phone', setting_value: companyPhone },
    { setting_key: 'currency_symbol', setting_value: currencySymbol },
    { setting_key: 'currency_code', setting_value: currencyCode },
    { setting_key: 'tax_rate', setting_value: taxRate.toString() },
    { setting_key: 'theme_mode', setting_value: themeMode },
    { setting_key: 'theme_color', setting_value: themeColor }
  ];

  const logo = document.querySelector('.logo-title');
  if (logo) logo.innerText = companyName.toUpperCase();

  const actionFn = async () => {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('token') || ''}`,
        'x-user-role': 'admin'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Server error');
    }
    await syncWithBackend();
  };

  await executeAction(btn, actionFn, "Global settings updated successfully!", "System settings updated successfully.");
}

// ================= REPORTS & ANALYTICS OPERATIONS =================
let activeReport = 'sales';
let repSalesChartInstance = null;
let repPaymentChartInstance = null;
let repChartMode = 'revenue'; // 'revenue', 'transactions', 'profit'

function switchReportTab(type) {
  activeReport = type;
  document.getElementById('repSalesBtn').classList.remove('active');
  document.getElementById('repStockBtn').classList.remove('active');
  document.getElementById('repCustBtn').classList.remove('active');

  // Hide all content containers
  document.getElementById('reportSalesContainer').classList.remove('active');
  document.getElementById('reportStockContainer').classList.remove('active');
  document.getElementById('reportCustContainer').classList.remove('active');

  if (type === 'sales') {
    document.getElementById('repSalesBtn').classList.add('active');
    document.getElementById('reportSalesContainer').classList.add('active');
    generateSalesReport();
  } else if (type === 'stock') {
    document.getElementById('repStockBtn').classList.add('active');
    document.getElementById('reportStockContainer').classList.add('active');
    generateStockReport();
  } else if (type === 'cust') {
    document.getElementById('repCustBtn').classList.add('active');
    document.getElementById('reportCustContainer').classList.add('active');
    generateCustomerReport();
  }
}

function generateSalesReport() {
  const startDateStr = document.getElementById('repStartDate').value;
  const endDateStr = document.getElementById('repEndDate').value;
  if (!startDateStr || !endDateStr) return;

  const start = new Date(startDateStr);
  start.setHours(0,0,0,0);
  const end = new Date(endDateStr);
  end.setHours(23,59,59,999);

  // Filter sales
  const filteredSales = sales.filter(s => {
    const d = new Date(s.sale_date);
    return d >= start && d <= end;
  });

  // Calculate totals
  const totalSales = filteredSales.length;
  const totalRevenue = filteredSales.reduce((acc, s) => acc + s.total, 0);
  const totalProfit = filteredSales.reduce((acc, s) => acc + (s.total * 0.527), 0);
  const avgSale = totalSales > 0 ? (totalRevenue / totalSales) : 0;

  // Update UI values
  document.getElementById('repTotalSalesCount').innerText = totalSales;
  document.getElementById('repTotalRevenueAmt').innerText = `$${totalRevenue.toFixed(2)}`;
  document.getElementById('repTotalProfitAmt').innerText = `$${totalProfit.toFixed(2)}`;
  document.getElementById('repAvgSaleAmt').innerText = `$${avgSale.toFixed(2)}`;

  // Update table
  const tbody = document.getElementById('repSalesTableBody');
  tbody.innerHTML = '';
  filteredSales.forEach(s => {
    const cust = customers.find(c => c.id === s.customer_id)?.name || 'Walk-in';
    const date = new Date(s.sale_date).toLocaleDateString();
    const profit = s.total * 0.527;
    const tax = s.total * 0.1;
    tbody.innerHTML += `
      <tr>
        <td><strong>${s.invoice_no}</strong></td>
        <td>${cust}</td>
        <td>${date}</td>
        <td><span class="badge-pay">${s.payment_method.toUpperCase()}</span></td>
        <td>$${tax.toFixed(2)}</td>
        <td><strong>$${s.total.toFixed(2)}</strong></td>
        <td style="color: var(--green-800); font-weight: 700;">$${profit.toFixed(2)}</td>
      </tr>
    `;
  });

  if (filteredSales.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--ink-muted);">No transactions found in this date range.</td></tr>';
  }

  // Render Charts
  renderSalesReportCharts(filteredSales);
}

function renderSalesReportCharts(filteredSales) {
  if (typeof Chart === 'undefined') return;

  // Group by date for Daily Sales Performance
  const dateMap = {};
  filteredSales.forEach(s => {
    const dStr = new Date(s.sale_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    if (!dateMap[dStr]) {
      dateMap[dStr] = { revenue: 0, transactions: 0, profit: 0 };
    }
    dateMap[dStr].revenue += s.total;
    dateMap[dStr].transactions += 1;
    dateMap[dStr].profit += s.total * 0.527;
  });

  const labels = Object.keys(dateMap).length > 0 ? Object.keys(dateMap) : ['No Data'];
  const dataPoints = Object.keys(dateMap).length > 0 
    ? Object.values(dateMap).map(v => {
        if (repChartMode === 'revenue') return v.revenue;
        if (repChartMode === 'transactions') return v.transactions;
        if (repChartMode === 'profit') return v.profit;
      })
    : [0];

  // 1. Line Chart
  const ctxLine = document.getElementById('repSalesLineChart');
  if (ctxLine) {
    if (repSalesChartInstance) repSalesChartInstance.destroy();
    repSalesChartInstance = new Chart(ctxLine, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: repChartMode.charAt(0).toUpperCase() + repChartMode.slice(1),
          data: dataPoints,
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37, 99, 235, 0.15)',
          fill: true,
          tension: 0.4,
          pointBackgroundColor: '#2563eb',
          pointRadius: 5
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { color: '#f1f5f9' } },
          x: { grid: { display: false } }
        }
      }
    });
  }

  // 2. Doughnut Chart for Payment Distribution
  const payMap = { cash: 0, card: 0, upi: 0 };
  filteredSales.forEach(s => {
    const m = s.payment_method.toLowerCase();
    if (payMap[m] !== undefined) payMap[m]++;
  });

  const ctxDoughnut = document.getElementById('repPaymentDoughnutChart');
  if (ctxDoughnut) {
    if (repPaymentChartInstance) repPaymentChartInstance.destroy();
    repPaymentChartInstance = new Chart(ctxDoughnut, {
      type: 'doughnut',
      data: {
        labels: ['Cash', 'Card', 'UPI'],
        datasets: [{
          data: [payMap.cash, payMap.card, payMap.upi],
          backgroundColor: ['#16a34a', '#2563eb', '#7c3aed']
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } }
      }
    });
  }
}

function toggleRepChartMode(mode) {
  repChartMode = mode;
  document.getElementById('btnRepChartRev').classList.remove('active');
  document.getElementById('btnRepChartTx').classList.remove('active');
  document.getElementById('btnRepChartProfit').classList.remove('active');

  if (mode === 'revenue') document.getElementById('btnRepChartRev').classList.add('active');
  if (mode === 'transactions') document.getElementById('btnRepChartTx').classList.add('active');
  if (mode === 'profit') document.getElementById('btnRepChartProfit').classList.add('active');

  generateSalesReport();
}

function toggleQuickRangeDropdown() {
  const d = document.getElementById('quickRangeDropdown');
  if (d) d.style.display = d.style.display === 'none' ? 'block' : 'none';
}

function setQuickRange(range) {
  const startInput = document.getElementById('repStartDate');
  const endInput = document.getElementById('repEndDate');
  if (!startInput || !endInput) return;

  const today = new Date();
  let start = new Date();
  let end = new Date();

  if (range === 'today') {
    start = today;
    end = today;
  } else if (range === 'yesterday') {
    start.setDate(today.getDate() - 1);
    end.setDate(today.getDate() - 1);
  } else if (range === 'this_week') {
    const day = today.getDay();
    const diff = today.getDate() - day + (day === 0 ? -6 : 1);
    start = new Date(today.setDate(diff));
    end = new Date();
  } else if (range === 'this_month') {
    start = new Date(today.getFullYear(), today.getMonth(), 1);
    end = new Date();
  }

  const format = (d) => d.toISOString().split('T')[0];
  startInput.value = format(start);
  endInput.value = format(end);

  toggleQuickRangeDropdown();
  generateSalesReport();
}

function generateStockReport() {
  const totalValCost = products.reduce((acc, p) => acc + ((p.stock || 0) * p.cost_price), 0);
  const totalValRetail = products.reduce((acc, p) => acc + ((p.stock || 0) * p.selling_price), 0);
  const totalQty = products.reduce((acc, p) => acc + (p.stock || 0), 0);

  document.getElementById('repStockValuationCost').innerText = `$${totalValCost.toFixed(2)}`;
  document.getElementById('repStockValuationRetail').innerText = `$${totalValRetail.toFixed(2)}`;
  document.getElementById('repTotalStockQty').innerText = totalQty;

  const tbody = document.getElementById('repStockTableBody');
  tbody.innerHTML = '';
  products.forEach(p => {
    const qty = p.stock || 0;
    const valCost = qty * p.cost_price;
    const valRetail = qty * p.selling_price;
    tbody.innerHTML += `
      <tr>
        <td><code>${p.sku}</code></td>
        <td><strong>${p.name}</strong></td>
        <td>$${p.cost_price.toFixed(2)}</td>
        <td>$${p.selling_price.toFixed(2)}</td>
        <td><span class="stock-pill ${qty < p.min_stock_alert ? 'low' : 'ok'}">${qty} ${p.uom}</span></td>
        <td><strong>$${valCost.toFixed(2)}</strong></td>
        <td><strong>$${valRetail.toFixed(2)}</strong></td>
      </tr>
    `;
  });
}

function generateCustomerReport() {
  const totalCust = customers.length;
  const totalBalances = customers.reduce((acc, c) => acc + (c.balance || 0), 0);
  const totalPoints = customers.reduce((acc, c) => acc + (c.loyalty_points || 0), 0);

  document.getElementById('repTotalCustCount').innerText = totalCust;
  document.getElementById('repTotalOutstandingAmt').innerText = `$${totalBalances.toFixed(2)}`;
  document.getElementById('repTotalLoyaltyPts').innerText = `${totalPoints} pts`;

  const tbody = document.getElementById('repCustTableBody');
  tbody.innerHTML = '';
  customers.forEach(c => {
    tbody.innerHTML += `
      <tr>
        <td><strong>${c.name}</strong></td>
        <td>${c.phone}</td>
        <td>$${c.credit_limit.toFixed(2)}</td>
        <td style="color:${c.balance > 0 ? 'var(--red-600)' : 'inherit'}; font-weight:${c.balance > 0 ? '700' : 'normal'}">$${c.balance.toFixed(2)}</td>
        <td><span class="status-badge completed">${c.tier.toUpperCase()}</span></td>
        <td><strong>${c.loyalty_points}</strong></td>
      </tr>
    `;
  });
}

// ================= CATEGORY MANAGEMENT LOGIC =================
function loadCategoryManagement() {
  const totalCategories = categories.length;
  
  const categoryCounts = {};
  products.forEach(p => {
    if (p.category_id) {
      categoryCounts[p.category_id] = (categoryCounts[p.category_id] || 0) + 1;
    }
  });

  const activeCategoriesCount = Object.keys(categoryCounts).length;
  const totalProductsCount = products.length;

  const statsTotal = document.getElementById('statsTotalCategories');
  if (statsTotal) statsTotal.innerText = totalCategories;
  const statsActive = document.getElementById('statsActiveCategories');
  if (statsActive) statsActive.innerText = activeCategoriesCount;
  const statsProducts = document.getElementById('statsProductsAssigned');
  if (statsProducts) statsProducts.innerText = totalProductsCount;

  const grid = document.getElementById('categoryGrid');
  if (!grid) return;
  grid.innerHTML = '';

  categories.forEach(cat => {
    const count = categoryCounts[cat.id] || 0;
    const desc = cat.description || `${cat.name} products and materials`;
    const createdDate = cat.created_at ? new Date(cat.created_at).toLocaleDateString() : 'Jul 21, 2026';
    const updatedDate = cat.updated_at ? new Date(cat.updated_at).toLocaleDateString() : 'Jul 21, 2026';

    const card = document.createElement('div');
    card.className = 'category-card';
    card.innerHTML = `
      <div class="category-card-header">
        <h4 class="category-title">${cat.name}</h4>
        <span class="category-badge">${count} products</span>
      </div>
      <p class="category-desc">${desc}</p>
      <div class="category-meta">
        <span>Created: ${createdDate}</span>
        <span>Updated: ${updatedDate}</span>
      </div>
      <div class="category-actions">
        <button class="category-btn edit" onclick="editCategory(${cat.id})"><i class="fa-solid fa-pen"></i> Edit</button>
        <button class="category-btn delete" onclick="deleteCategory(${cat.id})"><i class="fa-solid fa-trash-can"></i> Delete</button>
      </div>
    `;
    grid.appendChild(card);
  });
}

function openAddCategoryModal() {
  const modal = document.getElementById('categoryModal');
  if (modal) modal.classList.add('active');
}

function closeCategoryModal() {
  const modal = document.getElementById('categoryModal');
  if (modal) modal.classList.remove('active');
}

async function submitNewCategoryModal(event) {
  event.preventDefault();
  const name = document.getElementById('catModalNameInput').value;
  const description = document.getElementById('catModalDescInput').value;

  const payload = { name, description };

  try {
    const res = await fetch('/api/inventory/categories', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('token') || ''}`,
        'x-user-role': 'manager'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Server error');
    }

    alert('Category created successfully!');
    document.getElementById('categoryModalForm').reset();
    closeCategoryModal();
    await syncWithBackend();
  } catch (err) {
    showToast(err.message || 'Category was not created.', 'error');
  }
}

async function deleteCategory(catId) {
  if (confirm('Are you sure you want to delete this category?')) {
    try {
      const res = await fetch(`/api/inventory/categories/${catId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token') || ''}`,
          'x-user-role': 'admin'
        }
      });

      if (!res.ok) {
        throw new Error('Server error');
      }

      alert('Category deleted successfully!');
      await syncWithBackend();
    } catch (err) {
      console.error('Delete category API failed, using fallback:', err);
      categories = categories.filter(c => c.id !== catId);
      loadCategoryManagement();
    }
  }
}

async function editCategory(catId) {
  const cat = categories.find(c => c.id === catId);
  if (cat) {
    const newName = prompt('Enter new name for category:', cat.name);
    if (newName) {
      const payload = { name: newName, parent_id: cat.parent_id, description: cat.description };
      try {
        const res = await fetch(`/api/inventory/categories/${catId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('token') || ''}`,
            'x-user-role': 'manager'
          },
          body: JSON.stringify(payload)
        });

        if (!res.ok) {
          throw new Error('Server error');
        }

        alert('Category updated successfully!');
        await syncWithBackend();
      } catch (err) {
        console.error('Edit category API failed, using fallback:', err);
        cat.name = newName;
        cat.updated_at = new Date();
        loadCategoryManagement();
      }
    }
  }
}

function exportActiveReportToCSV() {
  let csvContent = "data:text/csv;charset=utf-8,";
  
  if (activeReport === 'sales') {
    csvContent += "Invoice No,Customer,Payment Method,Grand Total,Sale Date\n";
    sales.forEach(s => {
      const cust = customers.find(c => c.id === s.customer_id)?.name || 'Walk-in';
      csvContent += `${s.invoice_no},"${cust}",${s.payment_method},${s.total},"${new Date(s.sale_date).toLocaleDateString()}"\n`;
    });
  } else if (activeReport === 'stock') {
    csvContent += "SKU,Product Name,Cost Price,Selling Price,In Stock,Valuation Cost\n";
    products.forEach(p => {
      const qty = p.stock || 0;
      const val = qty * p.cost_price;
      csvContent += `${p.sku},"${p.name}",${p.cost_price},${p.selling_price},${qty},${val.toFixed(2)}\n`;
    });
  } else if (activeReport === 'cust') {
    csvContent += "Customer Name,Phone,Credit Limit,Balance Owed,Tier\n";
    customers.forEach(c => {
      csvContent += `"${c.name}",${c.phone},${c.credit_limit},${c.balance},${c.tier}\n`;
    });
  }

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `Inventia_Report_${activeReport}_${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// ================= BARCODE VIEWER OPERATIONS =================
async function openBarcodeModal(productId) {
  const product = products.find(p => p.id === productId);
  if (product) {
    document.getElementById('barcodeProductTitle').innerText = product.name;
    const image = document.getElementById('barcodeImage');
    if (image.dataset.objectUrl) URL.revokeObjectURL(image.dataset.objectUrl);
    image.removeAttribute('data-assignment-id');
    document.getElementById('barcodeModal').classList.add('active');
    try {
      let response = await fetch(`/api/v1/barcodes/products?q=${encodeURIComponent(product.sku)}&limit=20`);
      let data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Barcode could not be loaded.');
      let record = (data.products || []).find(item => Number(item.product_id) === Number(product.id));
      if (!record?.assignment_id) {
        response = await fetch('/api/v1/barcodes/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_ids: [product.id] })
        });
        data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || 'Barcode assignment failed.');
        record = { assignment_id: data.assignments?.[0]?.id };
      }
      if (!record?.assignment_id) throw new Error('Barcode assignment is pending retry.');
      const imageResponse = await fetch(`/api/v1/barcodes/${record.assignment_id}/render?format=png`);
      if (!imageResponse.ok) throw new Error('Barcode image generation failed.');
      const objectUrl = URL.createObjectURL(await imageResponse.blob());
      image.src = objectUrl;
      image.dataset.objectUrl = objectUrl;
      image.dataset.assignmentId = record.assignment_id;
    } catch (error) {
      showToast(error.message, 'error');
    }
  }
}

function closeBarcodeModal() {
  const image = document.getElementById('barcodeImage');
  if (image?.dataset.objectUrl) {
    URL.revokeObjectURL(image.dataset.objectUrl);
    delete image.dataset.objectUrl;
  }
  document.getElementById('barcodeModal').classList.remove('active');
}

async function downloadCurrentBarcode() {
  const image = document.getElementById('barcodeImage');
  if (!image?.dataset.assignmentId) return showToast('Generate the barcode first.', 'info');
  const response = await fetch(`/api/v1/barcodes/${image.dataset.assignmentId}/render?format=png&download=1`);
  if (!response.ok) return showToast('Unable to download this barcode.', 'error');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${document.getElementById('barcodeProductTitle').innerText.replace(/\s+/g, '-')}-barcode.png`;
  link.click();
  URL.revokeObjectURL(url);
}

async function printCurrentBarcode() {
  const image = document.getElementById('barcodeImage');
  if (!image?.dataset.assignmentId) return showToast('Generate the barcode first.', 'info');
  const response = await fetch('/api/v1/barcode-print-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      output_type: 'PDF',
      printer_type: 'browser',
      copies: 1,
      starting_position: 1,
      items: [{ assignment_id: Number(image.dataset.assignmentId), quantity: 1 }]
    })
  });
  const job = await response.json();
  if (!response.ok) return showToast(job.error?.message || 'Unable to create the print job.', 'error');
  if (job.status !== 'COMPLETED') return showToast(job.error_message || 'Print output is queued for retry.', 'info');
  await downloadBarcodePrintJob(job.id, true);
}

// ================= BARCODE & LABEL CENTER =================
async function barcodeApi(path, options = {}) {
  const response = await fetch(`/api/v1${path}`, options);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.blob();
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.message || 'Barcode operation failed.');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function loadBarcodeWorkspace() {
  try {
    await Promise.all([
      loadBarcodeOverview(),
      loadBarcodeProducts(),
      loadBarcodeTemplates(),
      loadBarcodeSettings()
    ]);
    await loadBarcodeViewData(activeBarcodeView);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function openBarcodeWorkspaceView(view = 'overview', button = null, { syncHistory = true, replaceHistory = false } = {}) {
  if (!BARCODE_VIEW_ROUTES[view]) view = 'overview';
  if (currentTab !== 'barcodes') switchTab('barcodes');
  activeBarcodeView = view;
  document.querySelectorAll('.barcode-panel').forEach(panel => panel.classList.remove('active'));
  document.querySelectorAll('.barcode-view-tabs button').forEach(tab => tab.classList.remove('active'));
  document.querySelectorAll('#dropdownBarcodes .nav-dropdown-item').forEach(item => {
    item.classList.toggle('active', item.dataset.barcodeView === view);
  });
  document.getElementById('dropdownBarcodes')?.classList.add('open');
  const panel = document.getElementById(`barcodePanel${view.charAt(0).toUpperCase()}${view.slice(1)}`);
  const targetButton = button || document.querySelector(`.barcode-view-tabs [data-barcode-panel="${view}"]`);
  panel?.classList.add('active');
  targetButton?.classList.add('active');
  if (syncHistory) syncBarcodeClientRoute(view, { replace: replaceHistory });
  await loadBarcodeViewData(view).catch(error => showToast(error.message, 'error'));
  if (view === 'scanner') setTimeout(() => document.getElementById('barcodeWorkspaceScanInput')?.focus(), 60);
}

async function loadBarcodeViewData(view) {
  if (view === 'overview') return loadBarcodeOverview();
  if (view === 'products' || view === 'generate' || view === 'batch') return loadBarcodeProducts();
  if (view === 'designer') {
    await loadBarcodeTemplates();
    return renderBarcodeDesignerPreview();
  }
  if (view === 'scanner') return loadBarcodeScanHistory();
  if (view === 'queue' || view === 'history') return loadBarcodePrintJobs(view);
  if (view === 'analytics') return loadBarcodeAnalytics();
  if (view === 'recommendations') return loadBarcodeRecommendations();
  if (view === 'settings') return loadBarcodeSettings();
}

async function loadBarcodeOverview() {
  const data = await barcodeApi('/barcodes/overview');
  const kpis = data.kpis || {};
  const cards = [
    ['Total Products', kpis.total_products, 'fa-boxes-stacked', 'Active catalog records'],
    ['With Barcode', kpis.products_with_barcode, 'fa-barcode', 'Persistent identities'],
    ['Without Barcode', kpis.products_without_barcode, 'fa-triangle-exclamation', 'Needs assignment'],
    ['Variant Barcodes', kpis.variant_barcodes, 'fa-tags', 'Exact variant mappings'],
    ['Printed Today', kpis.labels_printed_today, 'fa-print', 'Physical labels'],
    ['Failed Jobs', kpis.failed_print_jobs, 'fa-circle-xmark', 'Safe to retry'],
    ['Queued Jobs', kpis.queued_print_jobs, 'fa-list-check', 'Pending output'],
    ['Scanner', kpis.scanner_status, 'fa-expand', `${kpis.scans_today || 0} scans today`]
  ];
  const container = document.getElementById('barcodeKpis');
  if (container) container.innerHTML = cards.map(([label, value, icon, note]) => `
    <article class="kpi-card">
      <div class="barcode-kpi-card-top"><span class="kpi-label">${escapeHtml(label)}</span><i class="fa-solid ${icon}"></i></div>
      <h3 class="kpi-value">${escapeHtml(value ?? 0)}</h3>
      <span class="kpi-subtext">${escapeHtml(note)}</span>
    </article>`).join('');
  renderBarcodeActivityList('barcodeRecentAssignments', data.recent_assignments, item => ({
    title: item.product_name,
    subtitle: `${item.variant_name ? `${item.variant_name} · ` : ''}${item.barcode_value} · ${item.barcode_type}`,
    trailing: formatBarcodeDate(item.assigned_at)
  }));
  renderBarcodeActivityList('barcodeRecentJobs', data.recent_print_jobs, item => ({
    title: item.job_number,
    subtitle: `${item.template_name} · ${item.label_count} labels`,
    trailing: barcodeStatusBadge(item.status)
  }));
  renderBarcodeActivityList('barcodeMissingProducts', data.missing_products, item => ({
    title: item.name,
    subtitle: item.sku,
    trailing: '<span class="status-badge pending">Missing</span>'
  }));
  return data;
}

function renderBarcodeActivityList(id, items = [], mapper) {
  const container = document.getElementById(id);
  if (!container) return;
  if (!items.length) {
    container.innerHTML = '<div class="barcode-empty-state">No records to show.</div>';
    return;
  }
  container.innerHTML = items.map(item => {
    const mapped = mapper(item);
    return `<div class="barcode-activity-item"><div><strong>${escapeHtml(mapped.title || '')}</strong><span>${escapeHtml(mapped.subtitle || '')}</span></div><div>${mapped.trailing || ''}</div></div>`;
  }).join('');
}

function scheduleBarcodeProductSearch() {
  clearTimeout(barcodeProductSearchTimer);
  barcodeProductSearchTimer = setTimeout(() => loadBarcodeProducts(), 250);
}

async function loadBarcodeProducts() {
  const query = new URLSearchParams({ limit: '500' });
  const search = document.getElementById('barcodeProductSearch')?.value.trim();
  const status = document.getElementById('barcodeStatusFilter')?.value;
  const type = document.getElementById('barcodeTypeFilter')?.value;
  if (search) query.set('q', search);
  if (status) query.set('status', status);
  if (type) query.set('type', type);
  const data = await barcodeApi(`/barcodes/products?${query}`);
  barcodeProducts = data.products || [];
  renderBarcodeProductsTable();
  populateBarcodeProductSelector();
  updateBarcodeSelectionState();
  renderBarcodeAssignmentPreview();
  renderBarcodeSheetPreview();
  return barcodeProducts;
}

function renderBarcodeProductsTable() {
  const body = document.getElementById('barcodeProductsTable');
  if (!body) return;
  if (!barcodeProducts.length) {
    body.innerHTML = '<tr><td colspan="10" class="barcode-empty-state">No products match these barcode filters.</td></tr>';
    return;
  }
  body.innerHTML = barcodeProducts.map(item => {
    const selected = item.assignment_id && selectedBarcodeAssignments.has(Number(item.assignment_id));
    const batch = item.batch_no || '—';
    const expiry = item.expires_at ? String(item.expires_at).slice(0, 10) : '—';
    return `<tr>
      <td><input type="checkbox" ${selected ? 'checked' : ''} ${item.assignment_id ? '' : 'disabled'} onchange="toggleBarcodeSelection(${Number(item.assignment_id || 0)}, this.checked)"></td>
      <td><div class="barcode-product-identity">${item.image_url ? `<img src="${escapeHtml(resolveProductImage(item.image_url, item.product_name))}" alt="">` : `<span class="barcode-product-avatar">${escapeHtml(getInitials(item.product_name))}</span>`}<div><strong>${escapeHtml(item.product_name)}</strong><small>${escapeHtml(item.sku)}</small></div></div></td>
      <td>${item.barcode_value ? `<code>${escapeHtml(item.barcode_value)}</code>` : '—'}</td>
      <td>${escapeHtml(item.barcode_type || '—')}</td>
      <td>${escapeHtml(item.category_name || 'Uncategorized')}</td>
      <td>${Number(item.warehouse_stock || 0).toLocaleString()} ${escapeHtml(item.uom || '')}</td>
      <td>${escapeHtml(batch)}<br><small>${escapeHtml(expiry)}</small></td>
      <td>${currencySymbol}${Number(item.selling_price || 0).toFixed(2)}</td>
      <td>${barcodeStatusBadge(item.barcode_status)}</td>
      <td><div class="barcode-scan-actions">
        ${item.assignment_id ? `<button class="action-btn-sm" onclick="previewBarcodeAssignment(${item.assignment_id})" title="View barcode"><i class="fa-solid fa-eye"></i></button><button class="action-btn-sm" onclick="downloadBarcodeAssignment(${item.assignment_id}, 'png')" title="Download PNG"><i class="fa-solid fa-download"></i></button><button class="action-btn-sm" onclick="quickPrintBarcode(${item.assignment_id})" title="Print label"><i class="fa-solid fa-print"></i></button><button class="action-btn-sm" onclick="regenerateBarcodeAssignment(${item.assignment_id})" title="Regenerate barcode"><i class="fa-solid fa-rotate"></i></button>` : `<button class="action-btn-sm" onclick="generateBarcodeForProduct(${item.product_id})">Generate</button>`}
      </div></td>
    </tr>`;
  }).join('');
}

function barcodeStatusBadge(status) {
  const value = String(status || 'UNKNOWN').toUpperCase();
  const css = ['ASSIGNED', 'COMPLETED', 'RESOLVED', 'READY'].includes(value) ? 'completed'
    : ['FAILED', 'INVALID', 'DUPLICATE', 'UNKNOWN', 'OUT_OF_STOCK'].includes(value) ? 'cancelled'
      : 'pending';
  return `<span class="status-badge ${css}">${escapeHtml(value.replaceAll('_', ' '))}</span>`;
}

function toggleBarcodeSelection(assignmentId, checked) {
  if (!assignmentId) return;
  if (checked) selectedBarcodeAssignments.add(Number(assignmentId));
  else selectedBarcodeAssignments.delete(Number(assignmentId));
  updateBarcodeSelectionState();
}

function toggleAllBarcodeProducts(checked) {
  barcodeProducts.filter(item => item.assignment_id).forEach(item => {
    if (checked) selectedBarcodeAssignments.add(Number(item.assignment_id));
    else selectedBarcodeAssignments.delete(Number(item.assignment_id));
  });
  renderBarcodeProductsTable();
  updateBarcodeSelectionState();
}

function updateBarcodeSelectionState() {
  const count = selectedBarcodeAssignments.size;
  const countNode = document.getElementById('barcodeSelectedCount');
  const batchNode = document.getElementById('barcodeBatchSelected');
  if (countNode) countNode.textContent = count;
  if (batchNode) batchNode.textContent = `${count} product${count === 1 ? '' : 's'} selected`;
  const selectAll = document.getElementById('barcodeSelectAll');
  const visible = barcodeProducts.filter(item => item.assignment_id);
  if (selectAll) {
    selectAll.checked = visible.length > 0 && visible.every(item => selectedBarcodeAssignments.has(Number(item.assignment_id)));
    selectAll.indeterminate = visible.some(item => selectedBarcodeAssignments.has(Number(item.assignment_id))) && !selectAll.checked;
  }
}

async function generateMissingBarcodes(productIds = null) {
  const body = productIds?.length ? { product_ids: productIds.map(Number) } : {};
  const data = await barcodeApi('/barcodes/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  showToast(`${data.generated} barcode${data.generated === 1 ? '' : 's'} assigned.`, data.generated ? 'success' : 'info');
  await syncWithBackend();
  await Promise.all([loadBarcodeOverview(), loadBarcodeProducts()]);
  return data;
}

async function generateBarcodeForProduct(productId) {
  try {
    await generateMissingBarcodes([productId]);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function generateSelectedBarcodes() {
  const missingProductIds = barcodeProducts.filter(item => !item.assignment_id).map(item => item.product_id);
  if (!missingProductIds.length) return showToast('No missing barcode products are visible in this filter.', 'info');
  try {
    await generateMissingBarcodes(missingProductIds);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function downloadSelectedBarcode(format) {
  if (!selectedBarcodeAssignments.size) return showToast('Select at least one assigned barcode.', 'info');
  for (const id of selectedBarcodeAssignments) await downloadBarcodeAssignment(id, format, selectedBarcodeAssignments.size === 1);
}

async function downloadBarcodeAssignment(assignmentId, format = 'png', notify = true) {
  try {
    const response = await fetch(`/api/v1/barcodes/${assignmentId}/render?format=${encodeURIComponent(format)}&download=1`);
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error?.message || 'Barcode download failed.');
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] || `barcode-${assignmentId}.${format}`;
    downloadBlob(blob, filename);
    if (notify) showToast(`${format.toUpperCase()} downloaded.`, 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function previewBarcodeAssignment(assignmentId) {
  const item = barcodeProducts.find(product => Number(product.assignment_id) === Number(assignmentId));
  if (item) return openBarcodeModal(Number(item.product_id));
  const response = await fetch(`/api/v1/barcodes/${assignmentId}/render?format=png`);
  if (!response.ok) return showToast('Barcode preview failed.', 'error');
  const blob = await response.blob();
  const image = document.getElementById('barcodeImage');
  if (image.dataset.objectUrl) URL.revokeObjectURL(image.dataset.objectUrl);
  const objectUrl = URL.createObjectURL(blob);
  image.src = objectUrl;
  image.dataset.objectUrl = objectUrl;
  image.dataset.assignmentId = assignmentId;
  document.getElementById('barcodeProductTitle').textContent = 'Barcode label';
  document.getElementById('barcodeModal').classList.add('active');
}

async function copyBarcodeValue(value) {
  await navigator.clipboard.writeText(String(value));
  showToast('Barcode copied.', 'success');
}

async function regenerateBarcodeAssignment(assignmentId) {
  const reason = prompt('Why is this persistent barcode being regenerated? This action is audited.');
  if (!reason?.trim()) return;
  if (!confirm('The existing barcode will be archived and will no longer resolve in POS. Continue?')) return;
  try {
    const assignment = await barcodeApi(`/barcodes/${assignmentId}/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason.trim() })
    });
    selectedBarcodeAssignments.delete(Number(assignmentId));
    selectedBarcodeAssignments.add(Number(assignment.id));
    showToast(`Barcode regenerated as ${assignment.barcode_value}.`, 'success');
    await Promise.all([loadBarcodeOverview(), loadBarcodeProducts()]);
    await syncWithBackend();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function populateBarcodeProductSelector() {
  const select = document.getElementById('barcodeAssignProduct');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">Choose product</option>' + barcodeProducts.map(item =>
    `<option value="${item.product_id}">${escapeHtml(item.product_name)} · ${escapeHtml(item.sku)}${item.assignment_id ? ' · assigned' : ''}</option>`
  ).join('');
  if ([...select.options].some(option => option.value === current)) select.value = current;
}

async function validateManualBarcode() {
  const value = document.getElementById('barcodeAssignValue')?.value.trim();
  const message = document.getElementById('barcodeValidationMessage');
  if (!message) return;
  if (!value) {
    message.className = 'barcode-validation-state';
    message.textContent = 'Leave the value empty to use the organization sequence.';
    return;
  }
  try {
    const result = await barcodeApi('/barcodes/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        barcode_value: value,
        barcode_type: document.getElementById('barcodeAssignType')?.value || 'CODE128'
      })
    });
    message.className = `barcode-validation-state ${result.valid ? 'valid' : 'invalid'}`;
    message.textContent = result.message;
  } catch (error) {
    message.className = 'barcode-validation-state invalid';
    message.textContent = error.message;
  }
}

async function assignManualBarcode(event) {
  event.preventDefault();
  const productId = Number(document.getElementById('barcodeAssignProduct')?.value);
  const value = document.getElementById('barcodeAssignValue')?.value.trim();
  if (!productId) return showToast('Choose a product.', 'info');
  try {
    if (!value) {
      await generateMissingBarcodes([productId]);
    } else {
      const assignment = await barcodeApi('/barcodes/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_id: productId,
          barcode_value: value,
          barcode_type: document.getElementById('barcodeAssignType')?.value || 'CODE128',
          source: 'MANUAL'
        })
      });
      showToast(`Barcode ${assignment.barcode_value} assigned.`, 'success');
      await Promise.all([loadBarcodeOverview(), loadBarcodeProducts()]);
      await syncWithBackend();
    }
    document.getElementById('barcodeAssignValue').value = '';
    await validateManualBarcode();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function refreshBarcodeAssignmentPreview() {
  renderBarcodeAssignmentPreview();
}

async function renderBarcodeAssignmentPreview() {
  const container = document.getElementById('barcodeAssignmentPreview');
  if (!container) return;
  const productId = Number(document.getElementById('barcodeAssignProduct')?.value);
  const item = barcodeProducts.find(product => Number(product.product_id) === productId);
  if (!item) {
    container.className = 'barcode-label-preview barcode-label-preview-empty';
    container.innerHTML = '<i class="fa-solid fa-barcode"></i><span>Select a product to preview its current identity.</span>';
    return;
  }
  if (!item.assignment_id) {
    container.className = 'barcode-label-preview barcode-label-preview-empty';
    container.innerHTML = `<strong>${escapeHtml(item.product_name)}</strong><span>${escapeHtml(item.sku)}</span><small>Barcode will be generated from the organization sequence.</small>`;
    return;
  }
  container.className = 'barcode-label-preview';
  container.innerHTML = `<strong>${escapeHtml(item.product_name)}</strong><span>${escapeHtml(item.sku)}</span><div class="barcode-empty-state">Loading barcode preview…</div><small>${escapeHtml(item.barcode_value)}</small>`;
  await setProtectedBarcodeImage(container, item.assignment_id);
}

async function loadBarcodeTemplates() {
  const data = await barcodeApi('/barcode-templates');
  barcodeTemplates = data.templates || [];
  barcodeLayouts = data.layouts || [];
  const templateSelect = document.getElementById('barcodePrintTemplate');
  const layoutSelect = document.getElementById('barcodePrintLayout');
  if (templateSelect) templateSelect.innerHTML = barcodeTemplates.map(item => `<option value="${item.id}" ${item.is_default ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('');
  if (layoutSelect) layoutSelect.innerHTML = barcodeLayouts.map(item => `<option value="${item.id}" ${item.is_default ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('');
  const list = document.getElementById('barcodeTemplateList');
  if (list) list.innerHTML = barcodeTemplates.map(item => `<button type="button" onclick="editBarcodeTemplate(${item.id})"><span>${escapeHtml(item.name)}</span><span>${item.is_default ? 'Default' : escapeHtml(item.category)}</span></button>`).join('');
  renderBarcodeSheetPreview();
  return data;
}

function editBarcodeTemplate(id) {
  const template = barcodeTemplates.find(item => Number(item.id) === Number(id));
  if (!template) return;
  const config = template.configuration || {};
  document.getElementById('barcodeTemplateId').value = template.id;
  document.getElementById('barcodeTemplateName').value = template.name;
  document.getElementById('barcodeTemplateCategory').value = template.category;
  document.getElementById('tplShowProduct').checked = config.show_product !== false;
  document.getElementById('tplShowSku').checked = config.show_sku !== false;
  document.getElementById('tplShowNumber').checked = config.show_barcode_number !== false;
  document.getElementById('tplShowMrp').checked = config.show_mrp !== false;
  document.getElementById('tplShowBatch').checked = Boolean(config.show_batch);
  document.getElementById('tplShowExpiry').checked = Boolean(config.show_expiry);
  document.getElementById('tplShowBorder').checked = config.border !== false;
  document.getElementById('tplFontSize').value = config.font_size_pt || 8;
  document.getElementById('tplBarcodeHeight').value = config.barcode_height_mm || 11;
  document.getElementById('tplIsDefault').checked = Boolean(template.is_default);
  renderBarcodeDesignerPreview();
}

async function saveBarcodeTemplate(event) {
  event.preventDefault();
  const id = document.getElementById('barcodeTemplateId').value;
  const payload = {
    name: document.getElementById('barcodeTemplateName').value.trim(),
    category: document.getElementById('barcodeTemplateCategory').value,
    is_default: document.getElementById('tplIsDefault').checked,
    configuration: barcodeTemplateConfiguration()
  };
  try {
    const saved = await barcodeApi(id ? `/barcode-templates/${id}` : '/barcode-templates', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    document.getElementById('barcodeTemplateId').value = saved.id;
    showToast('Label template saved.', 'success');
    await loadBarcodeTemplates();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function barcodeTemplateConfiguration() {
  return {
    show_product: document.getElementById('tplShowProduct')?.checked !== false,
    show_sku: document.getElementById('tplShowSku')?.checked !== false,
    show_barcode_number: document.getElementById('tplShowNumber')?.checked !== false,
    show_mrp: document.getElementById('tplShowMrp')?.checked !== false,
    show_batch: Boolean(document.getElementById('tplShowBatch')?.checked),
    show_expiry: Boolean(document.getElementById('tplShowExpiry')?.checked),
    border: document.getElementById('tplShowBorder')?.checked !== false,
    font_size_pt: Number(document.getElementById('tplFontSize')?.value || 8),
    barcode_height_mm: Number(document.getElementById('tplBarcodeHeight')?.value || 11),
    alignment: 'center'
  };
}

async function renderBarcodeDesignerPreview() {
  const preview = document.getElementById('barcodeDesignerPreview');
  if (!preview) return;
  const selectedTemplate = barcodeTemplates.find(item => Number(item.id) === Number(document.getElementById('barcodeTemplateId')?.value));
  const config = document.getElementById('barcodeTemplateForm') ? barcodeTemplateConfiguration() : (selectedTemplate?.configuration || {});
  const item = barcodeProducts.find(product => product.assignment_id);
  preview.className = `barcode-label-preview${config.border === false ? ' without-border' : ''}`;
  if (!item) {
    preview.innerHTML = '<div class="barcode-empty-state">Assign a barcode to a real product to see a live preview.</div>';
    return;
  }
  const fontSize = Math.max(5, Math.min(Number(config.font_size_pt || 8), 32));
  preview.innerHTML = `
    ${config.show_product !== false ? `<strong style="font-size:${fontSize + 2}px">${escapeHtml(item.product_name)}</strong>` : ''}
    ${config.show_sku !== false ? `<span>SKU ${escapeHtml(item.sku)}</span>` : ''}
    <div class="barcode-empty-state">Loading print image…</div>
    ${config.show_barcode_number !== false ? `<small>${escapeHtml(item.barcode_value)}</small>` : ''}
    ${config.show_mrp !== false ? `<strong>MRP ${currencySymbol}${Number(item.selling_price || 0).toFixed(2)}</strong>` : ''}
    ${config.show_batch && item.batch_no ? `<span>Batch ${escapeHtml(item.batch_no)}</span>` : ''}
    ${config.show_expiry && item.expires_at ? `<span>Expiry ${escapeHtml(String(item.expires_at).slice(0, 10))}</span>` : ''}`;
  await setProtectedBarcodeImage(preview, item.assignment_id);
}

async function setProtectedBarcodeImage(container, assignmentId) {
  try {
    const response = await fetch(`/api/v1/barcodes/${assignmentId}/render?format=png`);
    if (!response.ok) return;
    const image = document.createElement('img');
    const objectUrl = URL.createObjectURL(await response.blob());
    image.src = objectUrl;
    image.alt = 'Generated product barcode';
    image.onload = () => URL.revokeObjectURL(objectUrl);
    container.querySelector('.barcode-empty-state')?.replaceWith(image);
  } catch {
    // Keep the explicit loading/error state in the preview.
  }
}

function renderBarcodeSheetPreview() {
  const preview = document.getElementById('barcodeSheetPreview');
  if (!preview) return;
  const layout = barcodeLayouts.find(item => Number(item.id) === Number(document.getElementById('barcodePrintLayout')?.value)) || barcodeLayouts[0];
  const columns = Number(layout?.columns || 4);
  const rows = Number(layout?.rows || 10);
  const slots = Math.min(columns * rows, 65);
  const startingPosition = Math.max(1, Number(document.getElementById('barcodePrintStart')?.value || 1));
  const selected = barcodeProducts.filter(item => selectedBarcodeAssignments.has(Number(item.assignment_id)));
  const quantity = Math.max(1, Number(document.getElementById('barcodePrintQuantity')?.value || 1));
  const labels = selected.flatMap(item => Array.from({ length: quantity }, () => item));
  preview.style.gridTemplateColumns = `repeat(${Math.min(columns, 8)}, minmax(0, 1fr))`;
  preview.innerHTML = Array.from({ length: slots }, (_, index) => {
    if (index < startingPosition - 1) return '<div class="barcode-sheet-slot blank">Skipped</div>';
    const item = labels[(index - (startingPosition - 1)) % Math.max(labels.length, 1)];
    if (!item) return '<div class="barcode-sheet-slot blank">Empty</div>';
    return `<div class="barcode-sheet-slot"><div><i class="fa-solid fa-barcode"></i><strong>${escapeHtml(item.product_name)}</strong><br>${escapeHtml(item.barcode_value || '')}</div></div>`;
  }).join('');
}

async function submitBarcodePrintJob(event, options = {}) {
  event?.preventDefault?.();
  const selected = barcodeProducts.filter(item => selectedBarcodeAssignments.has(Number(item.assignment_id)));
  if (!selected.length) return showToast('Select assigned products before creating a print job.', 'info');
  const quantity = Math.max(1, Number(options.quantity || document.getElementById('barcodePrintQuantity')?.value || 1));
  try {
    const job = await barcodeApi('/barcode-print-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template_id: Number(document.getElementById('barcodePrintTemplate')?.value),
        layout_id: Number(document.getElementById('barcodePrintLayout')?.value),
        output_type: options.output_type || document.getElementById('barcodePrintOutput')?.value || 'PDF',
        printer_type: 'browser',
        copies: Number(document.getElementById('barcodePrintCopies')?.value || 1),
        starting_position: Number(document.getElementById('barcodePrintStart')?.value || 1),
        items: selected.map(item => ({ assignment_id: Number(item.assignment_id), quantity }))
      })
    });
    if (job.status === 'COMPLETED') {
      showToast(`${job.label_count} labels prepared.`, 'success');
      await downloadBarcodePrintJob(job.id, Boolean(options.openForPrint));
    } else {
      showToast(job.error_message || 'Print job is retained for retry.', 'info');
    }
    await Promise.all([loadBarcodePrintJobs('queue'), loadBarcodeOverview()]);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function quickPrintBarcode(assignmentId) {
  selectedBarcodeAssignments = new Set([Number(assignmentId)]);
  updateBarcodeSelectionState();
  await submitBarcodePrintJob(null, { quantity: 1, output_type: 'PDF', openForPrint: true });
}

async function printBarcodeTestPage() {
  if (!selectedBarcodeAssignments.size) return showToast('Select one assigned product for the test page.', 'info');
  const first = [...selectedBarcodeAssignments][0];
  selectedBarcodeAssignments = new Set([first]);
  updateBarcodeSelectionState();
  await submitBarcodePrintJob(null, { quantity: 1, output_type: 'PDF', openForPrint: true });
}

async function loadBarcodePrintJobs(view = 'queue') {
  const data = await barcodeApi('/barcode-print-jobs?limit=200');
  const jobs = data.jobs || [];
  renderBarcodeJobsTable('barcodeQueueTable', jobs.filter(job => ['PENDING', 'RUNNING', 'FAILED'].includes(job.status)), false);
  renderBarcodeJobsTable('barcodeHistoryTable', jobs.filter(job => ['COMPLETED', 'CANCELLED'].includes(job.status)), true);
  return jobs;
}

function renderBarcodeJobsTable(id, jobs, history) {
  const body = document.getElementById(id);
  if (!body) return;
  if (!jobs.length) {
    body.innerHTML = `<tr><td colspan="8" class="barcode-empty-state">No ${history ? 'print history' : 'queued print jobs'}.</td></tr>`;
    return;
  }
  body.innerHTML = jobs.map(job => `<tr>
    <td><strong>${escapeHtml(job.job_number)}</strong></td><td>${escapeHtml(job.template_name)}</td><td>${escapeHtml(job.layout_name)}</td>
    <td>${Number(job.label_count || 0)}</td><td>${escapeHtml(job.output_type)}</td><td>${barcodeStatusBadge(job.status)}</td>
    <td>${formatBarcodeDate(history ? job.completed_at : job.created_at)}</td>
    <td><div class="barcode-scan-actions">
      ${job.status === 'COMPLETED' ? `<button class="action-btn-sm" onclick="downloadBarcodePrintJob(${job.id})"><i class="fa-solid fa-download"></i> Download</button>` : ''}
      ${job.status === 'FAILED' ? `<button class="action-btn-sm" onclick="retryBarcodePrintJob(${job.id})"><i class="fa-solid fa-rotate"></i> Retry</button><button class="action-btn-sm" onclick="cancelBarcodePrintJob(${job.id})">Cancel</button>` : ''}
    </div></td>
  </tr>`).join('');
}

async function retryBarcodePrintJob(id) {
  try {
    const job = await barcodeApi(`/barcode-print-jobs/${id}/retry`, { method: 'POST' });
    showToast(job.status === 'COMPLETED' ? 'Print job completed.' : (job.error_message || 'Print retry failed.'), job.status === 'COMPLETED' ? 'success' : 'error');
    await loadBarcodePrintJobs('queue');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function cancelBarcodePrintJob(id) {
  if (!confirm('Cancel this retained print job? Barcode assignments will not be changed.')) return;
  try {
    await barcodeApi(`/barcode-print-jobs/${id}/cancel`, { method: 'POST' });
    showToast('Print job cancelled.', 'success');
    await loadBarcodePrintJobs('queue');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function downloadBarcodePrintJob(id, openForPrint = false) {
  try {
    const response = await fetch(`/api/v1/barcode-print-jobs/${id}/download`);
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error?.message || 'Print output download failed.');
    }
    const blob = await response.blob();
    if (openForPrint && blob.type === 'application/pdf') {
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return;
    }
    const disposition = response.headers.get('content-disposition') || '';
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] || `barcode-print-${id}`;
    downloadBlob(blob, filename);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function submitBarcodeWorkspaceScan(event, explicitValue = null, source = 'MANUAL') {
  event?.preventDefault?.();
  const input = document.getElementById('barcodeWorkspaceScanInput');
  const value = String(explicitValue || input?.value || '').trim();
  if (!value) return;
  const resultNode = document.getElementById('barcodeScanResult');
  if (resultNode) resultNode.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Resolving barcode…';
  try {
    const response = await fetch('/api/v1/barcode-scans/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ barcode_value: value, source, action: 'RESOLVE' })
    });
    const result = await response.json();
    if (!response.ok && !result.resolved) {
      if (resultNode) resultNode.innerHTML = `<div class="barcode-scan-product"><h4>Unknown barcode</h4><code>${escapeHtml(value)}</code><p>No product or variant is assigned to this value.</p><div class="barcode-scan-actions"><button class="action-btn primary" onclick="prepareUnknownBarcodeAssignment(decodeURIComponent('${encodeURIComponent(value)}'))">Assign to product</button></div></div>`;
      showToast('Unknown barcode recorded for review.', 'error');
    } else {
      renderBarcodeScanResult(result);
      if (barcodeSettings?.scanner?.sound) playBarcodeFeedback(result.status === 'RESOLVED');
    }
    if (input) {
      input.value = '';
      input.focus();
    }
    await loadBarcodeScanHistory();
  } catch (error) {
    if (resultNode) resultNode.innerHTML = `<div class="barcode-empty-state">${escapeHtml(error.message)}</div>`;
    showToast(error.message, 'error');
  }
}

function renderBarcodeScanResult(result) {
  const node = document.getElementById('barcodeScanResult');
  if (!node || !result.product) return;
  node.innerHTML = `<div class="barcode-scan-product">
    <div>${barcodeStatusBadge(result.status)}</div>
    <h4>${escapeHtml(result.product.name)}</h4>
    <span>${escapeHtml(result.variant?.name ? `${result.variant.name} · ` : '')}${escapeHtml(result.variant?.sku || result.product.sku)}</span>
    <strong>${currencySymbol}${Number(result.product.selling_price || 0).toFixed(2)} · Stock ${Number(result.product.available_stock || 0)}</strong>
    <div class="barcode-scan-actions">
      <button class="action-btn primary" ${Number(result.product.available_stock || 0) <= 0 ? 'disabled' : ''} onclick="addScannedProductToPos(${result.product.id})"><i class="fa-solid fa-cart-plus"></i> Add to POS</button>
      <button class="action-btn secondary" onclick="switchTab('inventory')">Open product list</button>
    </div>
  </div>`;
}

function addScannedProductToPos(productId) {
  const product = products.find(item => Number(item.id) === Number(productId));
  if (!product) return showToast('Refresh product data before adding this scan to POS.', 'info');
  addToCart(Number(productId));
  switchTab('pos');
  showToast(`${product.name} added to POS.`, 'success');
}

function prepareUnknownBarcodeAssignment(value) {
  openBarcodeWorkspaceView('generate');
  const input = document.getElementById('barcodeAssignValue');
  if (input) input.value = value;
  validateManualBarcode();
}

async function loadBarcodeScanHistory() {
  const data = await barcodeApi('/barcode-scans/history?limit=100');
  renderBarcodeActivityList('barcodeScanHistory', data.scans, item => ({
    title: item.product_name || item.barcode_value,
    subtitle: `${item.status} · ${item.source}${item.sku ? ` · ${item.sku}` : ''}`,
    trailing: formatBarcodeDate(item.created_at)
  }));
  return data.scans;
}

async function startBarcodeCamera() {
  if (!navigator.mediaDevices?.getUserMedia) return showToast('Camera scanning is not supported in this browser.', 'error');
  if (!('BarcodeDetector' in window)) return showToast('This browser does not provide native BarcodeDetector support. Use a USB scanner or manual input.', 'info');
  try {
    barcodeCameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    const region = document.getElementById('barcodeCameraRegion');
    const video = document.getElementById('barcodeCameraVideo');
    region.hidden = false;
    video.srcObject = barcodeCameraStream;
    await video.play();
    const detector = new BarcodeDetector();
    barcodeCameraTimer = setInterval(async () => {
      try {
        const codes = await detector.detect(video);
        if (!codes.length) return;
        const value = codes[0].rawValue;
        stopBarcodeCamera();
        await submitBarcodeWorkspaceScan(null, value, 'CAMERA');
      } catch {
        // Continue the camera loop; transient decode misses are expected.
      }
    }, 500);
    document.getElementById('barcodeScannerStatus').textContent = 'Camera active';
  } catch (error) {
    showToast(error.name === 'NotAllowedError' ? 'Camera permission was denied.' : error.message, 'error');
  }
}

function stopBarcodeCamera() {
  clearInterval(barcodeCameraTimer);
  barcodeCameraTimer = null;
  barcodeCameraStream?.getTracks().forEach(track => track.stop());
  barcodeCameraStream = null;
  const region = document.getElementById('barcodeCameraRegion');
  const video = document.getElementById('barcodeCameraVideo');
  if (video) video.srcObject = null;
  if (region) region.hidden = true;
  const status = document.getElementById('barcodeScannerStatus');
  if (status) status.textContent = 'Ready';
}

function playBarcodeFeedback(success) {
  try {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = success ? 880 : 220;
    gain.gain.setValueAtTime(.06, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + .09);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + .1);
  } catch {
    // Audio feedback is optional.
  }
}

async function loadBarcodeAnalytics() {
  const data = await barcodeApi('/barcode-analytics');
  const cards = [
    ['Active assignments', data.assignments.total || 0, 'fa-barcode'],
    ['Resolved scans', data.scans.resolved || 0, 'fa-circle-check'],
    ['Unknown scans', data.scans.unknown || 0, 'fa-circle-question'],
    ['Labels produced', data.print_jobs.labels || 0, 'fa-print'],
    ['Completed jobs', data.print_jobs.completed || 0, 'fa-list-check'],
    ['Failed jobs', data.print_jobs.failed || 0, 'fa-triangle-exclamation']
  ];
  const container = document.getElementById('barcodeAnalyticsKpis');
  if (container) container.innerHTML = cards.map(([label, value, icon]) => `<article class="kpi-card"><div class="barcode-kpi-card-top"><span class="kpi-label">${escapeHtml(label)}</span><i class="fa-solid ${icon}"></i></div><h3 class="kpi-value">${Number(value).toLocaleString()}</h3></article>`).join('');
  renderBarcodeActivityList('barcodeTemplateAnalytics', data.template_usage, item => ({
    title: item.name,
    subtitle: `${item.uses} jobs`,
    trailing: `<strong>${Number(item.labels || 0).toLocaleString()} labels</strong>`
  }));
  renderBarcodeActivityList('barcodeTopPrinted', data.top_printed, item => ({
    title: item.product_name,
    subtitle: `${item.sku} · ${item.barcode_value}`,
    trailing: `<strong>${Number(item.print_count || 0).toLocaleString()}</strong>`
  }));
  return data;
}

async function loadBarcodeRecommendations() {
  const data = await barcodeApi('/barcode-recommendations');
  const provider = document.getElementById('barcodeRecommendationProvider');
  if (provider) provider.textContent = data.provider?.fallback ? 'Grounded local intelligence' : data.provider?.active;
  const container = document.getElementById('barcodeRecommendations');
  if (!container) return data;
  container.innerHTML = (data.recommendations || []).map(item => `<article class="barcode-recommendation-card">
    <span class="status-badge ${item.priority === 'high' ? 'cancelled' : item.priority === 'medium' ? 'pending' : 'completed'}">${escapeHtml(item.priority)}</span>
    <h5>${escapeHtml(item.title)}</h5><p>${escapeHtml(item.reason)}</p>
    <button class="action-btn secondary" onclick="runBarcodeRecommendation('${escapeHtml(item.action)}')">Review recommendation</button>
  </article>`).join('');
  return data;
}

function runBarcodeRecommendation(action) {
  const routes = {
    GENERATE_MISSING: 'generate',
    OPEN_SCANNER_HISTORY: 'scanner',
    OPEN_BATCH_PRINT: 'batch',
    OPEN_PRODUCTS: 'products',
    OPEN_PRINT_QUEUE: 'queue',
    OPEN_ANALYTICS: 'analytics'
  };
  openBarcodeWorkspaceView(routes[action] || 'overview');
}

async function loadBarcodeSettings() {
  barcodeSettings = await barcodeApi('/barcode-settings');
  const setChecked = (id, value) => { const node = document.getElementById(id); if (node) node.checked = Boolean(value); };
  const setValue = (id, value) => { const node = document.getElementById(id); if (node) node.value = value ?? ''; };
  setChecked('barcodeSetEnabled', barcodeSettings.enabled);
  setChecked('barcodeSetAuto', barcodeSettings.auto_generate);
  setChecked('barcodeSetManual', barcodeSettings.allow_manual);
  setChecked('barcodeSetRegenerate', barcodeSettings.allow_regeneration);
  setChecked('barcodeSetDuplicates', barcodeSettings.prevent_duplicates);
  setChecked('barcodeSetSound', barcodeSettings.scanner?.sound);
  setChecked('barcodeSetAutoPos', barcodeSettings.scanner?.auto_add_to_pos);
  setValue('barcodeSetType', barcodeSettings.default_type);
  setValue('barcodeSetPrefix', barcodeSettings.prefix);
  setValue('barcodeSetSuffix', barcodeSettings.suffix);
  setValue('barcodeSetLength', barcodeSettings.sequence_length);
  setValue('barcodeSetTermination', barcodeSettings.scanner?.termination_key);
  setValue('barcodeSetDelay', barcodeSettings.scanner?.duplicate_delay_ms);
  const productType = document.getElementById('pBarcodeType');
  if (productType) productType.value = barcodeSettings.default_type || 'CODE128';
  return barcodeSettings;
}

async function saveBarcodeSettings(event) {
  event.preventDefault();
  try {
    barcodeSettings = await barcodeApi('/barcode-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: document.getElementById('barcodeSetEnabled').checked,
        auto_generate: document.getElementById('barcodeSetAuto').checked,
        default_type: document.getElementById('barcodeSetType').value,
        prefix: document.getElementById('barcodeSetPrefix').value,
        suffix: document.getElementById('barcodeSetSuffix').value,
        sequence_length: Number(document.getElementById('barcodeSetLength').value),
        prevent_duplicates: document.getElementById('barcodeSetDuplicates').checked,
        allow_manual: document.getElementById('barcodeSetManual').checked,
        allow_regeneration: document.getElementById('barcodeSetRegenerate').checked,
        scanner: {
          termination_key: document.getElementById('barcodeSetTermination').value,
          duplicate_delay_ms: Number(document.getElementById('barcodeSetDelay').value),
          sound: document.getElementById('barcodeSetSound').checked,
          auto_add_to_pos: document.getElementById('barcodeSetAutoPos').checked
        }
      })
    });
    showToast('Barcode settings saved.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function formatBarcodeDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

let barcodeHidBuffer = '';
let barcodeHidLastKeyAt = 0;
document.addEventListener('keydown', event => {
  if (!['pos', 'barcodes'].includes(currentTab) || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  if (target?.matches?.('input, textarea, select, [contenteditable="true"]')) return;
  const timestamp = Date.now();
  if (timestamp - barcodeHidLastKeyAt > 80) barcodeHidBuffer = '';
  barcodeHidLastKeyAt = timestamp;
  if (event.key === 'Enter' || event.key === 'Tab') {
    if (barcodeHidBuffer.length >= 4) {
      event.preventDefault();
      const value = barcodeHidBuffer;
      barcodeHidBuffer = '';
      if (currentTab === 'pos') {
        openScannerModal();
        document.getElementById('manualScanInput').value = value;
        document.querySelector('#scannerModal form')?.requestSubmit();
      } else {
        openBarcodeWorkspaceView('scanner');
        submitBarcodeWorkspaceScan(null, value, 'HID');
      }
    }
    return;
  }
  if (event.key.length === 1) barcodeHidBuffer += event.key;
});

// ================= PHASE 3: FINANCE & ACCOUNTING =================
let financeAccounts = [];

async function loadFinanceWorkspace() {
  try {
    const [summaryResponse, accountsResponse, journalsResponse] = await Promise.all([
      fetch('/api/finance/summary', { headers: getAuthHeaders() }),
      fetch('/api/accounts', { headers: getAuthHeaders() }),
      fetch('/api/journals', { headers: getAuthHeaders() })
    ]);
    if (!summaryResponse.ok || !accountsResponse.ok || !journalsResponse.ok) {
      throw new Error('Finance data could not be loaded.');
    }
    const summary = await summaryResponse.json();
    financeAccounts = await accountsResponse.json();
    const journals = await journalsResponse.json();
    setFinanceMoney('financeIncome', summary.total_income);
    setFinanceMoney('financeExpenses', summary.total_expenses);
    setFinanceMoney('financeProfit', summary.net_profit);
    setFinanceMoney('financeReceivable', summary.outstanding_receivable);
    renderFinanceAccounts(financeAccounts);
    renderFinanceJournals(journals);
    populateFinanceAccountSelectors();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function setFinanceMoney(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = `${currencySymbol}${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function renderFinanceAccounts(accounts) {
  const body = document.getElementById('financeAccountsTable');
  if (!body) return;
  body.innerHTML = accounts.length ? accounts.map(account => `
    <tr>
      <td><strong>${escapeHtml(account.code)}</strong></td>
      <td>${escapeHtml(account.name)}</td>
      <td><span class="status-badge ${account.account_type === 'income' ? 'completed' : ''}">${escapeHtml(account.account_type)}</span></td>
      <td>${currencySymbol}${Number(account.opening_balance || 0).toFixed(2)}</td>
    </tr>`).join('') : '<tr><td colspan="4" style="text-align:center;">No accounts found.</td></tr>';
}

function renderFinanceJournals(journals) {
  const body = document.getElementById('financeJournalsTable');
  if (!body) return;
  body.innerHTML = journals.length ? journals.slice(0, 20).map(journal => `
    <tr>
      <td><strong>${escapeHtml(journal.journal_no)}</strong></td>
      <td>${new Date(journal.journal_date).toLocaleDateString()}</td>
      <td>${escapeHtml(journal.journal_type)}</td>
      <td>${currencySymbol}${Number(journal.total_debit || 0).toFixed(2)}</td>
    </tr>`).join('') : '<tr><td colspan="4" style="text-align:center;">No journals posted yet.</td></tr>';
}

function populateFinanceAccountSelectors() {
  const options = financeAccounts.map(account => `<option value="${account.id}">${escapeHtml(account.code)} — ${escapeHtml(account.name)}</option>`).join('');
  ['financeDebitAccount', 'financeCreditAccount'].forEach(id => {
    const select = document.getElementById(id);
    if (select) select.innerHTML = `<option value="">Select account</option>${options}`;
  });
}

function openFinanceJournalModal() {
  if (!financeAccounts.length) loadFinanceWorkspace();
  const date = document.getElementById('financeJournalDate');
  if (date) date.value = new Date().toISOString().slice(0, 10);
  document.getElementById('financeJournalModal')?.classList.add('active');
}

function closeFinanceJournalModal() {
  document.getElementById('financeJournalModal')?.classList.remove('active');
}

async function submitFinanceJournal(event) {
  event.preventDefault();
  const amount = Number(document.getElementById('financeJournalAmount').value);
  const debitAccount = Number(document.getElementById('financeDebitAccount').value);
  const creditAccount = Number(document.getElementById('financeCreditAccount').value);
  if (debitAccount === creditAccount) return showToast('Debit and credit accounts must be different.', 'error');
  const response = await fetch('/api/journals', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      journal_type: 'general',
      journal_date: document.getElementById('financeJournalDate').value,
      reference: document.getElementById('financeJournalReference').value.trim(),
      description: document.getElementById('financeJournalDescription').value.trim(),
      entries: [
        { account_id: debitAccount, debit: amount, credit: 0 },
        { account_id: creditAccount, debit: 0, credit: amount }
      ]
    })
  });
  const result = await response.json();
  if (!response.ok) return showToast(result.error || 'Unable to post journal.', 'error');
  document.getElementById('financeJournalForm').reset();
  closeFinanceJournalModal();
  await loadFinanceWorkspace();
  showToast(`Journal ${result.journal_no} posted successfully.`, 'success');
}

async function createFinanceAccount() {
  const code = window.prompt('Account code (for example 5300):');
  if (!code) return;
  const name = window.prompt('Account name:');
  if (!name) return;
  const accountType = window.prompt('Account type: asset, liability, income, expense, or equity', 'expense')?.toLowerCase();
  if (!accountType) return;
  const response = await fetch('/api/accounts', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ code, name, account_type: accountType })
  });
  const result = await response.json();
  if (!response.ok) return showToast(result.error || 'Unable to create account.', 'error');
  await loadFinanceWorkspace();
  showToast(`Account ${result.code} created.`, 'success');
}

// ================= CHART.JS DASHBOARD INITIALIZATION =================
function initDashboardCharts() {
  renderDashboardCharts();
}

window.addEventListener('DOMContentLoaded', () => {
  initDashboardCharts();
});

// ================= SALES PAGE =================
function loadSalesPage() {
  const tbody = document.getElementById('salesPageTable');
  if (!tbody) return;
  tbody.innerHTML = '';

  sales.forEach(sale => {
    const cust = customers.find(c => c.id === sale.customer_id)?.name || 'Walk-in';
    const date = new Date(sale.sale_date);
    const dateStr = date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${sale.invoice_no}</strong></td>
      <td>${cust}</td>
      <td>${dateStr}</td>
      <td>—</td>
      <td><span class="badge-pay">${sale.payment_method}</span></td>
      <td><strong>${currencySymbol}${sale.total.toFixed(2)}</strong></td>
      <td><span class="status-badge completed">Completed</span></td>
      <td>
        <button class="action-btn-sm" onclick="downloadInvoice(${sale.id})"><i class="fa-solid fa-file-pdf"></i> PDF</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  if (sales.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:40px; color:var(--text-muted);">No sales recorded yet. Start a transaction from the POS tab.</td></tr>';
  }
}

function exportSalesToCSV() {
  let csvContent = "data:text/csv;charset=utf-8,";
  csvContent += "Invoice No,Customer,Payment Method,Total,Date\n";
  sales.forEach(s => {
    const cust = customers.find(c => c.id === s.customer_id)?.name || 'Walk-in';
    csvContent += `${s.invoice_no},"${cust}",${s.payment_method},${s.total},"${new Date(s.sale_date).toLocaleDateString()}"\n`;
  });
  const link = document.createElement("a");
  link.setAttribute("href", encodeURI(csvContent));
  link.setAttribute("download", `Inventia_Sales_${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// ================================================================
// SUB-TABS NAVIGATION & BRAND / WAREHOUSE MANAGEMENT LOGIC
// ================================================================

function switchSubTab(subTabId) {
  // Hide all panels
  document.querySelectorAll('.sub-tab-panel').forEach(p => p.style.display = 'none');
  // Show target panel
  const target = document.getElementById(subTabId);
  if (target) target.style.display = 'block';

  // Toggle active class on tab buttons
  document.querySelectorAll('.sub-tab').forEach(b => {
    b.classList.remove('active');
    b.style.borderBottomColor = 'transparent';
    b.style.fontWeight = '600';
    b.style.color = 'var(--ink-secondary)';
  });
  const activeBtn = document.querySelector(`.sub-tab[data-sub-tab="${subTabId}"]`);
  if (activeBtn) {
    activeBtn.classList.add('active');
    activeBtn.style.borderBottomColor = 'var(--blue-600)';
    activeBtn.style.fontWeight = '700';
    activeBtn.style.color = 'var(--blue-600)';
  }
}

// ─── Categories Modal Functions ───
function closeCategoryEditModal() {
  const modal = document.getElementById('categoryEditModal');
  if (modal) modal.classList.remove('active');
}

async function submitEditCategoryModal(event) {
  event.preventDefault();
  const id = parseInt(document.getElementById('categoryEditModalIdInput').value);
  const name = document.getElementById('categoryEditModalNameInput').value;
  const description = document.getElementById('categoryEditModalDescInput').value;
  
  const cat = categories.find(c => c.id === id);
  if (!cat) return;

  const payload = { name, parent_id: cat.parent_id, description };
  try {
    const res = await fetch(`/api/inventory/categories/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('token') || ''}`,
        'x-user-role': 'manager'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error('Server error');
    alert('Category updated successfully!');
    closeCategoryEditModal();
    await syncWithBackend();
  } catch (err) {
    showToast(err.message || 'Category was not updated.', 'error');
  }
}

// ─── Brands Modal Functions ───
function loadBrandManagement() {
  const brandGrid = document.getElementById('brandGrid');
  if (!brandGrid) return;
  brandGrid.innerHTML = '';

  // KPI Calculations
  const totalBrands = brands.length;
  const brandProductIds = new Set(products.map(p => p.brand_id));
  const activeBrands = brands.filter(b => brandProductIds.has(b.id)).length;

  const totalBrandsEl = document.getElementById('statsTotalBrands');
  if (totalBrandsEl) totalBrandsEl.innerText = totalBrands;
  const activeBrandsEl = document.getElementById('statsActiveBrands');
  if (activeBrandsEl) activeBrandsEl.innerText = activeBrands;

  brands.forEach(b => {
    const card = document.createElement('div');
    card.className = 'brand-card';
    card.innerHTML = `
      <div class="brand-avatar">${b.name.substring(0, 2)}</div>
      <div class="brand-info">
        <div class="brand-name-text">${b.name}</div>
        <div class="brand-code-text">CODE: ${b.code}</div>
      </div>
      <div class="brand-card-actions">
        <button class="brand-action-btn edit" onclick="editBrand(${b.id})"><i class="fa-solid fa-pen"></i></button>
        <button class="brand-action-btn delete" onclick="deleteBrand(${b.id})"><i class="fa-solid fa-trash-can"></i></button>
      </div>
    `;
    brandGrid.appendChild(card);
  });
}

function openAddBrandModal() {
  const modal = document.getElementById('brandModal');
  if (modal) modal.classList.add('active');
}

function closeBrandModal() {
  const modal = document.getElementById('brandModal');
  if (modal) modal.classList.remove('active');
}

async function submitNewBrandModal(event) {
  event.preventDefault();
  const name = document.getElementById('brandModalNameInput').value;
  const code = document.getElementById('brandModalCodeInput').value;
  const payload = { name, code };

  try {
    const res = await fetch('/api/inventory/brands', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('token') || ''}`,
        'x-user-role': 'manager'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error('Server error');
    alert('Brand created successfully!');
    document.getElementById('brandModalForm').reset();
    closeBrandModal();
    await syncWithBackend();
  } catch (err) {
    showToast(err.message || 'Brand was not created.', 'error');
  }
}

function editBrand(brandId) {
  const brand = brands.find(b => b.id === brandId);
  if (brand) {
    document.getElementById('brandEditModalIdInput').value = brand.id;
    document.getElementById('brandEditModalNameInput').value = brand.name;
    document.getElementById('brandEditModalCodeInput').value = brand.code;
    const modal = document.getElementById('brandEditModal');
    if (modal) modal.classList.add('active');
  }
}

function closeBrandEditModal() {
  const modal = document.getElementById('brandEditModal');
  if (modal) modal.classList.remove('active');
}

async function submitEditBrandModal(event) {
  event.preventDefault();
  const id = parseInt(document.getElementById('brandEditModalIdInput').value);
  const name = document.getElementById('brandEditModalNameInput').value;
  const code = document.getElementById('brandEditModalCodeInput').value;

  const brand = brands.find(b => b.id === id);
  if (!brand) return;

  const payload = { name, code };
  try {
    const res = await fetch(`/api/inventory/brands/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('token') || ''}`,
        'x-user-role': 'manager'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error('Server error');
    alert('Brand updated successfully!');
    closeBrandEditModal();
    await syncWithBackend();
  } catch (err) {
    showToast(err.message || 'Brand was not updated.', 'error');
  }
}

async function deleteBrand(brandId) {
  if (confirm('Are you sure you want to delete this brand?')) {
    try {
      const res = await fetch(`/api/inventory/brands/${brandId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token') || ''}`,
          'x-user-role': 'admin'
        }
      });

      if (!res.ok) throw new Error('Server error');
      alert('Brand deleted successfully!');
      await syncWithBackend();
    } catch (err) {
      console.error('Delete brand API failed, using fallback:', err);
      brands = brands.filter(b => b.id !== brandId);
      loadBrandManagement();
      loadBrandsAndCategories();
      populateDropdowns();
    }
  }
}

// ─── Warehouses Modal Functions ───
function loadWarehouseManagement() {
  const grid = document.getElementById('warehouseGrid');
  if (!grid) return;
  grid.innerHTML = '';

  const totalStockQty = products.reduce((acc, p) => acc + (p.stock || 0), 0);
  const totalShowrooms = warehouses.filter(w => w.type === 'showroom').length;

  const totalWhEl = document.getElementById('statsTotalWarehouses');
  if (totalWhEl) totalWhEl.innerText = warehouses.length;
  const stockQtyEl = document.getElementById('statsWarehouseStockQty');
  if (stockQtyEl) stockQtyEl.innerText = totalStockQty;
  const showroomsEl = document.getElementById('statsTotalShowrooms');
  if (showroomsEl) showroomsEl.innerText = totalShowrooms;

  warehouses.forEach(wh => {
    let pct = 0.85;
    if (wh.type === 'showroom') pct = 0.12;
    if (wh.type === 'transit') pct = 0.03;

    const whQty = Math.round(totalStockQty * pct);
    let distinctItems = products.length;
    if (wh.type === 'transit') distinctItems = Math.min(3, products.length);

    const card = document.createElement('div');
    card.className = 'warehouse-card';
    card.innerHTML = `
      <div class="warehouse-card-header">
        <h4 class="warehouse-name">${wh.name}</h4>
        <span class="warehouse-badge ${wh.type}">${wh.type}</span>
      </div>
      <div class="warehouse-code">CODE: ${wh.code}</div>
      <div class="warehouse-address"><i class="fa-solid fa-location-dot"></i> ${wh.address}</div>
      <div class="warehouse-stats">
        <div>
          <span class="warehouse-stat-val">${distinctItems}</span>
          <span class="warehouse-stat-label">Unique Items</span>
        </div>
        <div>
          <span class="warehouse-stat-val">${whQty.toLocaleString()}</span>
          <span class="warehouse-stat-label">Stock Qty</span>
        </div>
      </div>
      <div class="category-actions" style="margin-top:auto;">
        <button class="category-btn edit" onclick="editWarehouse(${wh.id})"><i class="fa-solid fa-pen"></i> Edit</button>
        <button class="category-btn delete" onclick="deleteWarehouse(${wh.id})"><i class="fa-solid fa-trash-can"></i> Delete</button>
      </div>
    `;
    grid.appendChild(card);
  });
}

function openAddWarehouseModal() {
  const modal = document.getElementById('warehouseModal');
  if (modal) modal.classList.add('active');
}

function closeWarehouseModal() {
  const modal = document.getElementById('warehouseModal');
  if (modal) modal.classList.remove('active');
}

async function submitNewWarehouseModal(event) {
  event.preventDefault();
  const name = document.getElementById('whModalNameInput').value;
  const code = document.getElementById('whModalCodeInput').value;
  const type = document.getElementById('whModalTypeInput').value;
  const address = document.getElementById('whModalAddressInput').value;

  const payload = { name, code, type, address };

  try {
    const res = await fetch('/api/inventory/warehouses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('token') || ''}`,
        'x-user-role': 'manager'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error('Server error');
    alert('Warehouse location created successfully!');
    document.getElementById('warehouseModalForm').reset();
    closeWarehouseModal();
    await syncWithBackend();
  } catch (err) {
    showToast(err.message || 'Warehouse was not created.', 'error');
  }
}

function editWarehouse(whId) {
  const wh = warehouses.find(w => w.id === whId);
  if (wh) {
    document.getElementById('whEditModalIdInput').value = wh.id;
    document.getElementById('whEditModalNameInput').value = wh.name;
    document.getElementById('whEditModalCodeInput').value = wh.code;
    document.getElementById('whEditModalTypeInput').value = wh.type;
    document.getElementById('whEditModalAddressInput').value = wh.address;
    const modal = document.getElementById('warehouseEditModal');
    if (modal) modal.classList.add('active');
  }
}

function closeWarehouseEditModal() {
  const modal = document.getElementById('warehouseEditModal');
  if (modal) modal.classList.remove('active');
}

async function submitEditWarehouseModal(event) {
  event.preventDefault();
  const id = parseInt(document.getElementById('whEditModalIdInput').value);
  const name = document.getElementById('whEditModalNameInput').value;
  const code = document.getElementById('whEditModalCodeInput').value;
  const type = document.getElementById('whEditModalTypeInput').value;
  const address = document.getElementById('whEditModalAddressInput').value;

  const wh = warehouses.find(w => w.id === id);
  if (!wh) return;

  const payload = { name, code, type, address };
  try {
    const res = await fetch(`/api/inventory/warehouses/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('token') || ''}`,
        'x-user-role': 'manager'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error('Server error');
    alert('Warehouse location updated successfully!');
    closeWarehouseEditModal();
    await syncWithBackend();
  } catch (err) {
    showToast(err.message || 'Warehouse was not updated.', 'error');
  }
}

async function deleteWarehouse(whId) {
  if (confirm('Are you sure you want to delete this warehouse location?')) {
    try {
      const res = await fetch(`/api/inventory/warehouses/${whId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token') || ''}`,
          'x-user-role': 'admin'
        }
      });

      if (!res.ok) throw new Error('Server error');
      alert('Warehouse location deleted successfully!');
      await syncWithBackend();
    } catch (err) {
      console.error('Delete warehouse API failed, using fallback:', err);
      warehouses = warehouses.filter(w => w.id !== whId);
      loadWarehouseManagement();
      populateDropdowns();
    }
  }
}

// ================================================================
// FLOATING AI CHAT WIDGET & AI INTEGRATION SETTINGS LOGIC
// ================================================================

let currentAiConversationId = null;

function toggleAiChatDrawer(forceOpen = null) {
  const drawer = document.getElementById('aiChatDrawer');
  if (!drawer) return;
  if (forceOpen === true) drawer.classList.add('active');
  else if (forceOpen === false) drawer.classList.remove('active');
  else drawer.classList.toggle('active');
  if (drawer.classList.contains('active')) {
    loadAiStatus();
    setTimeout(() => document.getElementById('aiChatInput')?.focus(), 120);
  }
}

function askSuggestedQuestion(question) {
  const input = document.getElementById('aiChatInput');
  if (!input) return;
  toggleAiChatDrawer(true);
  input.value = question;
  document.getElementById('aiChatForm')?.requestSubmit();
}

async function sendAiMessage(event) {
  event.preventDefault();
  const input = document.getElementById('aiChatInput');
  const query = input.value.trim();
  if (!query) return;

  input.value = '';

  const messagesContainer = document.getElementById('aiChatMessages');

  // Append User Message
  const userDiv = document.createElement('div');
  userDiv.className = 'chat-msg user';
  userDiv.innerText = query;
  messagesContainer.appendChild(userDiv);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  // Append Typing Indicator
  const typingDiv = document.createElement('div');
  typingDiv.className = 'typing-indicator';
  typingDiv.innerHTML = `<span></span><span></span><span></span>`;
  messagesContainer.appendChild(typingDiv);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  try {
    const res = await fetch('/api/v1/ai/chat', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        message: query,
        conversation_id: currentAiConversationId,
        source: currentTab === 'automation' ? 'ai_workspace' : 'assistant_drawer'
      })
    });

    typingDiv.remove();

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Copilot request failed.');
    currentAiConversationId = data.conversation_id;
    setAiProviderLabels(data);

    const agentDiv = document.createElement('div');
    agentDiv.className = 'chat-msg agent';
    agentDiv.innerHTML = renderAiResponse(data);
    messagesContainer.appendChild(agentDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    if ((data.proposed_actions || []).length) loadAiWorkspace();
  } catch (err) {
    console.error('Chat API failed:', err);
    typingDiv.remove();
    const errDiv = document.createElement('div');
    errDiv.className = 'chat-msg agent';
    errDiv.innerText = err.message || 'The Business Copilot is unavailable. Please try again.';
    messagesContainer.appendChild(errDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

function formatMarkdown(text) {
  return escapeHtml(text || '')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

function renderAiResponse(data) {
  const cards = (data.cards || []).map(card => `
    <div class="ai-response-card">
      <strong>${escapeHtml(card.title)}</strong>
      <span>${escapeHtml(card.value)}${card.trend ? ` · ${escapeHtml(card.trend)}` : ''}</span>
    </div>`).join('');
  const sources = (data.sources || []).map(source => `
    <div class="ai-source-item"><strong>${escapeHtml(source.label || source.type)}</strong><br>${escapeHtml(source.type || 'business data')}</div>`).join('');
  const proposals = (data.proposed_actions || []).map(renderAiProposalCard).join('');
  return `
    <div>${formatMarkdown(data.answer)}</div>
    ${cards ? `<div class="ai-response-cards">${cards}</div>` : ''}
    ${sources ? `<div class="ai-source-list"><div class="universal-search-group">Evidence</div>${sources}</div>` : ''}
    ${proposals ? `<div class="ai-proposal-list"><div class="universal-search-group">Approval required</div>${proposals}</div>` : ''}
    <div class="ai-response-meta">${escapeHtml(data.provider || 'local')}${data.fallback ? ' · deterministic fallback' : ''}</div>`;
}

function renderAiProposalCard(proposal) {
  const payload = proposal.payload || {};
  const itemCount = Array.isArray(payload.items) ? payload.items.length : null;
  return `<article class="ai-proposal-card" data-proposal-id="${escapeHtml(proposal.id)}">
    <header>
      <div><strong>${escapeHtml(proposal.title || proposal.action_type)}</strong><div>${escapeHtml(proposal.reason || 'Generated from grounded business data.')}</div></div>
      <span class="status-badge ${proposal.status === 'approved' ? 'completed' : proposal.status === 'pending' ? 'pending' : 'cancelled'}">${escapeHtml(proposal.status || 'pending')}</span>
    </header>
    <div>${itemCount == null ? escapeHtml(previewActionPayload(payload)) : `${itemCount} item${itemCount === 1 ? '' : 's'} · ${escapeHtml(previewActionPayload(payload))}`}</div>
    ${proposal.status === 'pending' ? `<div class="ai-proposal-actions">
      <button class="action-btn primary compact" onclick="approveAiAction('${escapeHtml(proposal.id)}')"><i class="fa-solid fa-check"></i> Approve</button>
      <button class="action-btn secondary compact" onclick="rejectAiAction('${escapeHtml(proposal.id)}')"><i class="fa-solid fa-xmark"></i> Reject</button>
    </div>` : ''}
  </article>`;
}

function previewActionPayload(payload) {
  const values = [];
  if (payload.total) values.push(`Total ${currencySymbol}${Number(payload.total).toFixed(2)}`);
  if (payload.amount) values.push(`Amount ${currencySymbol}${Number(payload.amount).toFixed(2)}`);
  if (payload.quantity) values.push(`Quantity ${Number(payload.quantity)}`);
  if (payload.warehouse_id) values.push(`Warehouse #${payload.warehouse_id}`);
  if (payload.supplier_id) values.push(`Supplier #${payload.supplier_id}`);
  return values.join(' · ') || 'Open to review the validated details before execution.';
}

async function approveAiAction(id) {
  if (!window.confirm('Approve and execute this validated business action?')) return;
  await updateAiAction(id, 'approve');
}

async function rejectAiAction(id) {
  const reason = window.prompt('Why are you rejecting this proposal?', 'Not required now');
  if (reason === null) return;
  await updateAiAction(id, 'reject', { reason });
}

async function updateAiAction(id, operation, body = {}) {
  try {
    const response = await fetch(`/api/v1/ai/actions/${encodeURIComponent(id)}/${operation}`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(body)
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Unable to ${operation} proposal.`);
    showToast(operation === 'approve' ? 'Proposal approved and executed.' : 'Proposal rejected.', 'success');
    await loadAiWorkspace();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function loadAiStatus() {
  try {
    const response = await fetch('/api/v1/ai/status');
    const status = await response.json();
    if (!response.ok) throw new Error(status.error || 'AI status unavailable.');
    setAiProviderLabels(status);
    const modelSelect = document.getElementById('setAiModel');
    if (modelSelect) {
      const desired = status.configured ? status.model : 'local';
      if ([...modelSelect.options].some(option => option.value === desired)) modelSelect.value = desired;
    }
    const connection = document.getElementById('setAiConnectionStatus');
    if (connection) connection.value = status.configured ? 'OpenAI configured securely on server' : 'Local fallback active · add OPENAI_API_KEY on server';
    return status;
  } catch (error) {
    const connection = document.getElementById('setAiConnectionStatus');
    if (connection) connection.value = error.message;
    return null;
  }
}

function setAiProviderLabels(status) {
  const label = status.fallback || !status.configured
    ? 'Local intelligence · fallback active'
    : `${status.provider || 'OpenAI'} · ${status.model || 'configured'}`;
  ['aiDrawerProvider', 'aiWorkspaceProvider', 'dashboardAiProvider'].forEach(id => {
    const element = document.getElementById(id);
    if (!element) return;
    element.textContent = label;
    element.classList.toggle('pending', Boolean(status.fallback || !status.configured));
    element.classList.toggle('completed', !status.fallback && status.configured !== false);
  });
}

async function submitAiSettings(event) {
  event.preventDefault();
  const status = await loadAiStatus();
  if (status) {
    showToast(status.configured
      ? `Business Copilot is connected to ${status.model}.`
      : 'Deterministic local intelligence is active. Configure OPENAI_API_KEY on the server to enable OpenAI.', 'info');
  }
}

async function loadDashboardAi() {
  const score = document.getElementById('dashboardHealthScore');
  if (!score || !localStorage.getItem('token')) return;
  try {
    const response = await fetch('/api/v1/ai/insights');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'AI summary unavailable.');
    renderBusinessHealth(data.health, 'dashboard');
    renderAiInsights(document.getElementById('dashboardAiInsights'), data.insights);
    loadAiStatus();
  } catch (error) {
    const container = document.getElementById('dashboardAiInsights');
    if (container) container.innerHTML = `<div class="ai-insight-item danger"><i class="fa-solid fa-triangle-exclamation"></i><div><strong>Summary unavailable</strong><span>${escapeHtml(error.message)}</span></div></div>`;
  }
}

function renderBusinessHealth(health, target = 'dashboard') {
  if (!health) return;
  const label = String(health.status || 'attention').replace('_', ' ');
  if (target === 'dashboard') {
    document.getElementById('dashboardHealthScore').textContent = `${health.score}/100`;
    document.getElementById('dashboardHealthLabel').textContent = label;
    const metrics = document.getElementById('dashboardHealthMetrics');
    if (metrics) metrics.innerHTML = `
      <div><span>Revenue trend</span><strong>${Number(health.sales_trend_percent).toFixed(1)}%</strong></div>
      <div><span>Inventory health</span><strong>${Number(health.inventory_score).toFixed(0)}/100</strong></div>
      <div><span>Receivables</span><strong>${currencySymbol}${Number(health.outstanding_receivable).toLocaleString()}</strong></div>
      <div><span>Cash position</span><strong>${currencySymbol}${Number(health.cash_flow).toLocaleString()}</strong></div>`;
  } else {
    document.getElementById('aiHealthScore').textContent = `${health.score}/100`;
    document.getElementById('aiHealthStatus').textContent = label;
    document.getElementById('aiRevenue30d').textContent = `${currencySymbol}${Number(health.revenue_30d).toLocaleString()}`;
  }
}

function renderAiInsights(container, insights = []) {
  if (!container) return;
  const iconByType = { inventory: 'fa-boxes-stacked', finance: 'fa-wallet', sales: 'fa-chart-line' };
  container.innerHTML = insights.length ? insights.map(insight => {
    const tone = insight.severity === 'critical' ? 'danger' : insight.severity === 'positive' ? 'success' : 'warning';
    return `<div class="ai-insight-item ${tone}"><i class="fa-solid ${iconByType[insight.type] || 'fa-sparkles'}"></i><div><strong>${escapeHtml(insight.title)}</strong><span>${escapeHtml(insight.message)} ${escapeHtml(insight.action || '')}</span></div></div>`;
  }).join('') : '<div class="ai-insight-item success"><i class="fa-solid fa-circle-check"></i><div><strong>No urgent alerts</strong><span>Inventia found no immediate business risks in the available records.</span></div></div>';
}

async function loadAiWorkspace() {
  if (!document.getElementById('aiHealthScore')) return;
  try {
    const [insightsResponse, forecastResponse, actionsResponse, knowledgeResponse, status] = await Promise.all([
      fetch('/api/v1/ai/insights'),
      fetch('/api/v1/ai/forecast/inventory?days=30'),
      fetch('/api/v1/ai/actions?status=pending'),
      fetch('/api/v1/ai/knowledge'),
      loadAiStatus()
    ]);
    const [insights, forecast, actions, knowledge] = await Promise.all([
      insightsResponse.json(), forecastResponse.json(), actionsResponse.json(), knowledgeResponse.json()
    ]);
    if (!insightsResponse.ok) throw new Error(insights.error || 'Insights unavailable.');
    if (!forecastResponse.ok) throw new Error(forecast.error || 'Forecast unavailable.');
    if (!actionsResponse.ok) throw new Error(actions.error || 'Proposals unavailable.');
    if (!knowledgeResponse.ok) throw new Error(knowledge.error || 'Knowledge unavailable.');
    renderBusinessHealth(insights.health, 'workspace');
    renderAiInsights(document.getElementById('aiWorkspaceInsights'), insights.insights);
    const reorder = (forecast.items || []).filter(item => item.reorder_quantity > 0);
    document.getElementById('aiReorderCount').textContent = reorder.length;
    document.getElementById('aiPendingActions').textContent = actions.length;
    renderAiForecast(forecast.items || []);
    document.getElementById('aiActionProposalList').innerHTML = actions.length
      ? actions.map(renderAiProposalCard).join('')
      : '<div class="workspace-empty-state compact"><i class="fa-solid fa-clipboard-check"></i><p>No pending proposals.</p></div>';
    renderAiKnowledge(knowledge);
    if (status) setAiProviderLabels(status);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderAiForecast(items) {
  const table = document.getElementById('aiForecastTable');
  if (!table) return;
  const relevant = [...items].filter(item => item.reorder_quantity > 0).slice(0, 12);
  table.innerHTML = relevant.length ? relevant.map(item => `
    <tr>
      <td><strong>${escapeHtml(item.name)}</strong><br><small>${escapeHtml(item.sku)}</small></td>
      <td>${Number(item.current_stock)}</td>
      <td>${Number(item.forecast_demand).toFixed(1)}</td>
      <td><strong>${Number(item.reorder_quantity)}</strong></td>
      <td><span class="status-badge ${item.risk === 'critical' ? 'cancelled' : 'pending'}">${escapeHtml(item.risk)}</span></td>
    </tr>`).join('') : '<tr><td colspan="5">Stock is sufficient against the available 30-day demand forecast.</td></tr>';
}

async function submitAiKnowledge(event) {
  event.preventDefault();
  const title = document.getElementById('aiKnowledgeTitle').value.trim();
  const content = document.getElementById('aiKnowledgeContent').value.trim();
  const tags = document.getElementById('aiKnowledgeTags').value.trim();
  try {
    const response = await fetch('/api/v1/ai/knowledge', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ title, content, tags })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Unable to add knowledge.');
    event.target.reset();
    showToast('Knowledge document added.', 'success');
    loadAiWorkspace();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderAiKnowledge(documents = []) {
  const container = document.getElementById('aiKnowledgeList');
  if (!container) return;
  container.innerHTML = documents.length ? documents.slice(0, 12).map(document => `
    <article class="ai-knowledge-item">
      <header><div><strong>${escapeHtml(document.title)}</strong><div>${escapeHtml(document.tags || 'No tags')}</div></div><span class="status-badge ${document.status === 'active' ? 'completed' : 'pending'}">${escapeHtml(document.status)}</span></header>
      <div>${escapeHtml(String(document.content || '').slice(0, 180))}${String(document.content || '').length > 180 ? '…' : ''}</div>
      <div class="ai-proposal-actions">
        <button class="action-btn secondary compact" onclick="archiveAiKnowledge('${escapeHtml(document.id)}', '${document.status === 'active' ? 'archived' : 'active'}')">${document.status === 'active' ? 'Archive' : 'Restore'}</button>
        <button class="action-btn secondary compact" onclick="deleteAiKnowledge('${escapeHtml(document.id)}')">Delete</button>
      </div>
    </article>`).join('') : '<div class="workspace-empty-state compact"><i class="fa-solid fa-book-open"></i><p>No knowledge documents yet.</p></div>';
}

async function archiveAiKnowledge(id, status) {
  await mutateAiKnowledge(`/api/v1/ai/knowledge/${encodeURIComponent(id)}`, 'PUT', { status }, status === 'active' ? 'Knowledge restored.' : 'Knowledge archived.');
}

async function deleteAiKnowledge(id) {
  if (!window.confirm('Delete this knowledge document?')) return;
  await mutateAiKnowledge(`/api/v1/ai/knowledge/${encodeURIComponent(id)}`, 'DELETE', null, 'Knowledge document deleted.');
}

async function mutateAiKnowledge(url, method, body, successMessage) {
  try {
    const response = await fetch(url, {
      method,
      headers: getAuthHeaders(),
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Knowledge update failed.');
    showToast(successMessage, 'success');
    loadAiWorkspace();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function startLiveTimestamp() {
  const el = document.getElementById('liveTimestamp');
  if (!el) return;

  function update() {
    const now = new Date();
    const optionsDate = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const datePart = now.toLocaleDateString('en-US', optionsDate);
    const timePart = now.toLocaleTimeString('en-US', { hour12: true });
    el.innerText = `${datePart} ${timePart}`;
  }

  update();
  setInterval(update, 1000);
}

// ================================================================
// SEARCHABLE CUSTOMER SELECTOR LOGIC
// ================================================================

function filterCustomerDropdown(query = '') {
  const dropdown = document.getElementById('customerSearchResultsList');
  if (!dropdown) return;

  const q = query.toLowerCase().trim();
  dropdown.innerHTML = '';
  dropdown.style.display = 'block';

  // Option 1: Walk-in Customer
  const walkInDiv = document.createElement('div');
  walkInDiv.style.cssText = 'padding: 10px 12px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.15s; display: flex; justify-content: space-between; align-items: center; background: #ffffff;';
  walkInDiv.onmouseover = () => walkInDiv.style.background = 'var(--blue-50)';
  walkInDiv.onmouseout = () => walkInDiv.style.background = '#ffffff';
  walkInDiv.onclick = () => selectCustomerForCart('', 'Walk-in Customer');
  walkInDiv.innerHTML = `
    <div>
      <strong style="font-size:0.85rem; color:var(--ink); display:block;">Walk-in Customer</strong>
      <span style="font-size:0.72rem; color:var(--ink-muted);">Standard counter checkout</span>
    </div>
    <span style="font-size:0.7rem; font-weight:700; color:var(--blue-600); background:var(--blue-50); padding:2px 6px; border-radius:4px;">DEFAULT</span>
  `;
  dropdown.appendChild(walkInDiv);

  // Filter customers by name, phone, or email
  const filtered = customers.filter(c => 
    !q || 
    c.name.toLowerCase().includes(q) || 
    (c.phone && c.phone.toLowerCase().includes(q)) ||
    (c.email && c.email.toLowerCase().includes(q))
  );

  if (filtered.length === 0) {
    const noResultDiv = document.createElement('div');
    noResultDiv.style.cssText = 'padding: 12px; text-align: center; color: var(--ink-muted); font-size: 0.8rem;';
    noResultDiv.innerText = `No customer found matching "${query}"`;
    dropdown.appendChild(noResultDiv);
    return;
  }

  filtered.forEach(c => {
    const itemDiv = document.createElement('div');
    itemDiv.style.cssText = 'padding: 10px 12px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.15s; display: flex; justify-content: space-between; align-items: center; background: #ffffff;';
    itemDiv.onmouseover = () => itemDiv.style.background = 'var(--blue-50)';
    itemDiv.onmouseout = () => itemDiv.style.background = '#ffffff';
    itemDiv.onclick = () => selectCustomerForCart(c.id, `${c.name} (${c.tier ? c.tier.toUpperCase() : 'BRONZE'})`);

    const phoneText = c.phone ? ` | ${c.phone}` : '';
    itemDiv.innerHTML = `
      <div>
        <strong style="font-size:0.85rem; color:var(--ink); display:block;">${c.name}</strong>
        <span style="font-size:0.72rem; color:var(--ink-muted);">${c.email || 'No email'}${phoneText}</span>
      </div>
      <span style="font-size:0.7rem; font-weight:700; color:var(--blue-600); text-transform:uppercase; background:var(--blue-50); padding:2px 6px; border-radius:4px;">${c.tier || 'BRONZE'}</span>
    `;
    dropdown.appendChild(itemDiv);
  });
}

function selectCustomerForCart(customerId, displayText) {
  const hiddenInput = document.getElementById('cartCustomerSelect');
  const searchInput = document.getElementById('cartCustomerSearchInput');
  const dropdown = document.getElementById('customerSearchResultsList');

  if (hiddenInput) hiddenInput.value = customerId || '';
  if (searchInput) searchInput.value = displayText;
  if (dropdown) dropdown.style.display = 'none';
  const customer = customers.find(item => Number(item.id) === Number(customerId));
  const gstinInput = document.getElementById('posCustomerGstin');
  const addressInput = document.getElementById('posCustomerAddress');
  if (gstinInput) gstinInput.value = customer?.gstin || '';
  if (addressInput) addressInput.value = customer?.address || '';
}

// Close customer search dropdown list on outside click
document.addEventListener('click', (e) => {
  const searchInput = document.getElementById('cartCustomerSearchInput');
  const dropdown = document.getElementById('customerSearchResultsList');
  if (dropdown && searchInput && !searchInput.contains(e.target) && !dropdown.contains(e.target)) {
    dropdown.style.display = 'none';
  }
});

// ================================================================
// REAL-TIME CHART.JS ANALYTICS & CRM LOYALTY LEDGER
// ================================================================

let dashboardChartInstances = {};

function renderDashboardCharts() {
  if (typeof Chart === 'undefined') return;

  // Destroy existing chart instances before re-rendering
  Object.values(dashboardChartInstances).forEach(chart => {
    if (chart && typeof chart.destroy === 'function') chart.destroy();
  });
  dashboardChartInstances = {};

  // 1. Weekly Sales Performance Chart
  const weeklyCanvas = document.getElementById('weeklySalesChart');
  if (weeklyCanvas) {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const salesTotals = [0, 0, 0, 0, 0, 0, 0];
    
    sales.forEach(sale => {
      let dayIndex = new Date(sale.sale_date).getDay() - 1; // 0 is Sunday, 1 is Monday, etc.
      if (dayIndex === -1) dayIndex = 6; // Sunday
      salesTotals[dayIndex] += (sale.total || 0);
    });

    dashboardChartInstances.weekly = new Chart(weeklyCanvas, {
      type: 'bar',
      data: {
        labels: days,
        datasets: [{
          label: 'Sales ($)',
          data: salesTotals,
          backgroundColor: '#2563eb',
          borderRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true } }
      }
    });
  }

  // 2. Top Products Chart
  const topCanvas = document.getElementById('topProductsChart');
  if (topCanvas) {
    const sortedProducts = [...products]
      .filter(p => (p.sales_count || 0) > 0)
      .sort((a, b) => (b.sales_count || 0) - (a.sales_count || 0))
      .slice(0, 5);

    const topLabels = sortedProducts.length > 0 ? sortedProducts.map(p => p.name) : ['No Data'];
    const topValues = sortedProducts.length > 0 ? sortedProducts.map(p => p.sales_count || 0) : [0];

    dashboardChartInstances.topProd = new Chart(topCanvas, {
      type: 'bar',
      data: {
        labels: topLabels,
        datasets: [{
          label: 'Units Sold',
          data: topValues,
          backgroundColor: '#f59e0b',
          borderRadius: 4
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } }
      }
    });
  }

  // 3. Payment Methods Distribution Chart
  const payCanvas = document.getElementById('paymentMethodsChart');
  if (payCanvas) {
    const payCounts = { cash: 0, card: 0, upi: 0, razorpay: 0 };
    sales.forEach(s => {
      const m = (s.payment_method || 'cash').toLowerCase();
      if (payCounts[m] !== undefined) payCounts[m]++;
      else payCounts.cash++;
    });

    const totalPayCount = Object.values(payCounts).reduce((a, b) => a + b, 0);

    dashboardChartInstances.payMethod = new Chart(payCanvas, {
      type: 'doughnut',
      data: {
        labels: ['Cash', 'Card', 'UPI', 'Razorpay'],
        datasets: [{
          data: totalPayCount > 0 
            ? [payCounts.cash, payCounts.card, payCounts.upi, payCounts.razorpay]
            : [0, 0, 0, 0],
          backgroundColor: ['#10b981', '#3b82f6', '#8b5cf6', '#0284c7']
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } }
      }
    });
  }

  // Sparklines
  renderSparkline('sparkCustomers', [0, 0, 0, 0, customers.length], '#6366f1');
  renderSparkline('sparkOrders', [0, 0, 0, 0, sales.length], '#a855f7');
  renderSparkline('sparkProducts', [0, 0, 0, 0, products.length], '#3b82f6');
}

function renderSparkline(canvasId, dataPoints, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  dashboardChartInstances[canvasId] = new Chart(canvas, {
    type: 'line',
    data: {
      labels: dataPoints.map((_, i) => i),
      datasets: [{
        data: dataPoints,
        borderColor: color,
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
        tension: 0.3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { display: false }, y: { display: false } }
    }
  });
}

function loadCustomerLedger() {
  const table = document.getElementById('customerLedgerTable');
  if (!table) return;
  table.innerHTML = '';

  const userRole = (localStorage.getItem('role') || 'admin').toLowerCase();

  customers.forEach(c => {
    const tr = document.createElement('tr');
    
    let tierColor = '#64748b';
    let tierBg = '#f1f5f9';
    const tier = (c.tier || 'bronze').toLowerCase();
    if (tier === 'platinum') { tierColor = '#7c3aed'; tierBg = '#f5f3ff'; }
    else if (tier === 'gold') { tierColor = '#d97706'; tierBg = '#fef3c7'; }
    else if (tier === 'silver') { tierColor = '#2563eb'; tierBg = '#eff6ff'; }

    const actionCell = userRole === 'admin' ? `
      <td>
        <button class="action-btn-sm" style="background-color: var(--red-600); color: #fff; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; transition: background-color var(--transition);" onmouseover="this.style.backgroundColor='#b91c1c'" onmouseout="this.style.backgroundColor='var(--red-600)'" onclick="deleteCustomer(${c.id})">
          <i class="fa-solid fa-trash"></i> Delete
        </button>
      </td>
    ` : `<td>-</td>`;

    tr.innerHTML = `
      <td>
        <strong style="color:var(--ink); font-size:0.9rem;">${c.name}</strong><br>
        <span style="font-size:0.75rem; color:var(--ink-muted);">ID: CUST-${c.id}</span>
      </td>
      <td>
        <span style="font-weight:600;">${c.phone || 'N/A'}</span><br>
        <span style="font-size:0.75rem; color:var(--ink-muted);">${c.email || 'No email'}</span>
      </td>
      <td style="font-weight:700; color:var(--ink);">${currencySymbol}${Number(c.credit_limit || 0).toFixed(2)}</td>
      <td style="font-weight:800; color:${Number(c.balance || 0) > 0 ? '#dc2626' : '#16a34a'};">${currencySymbol}${Number(c.balance || 0).toFixed(2)}</td>
      <td>
        <span style="font-size:0.75rem; font-weight:800; text-transform:uppercase; color:${tierColor}; background:${tierBg}; padding:4px 10px; border-radius:12px; display:inline-block;"><i class="fa-solid fa-award"></i> ${tier}</span>
      </td>
      <td>
        <strong style="font-size:1rem; color:var(--blue-600);"><i class="fa-solid fa-star" style="color:#f59e0b;"></i> ${c.loyalty_points || 0} pts</strong>
      </td>
      ${actionCell}
    `;
    table.appendChild(tr);
  });
}

async function deleteCustomer(customerId) {
  if (!confirm('Are you sure you want to delete this customer profile? This action is permanent.')) {
    return;
  }

  const cust = customers.find(c => c.id === customerId);
  const custName = cust ? cust.name : 'Customer';

  const actionFn = async () => {
    const res = await fetch(`/api/v1/customers/${customerId}`, { method: 'DELETE' });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || 'Server error');
    }

    await syncWithBackend();
  };

  await executeAction(null, actionFn, "Customer deleted successfully.", `Deleted customer profile "${custName}".`);
}
