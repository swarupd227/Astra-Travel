/**
 * Opt-in seeding of the SYNTHETIC published stack into the local development database, so the quote and
 * policy screens can be tried with data. It is skipped unless SEED_SYNTHETIC_STACK=true, and then it must be
 * pointed at the development database (it never resets anything):
 *
 *   SEED_SYNTHETIC_STACK=true TEST_DATABASE_URL=$DATABASE_URL TEST_DATABASE_OWNER_URL=$DATABASE_OWNER_URL \
 *     npx vitest run --project integration apps/api/test/seed-synthetic-stack.int.test.ts
 *
 * What it creates is labelled synthetic: invented rate manuals (loss cost multiplier 1), a made-up Delaware
 * disclosure, a fictional sanctions entry, plan Q-DE, one bound policy and one open quote. It is not data
 * Assurant has filed, and it is never created in production.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './helpers';
import { publishedStack, send } from './fixtures';

const enabled = process.env.SEED_SYNTHETIC_STACK === 'true';
let t: TestContext;

beforeAll(async () => {
  if (enabled) t = await createTestApp();
}, 60_000);
afterAll(async () => {
  if (enabled) await t.close();
});

describe.skipIf(!enabled)('seed the synthetic stack', () => {
  it('publishes plan Q-DE, binds one policy and leaves one quote open', async () => {
    const st = await publishedStack(t);
    const q1 = await send(t, 'POST', '/v1/quotes', st.tokens.partner, st.quoteBody({ selection: ['trip_interruption'] }));
    expect(q1.statusCode, q1.body).toBe(201);
    const bound = await send(t, 'POST', `/v1/quotes/${q1.json().id}/bind`, st.tokens.partner, {
      ableToTravel: true,
      acknowledgement: { disclosureVersion: st.disclosureVersion, acknowledgedBy: 'Pat Sample' },
      payment: { reference: `SYNTH-PAY-${Date.now()}`, amount: q1.json().premium.total },
      purchaser: { name: 'Pat Sample', email: 'pat.sample@example.com' },
    }, { 'idempotency-key': `seed-${Date.now()}` });
    expect(bound.statusCode, bound.body).toBe(201);
    const open = await send(t, 'POST', '/v1/quotes', st.tokens.partner, st.quoteBody({ travellers: [{ firstName: 'Ola', lastName: 'Open', dateOfBirth: '1985-02-02', costPerTraveller: '3000' }] }));
    expect(open.statusCode, open.body).toBe(201);
    console.warn(`Seeded: policy ${bound.json().number} and open quote ${open.json().id}`);
  }, 300_000);
});
