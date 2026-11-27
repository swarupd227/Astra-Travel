/**
 * Increment 12 journey: a finance analyst proposes a commission rule, a compliance officer approves it, and the
 * premium records and batches screens work. Records themselves come from binds and servicing (the API), so this
 * journey does not need any; it needs an account in the development database.
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
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

test('a commission rule is proposed, approved by someone else, and the billing screens work', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'One journey is enough; the screens are checked with axe here.');
  test.setTimeout(600_000);

  await signIn(page, 'finance.analyst', '/billing/rules');
  await expect(
    page.getByRole('heading', { name: 'Commission and programme rules', level: 1 }),
  ).toBeVisible({ timeout: 90_000 });
  const account = page.getByLabel('Account');
  test.skip((await account.locator('option').count()) === 0, 'Register an account first');
  await expectAccessible(page);
  await page.getByLabel('Effective from').first().fill('2026-01-01');
  await page.getByLabel('Percent').fill('10');
  await page.getByRole('button', { name: 'Propose this rule' }).click();
  await expect(
    page.getByText('The rule is proposed. Someone else approves it before it applies.'),
  ).toBeVisible({ timeout: 60_000 });
  // The maker is not offered the approval.
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);

  await signIn(page, 'compliance.officer', '/billing/rules');
  await expect(page.getByRole('heading', { name: 'Commission rules', level: 2 })).toBeVisible({
    timeout: 60_000,
  });
  await page
    .getByRole('row')
    .filter({ hasText: 'Draft' })
    .first()
    .getByRole('button', { name: 'Approve' })
    .click();
  // The approved rule leaves the drafts: its row now says Approved.
  await expect(page.getByRole('row').filter({ hasText: 'Approved' }).first()).toBeVisible({
    timeout: 60_000,
  });
  await expectAccessible(page);

  await signIn(page, 'finance.analyst', '/billing');
  await expect(page.getByRole('heading', { name: 'Premium records', level: 1 })).toBeVisible({
    timeout: 60_000,
  });
  await expectAccessible(page);

  await page.goto('/billing/batches');
  await expect(
    page.getByRole('heading', { name: 'Batches sent to billing', level: 1 }),
  ).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Collect ready records into a batch' }).click();
  await expect(page.getByText(/No premium record is ready to send|Batch made with/)).toBeVisible({
    timeout: 60_000,
  });
  await expectAccessible(page);
});
