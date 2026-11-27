/**
 * Plan versions saved before a part was added to plan documents still open. Synthetic data only.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, requireEnv, resetDatabase, type TestContext } from './helpers';
import { addDays, publishedStack, send, today, type Stack } from './fixtures';

let t: TestContext;
let st: Stack;

beforeAll(async () => {
  t = await createTestApp();
  await resetDatabase();
  st = await publishedStack(t);
}, 240_000);
afterAll(async () => t.close());

/** As the database owner, with row security applying to the platform: rewrites a draft as an older release saved it. */
async function saveAsOlderRelease(versionId: string): Promise<void> {
  const client = new pg.Client({ connectionString: requireEnv('TEST_DATABASE_OWNER_URL') });
  await client.connect();
  try {
    await client.query(`SELECT set_config('app.account_ids', '*', false)`);
    const done = await client.query(
      `UPDATE plans.plan_versions SET document = document - 'servicing' - 'timing' WHERE id = $1`,
      [versionId],
    );
    expect(done.rowCount).toBe(1);
  } finally {
    await client.end();
  }
}

describe('a plan version saved by an older release', () => {
  it('opens, with the parts it lacks at their defaults', async () => {
    const draft = await send(t, 'POST', `/v1/plans/${st.planId}/drafts`, st.tokens.product, {
      effectiveFrom: addDays(today(), 30),
    });
    expect(draft.statusCode, draft.body).toBe(201);
    await saveAsOlderRelease(draft.json().id);

    const read = await send(t, 'GET', `/v1/plan-versions/${draft.json().id}`, st.tokens.product);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().document).toMatchObject({
      timing: {},
      servicing: { postReviewRefund: 'none', additionalCostDays: null, addBenefitDays: null },
    });
    expect(read.json().document.benefits.length).toBeGreaterThan(0);
  });
});
