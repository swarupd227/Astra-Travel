/**
 * Increment 8 journeys: reviewing what the configuration agents propose. The proposals are written to the
 * database directly, as an agent's submission would store them (an agent run needs a live Claude model; see
 * agents-config.live.spec.ts), so these tests cover what a person sees and does: the panels, the review
 * page, correcting and applying variables, and loading a drafted manual. Data is synthetic and unique per run.
 */
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import pg from 'pg';

const password = process.env.DEV_USER_PASSWORD;
const dbUrl = process.env.DATABASE_OWNER_URL;

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

async function seed(agentId: string, kind: string, subjectType: string, subjectId: string, summary: string, content: unknown, verification: unknown): Promise<void> {
  const c = new pg.Client({ connectionString: dbUrl });
  await c.connect();
  try {
    const agent = await c.query(`SELECT 1 FROM agents.agents WHERE id = $1`, [agentId]);
    if (!agent.rowCount) throw new Error(`${agentId} is not registered: start the worker, which registers the agents`);
    await c.query(
      `INSERT INTO agents.proposals (kind, agent_id, requested_by, subject_type, subject_id, summary, content, verification) VALUES ($1, $2, 'e2e', $3, $4, $5, $6, $7)`,
      [kind, agentId, subjectType, subjectId, summary, JSON.stringify(content), JSON.stringify(verification)],
    );
  } finally {
    await c.end();
  }
}

async function loadEdition(page: Page, run: string, kind: string, name: string, body: string, mime = 'text/plain'): Promise<string> {
  await signIn(page, 'compliance.officer', '/forms');
  await page.getByRole('button', { name: 'Load edition' }).click();
  const load = page.getByRole('dialog', { name: 'Load a form edition' });
  await load.getByLabel('Document').setInputFiles({ name: `${name}_${run}.txt`, mimeType: mime, buffer: Buffer.from(body) });
  await load.getByLabel('Form number').fill(`${name}_${run}`);
  await load.getByLabel('Edition').fill('2026-04');
  await load.getByLabel('Title').fill(`E2E ${name} ${run}`);
  await load.getByLabel('Kind').selectOption(kind);
  await load.getByRole('button', { name: 'Load edition' }).click();
  await expect(page.getByText('Edition loaded')).toBeVisible({ timeout: 60_000 });
  return page.url().split('?')[0]!.split('/').pop()!;
}

test.beforeEach(() => {
  test.skip(!dbUrl, 'DATABASE_OWNER_URL is needed to store proposals as an agent would');
});

test('a product manager reviews the variables an agent proposed, corrects one and saves them to the draft map', async ({ page, isMobile }) => {
  test.skip(isMobile, 'One journey is enough; the screens are checked with axe here.');
  test.setTimeout(600_000);
  const run = Date.now().toString(36);
  const schedule = [`SCHEDULE OF BENEFITS (synthetic test schedule, run ${run})`, 'Trip Cancellation maximum [$500-$10,000] per person', 'You may cancel within the [ten (10) - fifteen (15)] day review period.'].join('\n');
  const editionId = await loadEdition(page, run, 'schedule', 'agsch', schedule);

  await signIn(page, 'product.manager', `/forms/${editionId}`);
  await expect(page.getByRole('heading', { name: 'Form Configuration (AG-01)' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('No proposals yet.')).toBeVisible();
  await expectAccessible(page);

  // Until governance approves the agent's first version, asking is refused with the reason.
  await page.getByRole('button', { name: 'Ask for a proposed map' }).click();
  await expect(page.getByText(/no approved version yet/)).toBeVisible({ timeout: 30_000 });

  const a = schedule.indexOf('[$500-$10,000]');
  const b = schedule.indexOf('[ten (10) - fifteen (15)]');
  await seed(
    'AG-01',
    'variable_map',
    'form_edition',
    editionId,
    'Two variables found in the schedule.',
    {
      items: [
        { variable: { key: 'tc_max', label: 'Trip Cancellation maximum', type: 'numeric_range', constraints: { min: 500, max: 10000, unit: 'usd' }, textStart: a, textEnd: a + '[$500-$10,000]'.length, excerpt: '[$500-$10,000]' }, rationale: 'The bracket gives the filed dollar range.' },
        { variable: { key: 'review_days', label: 'Review period', type: 'time_period', constraints: { min: 10, max: 15, unit: 'days' }, textStart: b, textEnd: b + '[ten (10) - fifteen (15)]'.length, excerpt: '[ten (10) - fifteen (15)]' }, rationale: 'Written-out numbers with the figures in brackets.' },
      ],
    },
    [
      { item: 'tc_max', ok: true, detail: 'Page 1: “[$500-$10,000]”. Matches the form-reading rule.' },
      { item: 'review_days', ok: false, detail: 'Page 1: “[ten (10) - fifteen (15)]”. Differs from the form-reading rule: check the type and range.' },
    ],
  );
  await page.reload();
  await page.getByRole('link', { name: 'Two variables found in the schedule.' }).click();
  await page.waitForURL(/\/proposals\/[0-9a-f-]{36}/, { timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Variable map', level: 1 })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Proposed by an agent, not saved')).toBeVisible();
  // What verified is ticked; what needs a look is not.
  await expect(page.getByRole('checkbox', { name: 'Save Trip Cancellation maximum' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Save Review period' })).not.toBeChecked();
  await expect(page.getByText('Check this')).toBeVisible();
  await expectAccessible(page);

  // Correct one label, accept the other as it is, and save both.
  await page.getByRole('textbox', { name: 'Label for tc_max' }).fill('Trip Cancellation maximum (corrected)');
  await page.getByRole('checkbox', { name: 'Save Review period' }).check();
  await page.getByRole('button', { name: /Save 2 variables to the draft map/ }).click();
  await expect(page.getByText('Variables saved')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Accepted', { exact: true }).locator('..')).toContainText('1');
  await expect(page.getByText('Corrected', { exact: true }).locator('..')).toContainText('1');
  await expectAccessible(page);

  // The corrected variable is in the draft map on the edition page.
  await page.goto(`/forms/${editionId}`);
  await expect(page.getByText('Trip Cancellation maximum (corrected)').first()).toBeVisible({ timeout: 60_000 });
});

test('a rating analyst loads the drafted manual as a draft after seeing which tables were found on the filed pages', async ({ page, isMobile }) => {
  test.skip(isMobile, 'One journey is enough; the screens are checked with axe here.');
  test.setTimeout(600_000);
  const run = Date.now().toString(36);
  const manualText = ['RATE MANUAL (synthetic test manual)\nRETR-E2E-1', `Table 2.1.5 Trip cost per $100\nFrom $1: 1.0000\nFrom $501: 0.9000\nRETR-E2E-${run}-2`].join('\f');
  const editionId = await loadEdition(page, run, 'rate_manual', 'agman', manualText);

  await signIn(page, 'rating.analyst', `/forms/${editionId}`);
  await expect(page.getByRole('heading', { name: 'Rate Manual Ingestion (AG-02)' })).toBeVisible({ timeout: 60_000 });
  const code = `RETR-E2E-${run.toUpperCase()}`;
  await seed(
    'AG-02',
    'rate_manual',
    'form_edition',
    editionId,
    'One table drafted from page 2.',
    {
      manual: {
        code,
        state: 'DE',
        benefit: 'TCAN',
        effectiveFrom: '2026-01-01',
        document: {
          baseLossCost: '1.475',
          exposure: { kind: 'per_100_trip_cost', table: '2.1.5' },
          minimumTripCost: null,
          variables: [],
          perilPackage: null,
          exclusionWaivers: null,
          supplemental: [],
          tables: [{ id: '2.1.5', name: 'Trip cost per $100', page: `RETR-E2E-${run}-2`, keys: [{ input: 'tripCost', match: 'band' }], rows: [{ keys: [1], factor: '1.0000' }, { keys: [501], factor: '0.9000' }], unused: null, unknown: null }],
          conversion: { lossCostMultiplier: null, minimumPremium: null, roundTo: 2 },
        },
      },
      uncertainties: ['The manual gives no loss cost multiplier.'],
    },
    [{ item: '2.1.5', ok: true, detail: 'All 2 factors are on page 2.' }],
  );
  await page.reload();
  await page.getByRole('link', { name: 'One table drafted from page 2.' }).click();
  await expect(page.getByRole('heading', { name: 'Drafted manual' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('The manual gives no loss cost multiplier.')).toBeVisible();
  await expect(page.getByText('All found')).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Load as a draft manual' }).click();
  await expect(page.getByText('Draft manual loaded')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('link', { name: 'Open the draft manual' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`${code}, version 1`) })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
});
