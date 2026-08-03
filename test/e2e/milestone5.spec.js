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
    for (const key of ['navigation_v2', 'online_store_v2', 'integrations_v2']) {
      await window.InventiaCore.api.put(`/feature-flags/${key}`, { enabled: true, configuration: {} });
    }
    const products = await window.InventiaCore.api.get('/products?limit=1');
    if (!products.products?.length) {
      const suffix = String(Date.now());
      await window.InventiaCore.api.post('/products', { sku: `STORE-${suffix}`, name: 'E2E Store Product', cost_price: 50, selling_price: 100, hsn_code: '9403', gst_rate: 18 });
    }
    await window.InventiaCore.initializeAuthenticated();
  });
}

test('Milestone 5 store and integration routes use the existing design shell', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page);
  for (const [module, view, title] of [
    ['store', 'overview', 'Online Store'], ['store', 'catalog', 'Online Catalogue'], ['store', 'orders', 'Online Orders'],
    ['integrations', 'overview', 'Integrations'], ['integrations', 'api-keys', 'Developer API Keys'], ['integrations', 'webhooks', 'Webhooks']
  ]) {
    await page.evaluate(([routeModule, routeView]) => window.InventiaCore.router.navigate(routeModule, routeView), [module, view]);
    await expect(page).toHaveURL(new RegExp(`workspace=${module}.*view=${view}`));
    await expect(page.locator('#milestone5-workspace')).toHaveClass(/active/);
    await expect(page.locator('#m5WorkspaceTitle')).toHaveText(title);
  }
  await page.evaluate(() => window.InventiaCore.router.navigate('integrations', 'overview'));
  await expect(page.locator('#m5WorkspaceTable')).toContainText('Shopify');
  await expect(page.locator('#m5WorkspaceTable')).toContainText('Coming later');
  expect(errors).toEqual([]);
});

test('Milestone 5 publishes a catalogue and exposes only safe public product data', async ({ page, request }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page);

  await page.evaluate(() => window.InventiaCore.router.navigate('store', 'overview'));
  await page.getByRole('button', { name: 'Edit settings' }).click();
  await page.locator('#m5CreateForm select[name="status"]').selectOption('PUBLISHED');
  await page.locator('#m5CreateForm select[name="mode"]').selectOption('DIRECT_ORDER');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#m5WorkspaceKpis')).toContainText('PUBLISHED');

  await page.getByRole('button', { name: 'Catalogue' }).click();
  const publish = page.getByRole('button', { name: 'Publish', exact: true }).first();
  if (await publish.isVisible()) await publish.click();
  await expect(page.locator('#m5WorkspaceTable')).toContainText('Published');

  const catalog = await request.get('/api/v1/public/store/northwind-interiors/catalog');
  expect(catalog.ok()).toBeTruthy();
  const payload = await catalog.json();
  expect(payload.ordering_enabled).toBe(true);
  expect(payload.products.length).toBeGreaterThan(0);
  expect(payload.products[0]).not.toHaveProperty('cost_price');
  expect(errors).toEqual([]);
});

test('Milestone 5 API-key UI reveals a secret once', async ({ page }) => {
  await login(page);
  await page.evaluate(() => window.InventiaCore.router.navigate('integrations', 'api-keys'));
  await page.getByRole('button', { name: 'Create API key' }).click();
  await page.locator('#m5CreateForm input[name="name"]').fill(`E2E API ${Date.now()}`);
  await page.getByRole('button', { name: 'Create key' }).click();
  await expect(page.locator('#m5CreateForm code')).toContainText('inv_');
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#m5WorkspaceTable')).toContainText('E2E API');
  await expect(page.locator('#m5WorkspaceTable')).not.toContainText(/inv_[A-Za-z0-9_-]{20}/);
});
