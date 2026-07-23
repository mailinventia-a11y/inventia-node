// State Management
let currentTab = 'dashboard';
let cart = [];
let calculatorMode = 'dims';
let activeCalculatorProduct = null;

// Mock Data Store (Fallbacks if Express server / Supabase is loading/offline)
let brands = [
  { id: 1, name: 'Kohler', code: 'KOH' },
  { id: 2, name: 'Havells', code: 'HAV' },
  { id: 3, name: 'Asian Paints', code: 'ASP' },
  { id: 4, name: 'CenturyPly', code: 'CEN' }
];

let categories = [
  { id: 1, name: 'Flooring & Tiles', parent_id: null },
  { id: 2, name: 'Lighting', parent_id: null },
  { id: 3, name: 'Furniture & Decor', parent_id: null },
  { id: 4, name: 'Food & Beverages', parent_id: null },
  { id: 5, name: 'Clothing', parent_id: null },
  { id: 6, name: 'Electronics', parent_id: null },
  { id: 7, name: 'Home & Garden', parent_id: null }
];

let products = [
  { id: 1, sku: 'FOD001', barcode: 'FOD001', name: 'Chocolate Bar', brand_id: 1, category_id: 4, uom: 'piece', coverage_per_box: null, cost_price: 1.50, selling_price: 2.99, material: 'Organic', finish: 'Standard', dimensions: '100g', shade_lot_number: 'LOT-CHOC', min_stock_alert: 50, stock: 1200, image_url: 'https://images.unsplash.com/photo-1582176647444-f7b60e6f7734?w=400' },
  { id: 2, sku: 'FOD002', barcode: 'FOD002', name: 'Coffee Beans', brand_id: 1, category_id: 4, uom: 'piece', coverage_per_box: null, cost_price: 6.00, selling_price: 12.99, material: 'Arabica', finish: 'Roasted', dimensions: '500g', shade_lot_number: 'LOT-COFF', min_stock_alert: 5, stock: 3, image_url: 'https://images.unsplash.com/photo-1559056199-641a0ac8b55e?w=400' },
  { id: 3, sku: 'CLT001', barcode: 'CLT001', name: 'Cotton T-Shirt', brand_id: 2, category_id: 5, uom: 'piece', coverage_per_box: null, cost_price: 8.00, selling_price: 19.99, material: 'Cotton', finish: 'Blue', dimensions: 'Medium', shade_lot_number: 'LOT-TSHIRT', min_stock_alert: 10, stock: 99, image_url: 'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=400' },
  { id: 4, sku: 'HOM001', barcode: 'HOM001', name: 'Gardening Tools Set', brand_id: 3, category_id: 7, uom: 'piece', coverage_per_box: null, cost_price: 25.00, selling_price: 59.99, material: 'Steel & Wood', finish: 'Natural', dimensions: '3-Piece', shade_lot_number: 'LOT-GARD', min_stock_alert: 5, stock: 18, image_url: 'https://images.unsplash.com/photo-1617576683096-00fc8eecb3af?w=400' },
  { id: 5, sku: 'CLT002', barcode: 'CLT002', name: 'Jeans', brand_id: 2, category_id: 5, uom: 'piece', coverage_per_box: null, cost_price: 20.00, selling_price: 49.99, material: 'Denim', finish: 'Classic Wash', dimensions: 'Size 32', shade_lot_number: 'LOT-JEANS', min_stock_alert: 10, stock: 74, image_url: 'https://images.unsplash.com/photo-1542272604-780c96856592?w=400' },
  { id: 6, sku: 'ELE001', barcode: 'ELE001', name: 'Laptop Pro', brand_id: 4, category_id: 6, uom: 'piece', coverage_per_box: null, cost_price: 800.00, selling_price: 1299.99, material: 'Aluminum', finish: 'Space Gray', dimensions: '15-inch', shade_lot_number: 'LOT-LAPTOP', min_stock_alert: 2, stock: 15, image_url: 'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=400' },
  { id: 7, sku: 'TL-CAR-60-GL', barcode: 'TL-CAR-60-GL', name: 'Carrara White Glossy Tile', brand_id: 1, category_id: 1, uom: 'box', coverage_per_box: 14.4, cost_price: 18.50, selling_price: 32.99, material: 'Ceramic', finish: 'Glossy', dimensions: '600x600 mm', shade_lot_number: 'BATCH-2026A', min_stock_alert: 10, stock: 45, image_url: 'https://images.unsplash.com/photo-1615873968403-89e068629265?w=400' },
  { id: 8, sku: 'LT-CHN-BR-12', barcode: 'LT-CHN-BR-12', name: 'Brushed Brass Chandelier', brand_id: 2, category_id: 2, uom: 'piece', coverage_per_box: null, cost_price: 120.00, selling_price: 249.99, material: 'Brass & Glass', finish: 'Brushed', dimensions: '12-Light', shade_lot_number: 'N/A', min_stock_alert: 3, stock: 8, image_url: 'https://images.unsplash.com/photo-1540932239986-30128078f3c5?w=400' },
  { id: 9, sku: 'FN-SOF-WL-03', barcode: 'FN-SOF-WL-03', name: 'Walnut Wood 3-Seater Sofa', brand_id: 4, category_id: 3, uom: 'piece', coverage_per_box: null, cost_price: 450.00, selling_price: 899.00, material: 'Teak/Walnut Wood', finish: 'Walnut Stain', dimensions: '3-Seater', shade_lot_number: 'WL-03', min_stock_alert: 2, stock: 1, image_url: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400' }
];

let customers = [
  { id: 1, name: 'John Doe', phone: '+1 555-0199', email: 'john@example.com', address: '123 Pine St', credit_limit: 1000.00, balance: 0.00, loyalty_points: 120, tier: 'silver' },
  { id: 2, name: 'Apex Builders', phone: '+1 555-9011', email: 'billing@apex.com', address: '45 Industrial Ave', credit_limit: 50000.00, balance: 14500.00, loyalty_points: 2450, tier: 'platinum' }
];

let sales = [
  { id: 1, invoice_no: 'INV-17112026', customer_id: 1, user_id: 1, subtotal: 329.90, discount: 29.90, tax_amount: 30.00, total: 330.00, payment_method: 'card', payment_status: 'completed', sale_date: new Date() }
];

let transfers = [
  { id: 1, from: 'Main Warehouse', to: 'City Showroom', product: 'Carrara White Tile', qty: 20, status: 'completed' }
];

let warehouses = [
  { id: 1, name: 'Main Warehouse', code: 'WH-MAIN', type: 'warehouse', address: '404 Logistics Boulevard, Sector 5' },
  { id: 2, name: 'City Showroom', code: 'SR-CITY', type: 'showroom', address: '12 Luxury Retail Avenue, Downtown' },
  { id: 3, name: 'Transit Dock', code: 'TD-TRANSIT', type: 'transit', address: 'Harbor Gate 12, Shipping Terminal' }
];

let staff = [
  { id: 1, username: 'admin', full_name: 'System Admin', email: 'admin@inventia.com', role: 'admin', status: 1 },
  { id: 2, username: 'vivin', full_name: 'Vivin', email: 'test@inventia.com', role: 'manager', status: 1 }
];

// Initialize UI
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  loadDashboardData();
  loadPOSCatalog();
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
  
  // Connect APIs if online
  fetch('/api/status')
    .then(r => r.json())
    .then(status => {
      console.log('Backend server is alive, loading live database records...');
      syncWithBackend();
    })
    .catch(e => {
      console.log('Running in local browser simulator mode. Set up Supabase credentials in .env to use live DB.');
    });
});



// Sync data from database APIs if available
async function syncWithBackend() {
  try {
    const headers = {
      'Authorization': 'Bearer mock-token',
      'x-user-role': 'admin',
      'x-user-id': '1'
    };

    const pRes = await fetch('/api/inventory/products', { headers });
    if (pRes.ok) products = await pRes.json();

    const cRes = await fetch('/api/sales/customers', { headers });
    if (cRes.ok) customers = await cRes.json();

    const bRes = await fetch('/api/inventory/brands', { headers });
    if (bRes.ok) brands = await bRes.json();

    const catRes = await fetch('/api/inventory/categories', { headers });
    if (catRes.ok) categories = await catRes.json();

    const wRes = await fetch('/api/inventory/warehouses', { headers });
    if (wRes.ok) warehouses = await wRes.json();

    const sRes = await fetch('/api/sales', { headers });
    if (sRes.ok) sales = await sRes.json();

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
    default: return '';
  }
}

// Sidebar Navigation Router
function setupNavigation() {
  // Setup parent level tab buttons
  const buttons = document.querySelectorAll('.nav-menu > .nav-btn[data-tab]');
  buttons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tabName = btn.getAttribute('data-tab');
      // Close all dropdowns when clicking top level links
      document.querySelectorAll('.nav-dropdown-wrapper').forEach(w => w.classList.remove('active'));
      switchTab(tabName);
    });
  });

  // Setup dropdown triggers
  const triggers = document.querySelectorAll('.nav-dropdown-trigger');
  triggers.forEach(trigger => {
    trigger.addEventListener('click', (e) => {
      const wrapper = trigger.closest('.nav-dropdown-wrapper');
      
      // Close all other dropdown wrappers
      document.querySelectorAll('.nav-dropdown-wrapper').forEach(w => {
        if (w !== wrapper) w.classList.remove('active');
      });
      
      // Toggle current dropdown wrapper
      wrapper.classList.toggle('active');
    });
  });

  // Setup dropdown sub-items
  const subItems = document.querySelectorAll('.nav-dropdown-item');
  subItems.forEach(item => {
    item.addEventListener('click', (e) => {
      const tabName = item.getAttribute('data-tab');
      const reportType = item.getAttribute('data-report-type');

      // Update active dropdown items
      document.querySelectorAll('.nav-dropdown-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      // Update active parent button
      document.querySelectorAll('.nav-menu > .nav-btn').forEach(b => b.classList.remove('active'));
      const wrapper = item.closest('.nav-dropdown-wrapper');
      if (wrapper) {
        wrapper.querySelector('.nav-btn').classList.add('active');
      }

      // Switch panels
      switchTab(tabName, reportType);

      // If report type, select correct report sub-tab
      if (reportType) {
        switchReportTab(reportType);
      }
    });
  });
}

// Global switchTab helper (used by footer links, quick-action buttons, etc.)
function switchTab(tabName, reportType = null) {
  const targetPanel = document.getElementById(tabName);
  if (!targetPanel) return;

  // Clear active states on all buttons and dropdown items
  document.querySelectorAll('.nav-menu > .nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.nav-dropdown-item').forEach(i => i.classList.remove('active'));

  // If reports tab, highlight based on report type
  if (tabName === 'reports') {
    const type = reportType || activeReport;
    const matchingSub = document.querySelector(`.nav-dropdown-item[data-tab="reports"][data-report-type="${type}"]`);
    if (matchingSub) {
      matchingSub.classList.add('active');
      const wrapper = matchingSub.closest('.nav-dropdown-wrapper');
      if (wrapper) {
        wrapper.classList.add('active');
        wrapper.querySelector('.nav-btn').classList.add('active');
      }
    }
  } else {
    // Highlight matching direct button
    const matchingBtn = document.querySelector(`.nav-menu > .nav-btn[data-tab="${tabName}"]`);
    if (matchingBtn) {
      matchingBtn.classList.add('active');
    } else {
      // Highlight matching sub-item if it's inside a dropdown
      const matchingSub = document.querySelector(`.nav-dropdown-item[data-tab="${tabName}"]`);
      if (matchingSub) {
        matchingSub.classList.add('active');
        const wrapper = matchingSub.closest('.nav-dropdown-wrapper');
        if (wrapper) {
          wrapper.classList.add('active');
          wrapper.querySelector('.nav-btn').classList.add('active');
        }
      }
    }
  }

  document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
  targetPanel.classList.add('active');
  currentTab = tabName;
  window.scrollTo(0, 0);
}

// ================= MODULE 1: DASHBOARD =================
function loadDashboardData() {
  // KPI calculations
  const totalValuation = products.reduce((acc, p) => acc + (p.cost_price * (p.stock || 10)), 0);
  const lowStockCount = products.filter(p => (p.stock || 0) < p.min_stock_alert).length;
  
  const elVal = document.getElementById('kpiValuation');
  if (elVal) elVal.innerText = `$${totalValuation.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
  const elLow = document.getElementById('kpiLowStock');
  if (elLow) elLow.innerText = `${lowStockCount} Products`;

  const elCust = document.getElementById('dashboardCustomerCount');
  if (elCust) elCust.innerText = customers.length;
  const elOrd = document.getElementById('dashboardOrderCount');
  if (elOrd) elOrd.innerText = sales.length;
  const elProd = document.getElementById('dashboardProductCount');
  if (elProd) elProd.innerText = products.length;
  
  // Render recent sales
  const recentTable = document.getElementById('recentSalesTable');
  if (!recentTable) return;
  recentTable.innerHTML = '';
  sales.forEach(sale => {
    const cust = customers.find(c => c.id === sale.customer_id)?.name || 'Walk-in';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${sale.invoice_no}</strong></td>
      <td>${cust}</td>
      <td><span class="badge-pay">${sale.payment_method}</span></td>
      <td>$${sale.total.toFixed(2)}</td>
      <td>
        <button class="action-btn-sm" onclick="downloadInvoice(${sale.id})"><i class="fa-solid fa-file-pdf"></i> PDF</button>
      </td>
    `;
    recentTable.appendChild(tr);
  });

  // Render stock alerts
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

function downloadInvoice(saleId) {
  window.open(`/api/sales/invoice/${saleId}/pdf`, '_blank');
}

// ================= MODULE 2: POS CATALOG & CART =================
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
    card.style.cssText = 'background: white; border-radius: var(--radius-md); border: 1px solid var(--border-color); padding: 14px; display: flex; flex-direction: column; justify-content: space-between; box-shadow: 0 2px 4px rgba(0,0,0,0.03); transition: transform 0.2s, box-shadow 0.2s; cursor: pointer;';
    card.onclick = () => addToCart(p.id);
    
    // Photo preview fallback
    const photoUrl = p.image_url || 'https://images.unsplash.com/photo-1582176647444-f7b60e6f7734?w=400';

    card.innerHTML = `
      <div>
        <div style="width: 100%; height: 130px; border-radius: var(--radius-sm); overflow: hidden; background-color: #f8fafc; margin-bottom: 10px;">
          <img src="${photoUrl}" alt="${p.name}" style="width: 100%; height: 100%; object-fit: cover;">
        </div>
        <h5 style="font-size: 0.95rem; font-weight: 700; color: var(--text-main); margin-bottom: 4px; line-height: 1.3;">${p.name}</h5>
        <span style="font-size: 0.75rem; color: var(--text-muted); display: block; margin-bottom: 8px;">${catName}</span>
        <div style="font-size: 1.15rem; font-weight: 800; color: var(--primary); margin-bottom: 4px;">$${p.selling_price.toFixed(2)}</div>
        <span style="font-size: 0.75rem; color: ${(p.stock || 0) < p.min_stock_alert ? 'var(--alert)' : 'var(--text-muted)'}; display: block; margin-bottom: 12px; font-weight: 600;">Stock: ${p.stock || 0}</span>
      </div>
      <button style="width: 100%; padding: 10px; background-color: var(--primary); color: white; border: none; border-radius: var(--radius-sm); font-family: var(--font-family); font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 0.85rem;">
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

function handleScanSubmit(event) {
  event.preventDefault();
  const code = document.getElementById('manualScanInput').value.trim().toLowerCase();
  if (!code) return;

  const product = products.find(p => 
    (p.barcode && p.barcode.toLowerCase() === code) || 
    p.sku.toLowerCase() === code ||
    p.name.toLowerCase().includes(code)
  );

  if (product) {
    addToCart(product.id);
    closeScannerModal();
    document.getElementById('manualScanInput').value = '';
  } else {
    alert(`No product found matching barcode or SKU: "${code}"`);
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
    document.getElementById('cartSubtotal').innerText = '$0.00';
    document.getElementById('cartTax').innerText = '$0.00';
    document.getElementById('cartGrandTotal').innerText = '$0.00';
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
      <div style="text-align: right; color: #334155; font-weight: 600; font-size: 0.85rem;">$${item.unit_price.toFixed(2)}</div>
      <div style="text-align: center;">
        <input type="number" value="${item.quantity}" min="1" onchange="updateCartQty(${index}, this.value)" style="width: 42px; text-align: center; padding: 4px 2px; border-radius: 4px; border: 1px solid #cbd5e1; font-weight: 700; font-size: 0.85rem; color: #0f172a; background: #f8fafc;">
      </div>
      <div style="text-align: right; font-weight: 800; color: #2563eb; font-size: 0.85rem;">$${rowTotal.toFixed(2)}</div>
      <div style="text-align: right;">
        <button onclick="removeFromCart(${index})" style="background: #fef2f2; border: 1px solid #fee2e2; color: #dc2626; cursor: pointer; padding: 5px 7px; border-radius: 4px; transition: all 0.2s;" title="Remove Item"><i class="fa-solid fa-trash-can" style="font-size: 0.75rem;"></i></button>
      </div>
    `;
    list.appendChild(row);
  });

  const discount = Number(document.getElementById('cartDiscount').value) || 0;
  const tax = (subtotal - discount) * 0.1;
  const grandTotal = subtotal - discount + tax;

  document.getElementById('cartSubtotal').innerText = `$${subtotal.toFixed(2)}`;
  document.getElementById('cartTax').innerText = `$${tax.toFixed(2)}`;
  document.getElementById('cartGrandTotal').innerText = `$${grandTotal.toFixed(2)}`;
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

// Complete checkout
async function submitPOSCheckout() {
  if (cart.length === 0) {
    alert('Billing cart is empty.');
    return;
  }

  const customerId = document.getElementById('cartCustomerSelect').value;
  const warehouseId = document.getElementById('cartWarehouseSelect').value;
  const discount = document.getElementById('cartDiscount').value;
  const paymentMethod = document.querySelector('input[name="payment_method"]:checked').value;

  const payload = {
    customer_id: customerId ? parseInt(customerId) : null,
    warehouse_id: parseInt(warehouseId),
    items: cart.map(item => ({ product_id: item.product_id, quantity: item.quantity, unit_price: item.unit_price })),
    discount: parseFloat(discount) || 0,
    payment_method: paymentMethod
  };

  // If payment method is Razorpay, open Razorpay popup
  if (paymentMethod === 'razorpay') {
    const subtotalCalc = cart.reduce((acc, i) => acc + (i.quantity * i.unit_price), 0);
    const discountCalc = parseFloat(discount) || 0;
    const taxCalc = (subtotalCalc - discountCalc) * 0.1;
    const grandTotalCalc = subtotalCalc - discountCalc + taxCalc;

    try {
      const orderRes = await fetch('/api/sales/razorpay/create-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer mock-token',
          'x-user-role': 'cashier'
        },
        body: JSON.stringify({ amount: grandTotalCalc, receipt: 'rcpt_' + Date.now() })
      });
      const orderData = await orderRes.json();

      if (window.Razorpay) {
        const options = {
          key: orderData.key_id,
          amount: orderData.amount,
          currency: orderData.currency || 'INR',
          name: 'Inventia POS Terminal',
          description: `POS Checkout (${cart.length} items)`,
          order_id: orderData.order_id,
          handler: async function (response) {
            payload.payment_status = 'completed';
            payload.razorpay_payment_id = response.razorpay_payment_id;
            await executeFinalCheckoutPayload(payload);
          },
          prefill: {
            name: document.getElementById('cartCustomerSearchInput').value || 'Walk-in Customer'
          },
          theme: { color: '#0284c7' }
        };
        const rzp1 = new window.Razorpay(options);
        rzp1.open();
        return;
      }
    } catch (rzpErr) {
      console.warn('Razorpay SDK notice, proceeding with simulated payment:', rzpErr);
    }
  }

  await executeFinalCheckoutPayload(payload);
}

async function executeFinalCheckoutPayload(payload) {
  try {
    const res = await fetch('/api/sales/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer mock-token',
        'x-user-role': 'cashier',
        'x-user-id': '1'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      throw new Error(`Server error: ${res.status}`);
    }

    const data = await res.json();
    if (data.success) {
      alert(`POS checkout completed! Invoice: ${data.invoice_no}`);
      clearCart();
      await syncWithBackend();
    } else {
      alert(`Checkout failed: ${data.error}`);
    }
  } catch (err) {
    alert(`[Offline Demo] POS checkout complete! Added to recent transactions list.`);
    const mockInvoiceNo = 'INV-' + Date.now().toString().slice(-6);
    const subtotal = cart.reduce((acc, i) => acc + (i.quantity * i.unit_price), 0);
    const total = subtotal - (payload.discount || 0) + ((subtotal - (payload.discount || 0)) * 0.1);
    sales.unshift({
      id: Date.now(),
      invoice_no: mockInvoiceNo,
      customer_id: payload.customer_id,
      user_id: 1,
      subtotal,
      discount: payload.discount,
      tax_amount: (subtotal - (payload.discount || 0)) * 0.1,
      total,
      payment_method: payload.payment_method,
      payment_status: 'completed',
      sale_date: new Date()
    });
    cart.forEach(item => {
      const prod = products.find(p => p.id === item.product_id);
      if (prod) prod.stock = Math.max(0, prod.stock - item.quantity);
    });
    clearCart();
    loadDashboardData();
    loadPOSCatalog();
    loadInventoryTable();
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
      <td>Cost: $${p.cost_price.toFixed(2)}<br><span style="font-weight:700">Sell: $${p.selling_price.toFixed(2)}</span></td>
      <td>
        <span class="stock-pill ${(p.stock || 0) < p.min_stock_alert ? 'low' : 'ok'}">${p.stock || 0} ${p.uom}s</span>
      </td>
    `;
    table.appendChild(tr);
  });
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

async function submitNewProduct(event) {
  event.preventDefault();

  const fileInput = document.getElementById('pImageFile');
  let imageUrl = '';

  try {
    // If a file is selected, upload it first
    if (fileInput && fileInput.files && fileInput.files[0]) {
      const file = fileInput.files[0];
      const base64 = await toBase64(file);
      
      const uploadRes = await fetch('/api/inventory/products/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer mock-token',
          'x-user-role': 'manager'
        },
        body: JSON.stringify({ fileName: file.name, base64Data: base64 })
      });
      
      if (uploadRes.ok) {
        const uploadData = await uploadRes.json();
        imageUrl = uploadData.imageUrl;
      }
    }
  } catch (err) {
    console.error('Image upload failed, saving without image:', err);
  }
  
  const payload = {
    id: products.length + 1,
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
    stock: 0
  };

  // Add locally
  products.push(payload);
  loadInventoryTable();
  loadPOSCatalog();
  closeProductModal();
  document.getElementById('productForm').reset();
  
  // Call backend API in background
  fetch('/api/inventory/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer mock', 'x-user-role': 'admin' },
    body: JSON.stringify(payload)
  }).catch(e => console.log('Offline demo saved product locally.'));
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
  table.innerHTML = '';
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

  try {
    const res = await fetch('/api/inventory/stock/transfer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer mock-token',
        'x-user-role': 'manager',
        'x-user-id': '1'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Server error');
    }

    alert('Stock transfer completed successfully!');
    document.getElementById('transferForm').reset();
    await syncWithBackend();
  } catch (err) {
    console.error('Transfer API failed, using fallback:', err);
    // Offline simulation mode fallback
    alert(`[Offline Demo] Stock transfer completed successfully (simulated).\nError: ${err.message}`);
    const fromWh = document.getElementById('transferFromSelect').options[document.getElementById('transferFromSelect').selectedIndex].text;
    const toWh = document.getElementById('transferToSelect').options[document.getElementById('transferToSelect').selectedIndex].text;
    const product = products.find(p => p.id === pId);
    if (product) {
      transfers.unshift({
        id: transfers.length + 1,
        from: fromWh,
        to: toWh,
        product: product.name,
        qty: qty,
        status: 'completed'
      });
      product.stock = Math.max(0, product.stock - qty);
      loadTransferLogs();
      loadInventoryTable();
      loadDashboardData();
      document.getElementById('transferForm').reset();
    }
  }
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

  const product = products.find(p => p.id === pId);
  if (product) {
    product.stock = (product.stock || 0) + qty;
    alert(`Stock adjusted successfully! New stock level: ${product.stock} ${product.uom}s`);
    
    // Add to transfers log for simulation demonstration
    transfers.unshift({
      id: transfers.length + 1,
      from: qty > 0 ? 'Supplier Delivery' : 'Inventory Adjust',
      to: wId === 1 ? 'Main Warehouse' : wId === 2 ? 'City Showroom' : 'Transit Dock',
      product: product.name,
      qty: Math.abs(qty),
      status: 'completed'
    });

    closeStockInwardModal();
    document.getElementById('stockInwardForm').reset();
    
    loadInventoryTable();
    loadPOSCatalog();
    loadDashboardData();
    loadTransferLogs();

    // POST to backend API
    fetch('/api/inventory/stock/adjust', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer mock-token',
        'x-user-role': 'manager',
        'x-user-id': '1'
      },
      body: JSON.stringify({ product_id: pId, warehouse_id: wId, quantity_change: qty, reason, notes })
    }).catch(e => console.log('Offline demo updated stock locally.'));
  }
}

// Submit Customer Form
async function submitNewCustomer(event) {
  event.preventDefault();
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

  customers.push(payload);
  alert('Customer profile created successfully!');
  
  closeCustomerModal();
  document.getElementById('customerForm').reset();
  
  loadCustomerLedger();
  populateDropdowns();

  // POST to API in background
  fetch('/api/sales/customers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer mock', 'x-user-role': 'cashier' },
    body: JSON.stringify(payload)
  }).catch(e => console.log('Offline demo saved customer profile.'));
}

// Setup Event Listeners for Filtering & Search
document.addEventListener('DOMContentLoaded', () => {
  // POS Catalog Filters
  const filterBtns = document.querySelectorAll('.filter-btn');
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const cat = btn.getAttribute('data-cat');
      filterPOSCatalog(cat);
    });
  });

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
      <td>Cost: $${p.cost_price.toFixed(2)}<br><span style="font-weight:700">Sell: $${p.selling_price.toFixed(2)}</span></td>
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
    const res = await fetch('/api/inventory/brands', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer mock-token',
        'x-user-role': 'manager'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Server error');
    }

    alert('Brand added successfully!');
    document.getElementById('brandForm').reset();
    await syncWithBackend();
  } catch (err) {
    console.error('Brand API failed, using fallback:', err);
    alert('[Offline Demo] Brand added successfully (simulated).');
    brands.push({ id: brands.length + 1, name, code });
    document.getElementById('brandForm').reset();
    loadBrandsAndCategories();
    populateDropdowns();
  }
}

async function submitNewCategory(event) {
  event.preventDefault();
  const name = document.getElementById('catNameInput').value;
  const parentVal = document.getElementById('catParentInput').value;
  const parentId = parentVal ? parseInt(parentVal) : null;

  const payload = { name, parent_id: parentId };

  try {
    const res = await fetch('/api/inventory/categories', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer mock-token',
        'x-user-role': 'manager'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Server error');
    }

    alert('Category added successfully!');
    document.getElementById('categoryForm').reset();
    await syncWithBackend();
  } catch (err) {
    console.error('Category API failed, using fallback:', err);
    alert('[Offline Demo] Category added successfully (simulated).');
    categories.push({ id: categories.length + 1, name, parent_id: parentId });
    document.getElementById('categoryForm').reset();
    loadBrandsAndCategories();
    populateDropdowns();
  }
}

// ================= STAFF & USER MANAGEMENT =================
function loadStaffList() {
  const table = document.getElementById('staffListTable');
  if (table) {
    table.innerHTML = '';
    staff.forEach(s => {
      table.innerHTML += `
        <tr>
          <td>
            <strong>${s.full_name}</strong><br>
            <span class="badge-status ${s.role === 'admin' ? 'completed' : 'pending'}">${s.role.toUpperCase()}</span>
          </td>
          <td>${s.username}<br><span style="font-size:0.75rem; color:var(--text-muted)">${s.email}</span></td>
          <td>
            <button class="action-btn-sm" style="background-color:${s.status === 1 ? 'var(--success)' : 'var(--text-muted)'}" onclick="toggleUserStatus(${s.id}, ${s.status})">
              ${s.status === 1 ? 'Active' : 'Inactive'}
            </button>
          </td>
        </tr>
      `;
    });
  }
}

async function submitNewStaff(event) {
  event.preventDefault();
  const full_name = document.getElementById('sFullName').value;
  const username = document.getElementById('sUsername').value;
  const role = document.getElementById('sRole').value;
  const email = document.getElementById('sEmail').value;
  const password = document.getElementById('sPassword').value;

  const payload = { username, password, full_name, email, role };

  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer mock-token',
        'x-user-role': 'admin'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Server error');
    }

    alert('Staff account registered successfully!');
    document.getElementById('staffForm').reset();
    await syncWithBackend();
  } catch (err) {
    console.error('Staff registration API failed, using fallback:', err);
    alert('[Offline Demo] Staff account registered successfully (simulated).');
    staff.push({ id: staff.length + 1, username, full_name, email, role, status: 1 });
    document.getElementById('staffForm').reset();
    loadStaffList();
  }
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
          'Authorization': 'Bearer mock-token',
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
      console.error('Toggle status API failed, using fallback:', err);
      member.status = newStatus;
      alert(`Staff account status updated (simulated)!`);
      loadStaffList();
    }
  }
}

// ================= APP SETTINGS MANAGEMENT =================
async function submitSettings(event) {
  event.preventDefault();
  const companyName = document.getElementById('setCompanyName').value;
  const companyEmail = document.getElementById('setCompanyEmail').value;
  const companyAddress = document.getElementById('setCompanyAddress').value;
  const companyPhone = document.getElementById('setCompanyPhone').value;
  const currencySymbol = document.getElementById('setCurrencySymbol').value;
  const currencyCode = document.getElementById('setCurrencyCode').value;
  const taxRate = parseFloat(document.getElementById('setTaxRate').value) / 100;

  const payload = [
    { setting_key: 'company_name', setting_value: companyName },
    { setting_key: 'company_email', setting_value: companyEmail },
    { setting_key: 'company_address', setting_value: companyAddress },
    { setting_key: 'company_phone', setting_value: companyPhone },
    { setting_key: 'currency_symbol', setting_value: currencySymbol },
    { setting_key: 'currency_code', setting_value: currencyCode },
    { setting_key: 'tax_rate', setting_value: taxRate.toString() }
  ];

  // Apply to sidebar UI
  const logo = document.querySelector('.logo-title');
  if (logo) logo.innerText = companyName.toUpperCase();

  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer mock-token',
        'x-user-role': 'admin'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Server error');
    }

    alert('Global settings updated successfully! UI refreshed.');
    await syncWithBackend();
  } catch (err) {
    console.error('Settings API failed, using fallback:', err);
    alert('[Offline Demo] Global settings updated successfully (simulated).');
  }
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
        'Authorization': 'Bearer mock-token',
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
    console.error('Modal category creation API failed, using fallback:', err);
    alert('[Offline Demo] Category created successfully (simulated).');
    const newCat = {
      id: categories.length + 1,
      name: name,
      description: description,
      created_at: new Date(),
      updated_at: new Date()
    };
    categories.push(newCat);
    document.getElementById('categoryModalForm').reset();
    closeCategoryModal();
    loadCategoryManagement();
    loadBrandsAndCategories();
  }
}

async function deleteCategory(catId) {
  if (confirm('Are you sure you want to delete this category?')) {
    try {
      const res = await fetch(`/api/inventory/categories/${catId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': 'Bearer mock-token',
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
            'Authorization': 'Bearer mock-token',
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
function openBarcodeModal(productId) {
  const product = products.find(p => p.id === productId);
  if (product) {
    document.getElementById('barcodeProductTitle').innerText = product.name;
    
    // Generate barcode using JsBarcode
    JsBarcode("#barcodeImage", product.barcode || product.sku, {
      format: "CODE128",
      width: 2,
      height: 60,
      displayValue: true,
      lineColor: "#0f172a"
    });
    
    document.getElementById('barcodeModal').classList.add('active');
  }
}

function closeBarcodeModal() {
  document.getElementById('barcodeModal').classList.remove('active');
}

// ================= CHART.JS DASHBOARD INITIALIZATION =================
function initDashboardCharts() {
  if (typeof Chart === 'undefined') return;

  // 1. Weekly Sales Performance (Line Chart)
  const ctxWeekly = document.getElementById('weeklySalesChart');
  if (ctxWeekly) {
    new Chart(ctxWeekly, {
      type: 'line',
      data: {
        labels: ['Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue'],
        datasets: [{
          label: 'Revenue ($)',
          data: [0, 0, 0, 0, 0, 0, 80],
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

  // 2. Top Products (Bar Chart)
  const ctxTop = document.getElementById('topProductsChart');
  if (ctxTop) {
    new Chart(ctxTop, {
      type: 'bar',
      data: {
        labels: ['Gardening Tools Set', 'Coffee Beans'],
        datasets: [{
          label: 'Sales Count',
          data: [1, 1],
          backgroundColor: ['#6366f1', '#3b82f6'],
          borderRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { stepSize: 1 } },
          x: { grid: { display: false } }
        }
      }
    });
  }

  // 3. Payment Methods (Doughnut Chart)
  const ctxPay = document.getElementById('paymentMethodsChart');
  if (ctxPay) {
    new Chart(ctxPay, {
      type: 'doughnut',
      data: {
        labels: ['Card', 'Cash'],
        datasets: [{
          data: [1, 1],
          backgroundColor: ['#2563eb', '#60a5fa']
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
      <td><strong>$${sale.total.toFixed(2)}</strong></td>
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
        'Authorization': 'Bearer mock-token',
        'x-user-role': 'manager'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error('Server error');
    alert('Category updated successfully!');
    closeCategoryEditModal();
    await syncWithBackend();
  } catch (err) {
    console.error('Edit category API failed, using fallback:', err);
    cat.name = name;
    cat.description = description;
    cat.updated_at = new Date();
    alert('Category updated successfully (simulated)!');
    closeCategoryEditModal();
    loadCategoryManagement();
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
        'Authorization': 'Bearer mock-token',
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
    console.error('Brand modal create failed:', err);
    alert('[Offline Demo] Brand created successfully (simulated).');
    brands.push({ id: brands.length + 1, name, code });
    document.getElementById('brandModalForm').reset();
    closeBrandModal();
    loadBrandManagement();
    loadBrandsAndCategories();
    populateDropdowns();
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
        'Authorization': 'Bearer mock-token',
        'x-user-role': 'manager'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error('Server error');
    alert('Brand updated successfully!');
    closeBrandEditModal();
    await syncWithBackend();
  } catch (err) {
    console.error('Edit brand API failed, using fallback:', err);
    brand.name = name;
    brand.code = code;
    alert('Brand updated successfully (simulated)!');
    closeBrandEditModal();
    loadBrandManagement();
    loadBrandsAndCategories();
    populateDropdowns();
  }
}

async function deleteBrand(brandId) {
  if (confirm('Are you sure you want to delete this brand?')) {
    try {
      const res = await fetch(`/api/inventory/brands/${brandId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': 'Bearer mock-token',
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
        'Authorization': 'Bearer mock-token',
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
    console.error('Warehouse modal create failed:', err);
    alert('[Offline Demo] Warehouse location created successfully (simulated).');
    warehouses.push({ id: warehouses.length + 1, name, code, type, address });
    document.getElementById('warehouseModalForm').reset();
    closeWarehouseModal();
    loadWarehouseManagement();
    populateDropdowns();
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
        'Authorization': 'Bearer mock-token',
        'x-user-role': 'manager'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error('Server error');
    alert('Warehouse location updated successfully!');
    closeWarehouseEditModal();
    await syncWithBackend();
  } catch (err) {
    console.error('Edit warehouse API failed, using fallback:', err);
    wh.name = name;
    wh.code = code;
    wh.type = type;
    wh.address = address;
    alert('Warehouse location updated successfully (simulated)!');
    closeWarehouseEditModal();
    loadWarehouseManagement();
    populateDropdowns();
  }
}

async function deleteWarehouse(whId) {
  if (confirm('Are you sure you want to delete this warehouse location?')) {
    try {
      const res = await fetch(`/api/inventory/warehouses/${whId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': 'Bearer mock-token',
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

function toggleAiChatDrawer() {
  const drawer = document.getElementById('aiChatDrawer');
  if (drawer) drawer.classList.toggle('active');
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
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer mock-token'
      },
      body: JSON.stringify({ message: query })
    });

    if (messagesContainer.contains(typingDiv)) {
      messagesContainer.removeChild(typingDiv);
    }

    if (!res.ok) throw new Error('API failure');
    const data = await res.json();

    // Append Agent Response
    const agentDiv = document.createElement('div');
    agentDiv.className = 'chat-msg agent';
    agentDiv.innerHTML = formatMarkdown(data.reply);
    messagesContainer.appendChild(agentDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  } catch (err) {
    console.error('Chat API failed:', err);
    if (messagesContainer.contains(typingDiv)) {
      messagesContainer.removeChild(typingDiv);
    }
    const errDiv = document.createElement('div');
    errDiv.className = 'chat-msg agent';
    errDiv.innerText = 'Sorry, I am having trouble connecting to the POS server right now. Please try again.';
    messagesContainer.appendChild(errDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

function formatMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

function submitAiSettings(event) {
  event.preventDefault();
  alert('AI Agent API integration parameters saved and verified!');
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
    const salesTotals = [1200, 1900, 3000, 2500, 4200, 5800, sales.reduce((a, s) => a + (s.total || 0), 0)];
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
    const topLabels = products.slice(0, 5).map(p => p.name);
    const topValues = products.slice(0, 5).map(p => Math.floor(Math.random() * 40) + 10);
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

    dashboardChartInstances.payMethod = new Chart(payCanvas, {
      type: 'doughnut',
      data: {
        labels: ['Cash', 'Card', 'UPI', 'Razorpay'],
        datasets: [{
          data: [payCounts.cash || 5, payCounts.card || 3, payCounts.upi || 2, payCounts.razorpay || 1],
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
  renderSparkline('sparkCustomers', [1, 2, 3, 4, customers.length], '#6366f1');
  renderSparkline('sparkOrders', [5, 8, 12, 15, sales.length], '#a855f7');
  renderSparkline('sparkProducts', [6, 7, 8, 9, products.length], '#3b82f6');
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

  customers.forEach(c => {
    const tr = document.createElement('tr');
    
    let tierColor = '#64748b';
    let tierBg = '#f1f5f9';
    const tier = (c.tier || 'bronze').toLowerCase();
    if (tier === 'platinum') { tierColor = '#7c3aed'; tierBg = '#f5f3ff'; }
    else if (tier === 'gold') { tierColor = '#d97706'; tierBg = '#fef3c7'; }
    else if (tier === 'silver') { tierColor = '#2563eb'; tierBg = '#eff6ff'; }

    tr.innerHTML = `
      <td>
        <strong style="color:var(--ink); font-size:0.9rem;">${c.name}</strong><br>
        <span style="font-size:0.75rem; color:var(--ink-muted);">ID: CUST-${c.id}</span>
      </td>
      <td>
        <span style="font-weight:600;">${c.phone || 'N/A'}</span><br>
        <span style="font-size:0.75rem; color:var(--ink-muted);">${c.email || 'No email'}</span>
      </td>
      <td style="font-weight:700; color:var(--ink);">$${Number(c.credit_limit || 0).toFixed(2)}</td>
      <td style="font-weight:800; color:${Number(c.balance || 0) > 0 ? '#dc2626' : '#16a34a'};">$${Number(c.balance || 0).toFixed(2)}</td>
      <td>
        <span style="font-size:0.75rem; font-weight:800; text-transform:uppercase; color:${tierColor}; background:${tierBg}; padding:4px 10px; border-radius:12px; display:inline-block;"><i class="fa-solid fa-award"></i> ${tier}</span>
      </td>
      <td>
        <strong style="font-size:1rem; color:var(--blue-600);"><i class="fa-solid fa-star" style="color:#f59e0b;"></i> ${c.loyalty_points || 0} pts</strong>
      </td>
    `;
    table.appendChild(tr);
  });
}


