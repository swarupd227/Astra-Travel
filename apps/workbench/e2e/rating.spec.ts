/**
 * Increment 5a journey: load a rate manual, approve it as a second person, and rate a trip with the full
 * worksheet. The manual is the test fixture holding only values the specification quotes (not the filed
 * manual), under a synthetic code per run.
 */
import Decimal from 'decimal.js';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { SPEC_QUOTED_DE_TCAN } from '@astra/rating/fixtures';

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

test('a rate manual is loaded, approved by a second person and used to rate a trip', async ({
  page,
  isMobile,
}) => {
  test.skip(
    isMobile,
    'One journey is enough; the screens are checked on mobile in the accessibility sweep.',
  );
  test.setTimeout(600_000);
  const code = `E2E-DE-TC-${Date.now().toString(36).toUpperCase()}`;
  const expected = new Decimal('1.475')
    .mul(42)
    .mul(
      ['0.72', '1.288', '0.768', '1', '1.6286', '1.3333', '1.28'].reduce(
        (a, f) => a.mul(f),
        new Decimal(1),
      ),
    )
    .toFixed(2, Decimal.ROUND_HALF_UP);

  await signIn(page, 'rating.analyst', '/rating/manuals');
  await page.getByRole('button', { name: 'Load manual' }).click();
  const dialog = page.getByRole('dialog', { name: 'Load a rate manual' });
  await dialog.getByLabel('Manual file (JSON)').setInputFiles({
    name: 'manual.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...SPEC_QUOTED_DE_TCAN, perilPackage: null })),
  });
  await dialog.getByLabel('Manual code').fill(code);
  await dialog.getByLabel('Effective from').fill('2026-01-01');
  await dialog.getByRole('textbox', { name: 'State', exact: true }).fill('DE');
  await dialog.getByLabel('Benefit').fill('TCAN');
  await dialog
    .getByLabel('Source')
    .fill('Test fixture: values quoted in the specification (not the filed manual)');
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Load manual' }).click();
  await expect(page.getByText('Manual loaded')).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByText('You loaded this manual, so another rating analyst must approve it.'),
  ).toBeVisible();
  await expect(page.getByText('No loss cost multiplier')).toBeVisible();
  const manualUrl = page.url().split('?')[0]!;
  await expectAccessible(page);

  await signIn(page, 'compliance.officer', manualUrl);
  await page.getByLabel('What you checked').fill('Tables checked against the quoted values.');
  await page.getByRole('button', { name: 'Approve manual' }).click();
  await expect(page.getByText('Manual approved')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('No filing is recorded for DE.')).toBeVisible();

  await page.goto('/rating/calculator');
  await page
    .getByLabel('Manual')
    .selectOption({ label: `Preview: ${code} v1 (DE TCAN, approved)` });
  await page.getByLabel('Rate date').fill('2026-11-01');
  await page.getByRole('textbox', { name: 'Age', exact: true }).fill('45');
  await page.getByLabel('Pre-existing exclusion waived').selectOption('yes');
  await page.getByLabel('Trip cost per traveller').fill('4200');
  await page.getByLabel('Purchase date').fill('2026-11-21');
  await page.getByLabel('Departure date').fill('2026-12-11');
  await page.getByLabel('Return date').fill('2026-12-20');
  await page.getByLabel('Full-penalty point (days before departure)').fill('60');
  await page.getByLabel('Destination region').fill('Europe');
  await page.getByLabel('Business segment').fill('OTA - Cruise');
  await page.getByLabel('Package type').selectOption('optional');
  await page.getByRole('button', { name: 'Rate' }).click();
  await expect(page.getByText(`$${expected}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Loss cost (no multiplier filed)')).toBeVisible();
  await expect(page.getByText('Preview of an unpublished version')).toBeVisible();
  await expect(
    page.getByRole('row', { name: /Days before departure at purchase 0\.768 2\.1\.8 · from 15/ }),
  ).toBeVisible();
  await expectAccessible(page);
});
