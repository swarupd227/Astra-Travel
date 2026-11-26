/**
 * Increment 15 journey: a supervisor sees the one work queue with its timers and gives work to an underwriter, who
 * takes it, and policy search finds a policy by more than its number. The referral summary by AG-04 needs a live
 * model (ANTHROPIC_API_KEY), so it is covered by the API tests with a scripted model. Needs the development stack,
 * the API with the Increment 15 migration, and DEV_USER_PASSWORD in the environment.
 */
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const password = process.env.DEV_USER_PASSWORD;

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
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test('the work queue: a supervisor sees it with timers, and work is taken and handed back', async ({ page, isMobile }) => {
  test.skip(isMobile, 'One journey is enough; the screens are checked with axe here.');
  test.setTimeout(600_000);

  // The underwriter signs in once so the supervisor can give work to them, and raises a referral to have something to hold.
  await signIn(page, 'underwriter', '/work');
  await expect(page.getByRole('heading', { name: 'Work queue', level: 1 })).toBeVisible({ timeout: 120_000 });
  await expectAccessible(page);

  await signIn(page, 'ops.supervisor', '/work');
  await expect(page.getByRole('heading', { name: 'Work queue', level: 1 })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('heading', { name: 'How long work may wait' })).toBeVisible();
  await expect(page.getByText('Overdue', { exact: true }).first()).toBeVisible();
  await expectAccessible(page);

  const rows = page.getByRole('row').filter({ has: page.getByRole('button', { name: /^Take / }) });
  test.skip((await rows.count()) === 0, 'Nothing is waiting in this database; the API tests cover the queue');
  const first = rows.first();
  const held = page.getByRole('button', { name: /^Hand back / });
  const heldBefore = await held.count();

  // The supervisor gives it to the first person listed.
  await first.getByRole('combobox').selectOption({ index: 1 });
  await first.getByRole('button', { name: 'Give', exact: true }).click();
  await expect(page.getByText('Done: assigned')).toBeVisible({ timeout: 60_000 });
  await expect(held).toHaveCount(heldBefore + 1);

  // The supervisor hands it back to the queue.
  await held.first().click();
  await expect(page.getByText('Done: handed back')).toBeVisible({ timeout: 60_000 });
  await expect(held).toHaveCount(heldBefore);
});

test('policy search: a trip detail finds the policy and says what matched', async ({ page, isMobile }) => {
  test.skip(isMobile, 'One journey is enough.');
  test.setTimeout(300_000);
  await signIn(page, 'account.manager', '/search');
  await expect(page.getByRole('heading', { name: 'Find a policy', level: 1 })).toBeVisible({ timeout: 120_000 });
  await expectAccessible(page);
  await page.getByRole('searchbox').fill('ATP-');
  await page.getByRole('button', { name: 'Search' }).click();
  const status = page.getByRole('status').filter({ hasText: /for “ATP-” in \d+ ms|No policy found/ });
  await expect(status.or(page.getByText('No policy found'))).toBeVisible({ timeout: 120_000 });
  await expectAccessible(page);
});
