import { expect, test } from '@playwright/test';

async function login(page) {
  await page.goto('/');
  await page.locator('#loginOrganization').fill('northwind-interiors');
  await page.locator('#loginUsername').fill('admin');
  await page.locator('#loginPassword').fill('admin123');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.locator('#loginContainer')).toBeHidden();
  await page.waitForFunction(() => window.InventiaCore?.store?.getState().ready === true);
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
