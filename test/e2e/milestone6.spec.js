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

test('Milestone 6 unified report centre is keyboard-addressable and semantic', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page);
  await page.evaluate(() => window.InventiaCore.router.navigate('insights', 'analytics'));
  await expect(page).toHaveURL(/workspace=insights.*view=analytics/);
  await expect(page.locator('#milestone6-workspace')).toHaveClass(/active/);
  await expect(page.locator('#m6ReportSelect option')).toHaveCount(8);
  await page.locator('#m6ReportSelect').selectOption('audit');
  await page.getByRole('button', { name: 'Run report' }).click();
  await expect(page.locator('#m6ReportTitle')).toHaveText('Audited Activity');
  await expect(page.locator('#m6ReportTable table')).toBeVisible();
  await expect(page.locator('#m6ReportTable caption')).toHaveText('Audited Activity');
  await expect(page.locator('#m6ReportTable th[scope="col"]')).not.toHaveCount(0);
  await page.locator('#m6ReportSelect').focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('m6ReportFrom');
  expect(errors).toEqual([]);
});

test('Milestone 6 authenticated CSV export returns authoritative report data', async ({ page }) => {
  await login(page);
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/v1/reports/audit/export', { headers: { authorization: `Bearer ${localStorage.getItem('phase5AccessToken')}` } });
    return { ok: response.ok, type: response.headers.get('content-type'), disposition: response.headers.get('content-disposition'), text: await response.text() };
  });
  expect(result.ok).toBe(true);
  expect(result.type).toContain('text/csv');
  expect(result.disposition).toContain('inventia-audit');
  expect(result.text).toContain('request_id');
});
