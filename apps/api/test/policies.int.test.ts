/**
 * Increment 9: quote, bind, the policy record and cover verification (E04, E05) through the API and
 * database, on a complete published stack (see fixtures.ts). Every rate, limit and disclosure is SYNTHETIC.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, resetDatabase, type TestContext } from './helpers';
import { addDays, publishedStack, send, today, type Stack } from './fixtures';

let t: TestContext;
let st: Stack;

beforeAll(async () => {
  t = await createTestApp();
  await resetDatabase();
  st = await publishedStack(t);
}, 240_000);
afterAll(async () => t.close());

const partner = () => st.tokens.partner;
const quote = (over: Record<string, unknown> = {}, token = partner()) =>
  send(t, 'POST', '/v1/quotes', token, st.quoteBody(over));
const ack = () => ({ disclosureVersion: st.disclosureVersion, acknowledgedBy: 'Pat Sample' });
let refN = 0;
const bindBody = (amount: string, reference = `PAY-${Date.now()}-${refN++}`) => ({
  ableToTravel: true,
  acknowledgement: ack(),
  payment: { reference, amount },
  purchaser: { name: 'Pat Sample', email: 'pat@example.com' },
});
const bind = (
  quoteId: string,
  body: unknown,
  key = `bind-${Date.now()}-${refN++}`,
  token = partner(),
) => send(t, 'POST', `/v1/quotes/${quoteId}/bind`, token, body, { 'idempotency-key': key });

/** Runs SQL as the platform (all accounts visible), for what the API does not yet offer: servicing arrives in Increment 11. */
async function asPlatform<T>(
  fn: (
    q: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>,
  ) => Promise<T>,
): Promise<T> {
  const c = await t.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.account_ids', '*', true)`);
    const out = await fn((sql, params) => c.query(sql, params));
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

describe('quote (E04-F01)', () => {
  it('prices every benefit and traveller, with worksheets, versions, cover dates and the disclosure', async () => {
    const res = await quote();
    expect(res.statusCode, res.body).toBe(201);
    const q = res.json();
    expect(q).toMatchObject({
      status: 'open',
      revision: 1,
      outcome: 'eligible',
      bindable: true,
      notBindable: [],
    });
    expect(q.premium).toMatchObject({
      kind: 'premium',
      total: '84.00',
      perBenefit: [{ benefit: 'TCAN', total: '84.00' }],
      perTraveller: [{ travellerId: 'T1', total: '84.00' }],
    });
    expect(q.premium.lines).toHaveLength(1);
    // The recorded versions.
    expect(q.plan).toMatchObject({ code: 'Q-DE', version: 1 });
    expect(q.ruleSet.version).toBe(1);
    expect(q.manuals).toMatchObject({ TCAN: { code: 'Q-TCAN-DE', version: 1 } });
    expect(q.disclosure).toMatchObject({ version: st.disclosureVersion, state: 'DE' });
    // Cover dates by benefit group: pre-departure starts the day after premium is received.
    const tc = q.benefits.find((b: { code: string }) => b.code === 'trip_cancellation');
    expect(tc).toMatchObject({
      selected: true,
      packaging: 'packaged',
      premium: '84.00',
      coverageStart: `${addDays(today(), 1)}T00:01`,
      coverageEnd: `${st.dates.return}T23:59`,
    });
    expect(q.benefits.find((b: { code: string }) => b.code === 'trip_interruption')).toMatchObject({
      selected: false,
      available: true,
      premium: null,
    });
    // The worksheet behind each line is stored and reproduces exactly.
    const ws = await send(
      t,
      'GET',
      `/v1/rating/worksheets/${q.premium.lines[0].worksheetId}`,
      st.tokens.admin,
    );
    expect(ws.json()).toMatchObject({ amount: '84.00' });
    const again = await send(
      t,
      'POST',
      `/v1/rating/worksheets/${q.premium.lines[0].worksheetId}/reproduce`,
      st.tokens.admin,
    );
    expect(again.json().identical).toBe(true);
  });

  it('re-rates the same quote when optional benefits are added or removed (E04-F01-S02)', async () => {
    const q = (await quote()).json();
    const add = await send(t, 'PUT', `/v1/quotes/${q.id}/selection`, partner(), {
      selection: ['trip_interruption'],
    });
    expect(add.statusCode, add.body).toBe(200);
    expect(add.json()).toMatchObject({ id: q.id, revision: 2, premium: { total: '126.00' } });
    expect(
      add.json().benefits.find((b: { code: string }) => b.code === 'trip_interruption'),
    ).toMatchObject({
      selected: true,
      premium: '42.00',
      coverageStart: `${st.dates.departure}T00:01`,
    });
    // The versions it was made with are kept.
    expect(add.json().manuals.TCAN).toEqual(q.manuals.TCAN);
    const remove = await send(t, 'PUT', `/v1/quotes/${q.id}/selection`, partner(), {
      selection: [],
    });
    expect(remove.json()).toMatchObject({ id: q.id, revision: 3, premium: { total: '84.00' } });
    const bad = await send(t, 'PUT', `/v1/quotes/${q.id}/selection`, partner(), {
      selection: ['trip_cancellation'],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors[0]).toMatchObject({ code: 'unknown_benefit', field: 'selection' });
  });

  it('shows why an option is unavailable, and refuses it when chosen', async () => {
    const late = {
      trip: {
        purchaseDate: st.dates.purchase,
        initialDepositDate: addDays(st.dates.purchase, -25),
        departureDate: st.dates.departure,
        returnDate: st.dates.return,
        destinations: [{ country: 'FR', region: 'Europe' }],
      },
    };
    const q = (await quote(late)).json();
    const delay = q.benefits.find((b: { code: string }) => b.code === 'trip_delay');
    expect(delay).toMatchObject({ available: false });
    expect(delay.reason).toContain('25 days after the initial deposit');
    expect(q.waiver.applies).toBe(false);
    const refused = await quote({ ...late, selection: ['trip_delay'] });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().errors[0]).toMatchObject({
      code: 'benefit_unavailable',
      field: 'selection',
    });
  });

  it('gives each validation error a code, a field and a message (E04-F01-S03)', async () => {
    const noAge = await quote({
      travellers: [{ firstName: 'Pat', lastName: 'Sample', costPerTraveller: '4200' }],
    });
    expect(noAge.statusCode).toBe(400);
    expect(noAge.json().errors[0]).toMatchObject({
      field: expect.any(String),
      message: expect.any(String),
      code: expect.any(String),
    });
    const wrongState = await quote({ state: 'FL' });
    expect(wrongState.statusCode).toBe(400);
    expect(wrongState.json().errors[0]).toMatchObject({ code: 'wrong_state', field: 'state' });
    expect((await quote({ planCode: 'NOPE-PLAN' })).statusCode).toBe(404);
  });

  it('decides eligibility at quote: ineligible and referred cases are priced but cannot be bound', async () => {
    const old = (
      await quote({
        travellers: [
          {
            firstName: 'Olga',
            lastName: 'Old',
            dateOfBirth: '1940-01-01',
            costPerTraveller: '4200',
          },
        ],
      })
    ).json();
    expect(old).toMatchObject({ outcome: 'ineligible', bindable: false });
    expect(old.notBindable[0]).toContain('Maximum age');
    const dear = (
      await quote({
        travellers: [
          {
            firstName: 'Dan',
            lastName: 'Dear',
            dateOfBirth: '1980-05-05',
            costPerTraveller: '9000',
          },
        ],
      })
    ).json();
    expect(dear).toMatchObject({
      outcome: 'referred',
      bindable: false,
      premium: { total: '180.00' },
    });
    expect((await bind(old.id, bindBody('84.00'))).statusCode).toBe(400);
  });

  it('answers within 500 ms for 95% of quotes, excluding network time (E04-F01-S01)', async () => {
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      const r = await quote();
      times.push(performance.now() - started);
      expect(r.statusCode).toBe(201);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
    console.warn(`quote: median ${times[10]!.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms`);
    expect(p95).toBeLessThan(500);
  });
});

describe('bind (E04-F02) and the policy record (E05)', () => {
  it('binds idempotently, only with the acknowledged disclosure and a payment that matches to the cent', async () => {
    const q = (await quote({ selection: ['trip_interruption'] })).json();
    expect(q.premium.total).toBe('126.00');

    // Refusals: no key; the wrong disclosure; a payment that does not match.
    const noKey = await send(t, 'POST', `/v1/quotes/${q.id}/bind`, partner(), bindBody('126.00'), {
      'idempotency-key': '',
    });
    expect(noKey.json().code).toBe('idempotency_key_required');
    const wrongDisclosure = await bind(q.id, {
      ...bindBody('126.00'),
      acknowledgement: { disclosureVersion: 'something-else', acknowledgedBy: 'Pat Sample' },
    });
    expect(wrongDisclosure.statusCode).toBe(400);
    expect(wrongDisclosure.json().errors[0].code).toBe('disclosure_not_acknowledged');
    const short = await bind(q.id, bindBody('125.99'));
    expect(short.statusCode).toBe(400);
    expect(short.json().errors[0].code).toBe('payment_not_confirmed');
    expect((await bind(q.id, { ...bindBody('126.00'), ableToTravel: false })).statusCode).toBe(400);

    const body = bindBody('126.00', 'PAY-IDEMPOTENT-1');
    const first = await bind(q.id, body, 'bind-key-0001');
    expect(first.statusCode, first.body).toBe(201);
    const p = first.json();
    expect(p).toMatchObject({ status: 'active', accountId: st.accountId });
    expect(p.number).toMatch(/^ATP-\d{4}-\d{6}$/);
    expect(p.record).toMatchObject({
      plan: { code: 'Q-DE', version: 1, state: 'DE' },
      ruleSet: { version: 1 },
      manuals: { TCAN: { code: 'Q-TCAN-DE' }, TINT: { code: 'Q-TINT-DE' } },
      disclosure: { version: st.disclosureVersion, acknowledgedBy: 'Pat Sample' },
      payment: { reference: 'PAY-IDEMPOTENT-1', amount: '126.00' },
      premium: { total: '126.00' },
      purchasedOn: today(),
      reviewPeriodEndsAt: `${addDays(today(), 10)}T23:59`,
      waiver: { applies: true },
    });
    // Components follow the plan's underwriting arrangement; cover dates follow its timing.
    expect(p.record.benefits).toEqual([
      expect.objectContaining({
        code: 'trip_cancellation',
        underwriter: 'VSC',
        premium: '84.00',
        limits: { maximum: 5000, basis: 'per person' },
        coverageStart: `${addDays(today(), 1)}T00:01`,
        coverageEnd: `${st.dates.return}T23:59`,
      }),
      expect.objectContaining({
        code: 'trip_interruption',
        underwriter: 'ABIC',
        premium: '42.00',
        limits: { maximum: 7500, basis: 'per person' },
        coverageStart: `${st.dates.departure}T00:01`,
        coverageEnd: `${st.dates.return}T23:59`,
      }),
    ]);
    expect(p.record.term).toEqual({
      start: `${addDays(today(), 1)}T00:01`,
      end: `${st.dates.return}T23:59`,
    });
    expect(p.history).toHaveLength(1);
    expect(p.history[0]).toMatchObject({ type: 'bound', actor: 'svc-quote-a' });

    // A repeated request returns the original policy; another key for the same quote is refused.
    const replay = await bind(q.id, body, 'bind-key-0001');
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json().id).toBe(p.id);
    const other = await bind(q.id, bindBody('126.00'), 'bind-key-0002');
    expect(other.statusCode).toBe(409);
    expect(other.json().detail).toContain(p.number);
    expect((await send(t, 'GET', `/v1/quotes/${q.id}`, partner())).json().status).toBe('bound');

    // The payment reference is used once, and a second policy for the same traveller and dates is refused.
    const q2 = (await quote()).json();
    const reused = await bind(q2.id, bindBody('84.00', 'PAY-IDEMPOTENT-1'));
    expect(reused.statusCode).toBe(400);
    const dup = await bind(q2.id, bindBody('84.00'));
    expect(dup.statusCode).toBe(400);
    expect(dup.json().detail).toContain(`already covered by policy ${p.number}`);
  });

  it('keeps accounts apart: another account cannot see, quote for or bind these', async () => {
    const q = (await quote()).json();
    const b = st.tokens.partnerB;
    expect((await send(t, 'GET', `/v1/quotes/${q.id}`, b)).statusCode).toBe(404);
    expect(
      (await send(t, 'PUT', `/v1/quotes/${q.id}/selection`, b, { selection: [] })).statusCode,
    ).toBe(404);
    expect((await bind(q.id, bindBody('84.00'), undefined, b)).statusCode).toBe(404);
    expect((await quote({}, b)).statusCode).toBe(403);
    expect((await send(t, 'GET', '/v1/quotes', b)).json().items).toEqual([]);
    expect((await send(t, 'GET', '/v1/policies', b)).json().items).toEqual([]);
    const mine = (await send(t, 'GET', '/v1/policies?q=Sample', partner())).json().items;
    expect(mine.length).toBeGreaterThan(0);
    expect((await send(t, 'GET', `/v1/policies/${mine[0].id}`, b)).statusCode).toBe(404);
  });

  it('shows the policy as it was at any moment, changes status only along the lifecycle, and verifies cover', async () => {
    const q = (
      await quote({
        travellers: [
          {
            firstName: 'Vera',
            lastName: 'Verify',
            dateOfBirth: '1975-03-03',
            costPerTraveller: '4200',
          },
        ],
      })
    ).json();
    const bound = await bind(q.id, bindBody('84.00'));
    expect(bound.statusCode, bound.body).toBe(201);
    const p = bound.json();
    const verifier = await t.idp.token({ roles: ['cover_verifier'], sub: 'claims-system' });
    const verify = (on: string, number = p.number, token = verifier) =>
      send(t, 'POST', '/v1/policy-verifications', token, { policyNumber: number, on });

    // Cover verification: in force inside the benefit's window, not before it starts or after it ends.
    const during = (await verify(`${st.dates.departure}T12:00`)).json();
    expect(during).toMatchObject({
      found: true,
      status: 'active',
      inForce: true,
      plan: 'Q-DE',
      travellers: ['Vera Verify'],
    });
    expect(during.benefits[0]).toMatchObject({
      code: 'trip_cancellation',
      inForceOnDate: true,
      limits: { maximum: 5000 },
    });
    const before = (await verify(`${today()}T12:00`)).json();
    expect(before).toMatchObject({ inForce: false });
    expect(before.reasons[0]).toContain('No benefit');
    expect((await verify(st.dates.return)).json().inForce).toBe(true);
    expect((await verify(addDays(st.dates.return, 1))).json().inForce).toBe(false);
    expect((await verify('2026-12-01', 'ATP-0000-000000')).json()).toMatchObject({ found: false });
    expect((await verify(st.dates.departure, p.number, partner())).statusCode).toBe(403);

    // Status changes only through the lifecycle's edges; events and policies are records.
    await new Promise((r) => setTimeout(r, 30));
    const beforeCancel = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 30));
    await asPlatform(async (db) => {
      await db(`UPDATE policies.policies SET status = 'cancelled' WHERE id = $1`, [p.id]);
      await db(
        `INSERT INTO policies.policy_events (policy_id, account_id, type, actor, actor_name, reason, data) VALUES ($1, $2, 'status_changed', 'service-1', 'Sam Service', 'Traveller cancelled in the review period', $3)`,
        [p.id, st.accountId, JSON.stringify({ to: 'cancelled' })],
      );
    });
    await expect(
      asPlatform((db) =>
        db(`UPDATE policies.policies SET status = 'active' WHERE id = $1`, [p.id]),
      ),
    ).rejects.toThrow(/cannot become/);
    await expect(
      asPlatform((db) =>
        db(`UPDATE policies.policies SET payment_reference = 'x' WHERE id = $1`, [p.id]),
      ),
    ).rejects.toThrow(/changes through events/);
    // The premium follows the record only while the policy is active (servicing, Increment 11).
    await expect(
      asPlatform((db) =>
        db(`UPDATE policies.policies SET premium_total = 1 WHERE id = $1`, [p.id]),
      ),
    ).rejects.toThrow(/cannot change/);
    await expect(
      asPlatform((db) =>
        db(`UPDATE policies.policy_events SET reason = 'x' WHERE policy_id = $1`, [p.id]),
      ),
    ).rejects.toThrow(/append-only|permission denied/);
    await expect(
      asPlatform((db) => db(`DELETE FROM policies.policies WHERE id = $1`, [p.id])),
    ).rejects.toThrow(/cannot be deleted|permission denied/);

    // The point-in-time view: active before the cancellation, cancelled after it, non-existent before it was bound.
    const now = (await send(t, 'GET', `/v1/policies/${p.id}`, partner())).json();
    expect(now.status).toBe('cancelled');
    expect(now.history.map((e: { type: string }) => e.type)).toEqual(['bound', 'status_changed']);
    expect(now.history[1]).toMatchObject({
      actor: 'service-1',
      actorName: 'Sam Service',
      reason: 'Traveller cancelled in the review period',
    });
    expect(
      (
        await send(
          t,
          'GET',
          `/v1/policies/${p.id}?asOf=${encodeURIComponent(beforeCancel)}`,
          partner(),
        )
      ).json(),
    ).toMatchObject({ status: 'active', asOf: beforeCancel });
    expect(
      (await send(t, 'GET', `/v1/policies/${p.id}?asOf=2020-01-01T00:00:00Z`, partner()))
        .statusCode,
    ).toBe(404);
    expect((await verify(`${st.dates.departure}T12:00`)).json()).toMatchObject({
      status: 'cancelled',
      inForce: false,
    });
  });

  it('stops a bind at an underwriter’s referral, and goes through only if it is cleared', async () => {
    const dear = {
      travellers: [
        { firstName: 'Dan', lastName: 'Dear', dateOfBirth: '1981-06-06', costPerTraveller: '9000' },
      ],
    };
    const q = (await quote(dear)).json();
    const blocked = await bind(q.id, bindBody('180.00'));
    expect(blocked.statusCode, blocked.body).toBe(412);
    expect(blocked.json().errors[0].code).toBe('referral_required');
    const referralId = blocked.json().errors[0].message as string;
    const open = (await send(t, 'GET', '/v1/referrals?status=open', st.tokens.uw1)).json().items;
    expect(open).toEqual([
      expect.objectContaining({
        id: referralId,
        caseRef: q.id,
        kind: 'underwriting',
        stage: 'bind',
      }),
    ]);
    // Asking again does not raise another referral.
    await bind(q.id, bindBody('180.00'));
    expect(
      (await send(t, 'GET', '/v1/referrals?status=open', st.tokens.uw1)).json().items,
    ).toHaveLength(1);
    expect(
      (
        await send(t, 'POST', `/v1/referrals/${referralId}/decision`, st.tokens.uw1, {
          decision: 'approved',
          reason: 'The trip cost is correct for this trip.',
        })
      ).statusCode,
    ).toBe(200);
    const through = await bind(q.id, bindBody('180.00'));
    expect(through.statusCode, through.body).toBe(201);

    // A declined case cannot be bound.
    const q2 = (
      await quote({
        travellers: [
          {
            firstName: 'Dora',
            lastName: 'Declined',
            dateOfBirth: '1982-07-07',
            costPerTraveller: '9000',
          },
        ],
      })
    ).json();
    const blocked2 = await bind(q2.id, bindBody('180.00'));
    await send(
      t,
      'POST',
      `/v1/referrals/${blocked2.json().errors[0].message}/decision`,
      st.tokens.uw1,
      { decision: 'declined', reason: 'Out of line with the plan.' },
    );
    const declined = await bind(q2.id, bindBody('180.00'));
    expect(declined.statusCode).toBe(412);
    expect(declined.json().errors[0].code).toBe('referral_declined');
  });

  it('holds a bind on a possible sanctions match until it is cleared', async () => {
    const q = (
      await quote({
        travellers: [
          {
            firstName: 'Sam',
            lastName: 'Sanctioned',
            dateOfBirth: '1990-09-09',
            costPerTraveller: '4200',
          },
        ],
      })
    ).json();
    expect(q.outcome).toBe('eligible');
    // A newer list now names this traveller.
    const csv = [
      '9100,"SANCTIONED, Sam",individual,SYNTH,-0-,-0-,-0-,-0-,-0-,-0-,-0-,"DOB 09 Sep 1990"',
    ].join('\n');
    const list = await send(t, 'POST', '/v1/sanctions-lists', st.tokens.compliance, {
      source: 'Synthetic list 2',
      sdnCsv: csv,
    });
    expect(
      (
        await send(t, 'POST', `/v1/sanctions-lists/${list.json().id}/decision`, st.tokens.uw1, {
          decision: 'approve',
          reason: 'Matches the file.',
        })
      ).statusCode,
    ).toBe(200);
    const held = await bind(q.id, bindBody('84.00'));
    expect(held.statusCode, held.body).toBe(412);
    expect(held.json().errors[0].code).toBe('sanctions_hold');
    const referral = (
      await send(t, 'GET', `/v1/referrals/${held.json().errors[0].message}`, st.tokens.uw1)
    ).json();
    expect(referral).toMatchObject({ kind: 'sanctions', status: 'open' });
    await send(t, 'POST', `/v1/referrals/${referral.id}/decision`, st.tokens.uw1, {
      decision: 'approved',
      reason: 'A different person: date of birth and nationality differ.',
    });
    expect((await bind(q.id, bindBody('84.00'))).statusCode).toBe(201);
  });
});
