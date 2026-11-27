/**
 * The AI model connection screen: a platform administrator saves and removes a key. The key is invented and the test
 * never presses "Test connection", so nothing is sent to the model service (the API tests cover that against a
 * stand-in). Skipped when a key is already saved, so it can never erase a real one. Needs DEV_USER_PASSWORD.
 */
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const password = process.env.DEV_USER_PASSWORD;
const INVENTED_KEY = 'invented-key-for-the-browser-test-0000-WXYZ';

async function signIn(page: Page, username: string, path = '/') {
  if (!password) throw new Error('DEV_USER_PASSWORD must be set (from .env)');
  await page.context().clearCookies();
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

test('AI model connection: a key is saved, shown only by its end, and removed', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'One journey is enough; the screen is checked with axe here.');
  test.setTimeout(600_000);
  await signIn(page, 'platform.admin', '/admin/model');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('AI model connection', {
    timeout: 120_000,
  });
  const saved = page.getByRole('region', { name: 'Saved key' });
  test.skip(
    (await saved.getByText('Not saved', { exact: true }).count()) === 0,
    'A key is saved in this database; it is left alone.',
  );
  await expectAccessible(page);

  const key = page.getByLabel('API key');
  await expect(key).toHaveAttribute('type', 'password');
  await key.fill(INVENTED_KEY);
  await page.getByLabel('Reason for saving').fill('Browser test');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByText('Saved. Agents use this key from their next request.')).toBeVisible({
    timeout: 60_000,
  });
  await expect(saved.getByText('••••WXYZ')).toBeVisible();
  await expect(key).toHaveValue('');
  expect(await page.content()).not.toContain(INVENTED_KEY);
  await expectAccessible(page);
  // A picture of the screen, when someone asks for one.
  if (process.env.E2E_SCREENSHOT) {
    await page.screenshot({ path: process.env.E2E_SCREENSHOT, fullPage: true });
  }

  await saved.getByRole('button', { name: 'Remove' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove the saved key' });
  await dialog.getByLabel('Reason').fill('Browser test finished');
  await dialog.getByRole('button', { name: 'Remove key' }).click();
  await expect(saved.getByText('Not saved', { exact: true })).toBeVisible({ timeout: 60_000 });
});

test('AI model connection is closed to other roles', async ({ page, isMobile }) => {
  test.skip(isMobile, 'One check is enough.');
  test.setTimeout(300_000);
  await signIn(page, 'ai.governance.lead', '/admin/model');
  await expect(page.getByText('You don’t have access to this page')).toBeVisible({
    timeout: 120_000,
  });
});
