/**
 * Increment 9 journey: staff look at quotes and policies. It needs a quote and a policy, which exist after the
 * synthetic stack has been seeded (see apps/api/test/seed-synthetic-stack.int.test.ts); without them the test
 * is skipped. Binding is done through the API with the payment system's confirmation, so it is not a screen.
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

test('staff review a quote, re-rate it, and read a policy as it was at a date', async ({ page, isMobile }) => {
  test.skip(isMobile, 'One journey is enough; the screens are checked with axe here.');
  test.setTimeout(600_000);

  await signIn(page, 'platform.admin', '/quotes');
  await expect(page.getByRole('heading', { name: 'Quotes', level: 1 })).toBeVisible({ timeout: 90_000 });
  test.skip((await page.getByRole('row').filter({ hasText: 'Open' }).count()) === 0, 'Seed the synthetic stack first');
  await expectAccessible(page);

  // An open quote: its price, benefits with cover dates, eligibility, versions and disclosure.
  await page.getByRole('row').filter({ hasText: 'Open' }).first().getByRole('link').click();
  await expect(page.getByText('Versions used')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Benefits and cover dates' })).toBeVisible();
  await expect(page.getByText('State disclosure')).toBeVisible();
  await expect(page.getByText('Ready to bind')).toBeVisible();
  await expectAccessible(page);

  // Ticking an optional benefit re-rates the same quote.
  const total = await page.getByRole('heading', { level: 1 }).innerText();
  await page.getByRole('checkbox', { name: /Trip Interruption/ }).check();
  await page.getByRole('button', { name: 'Re-rate' }).click();
  await expect(page.getByText('Re-rated. The quote keeps its number.')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(total, { timeout: 30_000 });

  // The new-quote form renders and is accessible.
  await page.goto('/quotes/new');
  await expect(page.getByRole('heading', { name: 'New quote', level: 1 })).toBeVisible({ timeout: 60_000 });
  await expectAccessible(page);

  // A policy: record, benefits with underwriters, history; and the record as it was before it existed.
  await page.goto('/policies');
  await expect(page.getByRole('heading', { name: 'Policies', level: 1 })).toBeVisible({ timeout: 60_000 });
  await expectAccessible(page);
  await page.getByRole('row').filter({ hasText: 'ATP-' }).first().getByRole('link').click();
  await expect(page.getByRole('heading', { name: /^ATP-\d{4}-\d{6}$/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  await expect(page.getByText(/Bound by/)).toBeVisible();
  await expect(page.getByText('Virginia Surety Company (VSC)').first()).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel('See the policy as it was on').fill('2020-01-01T00:00');
  await page.getByRole('button', { name: 'Show' }).click();
  await expect(page.getByText('The policy did not exist then')).toBeVisible({ timeout: 60_000 });
  await expectAccessible(page);
});
