/**
 * Increment 13 journey: an account manager sets up an account (profile, sandbox), compliance records a licence,
 * and the screens work. It needs an account in the development database. The development identity provider is
 * not given admin access, so issuing sandbox credentials is expected to be refused with that reason.
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

test('an account is set up: profile, sandbox and a licence', async ({ page, isMobile }) => {
  test.skip(isMobile, 'One journey is enough; the screens are checked with axe here.');
  test.setTimeout(600_000);

  await signIn(page, 'account.manager', '/accounts');
  await expect(page.getByRole('heading', { name: 'Accounts', level: 1 })).toBeVisible({ timeout: 90_000 });
  const rows = page.getByRole('row').filter({ has: page.getByRole('link') });
  test.skip((await rows.count()) === 0, 'Register an account first');
  await rows.first().getByRole('link').first().click();
  await page.getByRole('link', { name: 'Onboarding and configuration' }).click();
  await expect(page.getByRole('heading', { name: 'Onboarding and configuration', level: 1 })).toBeVisible({ timeout: 60_000 });
  const setupUrl = page.url();
  await expect(page.getByRole('heading', { name: 'Checklist' })).toBeVisible();
  await expectAccessible(page);

  // The profile: saving it moves the checklist.
  await page.getByLabel('Contract reference').fill(`CT-E2E-${Date.now().toString().slice(-6)}`);
  await page.getByLabel('Contract signed on').fill('2026-02-01');
  await page.getByLabel('States the account sells in').fill('DE');
  await page.getByLabel('Settlement terms').fill('Monthly statement, paid within 30 days');
  await page.getByRole('button', { name: 'Save the profile' }).click();
  await expect(page.getByText('The profile is saved.')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/^Contract signed and referenced$/)).toBeVisible();

  // The sandbox: created if it is not there; credentials are refused here because the development identity provider has no admin access.
  const create = page.getByRole('button', { name: 'Create the sandbox' });
  if (await create.count()) {
    await create.click();
  }
  // Once the sandbox exists the form that made it gives way to the credentials control.
  await expect(page.getByRole('button', { name: 'Issue sandbox credentials' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Issue sandbox credentials' }).click();
  await expect(page.getByText(/identity provider/i).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Using the sandbox' })).toBeVisible();
  await expectAccessible(page);

  // Compliance records a licence for the state, and the licences screen lists it.
  await signIn(page, 'compliance.officer', new URL(setupUrl).pathname);
  await expect(page.getByRole('heading', { name: 'Onboarding and configuration', level: 1 })).toBeVisible({ timeout: 90_000 });
  const number = `TR-E2E-${Date.now().toString().slice(-6)}`;
  await page.getByLabel('State', { exact: true }).fill('DE');
  await page.getByLabel('Number').fill(number);
  await page.getByLabel('Holder').fill('Synthetic Travel LLC');
  await page.getByLabel('Valid from').fill('2026-01-01');
  await page.getByLabel('Expires on').fill('2030-01-01');
  await page.getByRole('button', { name: 'Record this licence' }).click();
  await expect(page.getByText('Recorded.').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('cell', { name: number })).toBeVisible({ timeout: 60_000 });
  await page.goto('/compliance/licences?within=3650');
  await expect(page.getByRole('heading', { name: 'Licences and registrations', level: 1 })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('cell', { name: number })).toBeVisible({ timeout: 60_000 });
  await expectAccessible(page);
});
