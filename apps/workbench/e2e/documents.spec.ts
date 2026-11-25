/**
 * Increment 10 journey: staff assemble a plan version's schedule from the filed form, a second person releases
 * it, and a policy gets its documents with a PDF. It needs the synthetic stack in the development database
 * (see apps/api/test/seed-synthetic-stack.int.test.ts); without plan Q-DE the test is skipped.
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

test('a schedule is assembled, released by a second person, and a policy gets its documents', async ({ page, isMobile }) => {
  test.skip(isMobile, 'One journey is enough; the screens are checked with axe here.');
  test.setTimeout(600_000);

  // The product manager assembles the schedule of the published plan.
  await signIn(page, 'product.manager', '/plans');
  await expect(page.getByRole('heading', { name: 'Plans', level: 1 })).toBeVisible({ timeout: 90_000 });
  const plan = page.getByRole('row').filter({ hasText: 'Q-DE' }).getByRole('link').first();
  test.skip((await plan.count()) === 0, 'Seed the synthetic stack first');
  await plan.click();
  await page.getByRole('link', { name: /^Version \d+$/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Documents', level: 2 }).or(page.getByText('Documents', { exact: true }).first())).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Assemble the schedule' }).click();
  await page.waitForURL(/\/documents\/templates\//, { timeout: 90_000 });
  const templateUrl = page.url();
  await expect(page.getByRole('heading', { name: /^Schedule template, version \d+$/, level: 1 })).toBeVisible({ timeout: 60_000 });

  // The assembled wording has the plan's values in the filed format and no brackets; the checks pass.
  await expect(page.getByText('Assembled with nothing left in brackets')).toBeVisible();
  await expect(page.getByLabel('Assembled wording')).toContainText('Trip Cancellation maximum $5,000 per person');
  await expect(page.getByLabel('Assembled wording')).toContainText('twenty (20) days');
  await expect(page.getByLabel('Assembled wording')).not.toContainText('[');
  await expect(page.getByRole('heading', { name: 'Document Quality (AG-07)' })).toBeVisible();
  // The maker cannot release it.
  await expect(page.getByText(/You need the documents:release permission|You made this template/)).toBeVisible();
  await expectAccessible(page);

  // A compliance officer releases it.
  await signIn(page, 'compliance.officer', new URL(templateUrl).pathname);
  await expect(page.getByRole('heading', { name: /^Schedule template, version \d+$/, level: 1 })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Release this template' }).click();
  await expect(page.getByText('New policies on this plan version are issued with this template.')).toBeVisible({ timeout: 60_000 });
  await expectAccessible(page);

  // The list and the failures page render and are accessible.
  await page.goto('/documents');
  await expect(page.getByRole('heading', { name: 'Document templates', level: 1 })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('row').filter({ hasText: 'Released' }).first()).toBeVisible();
  await expectAccessible(page);
  await page.goto('/documents/failures');
  await expect(page.getByRole('heading', { name: 'Failed documents and deliveries', level: 1 })).toBeVisible({ timeout: 60_000 });
  await expectAccessible(page);

  // A policy: issue what it is missing, then read a document and open its PDF.
  await page.goto('/policies');
  await expect(page.getByRole('heading', { name: 'Policies', level: 1 })).toBeVisible({ timeout: 60_000 });
  test.skip((await page.getByRole('row').filter({ hasText: 'ATP-' }).count()) === 0, 'Seed a bound policy to check its documents');
  await page.getByRole('row').filter({ hasText: 'ATP-' }).first().getByRole('link').click();
  await expect(page.getByRole('heading', { name: /^ATP-\d{4}-\d{6}$/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Documents', { exact: true }).first()).toBeVisible();
  const issue = page.getByRole('button', { name: 'Issue the missing documents' });
  if (await issue.count()) {
    await issue.click();
    await expect(page.getByRole('link', { name: 'Purchase confirmation', exact: true })).toBeVisible({ timeout: 60_000 });
  }
  await expect(page.getByRole('link', { name: 'Purchase confirmation', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Schedule', exact: true })).toBeVisible();
  await expectAccessible(page);

  const pdfLink = page.getByRole('link', { name: /Open the PDF of the schedule/i });
  const href = await pdfLink.getAttribute('href');
  const pdf = await page.request.get(href!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');

  await page.getByRole('link', { name: 'Schedule', exact: true }).click();
  await expect(page.getByText('SHA-256')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel('Document text')).toContainText('Trip Cancellation maximum $5,000 per person');
  await expectAccessible(page);
});
