/**
 * Increment 11 journey: a service representative previews a correction and a cancellation on a policy, sees the
 * price and the rule behind it, and confirms. It needs a bound policy in the development database (see
 * apps/api/test/seed-synthetic-stack.int.test.ts); without one the test is skipped. The last step cancels
 * that policy, so the test uses the policy only once.
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

test('staff preview and make a correction, then preview and make a cancellation', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'One journey is enough; the screens are checked with axe here.');
  test.setTimeout(600_000);

  await signIn(page, 'service.rep', '/policies');
  await expect(page.getByRole('heading', { name: 'Policies', level: 1 })).toBeVisible({
    timeout: 90_000,
  });
  const active = page.getByRole('row').filter({ hasText: 'ATP-' }).filter({ hasText: 'Active' });
  test.skip((await active.count()) === 0, 'Seed a bound policy first');
  await active.first().getByRole('link').click();
  const service = page.getByRole('button', { name: 'Change or cancel' });
  await expect(service).toBeVisible({ timeout: 60_000 });
  await expectAccessible(page);
  await service.click();
  await expect(page.getByRole('heading', { name: 'Service this policy' })).toBeVisible();

  // A correction is previewed (no price change) and made with a reason.
  await page.getByLabel('What do you want to do?').selectOption('correct');
  await page.getByLabel('Purchaser email').fill('corrected@example.com');
  await page.getByLabel('Reason').fill('Email typed wrongly at purchase');
  await page.getByRole('button', { name: 'Show what this would do' }).click();
  await expect(page.getByRole('heading', { name: 'What would change' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText('The premium does not change.')).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Confirm at this price' }).click();
  await expect(page.getByText('was made and recorded in the history below')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText('Email typed wrongly at purchase').first()).toBeVisible();

  // A cancellation shows the rule that decides the refund, then is made.
  await service.click();
  await page.getByLabel('What do you want to do?').selectOption('cancel');
  await page.getByLabel('The traveller has had no loss that would lead to a claim.').check();
  await page.getByLabel('Reason').fill('Traveller changed their mind');
  await page.getByRole('button', { name: 'Show what this would do' }).click();
  await expect(page.getByRole('heading', { name: 'What would change' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText(/full premium is refunded|non-refundable/).first()).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Confirm at this price' }).click();
  await expect(page.getByText('Cancelled').first()).toBeVisible({ timeout: 60_000 });
  await expect(service).toHaveCount(0);
  await expect(
    page
      .getByRole('link', { name: 'Notice of Cancellation' })
      .or(page.getByRole('link', { name: /cancellation/i }))
      .first(),
  ).toBeVisible();
  await expectAccessible(page);

  // The agent-change sample renders.
  await signIn(page, 'ops.supervisor', '/servicing/agent-sample');
  await expect(
    page.getByRole('heading', { name: 'Changes made by the servicing agent', level: 1 }),
  ).toBeVisible({ timeout: 60_000 });
  await expectAccessible(page);
});
