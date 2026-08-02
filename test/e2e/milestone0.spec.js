import { expect, test } from '@playwright/test';

test('application shell, authenticated session, and modular core initialize together', async ({ page, request }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  const status = await request.get('/api/status');
  expect(status.ok()).toBeTruthy();

  await page.goto('/');
  await expect(page).toHaveTitle(/Inventia/i);
  await expect(page.locator('#loginContainer')).toBeVisible();
  await page.locator('#loginOrganization').fill('northwind-interiors');
  await page.locator('#loginUsername').fill('admin');
  await page.locator('#loginPassword').fill('admin123');
  await page.getByRole('button', { name: /sign in/i }).click();

  await expect(page.locator('#loginContainer')).toBeHidden();
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('[data-tab="dashboard"]')).toHaveClass(/active/);

  await page.waitForFunction(() => window.InventiaCore?.store?.getState().ready === true);
  const coreState = await page.evaluate(() => {
    const state = window.InventiaCore.store.getState();
    return {
      authenticated: state.authenticated,
      frontendModules: state.featureFlags.frontend_modules?.enabled,
      settingsNamespaces: Object.keys(state.settings)
    };
  });
  expect(coreState.authenticated).toBe(true);
  expect(coreState.frontendModules).toBe(true);
  expect(coreState.settingsNamespaces).toContain('organization');
  expect(coreState.settingsNamespaces).toContain('documents');
  expect(pageErrors).toEqual([]);
});
