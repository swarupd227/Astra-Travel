/**
 * Increment 16e: a card programme manager keeps a sample of an issuer's file (with a card number, which is removed)
 * and approves a mapping written by hand. Needs a card programme in the development database and DEV_USER_PASSWORD.
 * The agent's drafting needs a live model, so it is covered by the API tests.
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

test('issuer file mapping: a sample is kept without card numbers and a mapping is approved', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'One journey is enough; the screen is checked with axe here.');
  test.setTimeout(600_000);
  await signIn(page, 'platform.admin', '/card/programmes');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 120_000 });
  const programme = page.getByRole('row').getByRole('link').first();
  test.skip((await programme.count()) === 0, 'Register a card programme first');
  await programme.click();
  await page.getByRole('link', { name: 'Issuer file mapping' }).click();
  await expect(page.getByRole('heading', { name: 'Issuer file mapping', level: 1 })).toBeVisible({
    timeout: 120_000,
  });
  await expectAccessible(page);

  const file = 'CUST,SINCE\ntok-e2e-1,2025-01-15\n5500 0000 0000 0004,2025-01-15\n';
  await page
    .getByLabel('Issuer’s file')
    .setInputFiles({ name: 'issuer-e2e.csv', mimeType: 'text/csv', buffer: Buffer.from(file) });
  await page.getByRole('button', { name: 'Keep a sample' }).click();
  await expect(page.getByText(/1 card number\(s\) were removed/)).toBeVisible({ timeout: 90_000 });
  await expect(page.getByLabel('The first lines of the sample')).not.toContainText('5500');

  const mapping = {
    delimiter: ',',
    columns: {
      accountRef: { column: 'CUST' },
      productCode: { constant: 'PLAT' },
      action: { constant: 'A' },
      eligibleFrom: { column: 'SINCE', format: 'YYYY-MM-DD' },
      eligibleTo: null,
    },
  };
  await page.getByLabel('Mapping', { exact: true }).fill(JSON.stringify(mapping, null, 2));
  await page.getByRole('button', { name: /^Approve/ }).click();
  await expect(page.getByText(/Approved as version \d+|Version \d+ in use/).first()).toBeVisible({
    timeout: 90_000,
  });
  await expectAccessible(page);
});
