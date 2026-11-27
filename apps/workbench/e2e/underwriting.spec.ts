/**
 * Increment 7 journeys: the OFAC list loaded by one person and approved by another, and a rule set drafted
 * on a state plan by an underwriter and approved by someone else. Data is synthetic and unique per run.
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

test('compliance loads the OFAC list and a second person approves it', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'One journey is enough; the screen is checked with axe here.');
  test.setTimeout(300_000);
  const run = Date.now().toString(36);
  const source = `Synthetic list ${run}`;
  const sdn = [
    `9${Date.now()},"TESTBURG, Zorbek ${run}",individual,SYNTH-PROGRAM,-0-,-0-,-0-,-0-,-0-,-0-,-0-,"DOB 12 Mar 1970"`,
  ].join('\n');

  await signIn(page, 'compliance.officer', '/underwriting/sanctions');
  await expect(page.getByRole('heading', { name: 'Sanctions lists' })).toBeVisible({
    timeout: 60_000,
  });
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Load list' }).click();
  const dialog = page.getByRole('dialog', { name: 'Load the OFAC SDN list' });
  await dialog
    .getByLabel('SDN.CSV')
    .setInputFiles({ name: 'SDN.CSV', mimeType: 'text/csv', buffer: Buffer.from(sdn) });
  await dialog.locator('input[name="source"]').fill(source);
  await dialog.getByRole('button', { name: 'Load list' }).click();
  await expect(page.getByText('List loaded as a draft')).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('Escape');
  const row = () => page.getByRole('row').filter({ hasText: source });
  await expect(row()).toContainText('You loaded this list, so someone else approves it.', {
    timeout: 30_000,
  });

  await signIn(page, 'underwriter', '/underwriting/sanctions');
  await row().getByLabel('What you checked').fill('Entries match the published file.');
  await row().getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Screening is using an approved list')).toBeVisible({
    timeout: 60_000,
  });
  await expect(row()).toContainText('Approved');
  await expectAccessible(page);
});

/** Loads a schedule, maps one amount, builds and approves a one-benefit catalogue, then an approved base plan and a state plan. */
async function statePlan(page: Page, run: string): Promise<string> {
  const schedule = [
    `SCHEDULE OF BENEFITS (synthetic test schedule, run ${run})`,
    'Accident and Sickness Medical Expense [$10,000-$500,000] per person',
  ].join('\n');
  await signIn(page, 'compliance.officer', '/forms');
  await page.getByRole('button', { name: 'Load edition' }).click();
  const load = page.getByRole('dialog', { name: 'Load a form edition' });
  await load.getByLabel('Document').setInputFiles({
    name: `sch_${run}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(schedule),
  });
  await load.getByLabel('Form number').fill(`e2e_uw_${run}`);
  await load.getByLabel('Edition').fill('2026-04');
  await load.getByLabel('Title').fill(`E2E rules schedule ${run}`);
  await load.getByLabel('Kind').selectOption('schedule');
  await load.getByRole('button', { name: 'Load edition' }).click();
  await expect(page.getByText('Edition loaded')).toBeVisible({ timeout: 60_000 });
  const editionUrl = page.url().split('?')[0]!;

  await signIn(page, 'product.manager', editionUrl);
  await page.getByRole('button', { name: 'Start variable map' }).click();
  await expect(page.getByRole('heading', { name: 'Suggested from the form' })).toBeVisible({
    timeout: 30_000,
  });
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Numeric range' })
    .getByRole('button', { name: 'Map' })
    .first()
    .click();
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
  await b
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('Accident and Sickness Medical Expense');
  await b.getByLabel('Group').selectOption('medical_evacuation');
  await b
    .getByRole('group', { name: 'Maximum benefit' })
    .getByLabel('Amount')
    .selectOption('schedule:v_10_000_500_000');
  await b.getByRole('button', { name: 'Save' }).click();
  await expect(b).toBeHidden({ timeout: 30_000 });
  await signIn(page, 'compliance.officer', `${editionUrl}/catalogue`);
  await page.getByLabel('What you checked').fill('The benefit matches the schedule.');
  await page.getByRole('button', { name: 'Approve catalogue' }).click();
  await expect(page.getByText('Catalogue approved')).toBeVisible({ timeout: 60_000 });

  // Base plan (approved by compliance), then the state plan.
  await signIn(page, 'product.manager', '/plans');
  await page.getByRole('button', { name: 'New plan' }).click();
  const np = page.getByRole('dialog', { name: 'New plan' });
  await np.getByLabel('Plan code').fill(`UWB-${run.toUpperCase()}`);
  await np.getByLabel('Effective from').fill('2026-01-01');
  await np.getByLabel('Plan name').fill(`E2E rules base ${run}`);
  await np
    .getByLabel('Benefit catalogue')
    .selectOption({ label: `e2e_uw_${run} (2026-04) · catalogue v1` });
  await np.getByRole('button', { name: 'Create plan' }).click();
  await expect(page.getByText('Plan created')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('checkbox', { name: 'Accident and Sickness Medical Expense' }).check();
  await page
    .locator('section', { has: page.getByRole('heading', { name: 'Values', exact: true }) })
    .getByRole('spinbutton')
    .first()
    .fill('50000');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Saved. The draft is complete and can be approved.')).toBeVisible({
    timeout: 30_000,
  });
  const baseUrl = page.url().split('?')[0]!;
  await signIn(page, 'compliance.officer', baseUrl);
  await page.getByLabel('What you checked').fill('Benefits and values match the schedule.');
  await page.getByRole('button', { name: 'Approve version' }).click();
  await expect(page.getByText('Version approved')).toBeVisible({ timeout: 30_000 });

  await signIn(page, 'product.manager', '/plans');
  await page.getByRole('button', { name: 'New plan' }).click();
  const sp = page.getByRole('dialog', { name: 'New plan' });
  await sp.getByRole('radio', { name: 'State plan' }).check();
  await sp.getByLabel('Plan code').fill(`UWD-${run.toUpperCase()}`);
  await sp.getByLabel('Effective from').fill('2026-01-01');
  await sp.getByLabel('Plan name').fill(`E2E rules Delaware ${run}`);
  await sp
    .locator('select[name="parentPlanId"]')
    .selectOption({ label: `UWB-${run.toUpperCase()} · E2E rules base ${run}` });
  await sp.locator('input[name="state"]').fill('DE');
  await sp.getByRole('button', { name: 'Create plan' }).click();
  await expect(page.getByText('Plan created')).toBeVisible({ timeout: 60_000 });
  return `E2E rules Delaware ${run}`;
}

test('an underwriter drafts a rule set on a state plan and someone else approves it', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'One journey is enough; the screens are checked with axe here.');
  test.setTimeout(600_000);
  const run = Date.now().toString(36);
  const planName = await statePlan(page, run);

  await signIn(page, 'underwriter', '/underwriting/plans');
  await page.getByRole('link', { name: planName }).click();
  await expect(page.getByRole('heading', { name: planName })).toBeVisible({ timeout: 60_000 });
  await expectAccessible(page);
  await page.getByLabel('Effective from').fill('2026-01-01');
  await page.getByRole('button', { name: 'Start a rule set draft' }).click();
  await expect(page.getByText('Draft started')).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Add limit' }).click();
  await page.getByRole('spinbutton', { name: /: value$/ }).fill('75');
  await page.getByRole('button', { name: 'Add referral rule' }).click();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Saved. The draft has no problems and can be approved.')).toBeVisible(
    { timeout: 30_000 },
  );
  await page.reload();
  await expect(
    page.getByText('You built or edited this draft, so someone else must approve it.'),
  ).toBeVisible();
  await expect(page.getByText('Add at least one test case for this plan.')).toBeVisible();
  await expectAccessible(page);
  const url = page.url().split('?')[0]!;

  await signIn(page, 'compliance.officer', url);
  await page.getByLabel('What you checked').fill('Limits and rule checked.');
  await page.getByRole('button', { name: 'Approve rule set' }).click();
  await expect(page.getByText('Rule set approved')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('This version is approved')).toBeVisible();
  await expectAccessible(page);

  // The check page and the referral queue render for an underwriter.
  await signIn(page, 'underwriter', '/underwriting/check');
  await expect(page.getByRole('heading', { name: 'Eligibility check' })).toBeVisible({
    timeout: 60_000,
  });
  await expectAccessible(page);
  await page.goto('/underwriting/referrals');
  await expect(page.getByRole('heading', { name: 'Referrals' })).toBeVisible();
  await expectAccessible(page);
});
