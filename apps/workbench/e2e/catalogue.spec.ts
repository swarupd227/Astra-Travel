/**
 * Increment 4 journey: a benefit catalogue built on a schedule's approved variable map, approved by a
 * second person. The schedule is synthetic (amounts invented for the test, unique per run).
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

test('a benefit catalogue is built on the approved variable map and approved by a second person', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'One journey is enough; the screen is checked with axe here.');
  test.setTimeout(600_000);
  const run = Date.now().toString(36);
  const schedule = [
    `SCHEDULE OF BENEFITS (synthetic test schedule, run ${run})`,
    'Accident and Sickness Medical Expense [$10,000-$500,000] per person',
    'Dental [$100-$1,000]',
  ].join('\n');

  // Compliance loads the schedule.
  await signIn(page, 'compliance.officer', '/forms');
  await page.getByRole('button', { name: 'Load edition' }).click();
  const load = page.getByRole('dialog', { name: 'Load a form edition' });
  await load.getByLabel('Document').setInputFiles({
    name: `sch_${run}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(schedule),
  });
  await load.getByLabel('Form number').fill(`e2e_sch_${run}`);
  await load.getByLabel('Edition').fill('2026-04');
  await load.getByLabel('Title').fill(`E2E schedule ${run}`);
  await load.getByLabel('Kind').selectOption('schedule');
  await load.getByRole('button', { name: 'Load edition' }).click();
  await expect(page.getByText('Edition loaded')).toBeVisible({ timeout: 60_000 });
  const editionUrl = page.url().split('?')[0]!;

  // The product manager maps the two amounts.
  await signIn(page, 'product.manager', editionUrl);
  await page.getByRole('button', { name: 'Start variable map' }).click();
  await expect(page.getByRole('heading', { name: 'Suggested from the form' })).toBeVisible({
    timeout: 30_000,
  });
  for (let i = 0; i < 2; i++) {
    await page
      .getByRole('listitem')
      .filter({ hasText: 'Numeric range' })
      .getByRole('button', { name: 'Map' })
      .first()
      .click();
    const editor = page.getByRole('dialog', { name: 'Map this wording' });
    await editor.getByRole('button', { name: 'Save variable' }).click();
    await expect(editor).toBeHidden({ timeout: 30_000 });
  }

  // Compliance approves the map.
  await signIn(page, 'compliance.officer', editionUrl);
  await page.getByLabel('What you checked').fill('Both amounts match the schedule.');
  await page.getByRole('button', { name: 'Approve map' }).click();
  await expect(page.getByText('Variable map approved')).toBeVisible({ timeout: 30_000 });

  // The product manager builds the catalogue.
  await signIn(page, 'product.manager', `${editionUrl}/catalogue`);
  await page.getByRole('button', { name: 'Start the catalogue' }).click();
  await expect(page.getByRole('heading', { name: /^Benefits/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Add' }).first().click();
  const b = page.getByRole('dialog', { name: 'Add a benefit' });
  await b
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('Accident and Sickness Medical Expense');
  await b.getByLabel('Group').selectOption('medical_evacuation');
  await b
    .getByRole('group', { name: 'Maximum benefit' })
    .getByLabel('Amount')
    .selectOption('schedule:v_10_000_500_000');
  await b.getByRole('button', { name: 'Add sub-limit' }).click();
  await b.getByLabel('Sub-limit name').fill('Dental');
  await b
    .getByRole('group', { name: 'Sub-limit amount' })
    .getByLabel('Amount')
    .selectOption('schedule:v_100_1_000');
  await expectAccessible(page);
  await b.getByRole('button', { name: 'Save' }).click();
  await expect(b).toBeHidden({ timeout: 30_000 });
  await expect(
    page.getByText(/Dental: \$100–\$1,000, per person \(included in the maximum\)/),
  ).toBeVisible();
  await expect(
    page.getByText('You built or edited this draft, so someone else must approve it.'),
  ).toBeVisible();
  await expectAccessible(page);

  // Compliance approves it.
  await signIn(page, 'compliance.officer', `${editionUrl}/catalogue`);
  await page
    .getByLabel('What you checked')
    .fill('The benefit and its sub-limit match the schedule.');
  await page.getByRole('button', { name: 'Approve catalogue' }).click();
  await expect(page.getByText('Catalogue approved')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Version 1, approved')).toBeVisible();
});
