import { expect, test } from '@playwright/test';

async function loginAndEnable(page) {
  await page.goto('/');
  await page.locator('#loginOrganization').fill('northwind-interiors');
  await page.locator('#loginUsername').fill('admin');
  await page.locator('#loginPassword').fill('admin123');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.locator('#loginContainer')).toBeHidden();
  await page.waitForFunction(() => window.InventiaCore?.store?.getState().ready === true);
  await page.evaluate(async () => {
    await window.InventiaCore.api.put('/feature-flags/navigation_v2', { enabled: true, configuration: {} });
    await window.InventiaCore.api.put('/feature-flags/trade_workspaces', { enabled: true, configuration: {} });
    await window.InventiaCore.initializeAuthenticated();
  });
}

test('every Milestone 1 route resolves to its own workspace without browser errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await loginAndEnable(page);
  await page.locator('#dropdownTradeDocuments .nav-dropdown-trigger').click();
  await page.locator('[data-module="trade"][data-view="quotations"]').click();
  await expect(page.locator('#m1WorkspaceTitle')).toHaveText('Quotations');
  const routes = [
    ['trade', 'quotations', 'Quotations'], ['trade', 'sales-orders', 'Sales Orders'],
    ['trade', 'purchase-orders', 'Purchase Orders'], ['trade', 'deliveries', 'Delivery Challans'],
    ['trade', 'packing-lists', 'Packing Lists'], ['trade', 'sales-returns', 'Sales Returns'],
    ['trade', 'purchase-returns', 'Purchase Returns'], ['trade', 'grns', 'Goods Receipt Notes'],
    ['trade', 'approvals', 'Approvals'], ['inventory', 'variants', 'Variants'],
    ['inventory', 'price-lists', 'Price Lists'], ['inventory', 'supplier-mappings', 'Supplier Mappings'],
    ['inventory', 'balances', 'Inventory Balances'], ['inventory', 'movements', 'Stock Timeline'],
    ['inventory', 'adjustments', 'Adjustments & Damage'], ['inventory', 'batches', 'Batches & Expiry'],
    ['inventory', 'serials', 'Serial Numbers'], ['inventory', 'reservations', 'Reservations'],
    ['inventory', 'cycle-counts', 'Cycle Counts'], ['inventory', 'reorder-rules', 'Reorder Rules'],
    ['inventory', 'valuation', 'Inventory Valuation'], ['settings', 'documents', 'Documents Settings']
  ];
  for (const [module, view, title] of routes) {
    await page.evaluate(([routeModule, routeView]) => window.InventiaCore.router.navigate(routeModule, routeView), [module, view]);
    await expect(page.locator('#milestone1-workspace')).toHaveClass(/active/);
    await expect(page.locator('#m1WorkspaceTitle')).toHaveText(title);
    const navigation = page.locator(`[data-module="${module}"][data-view="${view}"]`);
    if (await navigation.count()) await expect(navigation).toHaveClass(/active/);
    else await expect(page.locator(`[data-module="${module}"][data-view="organization"]`)).toHaveClass(/active/);
  }
  expect(errors).toEqual([]);
});

test('unauthorized direct workspace navigation returns home before loading data', async ({ page }) => {
  await loginAndEnable(page);
  let tradeRequests = 0;
  page.on('request', request => { if (request.url().includes('/api/v1/trade/quotations')) tradeRequests += 1; });
  await page.evaluate(async () => {
    localStorage.setItem('permissions', JSON.stringify(['dashboard.read']));
    await window.InventiaCore.router.navigate('trade', 'quotations');
  });
  await expect(page.locator('#dashboard')).toHaveClass(/active/);
  expect(tradeRequests).toBe(0);
});

test('Milestone 1 workspace remains usable on mobile and in dark mode', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAndEnable(page);
  await page.evaluate(async () => {
    document.documentElement.setAttribute('data-theme-mode', 'dark');
    await window.InventiaCore.router.navigate('inventory', 'balances');
  });
  await expect(page.locator('#m1WorkspaceTitle')).toHaveText('Inventory Balances');
  await expect(page.locator('#m1WorkspaceTable')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
  expect(overflow).toBe(false);
});
