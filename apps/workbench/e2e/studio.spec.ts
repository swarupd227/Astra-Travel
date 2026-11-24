/**
 * Increment 3 journeys through the real sign-in, API and database: reference data approval
 * (maker-checker), loading a form edition, the filing register and the variable map.
 * Form wording is quoted from the product specification (M1); form numbers are synthetic per run.
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

async function signOut(page: Page) {
  await page.context().clearCookies();
}

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

const FORM_TEXT = [
  'Individual Travel Policy (wording quoted in the Astra Travel specification, M1; synthetic edition for testing)',
  'You may cancel within the [ten (10) - fifteen (15)] day review period.',
  'Trip Cancellation maximum per person [$0-$5,000,000].',
  'We do not cover travel to <<insert list of countries>>.',
].join('\n');

test('reference data, a filed form and its variable map, each approved by a second person', async ({
  page,
  isMobile,
}) => {
  test.skip(
    isMobile,
    'One journey is enough; the screens are checked on mobile in the accessibility sweep.',
  );
  test.setTimeout(600_000); // several first-time page compiles in development mode
  const run = Date.now().toString(36);

  // 1. US states take effect only once a person approves them (the loader script loaded them as drafts).
  await signIn(page, 'compliance.officer', '/reference-data/us_states');
  await expect(
    page.getByRole('heading', { level: 1, name: 'US states, district and territories' }),
  ).toBeVisible({ timeout: 60_000 });
  const draft = page.getByRole('row', { name: /Draft/ }).first();
  if (await draft.isVisible()) {
    await draft.getByRole('link').click();
    await page.getByLabel('Reason').fill('Checked against USPS Publication 28, Appendix B.');
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('Version approved')).toBeVisible({ timeout: 30_000 });
  }
  await page.goto('/reference-data');
  await expect(page.getByRole('row', { name: /US states.*Version \d+ since/ })).toBeVisible();

  // 2. Load a form edition (plain text) and see its bracketed wording.
  await page.goto('/forms');
  await page.getByRole('button', { name: 'Load edition' }).click();
  const load = page.getByRole('dialog', { name: 'Load a form edition' });
  await load.getByLabel('Document').setInputFiles({
    name: `e2e_${run}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(`${FORM_TEXT}\nTest run ${run}`),
  });
  await load.getByLabel('Form number').fill(`e2e_pol_${run}`);
  await load.getByLabel('Edition').fill('2026-05');
  await load.getByLabel('Title').fill(`E2E individual policy ${run}`);
  await expectAccessible(page);
  await load.getByRole('button', { name: 'Load edition' }).click();
  await expect(page.getByText('Edition loaded')).toBeVisible({ timeout: 60_000 });
  const editionUrl = page.url().split('?')[0]!;

  // 3. Record its filing in New York, submit and approve it, then check it can be used.
  await page.getByRole('button', { name: 'Record filing' }).click();
  const rec = page.getByRole('dialog', { name: 'Record a filing' });
  await rec.getByLabel('States').fill('NY');
  await rec.getByRole('button', { name: 'Record filing' }).click();
  await expect(page.getByText('Filing recorded')).toBeVisible({ timeout: 60_000 });
  const update = async (
    change: string,
    fill: (d: ReturnType<Page['getByRole']>) => Promise<void>,
  ) => {
    await page.getByRole('button', { name: 'Update status' }).click();
    const d = page.getByRole('dialog', { name: 'Update the filing' });
    await d.getByLabel('Change').selectOption({ label: change });
    await fill(d);
    await d.getByRole('button', { name: change }).click();
    await expect(page.getByText(/^Filing (submitted|approved)$/)).toBeVisible({ timeout: 30_000 });
  };
  await update('Record submission', async (d) => {
    await d.getByLabel('Submitted on').fill('2026-01-10');
    await d.getByLabel('Reason or reference').fill('Filed through SERFF.');
  });
  await update('Record approval', async (d) => {
    await d.getByLabel('Decision date').fill('2026-02-15');
    await d.getByLabel('Effective from').fill('2026-03-01');
    await d.getByLabel('SERFF tracking number').fill(`E2E-${run}`.toUpperCase());
    await d.getByLabel('Reason or reference').fill('Approval letter received.');
  });
  await expect(page.getByText('In effect today')).toBeVisible();
  await expectAccessible(page);

  await page.goto(editionUrl);
  await page.getByRole('textbox', { name: 'State', exact: true }).fill('NY');
  await page.getByLabel('Date').fill('2026-02-28');
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByText('Approved in NY, but not in effect until 2026-03-01.')).toBeVisible({
    timeout: 30_000,
  });
  await page.getByLabel('Date').fill('2026-03-01');
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByText(/^Approved in NY from 2026-03-01/)).toBeVisible({ timeout: 30_000 });
  await signOut(page);

  // 4. A product manager builds the variable map from the suggested wording.
  await signIn(page, 'product.manager', editionUrl);
  await page.getByRole('button', { name: 'Start variable map' }).click();
  await expect(page.getByRole('heading', { name: 'Suggested from the form' })).toBeVisible({
    timeout: 30_000,
  });
  for (const expected of ['Time period', 'Numeric range']) {
    await page
      .getByRole('listitem')
      .filter({ hasText: expected })
      .getByRole('button', { name: 'Map' })
      .first()
      .click();
    const editor = page.getByRole('dialog', { name: 'Map this wording' });
    await expect(editor.getByLabel('Type')).toHaveValue(
      expected === 'Time period' ? 'time_period' : 'numeric_range',
    );
    await editor.getByRole('button', { name: 'Save variable' }).click();
    await expect(editor).toBeHidden({ timeout: 30_000 });
  }
  await expect(
    page.getByText('You built or edited this draft, so someone else must approve it.'),
  ).toBeVisible();
  await expectAccessible(page);
  await signOut(page);

  // 5. Compliance approves it.
  await signIn(page, 'compliance.officer', editionUrl);
  await page
    .getByLabel('What you checked')
    .fill('Each variable matches the filed range in the form.');
  await page.getByRole('button', { name: 'Approve map' }).click();
  await expect(page.getByText('Variable map approved')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^Approved by .+ Approved maps never change/)).toBeVisible();
});
