/**
 * Increment 6 journey: a base plan built from an approved benefit catalogue, its values checked against the
 * filed ranges as they are entered, approved by a second person; then a state plan whose publication checks
 * list what is missing. The schedule is synthetic (amounts invented for the test, unique per run).
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

/** Loads a schedule, maps its amounts, builds and approves a one-benefit catalogue; returns the edition URL. */
async function approvedCatalogue(page: Page, run: string) {
  const schedule = [`SCHEDULE OF BENEFITS (synthetic test schedule, run ${run})`, 'Accident and Sickness Medical Expense [$10,000-$500,000] per person'].join('\n');
  await signIn(page, 'compliance.officer', '/forms');
  await page.getByRole('button', { name: 'Load edition' }).click();
  const load = page.getByRole('dialog', { name: 'Load a form edition' });
  await load.getByLabel('Document').setInputFiles({ name: `sch_${run}.txt`, mimeType: 'text/plain', buffer: Buffer.from(schedule) });
  await load.getByLabel('Form number').fill(`e2e_plan_${run}`);
  await load.getByLabel('Edition').fill('2026-04');
  await load.getByLabel('Title').fill(`E2E plan schedule ${run}`);
  await load.getByLabel('Kind').selectOption('schedule');
  await load.getByRole('button', { name: 'Load edition' }).click();
  await expect(page.getByText('Edition loaded')).toBeVisible({ timeout: 60_000 });
  const editionUrl = page.url().split('?')[0]!;

  await signIn(page, 'product.manager', editionUrl);
  await page.getByRole('button', { name: 'Start variable map' }).click();
  await expect(page.getByRole('heading', { name: 'Suggested from the form' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('listitem').filter({ hasText: 'Numeric range' }).getByRole('button', { name: 'Map' }).first().click();
  const editor = page.getByRole('dialog', { name: 'Map this wording' });
  await editor.getByRole('button', { name: 'Save variable' }).click();
  await expect(editor).toBeHidden({ timeout: 30_000 });

  await signIn(page, 'compliance.officer', editionUrl);
  await page.getByLabel('What you checked').fill('The amount matches the schedule.');
  await page.getByRole('button', { name: 'Approve map' }).click();
  await expect(page.getByText('Variable map approved')).toBeVisible({ timeout: 30_000 });

  await signIn(page, 'product.manager', `${editionUrl}/catalogue`);
  await page.getByRole('button', { name: 'Start the catalogue' }).click();
  await expect(page.getByRole('heading', { name: /^Benefits/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Add' }).first().click();
  const b = page.getByRole('dialog', { name: 'Add a benefit' });
  await b.getByRole('textbox', { name: 'Name', exact: true }).fill('Accident and Sickness Medical Expense');
  await b.getByLabel('Group').selectOption('medical_evacuation');
  await b.getByRole('group', { name: 'Maximum benefit' }).getByLabel('Amount').selectOption('schedule:v_10_000_500_000');
  await b.getByRole('button', { name: 'Save' }).click();
  await expect(b).toBeHidden({ timeout: 30_000 });

  await signIn(page, 'compliance.officer', `${editionUrl}/catalogue`);
  await page.getByLabel('What you checked').fill('The benefit matches the schedule.');
  await page.getByRole('button', { name: 'Approve catalogue' }).click();
  await expect(page.getByText('Catalogue approved')).toBeVisible({ timeout: 30_000 });
}

test('a base plan is built within the filed ranges, approved by a second person, and a state plan lists what publication needs', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'One journey is enough; the screens are checked with axe here.');
  test.setTimeout(600_000);
  const run = Date.now().toString(36).toUpperCase();
  await approvedCatalogue(page, run.toLowerCase());

  // The product manager creates a base plan from the catalogue.
  await signIn(page, 'product.manager', '/plans');
  await page.getByRole('button', { name: 'New plan' }).click();
  const dialog = page.getByRole('dialog', { name: 'New plan' });
  await dialog.getByLabel('Plan code').fill(`BASE-${run}`);
  await dialog.getByLabel('Effective from').fill('2026-01-01');
  await dialog.getByLabel('Plan name').fill(`E2E base plan ${run}`);
  await dialog.getByLabel('Benefit catalogue').selectOption({ label: `e2e_plan_${run.toLowerCase()} (2026-04) · catalogue v1` });
  await dialog.getByRole('button', { name: 'Create plan' }).click();
  await expect(page.getByText('Plan created')).toBeVisible({ timeout: 60_000 });
  await expectAccessible(page);

  // Including the benefit asks for its maximum; a value outside the filed range is refused with the range.
  await page.getByRole('checkbox', { name: 'Accident and Sickness Medical Expense' }).check();
  const values = page.locator('section', { has: page.getByRole('heading', { name: 'Values', exact: true }) });
  const amount = values.getByRole('spinbutton').first();
  await amount.fill('600000');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText(/must be between 10000 and 500000 \(filed range\)/).first()).toBeVisible({ timeout: 30_000 });
  await amount.fill('50000');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Saved. The draft is complete and can be approved.')).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(page.getByText('You built or edited this draft, so someone else must approve it.')).toBeVisible();
  await expectAccessible(page);
  const versionUrl = page.url().split('?')[0]!;

  // Compliance approves it.
  await signIn(page, 'compliance.officer', versionUrl);
  await page.getByLabel('What you checked').fill('Benefits and values match the schedule.');
  await page.getByRole('button', { name: 'Approve version' }).click();
  await expect(page.getByText('Version approved')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('This version is approved')).toBeVisible();

  // A state plan made from it shows what stands between it and publication.
  await signIn(page, 'product.manager', '/plans');
  await page.getByRole('button', { name: 'New plan' }).click();
  const state = page.getByRole('dialog', { name: 'New plan' });
  await state.getByRole('radio', { name: 'State plan' }).check();
  await state.getByLabel('Plan code').fill(`DE-${run}`);
  await state.getByLabel('Effective from').fill('2026-01-01');
  await state.getByLabel('Plan name').fill(`E2E Delaware plan ${run}`);
  await state.locator('select[name="parentPlanId"]').selectOption({ label: `BASE-${run} · E2E base plan ${run}` });
  await state.locator('input[name="state"]').fill('DE');
  await state.getByRole('button', { name: 'Create plan' }).click();
  await expect(page.getByText('Plan created')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('spinbutton').first()).toHaveValue('50000');
  await expect(page.getByText('Forms filed and approved in the state')).toBeVisible();
  await expect(page.getByText(/No filing is recorded for DE/)).toBeVisible();
  await expectAccessible(page);
});
