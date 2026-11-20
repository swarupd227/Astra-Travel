/**
 * The agent governance journey against the real model. Opt-in (E2E_LIVE_AGENTS=1) because it spends
 * Claude tokens: an evaluation of six cases plus one question, a few cents at list price.
 * Needs the local stack, API, worker (with ANTHROPIC_API_KEY) and workbench running.
 */
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.skip(
  process.env.E2E_LIVE_AGENTS !== '1',
  'Set E2E_LIVE_AGENTS=1 to run against the real model',
);
test.describe.configure({ mode: 'serial' });

const password = process.env.DEV_USER_PASSWORD!;

async function signIn(page: Page, username: string, path: string) {
  await page.goto(path);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
  await page.waitForURL((url) => url.origin === 'http://localhost:3000');
}

async function expectAccessible(page: Page) {
  // Next.js dev mode keeps connections open, so wait for the rendered page rather than network idle.
  await page.getByRole('heading', { level: 1 }).first().waitFor();
  await page.waitForLoadState('load');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

test('a governance lead releases the Copilot only after a passed evaluation', async ({ page }) => {
  test.setTimeout(10 * 60_000);
  await signIn(page, 'ai.governance.lead', '/agents/AG-10');
  await expect(page.getByRole('heading', { level: 1, name: 'Operations Copilot' })).toBeVisible();
  await expectAccessible(page);

  const warrantButton = page.getByRole('button', { name: /^(Set|Change) warrant$/ });
  if ((await warrantButton.textContent())?.startsWith('Set')) {
    await warrantButton.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /Start from the warrant proposed/ }).click();
    await dialog.getByLabel('Reason').fill('Adopt the proposed warrant for the local environment');
    await dialog.getByRole('button', { name: 'Save warrant' }).click();
    await expect(dialog.getByText(/Warrant version \d+ is now in force/)).toBeVisible();
    await page.keyboard.press('Escape');
  }

  const budgetButton = page.getByRole('button', { name: /^(Set|Change) budget$/ });
  if ((await budgetButton.textContent())?.startsWith('Set')) {
    await budgetButton.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Monthly limit (USD)').fill('25');
    await dialog.getByLabel('Reason').fill('Local development budget');
    await dialog.getByRole('button', { name: 'Save budget' }).click();
    await expect(dialog.getByText('Budget saved.')).toBeVisible();
    await page.keyboard.press('Escape');
  }

  const pending = page
    .getByRole('row')
    .filter({ has: page.getByText('Pending') })
    .first();
  if (await pending.count()) {
    await pending.getByRole('button', { name: 'Evaluate' }).click();
    await expect(page.getByText('Evaluation started.')).toBeVisible();
    // The page refreshes itself while the evaluation runs against the real model.
    await expect(page.getByText(/^(Passed|Failed)$/).first()).toBeVisible({ timeout: 8 * 60_000 });
    await expect(page.getByText('Passed').first()).toBeVisible();
    await pending.getByRole('button', { name: 'Decide' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Reason').fill('Evaluation passed every case');
    await dialog.getByRole('button', { name: 'Approve' }).click();
    // Approval re-renders the versions table (the dialog's row is no longer pending); the page's live
    // notice is the confirmation.
    await expect(page.getByText(/Version \d+ is live/)).toBeVisible({ timeout: 30_000 });
  }
  await page.reload();
  await expect(page.getByText(/Version \d+ is live/)).toBeVisible();
});

test('a service representative gets an answer grounded in platform records', async ({ page }) => {
  test.setTimeout(4 * 60_000);
  await signIn(page, 'service.rep', '/copilot');
  await expect(page.getByText(/Version \d+ live/)).toBeVisible();
  await expectAccessible(page);
  await page
    .getByLabel('Your question')
    .fill('Which accounts are still in onboarding? Give their codes.');
  await page.getByRole('button', { name: 'Send question' }).click();
  await expect(page.getByText('Looking up accounts')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole('link', { name: 'View run record' })).toBeVisible({
    timeout: 3 * 60_000,
  });
  await expect(page.getByText('SANDBOX-AIR')).toBeVisible();
  await page.screenshot({ path: 'test-results/copilot-answer.png', fullPage: true });

  await page.getByRole('link', { name: 'View run record' }).click();
  // The first visit compiles the route in development mode.
  await expect(page.getByRole('heading', { level: 1, name: 'Run record' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText('Warrant applied')).toBeVisible();
  await expectAccessible(page);
  await page.screenshot({ path: 'test-results/run-record.png', fullPage: true });
});
