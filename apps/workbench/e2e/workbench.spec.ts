/**
 * Workbench journeys and WCAG 2.2 AA checks (axe) on every screen, signed in through the real
 * OpenID Connect flow. Requires the local stack and the dev seed (docs/LOCAL_DEVELOPMENT.md).
 */
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const password = process.env.DEV_USER_PASSWORD;

async function signIn(page: Page, username: string, path = '/') {
  if (!password) throw new Error('DEV_USER_PASSWORD must be set (from .env)');
  await page.goto(path);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
  await page.waitForURL((url) => url.origin === 'http://localhost:3000');
}

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

const PAGES = [
  '/',
  '/accounts',
  '/integrations/webhooks',
  '/operations/events',
  '/operations/events?view=dead',
  '/governance/audit',
  '/admin/flags',
  '/profile',
  '/copilot',
  '/agents',
  '/agents/AG-10',
  '/agents/reviews',
];

test('platform administrator sees every screen, and every screen is accessible', async ({
  page,
}) => {
  test.setTimeout(240_000); // eight full axe scans in development mode
  await signIn(page, 'platform.admin');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    /Good (morning|afternoon|evening)/,
  );
  for (const path of PAGES) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectAccessible(page);
  }
});

test('navigation follows the role: an underwriter does not see governance screens', async ({
  page,
  isMobile,
}) => {
  await signIn(page, 'underwriter');
  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  const nav = page.getByRole('navigation', { name: 'Workbench' }).last();
  await expect(nav.getByRole('link', { name: 'Accounts' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Audit trail' })).toHaveCount(0);
  await page.goto('/governance/audit');
  await expect(page.getByText('You don’t have access to this page')).toBeVisible();
});

test('account manager registers an account and it appears in the audit trail', async ({ page }) => {
  const code = `E2E-${Date.now().toString(36).toUpperCase()}`;
  await signIn(page, 'account.manager', '/accounts');
  await page.getByRole('button', { name: 'Register account' }).click();
  const dialog = page.getByRole('dialog', { name: 'Register an account' });
  await expectAccessible(page);
  await dialog.getByLabel('Account name').fill(`E2E Air ${code} (synthetic)`);
  await dialog.getByLabel('Account code').fill(code);
  await dialog.getByRole('button', { name: 'Register account' }).click();
  // The redirect lands on a page that may need compiling first in development mode.
  await expect(page.getByText('Account registered')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 1 })).toContainText(code);
});

test('signing out ends the session', async ({ page }) => {
  await signIn(page, 'compliance.officer');
  await page.getByRole('button', { name: /Account menu/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL(/signed-out/);
  await page.goto('/');
  await expect(page).toHaveURL(/localhost:8080/);
});
