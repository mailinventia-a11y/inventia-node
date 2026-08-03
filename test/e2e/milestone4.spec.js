import { expect, test } from '@playwright/test';

async function login(page) {
  await page.goto('/');
  await page.locator('#loginOrganization').fill('northwind-interiors');
  await page.locator('#loginUsername').fill('admin');
  await page.locator('#loginPassword').fill('admin123');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.locator('#loginContainer')).toBeHidden();
  await page.waitForFunction(() => window.InventiaCore?.store?.getState().ready === true);
  await page.evaluate(async () => {
    for (const key of ['navigation_v2', 'subscriptions_v2', 'compliance_v2']) {
      await window.InventiaCore.api.put(`/feature-flags/${key}`, { enabled: true, configuration: {} });
    }
    const suffix = String(Date.now());
    const customers = await window.InventiaCore.api.get('/customers?limit=1');
    if (!customers.customers?.length) await window.InventiaCore.api.post('/customers', { name: `E2E Customer ${suffix}` });
    const warehouses = await window.InventiaCore.api.get('/reference/warehouses');
    if (!warehouses.items?.length) await window.InventiaCore.api.post('/reference/warehouses', { name: 'E2E Warehouse', code: `E2E-${suffix.slice(-6)}`, type: 'store' });
    const products = await window.InventiaCore.api.get('/products?limit=1');
    if (!products.products?.length) await window.InventiaCore.api.post('/products', { sku: `E2E-${suffix}`, name: 'E2E Product', cost_price: 50, selling_price: 100 });
    await window.InventiaCore.initializeAuthenticated();
  });
}

test('Milestone 4 subscription and compliance routes use the existing workspace shell', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page);

  for (const [module, view, title] of [
    ['subscriptions', 'overview', 'Subscriptions'],
    ['compliance', 'e-invoices', 'E-Invoices'],
    ['compliance', 'e-way-bills', 'E-Way Bills'],
    ['compliance', 'gstr-1', 'GSTR-1'],
    ['compliance', 'gstr-2b', 'GSTR-2B'],
    ['compliance', 'gstr-3b', 'GSTR-3B'],
    ['compliance', 'gstr-7', 'GSTR-7'],
    ['compliance', 'ims', 'IMS'],
    ['compliance', 'tds-tcs', 'TDS/TCS']
  ]) {
    await page.evaluate(([routeModule, routeView]) => window.InventiaCore.router.navigate(routeModule, routeView), [module, view]);
    await expect(page).toHaveURL(new RegExp(`workspace=${module}.*view=${view}`));
    await expect(page.locator('#milestone4-workspace')).toHaveClass(/active/);
    await expect(page.locator('#m4WorkspaceTitle')).toHaveText(title);
    await expect(page.locator(`[data-module="${module}"][data-view="${view}"]`).first()).toBeVisible();
  }

  expect(errors).toEqual([]);
});

test('Milestone 4 creates a subscription draft and prepares a GST return from the UI', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page);

  await page.evaluate(() => window.InventiaCore.router.navigate('subscriptions', 'overview'));
  await page.getByRole('button', { name: 'New subscription' }).click();
  await expect(page.locator('#m4CreateForm')).toBeVisible();
  for (const field of ['customer_id', 'warehouse_id', 'product_id']) {
    await page.locator(`#m4CreateForm select[name="${field}"]`).selectOption({ index: 1 });
  }
  await page.locator('#m4CreateForm input[name="name"]').fill(`E2E Subscription ${Date.now()}`);
  await page.locator('#m4CreateForm input[name="start_date"]').fill('2030-01-01');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('#m4WorkspaceTable')).toContainText('E2E Subscription');

  await page.evaluate(() => window.InventiaCore.router.navigate('compliance', 'gstr-1'));
  await page.getByRole('button', { name: 'Prepare period' }).click();
  await page.locator('#m4CreateForm input[name="period"]').fill('2030-01');
  await page.getByRole('button', { name: 'Prepare return' }).click();
  await expect(page.locator('#m4WorkspaceTable')).toContainText('2030-01');
  expect(errors).toEqual([]);
});
