/**
 * Increment 14 journey: a sandbox account is given branding, a widget and a hosted journey; a traveller prices a
 * trip on the public journey; staff see the same quote in the widget; and the journey completes with a test
 * payment. Booking files and staff issue are covered by the API tests. It needs an account with a sandbox in the
 * development database (the accounts journey makes one), the published plan Q-DE, and CHANNEL_SIGNING_SECRET in
 * the shared .env.
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

const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

test('a sandbox journey and widget: price, options, test payment and documents', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'One journey is enough; the screens are checked with axe here.');
  test.setTimeout(900_000);

  // Staff set up the sandbox account's channels.
  await signIn(page, 'account.manager', '/accounts');
  await expect(page.getByRole('heading', { name: 'Accounts', level: 1 })).toBeVisible({
    timeout: 90_000,
  });
  const twin = page.getByRole('row').filter({ hasText: '(sandbox)' }).first();
  test.skip(
    (await twin.count()) === 0,
    'Create a sandbox account first (the accounts journey does)',
  );
  await twin.getByRole('link').first().click();
  await page.getByRole('link', { name: 'Sales channels' }).click();
  await expect(
    page.getByRole('heading', { name: 'Widget, hosted journey and files', level: 1 }),
  ).toBeVisible({ timeout: 60_000 });
  const slug = `e2e-${Date.now().toString(36)}`;
  await page.getByLabel('Name shown to travellers').fill('E2E Travel');
  await page.getByLabel('Primary colour', { exact: true }).fill('#0b5cad');
  await page.getByLabel('Text on the primary colour').fill('#ffffff');
  await page.getByLabel('Switch the widget on').check();
  await page.getByLabel('Sites that may show it').fill('http://localhost:3000');
  await page.getByLabel('Switch the journey on').check();
  await page.getByLabel('Address', { exact: true }).fill(slug);
  await page.getByLabel('Plans it sells').fill('Q-DE');
  await page.getByLabel('Headline').fill('Cover for your end-to-end trip');
  await page.getByRole('button', { name: 'Save the channel settings' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible({
    timeout: 60_000,
  });
  await expectAccessible(page);

  // A traveller, not signed in, prices a trip on the hosted journey.
  await page.context().clearCookies();
  await page.goto(`/j/${slug}`);
  await expect(
    page.getByRole('heading', { name: 'Cover for your end-to-end trip', level: 1 }),
  ).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('E2E Travel').first()).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel('Departure date').fill(iso(25));
  await page.getByLabel('Return date').fill(iso(32));
  await page.getByLabel('Destination country').fill('FR');
  await page.getByLabel('Destination region').fill('Europe');
  await page.getByLabel('First name').first().fill('Sam');
  await page
    .getByLabel('Last name')
    .first()
    .fill(`Journey${Date.now().toString(36)}`);
  await page.getByLabel('Date of birth').first().fill('1980-05-05');
  await page.getByLabel('Trip cost to insure').first().fill('4200');
  await page.getByRole('button', { name: 'See my price' }).click();
  await expect(page.getByRole('heading', { name: 'Your cover and price', level: 1 })).toBeVisible({
    timeout: 120_000,
  });
  const quoteUrl = page.url();
  const quoteId = quoteUrl.split('/q/')[1]!.split(/[/?]/)[0]!;
  await expect(page.getByText('Total price')).toBeVisible();
  await expectAccessible(page);

  // Staff see the same quote in the widget, which re-rates when an option is ticked.
  await signIn(page, 'account.manager', `/quotes/${quoteId}/widget`);
  await expect(page.getByRole('heading', { name: 'Widget preview', level: 1 })).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByText('Total premium')).toBeVisible({ timeout: 60_000 });
  const before = await page.getByText('Total premium').locator('..').innerText();
  const optional = page.getByRole('checkbox').first();
  if (await optional.count()) {
    await optional.check();
    await expect(page.getByText('Total premium').locator('..')).not.toHaveText(before, {
      timeout: 60_000,
    });
  }
  await expect(page.getByRole('button', { name: 'Read the full policy wording' })).toBeVisible();
  await expectAccessible(page);

  // The traveller buys: a labelled test payment, then the documents.
  await page.context().clearCookies();
  await page.goto(`/j/${slug}/q/${quoteId}/pay`);
  await expect(page.getByRole('heading', { name: 'Buy your cover', level: 1 })).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByText('Test payment', { exact: true })).toBeVisible();
  await page.getByLabel('Your name').fill('Sam Sandbox');
  await page.getByLabel('Email for your documents').fill('sam@example.com');
  await expectAccessible(page);
  await page.getByLabel('I have read the notice above.').check();
  await page.getByLabel(/medically able to travel/).check();
  await page.getByRole('button', { name: /^Pay \$/ }).click();
  await expect(page.getByRole('heading', { name: 'Your cover is bought', level: 1 })).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByText(/ATP-\d{4}-\d{6}/).first()).toBeVisible();
  await expect(page.getByText('This was a test purchase in a sandbox')).toBeVisible();
  await expect(
    page.getByRole('link', { name: /Purchase Confirmation|Purchase confirmation/ }),
  ).toBeVisible();
  await expectAccessible(page);
});

test('booking files: a file is sent and its result listed', async ({ page, isMobile }) => {
  test.skip(isMobile, 'One journey is enough.');
  test.setTimeout(600_000);
  await signIn(page, 'account.manager', '/channels/booking-files');
  await expect(page.getByRole('heading', { name: 'Booking files', level: 1 })).toBeVisible({
    timeout: 120_000,
  });
  const account = page.getByLabel('Account');
  test.skip((await account.locator('option').count()) === 0, 'Register an account first');
  await expectAccessible(page);
  // One booking with an impossible date: the file is processed and the booking is rejected with its reason.
  const header =
    'booking_ref,plan_code,state,first_name,last_name,date_of_birth,trip_cost,departure_date,return_date,destination_country,destination_region,optional_benefits,purchaser_name,purchaser_email,payment_reference,payment_amount,disclosure_version,acknowledged_by,able_to_travel';
  const ref = `E2E-${Date.now().toString(36)}`;
  const row = `${ref},Q-DE,DE,Sam,Filed,1980-05-05,4200,not-a-date,${iso(40)},FR,Europe,,Sam Filed,,PAY-${ref},84.00,v1,Sam Filed,true`;
  await page.getByLabel('Bookings file').setInputFiles({
    name: `${ref}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(`${header}\n${row}\n`),
  });
  await page.getByRole('button', { name: 'Send the file' }).click();
  await expect(page.getByText('0 of 1 bookings accepted, 1 rejected.')).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByRole('row').filter({ hasText: `${ref}.csv` })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole('link', { name: `Download the result of ${ref}.csv` })).toBeVisible();
  await expectAccessible(page);
});
