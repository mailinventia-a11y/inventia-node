import { expect, test } from '@playwright/test';

async function loginAndEnableDocumentEngine(page) {
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
    await window.InventiaCore.api.put('/feature-flags/document_engine_v2', { enabled: true, configuration: {} });
    await window.InventiaCore.initializeAuthenticated();
  });
}

test('Milestone 2 document workspaces are routed, feature-gated, and use the shared shell', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await loginAndEnableDocumentEngine(page);

  const featureEntries = page.locator('[data-feature="document_engine_v2"]');
  await expect(featureEntries).toHaveCount(3);
  for (const [module, view, title] of [
    ['trade', 'pro-forma-invoices', 'Pro Forma Invoices'],
    ['documents', 'credit-notes', 'Credit Notes'],
    ['documents', 'debit-notes', 'Debit Notes']
  ]) {
    await page.evaluate(([routeModule, routeView]) => window.InventiaCore.router.navigate(routeModule, routeView), [module, view]);
    await expect(page).toHaveURL(new RegExp(`workspace=${module}.*view=${view}`));
    await expect(page.locator('#milestone1-workspace')).toHaveClass(/active/);
    await expect(page.locator('#m1WorkspaceTitle')).toHaveText(title);
    await expect(page.locator(`[data-module="${module}"][data-view="${view}"]`)).toHaveClass(/active/);
  }

  await page.getByRole('button', { name: 'New Debit note' }).click();
  await expect(page.locator('#m2FiscalForm')).toBeVisible();
  await expect(page.locator('#m2FiscalForm .action-btn.primary')).toHaveText('Save draft');
  expect(errors).toEqual([]);
});
