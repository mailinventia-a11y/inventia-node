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
    for (const key of ['finance_v2', 'reminders_v2', 'projects_v2']) {
      await window.InventiaCore.api.put(`/feature-flags/${key}`, { enabled: true, configuration: {} });
    }
    await window.InventiaCore.initializeAuthenticated();
  });
}

test('Milestone 3 finance foundation loads authoritative accounts and journals', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page);

  await page.evaluate(() => window.InventiaCore.router.navigate('finance', 'overview'));
  await expect(page).toHaveURL(/workspace=finance.*view=overview/);
  await expect(page.locator('#finance')).toHaveClass(/active/);
  await expect(page.locator('#financeAccountsTable tr')).toHaveCount(9);
  await expect(page.locator('#financeJournalsTable')).not.toContainText('Unable to load');
  await expect(page.locator('#financeIncome')).toContainText('₹');

  const reconciliation = await page.evaluate(() => window.InventiaCore.api.get('/finance/reconciliation'));
  expect(reconciliation).toHaveProperty('reconciled');
  expect(reconciliation.receivable_variance_minor).toBe(0);
  expect(reconciliation.bank_variance_minor).toBe(0);
  expect(errors).toEqual([]);
});

test('Milestone 3 payment links, reminders, and projects use routed feature-gated workspaces', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page);

  for (const [module, view, title] of [
    ['finance', 'payment-links', 'Payment Links'],
    ['reminders', 'overview', 'Reminders'],
    ['projects', 'overview', 'Projects']
  ]) {
    await page.evaluate(([routeModule, routeView]) => window.InventiaCore.router.navigate(routeModule, routeView), [module, view]);
    await expect(page).toHaveURL(new RegExp(`workspace=${module}.*view=${view}`));
    await expect(page.locator('#milestone3-workspace')).toHaveClass(/active/);
    await expect(page.locator('#m3WorkspaceTitle')).toHaveText(title);
    await expect(page.locator(`[data-module="${module}"][data-view="${view}"]`)).toBeVisible();
  }

  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.locator('#m3CreateForm')).toBeVisible();
  await page.locator('#m3CreateForm input[name="name"]').fill('E2E Project');
  await page.locator('#m3CreateForm select[name="status"]').selectOption('ACTIVE');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.locator('#m3WorkspaceTable')).toContainText('E2E Project');
  expect(errors).toEqual([]);
});
