/**
 * Increment 8 with the real model: AG-01 reads the specification's quoted wording and proposes its variable
 * map; the result is compared with a list prepared by hand from that wording. Runs only when ANTHROPIC_API_KEY
 * is set for the worker (and the agent has been evaluated and approved by the AI governance lead); otherwise
 * it is skipped. When Assurant provides the sample schedule, replace WORDING and GOLDEN with it and its
 * manually prepared list; the same comparison then gives the acceptance result for E01-F01-S03.
 */
import { expect, test, type Page } from '@playwright/test';

const password = process.env.DEV_USER_PASSWORD;
const live = !!process.env.ANTHROPIC_API_KEY && process.env.AGENTS_LIVE === 'true';

async function signIn(page: Page, username: string, path = '/') {
  if (!password) throw new Error('DEV_USER_PASSWORD must be set (from .env)');
  await page.context().clearCookies();
  await page.goto(path);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
  await page.waitForURL((url) => url.origin === 'http://localhost:3000');
}

/** The specification's quoted wording (M1), which quotes the filed VSC form and schedule. */
const WORDING = [
  'You may cancel within the [ten (10) - fifteen (15)] day review period.',
  'We will reimburse [twenty-five percent (25%) – one hundred percent (100%)] of the Trip Cost.',
  'Trip Cancellation maximum per person [$0-$5,000,000].',
  '[[Optional] Trip Delay maximum [$100-$10,000] per person]',
  'Maximum Benefit [PER PERSON] [PER TRIP].',
].join('\n');

/** Prepared by hand from the wording above: excerpts that must be proposed, with type and filed range. */
const GOLDEN = [
  { excerpt: '[ten (10) - fifteen (15)]', type: 'time_period' },
  { excerpt: '[twenty-five percent (25%) – one hundred percent (100%)]', type: 'percentage_range' },
  { excerpt: '[$0-$5,000,000]', type: 'numeric_range' },
  { excerpt: '[[Optional] Trip Delay maximum [$100-$10,000] per person]', type: 'optional_benefit' },
  { excerpt: '[$100-$10,000]', type: 'numeric_range' },
  { excerpt: '[PER PERSON] [PER TRIP]', type: 'limit_basis' },
];

test('AG-01 finds every variable of the quoted wording (live model)', async ({ page, isMobile }) => {
  test.skip(isMobile || !live, 'Needs ANTHROPIC_API_KEY, AGENTS_LIVE=true and an approved AG-01 version');
  test.setTimeout(900_000);
  const run = Date.now().toString(36);
  await signIn(page, 'compliance.officer', '/forms');
  await page.getByRole('button', { name: 'Load edition' }).click();
  const load = page.getByRole('dialog', { name: 'Load a form edition' });
  await load.getByLabel('Document').setInputFiles({ name: `live_${run}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`${WORDING}\n(run ${run})`) });
  await load.getByLabel('Form number').fill(`live_${run}`);
  await load.getByLabel('Edition').fill('2026-04');
  await load.getByLabel('Title').fill(`Live agent test ${run}`);
  await load.getByLabel('Kind').selectOption('schedule');
  await load.getByRole('button', { name: 'Load edition' }).click();
  await expect(page.getByText('Edition loaded')).toBeVisible({ timeout: 60_000 });

  await signIn(page, 'product.manager', page.url().split('?')[0]!);
  await page.getByRole('button', { name: 'Ask for a proposed map' }).click();
  await expect(page.getByRole('link', { name: /variables|variable/i }).first()).toBeVisible({ timeout: 600_000 });
  await page.getByRole('link', { name: /variables|variable/i }).first().click();
  await expect(page.getByRole('heading', { name: 'Variable map' })).toBeVisible({ timeout: 60_000 });

  // Compare what was proposed with the hand-made list: every golden excerpt appears with the right type.
  const rows = await page.getByRole('row').allInnerTexts();
  const missing = GOLDEN.filter((g) => !rows.some((r) => r.includes(g.excerpt) && r.toLowerCase().includes(g.type.replace(/_/g, ' '))));
  expect(missing, `Not proposed with the right type: ${missing.map((m) => m.excerpt).join(' | ')}`).toEqual([]);
});
