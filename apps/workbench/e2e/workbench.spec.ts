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
  '/card/programmes',
  '/card/master-policies',
  '/card/cover-check',
  '/forms',
  '/compliance/filings',
  '/reference-data',
  '/reference-data/us_states',
];

test('platform administrator sees every screen, and every screen is accessible', async ({
  page,
}) => {
  test.setTimeout(600_000); // nineteen full axe scans, with cold page compiles in development mode
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

test('card programme manager takes a programme live and claims cover is answered from the feed', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'One journey is enough; the screens are checked on mobile above.');
  test.setTimeout(240_000);
  const suffix = Date.now().toString(36).toUpperCase();
  const code = `E2E-${suffix}`;
  await signIn(page, 'card.programme.manager', '/card/master-policies');

  await page.getByRole('button', { name: 'Register master policy' }).click();
  const mp = page.getByRole('dialog', { name: 'Register a master policy' });
  await mp.getByLabel('Policyholder').selectOption({ label: 'Sandbox Bank (synthetic)' });
  await mp.getByLabel('Policy number').fill(`MP-${code}`);
  await mp.getByLabel('States').fill('NY, CA');
  await mp.getByLabel('Effective from').fill('2025-01-01');
  await expectAccessible(page);
  await mp.getByRole('button', { name: 'Register master policy' }).click();
  await expect(mp.getByText('Master policy registered.')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape');

  await page.goto('/card/programmes');
  await page.getByRole('button', { name: 'Set up programme' }).click();
  const setup = page.getByRole('dialog', { name: 'Set up a card programme' });
  await setup
    .getByLabel('Master policy')
    .selectOption({ label: `MP-${code} · Sandbox Bank (synthetic)` });
  await setup.getByLabel('Programme name').fill(`E2E card cover ${suffix}`);
  await setup.getByLabel('Programme code').fill(code);
  await setup.getByLabel('Card product').fill('Platinum Visa');
  await setup.getByLabel('Effective from').fill('2025-01-01');
  await setup.getByLabel('Payment condition').selectOption('partial');
  await setup.getByLabel('Minimum share paid with the card (%)').fill('50');
  await expectAccessible(page);
  await setup.getByRole('button', { name: 'Set up programme' }).click();
  await expect(page.getByText('Programme set up')).toBeVisible({ timeout: 30_000 });

  const feed = (seq: number, mode: 'test' | 'live', lines: string[]) => ({
    name: `${mode}-${seq}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(
      [
        `H|ASTRA-ELIG|1|${code}|${seq}|FULL|2026-11-01`,
        ...lines,
        `T|${lines.length}|${lines.length}|0|0`,
        '',
      ].join('\n'),
    ),
  });
  const upload = async (file: ReturnType<typeof feed>, mode: 'test' | 'live') => {
    await page.getByLabel('Feed file').setInputFiles(file);
    await page.getByRole('radio', { name: mode === 'test' ? /^Test/ : /^Live/ }).check();
    await page.getByRole('button', { name: 'Upload feed' }).click();
    await expect(page.getByText(/received and queued/)).toBeVisible({ timeout: 30_000 });
  };

  await upload(feed(1, 'test', ['D|tok_e2e_1|PLAT|A|2025-01-01|']), 'test');
  // The worker processes the feed; reload until the result shows.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('A test feed has passed. The programme can go live.')).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Go live' }).click();
  const live = page.getByRole('dialog', { name: 'Take the programme live' });
  await live.getByLabel('Reason').fill('Test feed passed; go-live approved in e2e.');
  await live.getByRole('button', { name: 'Go live' }).click();
  await expect(page.getByText('The programme is live', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await upload(
    feed(1, 'live', ['D|tok_e2e_1|PLAT|A|2025-01-01|', 'D|tok_e2e_2|GOLD|A|2025-01-01|2026-06-30']),
    'live',
  );
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('row', { name: /#1 Full.*Applied/ })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 60_000 });
  await expectAccessible(page);

  await page.goto('/card/cover-check');
  await page.getByLabel('Programme').selectOption({ label: `E2E card cover ${suffix} (${code})` });
  await page.getByLabel('Account reference').fill('tok_e2e_2');
  await page.getByLabel('Trip purchase date').fill('2026-05-01');
  await page.getByLabel('Loss date').fill('2026-05-20');
  await page.getByLabel('Trip cost (USD)').fill('1800');
  await page.getByLabel('Paid with the card (USD)').fill('900');
  await page.getByRole('button', { name: 'Verify cover' }).click();
  await expect(page.getByText('Covered', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(new RegExp(`certificate ${code}-\\d{9}`))).toBeVisible();
  await expectAccessible(page);

  await page.getByLabel('Trip purchase date').fill('2026-07-01');
  await page.getByLabel('Loss date').fill('2026-07-10');
  await page.getByRole('button', { name: 'Verify cover' }).click();
  await expect(page.getByText('Not covered', { exact: true })).toBeVisible({ timeout: 30_000 });
});
