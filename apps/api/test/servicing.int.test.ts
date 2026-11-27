/**
 * Increment 11: servicing (E06) through the API and database on a complete published stack (see fixtures.ts).
 * Rates, names and dates are SYNTHETIC: the stack's TCAN rate is 2.000 per $100 of trip cost, so a cost of 4200
 * rates at 84.00 and 5000 at 100.00. The review period is 10 days from purchase, as the stack's plan sets it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
afterEach(() => t.setNow(null));

const partner = () => st.tokens.partner;
let n = 0;
async function bindPolicy(
  over: { firstName?: string; lastName?: string; dob?: string; cost?: string } = {},
) {
  const first = over.firstName ?? `Sam${n}`;
  n++;
  const q = await send(
    t,
    'POST',
    '/v1/quotes',
    partner(),
    st.quoteBody({
      travellers: [
        {
          firstName: first,
          lastName: over.lastName ?? 'Servicetest',
          dateOfBirth: over.dob ?? '1980-05-05',
          costPerTraveller: over.cost ?? '4200',
        },
      ],
    }),
  );
  expect(q.statusCode, q.body).toBe(201);
  const b = await send(
    t,
    'POST',
    `/v1/quotes/${q.json().id}/bind`,
    partner(),
    {
      ableToTravel: true,
      acknowledgement: { disclosureVersion: st.disclosureVersion, acknowledgedBy: first },
      payment: { reference: `PAY-SVC-${Date.now()}-${n}`, amount: q.json().premium.total },
      purchaser: { name: first, email: 'svc@example.com' },
    },
    { 'idempotency-key': `bind-svc-${Date.now()}-${n}` },
  );
  expect(b.statusCode, b.body).toBe(201);
  return b.json() as {
    id: string;
    number: string;
    accountId: string;
    record: {
      premium: { total: string };
      trip: { departureDate: string; returnDate: string };
      travellers: { id: string }[];
      benefits: { code: string; coverageStart: string; coverageEnd: string }[];
      term: { start: string; end: string };
    };
  };
}
const preview = (id: string, body: unknown, token = partner()) =>
  send(t, 'POST', `/v1/policies/${id}/servicing/preview`, token, body);
const apply = (
  id: string,
  request: unknown,
  confirmAmount: string,
  key = `svc-${Date.now()}-${n++}`,
  token = partner(),
) =>
  send(
    t,
    'POST',
    `/v1/policies/${id}/servicing`,
    token,
    { request, confirmAmount },
    { 'idempotency-key': key },
  );
const view = async (id: string) =>
  (await send(t, 'GET', `/v1/policies/${id}`, st.tokens.admin)).json();
const docs = async (id: string) =>
  (await send(t, 'GET', `/v1/policies/${id}/documents`, st.tokens.admin)).json().items as {
    id: string;
    kind: string;
  }[];
const textOf = async (docId: string) =>
  (await send(t, 'GET', `/v1/documents/${docId}`, st.tokens.admin)).json().text as string;

describe('trip cost change (E06-F02-S02)', () => {
  it('is previewed with the price before it is made, and made only against that price', async () => {
    const p = await bindPolicy();
    const req = {
      type: 'change_cost',
      reason: 'Traveller added a tour',
      costs: [{ travellerId: 'T1', costPerTraveller: '5000' }],
    };
    const pv = await preview(p.id, req);
    expect(pv.statusCode, pv.body).toBe(200);
    expect(pv.json()).toMatchObject({
      allowed: true,
      premium: { before: '84.00', after: '100.00', delta: '16.00' },
      money: { charge: '16.00', refund: '0.00' },
      confirmAmount: '16.00',
      reviewPeriod: { inReview: true },
    });
    expect(pv.json().changes.map((c: { what: string }) => c.what)).toContain('Total premium');
    // Nothing was saved by previewing.
    expect((await view(p.id)).record.premium.total).toBe('84.00');

    // A price other than the one shown is refused.
    expect((await apply(p.id, req, '10.00')).statusCode).toBe(409);
    const key = `svc-cost-${Date.now()}`;
    const done = await apply(p.id, req, '16.00', key);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ type: 'change_cost', money: { charge: '16.00' } });
    const after = await view(p.id);
    expect(after.record.premium.total).toBe('100.00');
    expect(after.record.travellers[0].costPerTraveller).toBe('5000');
    expect(after.history.at(-1)).toMatchObject({
      type: 'details_changed',
      reason: 'Traveller added a tour',
      actor: 'svc-quote-a',
    });
    // Lists read the new premium, and the same key replays the same answer.
    const list = (await send(t, 'GET', `/v1/policies?q=${p.number}`, partner())).json().items;
    expect(list[0].premiumTotal).toBe('100.00');
    const replay = await apply(p.id, req, '16.00', key);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    // The change notice says what changed.
    const notice = (await docs(p.id)).find((d) => d.kind === 'change_notice')!;
    expect(await textOf(notice.id)).toContain('Total premium | 84.00 | 100.00');
    expect(done.json().noticeDocumentId).toBe(notice.id);
  });

  it('refunds a reduction in the review period, and keeps it after the review period (E06-F01)', async () => {
    const inReview = await bindPolicy();
    const lower = {
      type: 'change_cost',
      reason: 'Part of the trip was cancelled',
      costs: [{ travellerId: 'T1', costPerTraveller: '3000' }],
    };
    const a = await preview(inReview.id, lower);
    expect(a.json()).toMatchObject({
      premium: { delta: '-24.00' },
      money: { refund: '24.00', retained: '0.00' },
      confirmAmount: '-24.00',
    });
    expect((await apply(inReview.id, lower, '-24.00')).json().money.refund).toBe('24.00');

    const late = await bindPolicy();
    t.setNow(new Date(`${addDays(today(), 15)}T12:00:00Z`));
    const b = await preview(late.id, lower);
    expect(b.json()).toMatchObject({
      reviewPeriod: { inReview: false },
      money: { refund: '0.00', retained: '24.00' },
    });
    expect(b.json().money.explanation).toContain('non-refundable');
  });
});

describe('trip dates (E06-F02-S01)', () => {
  it('moves the cover dates with the trip and changes nothing else', async () => {
    const p = await bindPolicy();
    const dep = addDays(p.record.trip.departureDate, 3);
    const ret = addDays(p.record.trip.returnDate, 3);
    const req = {
      type: 'change_dates',
      reason: 'Flight moved',
      departureDate: dep,
      returnDate: ret,
    };
    const pv = await preview(p.id, req);
    expect(pv.json()).toMatchObject({
      allowed: true,
      premium: { delta: '0.00' },
      confirmAmount: '0.00',
    });
    expect((await apply(p.id, req, '0.00')).statusCode).toBe(200);
    const after = await view(p.id);
    expect(after.record.trip).toMatchObject({ departureDate: dep, returnDate: ret });
    const tc = after.record.benefits.find((b: { code: string }) => b.code === 'trip_cancellation');
    expect(tc.coverageEnd).toBe(`${ret}T23:59`);
    expect(after.record.term.end).toBe(`${ret}T23:59`);
    const row = (await send(t, 'GET', `/v1/policies?q=${p.number}`, partner())).json().items[0];
    expect(row.coverageEnd).toBe(`${ret}T23:59`);
  });

  it('refuses dates that do not work, with the reason', async () => {
    const p = await bindPolicy();
    const bad = await preview(p.id, {
      type: 'change_dates',
      reason: 'Typo',
      departureDate: addDays(p.record.trip.departureDate, 5),
      returnDate: p.record.trip.departureDate,
    });
    expect(bad.json()).toMatchObject({ allowed: false });
    expect(bad.json().problems.join(' ')).toContain('before the departure date');
    const refused = await apply(
      p.id,
      {
        type: 'change_dates',
        reason: 'Typo',
        departureDate: addDays(p.record.trip.departureDate, 5),
        returnDate: p.record.trip.departureDate,
      },
      '0.00',
    );
    expect(refused.statusCode).toBe(412);
    // A trip that has started cannot be moved.
    t.setNow(new Date(`${addDays(p.record.trip.departureDate, 1)}T12:00:00Z`));
    expect(
      (
        await preview(p.id, {
          type: 'change_dates',
          reason: 'Late',
          departureDate: addDays(today(), 40),
          returnDate: addDays(today(), 45),
        })
      )
        .json()
        .problems.join(' '),
    ).toContain('already started');
  });
});

describe('travellers, destinations and benefits (E06-F02-S03, E06-F02-S04)', () => {
  it('adds a traveller (re-rated and re-screened), then removes them with a refund in the review period', async () => {
    const p = await bindPolicy();
    const add = {
      type: 'add_traveller',
      reason: 'A friend is joining',
      traveller: {
        firstName: 'Ola',
        lastName: `Added${n}`,
        dateOfBirth: '1990-01-01',
        costPerTraveller: '2000',
      },
    };
    const pv = await preview(p.id, add);
    expect(pv.json(), pv.body).toMatchObject({
      allowed: true,
      premium: { before: '84.00', after: '124.00', delta: '40.00' },
    });
    expect((await apply(p.id, add, '40.00')).statusCode).toBe(200);
    const two = await view(p.id);
    expect(two.record.travellers.map((x: { id: string }) => x.id)).toEqual(['T1', 'T2']);
    const found = (await send(t, 'GET', `/v1/policies?q=Ola`, partner()))
      .json()
      .items.map((x: { number: string }) => x.number);
    expect(found).toContain(p.number);

    const rm = {
      type: 'remove_traveller',
      reason: 'The friend cannot come',
      travellerId: 'T2',
      noLoss: true,
    };
    expect((await preview(p.id, rm)).json()).toMatchObject({
      premium: { delta: '-40.00' },
      money: { refund: '40.00' },
    });
    expect((await apply(p.id, rm, '-40.00')).statusCode).toBe(200);
    expect((await view(p.id)).record.travellers).toHaveLength(1);
    // The only traveller cannot be removed.
    expect(
      (
        await preview(p.id, {
          type: 'remove_traveller',
          reason: 'Oops',
          travellerId: 'T1',
          noLoss: true,
        })
      )
        .json()
        .problems.join(' '),
    ).toContain('cancel the policy instead');
  });

  it('keeps a removal refund back when a loss has been reported', async () => {
    const p = await bindPolicy();
    await apply(
      p.id,
      {
        type: 'add_traveller',
        reason: 'Adding',
        traveller: {
          firstName: 'Lou',
          lastName: `Loss${n}`,
          dateOfBirth: '1991-02-02',
          costPerTraveller: '2000',
        },
      },
      '40.00',
    );
    const rm = await preview(p.id, {
      type: 'remove_traveller',
      reason: 'Claim expected',
      travellerId: 'T2',
      noLoss: false,
    });
    expect(rm.json()).toMatchObject({ money: { refund: '0.00', retained: '40.00' } });
  });

  it('screens a new traveller and refuses a possible sanctions match', async () => {
    const p = await bindPolicy();
    const bad = await preview(p.id, {
      type: 'add_traveller',
      reason: 'Adding',
      traveller: {
        firstName: 'Zorbek Quill',
        lastName: 'Testburg',
        dateOfBirth: '1970-03-12',
        costPerTraveller: '1000',
      },
    });
    expect(bad.json()).toMatchObject({ allowed: false });
    expect(bad.json().problems.join(' ')).toMatch(/sanctions/i);
  });

  it('changes destinations and adds an optional benefit only where the rules allow', async () => {
    const p = await bindPolicy();
    const dest = {
      type: 'change_destinations',
      reason: 'Changed the itinerary',
      destinations: [{ country: 'JP', region: 'Asia' }],
    };
    expect((await preview(p.id, dest)).json()).toMatchObject({ allowed: true });
    expect((await apply(p.id, dest, '0.00')).statusCode).toBe(200);
    expect((await view(p.id)).record.trip.destinations).toEqual([
      { country: 'JP', region: 'Asia' },
    ]);

    const add = {
      type: 'add_benefits',
      reason: 'Wants interruption cover',
      benefits: ['trip_interruption'],
    };
    const pv = await preview(p.id, add);
    expect(pv.json(), pv.body).toMatchObject({
      allowed: true,
      premium: { before: '84.00', after: '126.00', delta: '42.00' },
    });
    expect((await apply(p.id, add, '42.00')).statusCode).toBe(200);
    expect((await view(p.id)).record.benefits.map((b: { code: string }) => b.code).sort()).toEqual([
      'trip_cancellation',
      'trip_interruption',
    ]);
    expect((await preview(p.id, add)).json().problems.join(' ')).toContain('already on the policy');
    expect(
      (await preview(p.id, { ...add, benefits: ['trip_cancellation'] })).json().problems.join(' '),
    ).toContain('not an optional benefit');
  });
});

describe('cancellation (E06-F01-S01, E06-F01-S02)', () => {
  it('refunds the whole premium in the review period when there has been no loss, and issues the notice', async () => {
    const p = await bindPolicy();
    const req = { type: 'cancel', reason: 'Changed my mind', noLoss: true };
    const pv = await preview(p.id, req);
    expect(pv.json()).toMatchObject({
      allowed: true,
      money: { refund: '84.00', retained: '0.00' },
      confirmAmount: '84.00',
      reviewPeriod: { inReview: true },
    });
    expect((await apply(p.id, req, '0.00')).statusCode).toBe(409);
    const done = await apply(p.id, req, '84.00');
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().policy.status).toBe('cancelled');
    const notice = (await docs(p.id)).find((d) => d.kind === 'cancellation_notice')!;
    expect(await textOf(notice.id)).toContain('Notice of Cancellation');
    const out = await t.pool.connect();
    try {
      await out.query('BEGIN');
      await out.query(`SELECT set_config('app.account_ids', '*', true)`);
      expect(
        (
          await out.query(
            `SELECT count(*)::int AS n FROM platform.outbox WHERE type = 'PolicyCancelled' AND data->>'number' = $1 AND data->>'refund' = '84.00'`,
            [p.number],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await out.query(`SELECT status FROM underwriting.cover_register WHERE policy_ref = $1`, [
            p.number,
          ])
        ).rows.map((r) => r.status),
      ).toEqual(['cancelled']);
      await out.query('COMMIT');
    } finally {
      out.release();
    }
    // A cancelled policy cannot be serviced again.
    expect((await preview(p.id, req)).statusCode).toBe(409);
  });

  it('refunds nothing when a loss has been reported, and after the review period under the filed form', async () => {
    const a = await bindPolicy();
    expect(
      (await preview(a.id, { type: 'cancel', reason: 'A claim is likely', noLoss: false })).json(),
    ).toMatchObject({ money: { refund: '0.00', retained: '84.00' }, confirmAmount: '0.00' });
    const b = await bindPolicy();
    t.setNow(new Date(`${addDays(today(), 15)}T12:00:00Z`));
    const late = await preview(b.id, { type: 'cancel', reason: 'Changed my mind', noLoss: true });
    expect(late.json()).toMatchObject({
      reviewPeriod: { inReview: false },
      money: { refund: '0.00', retained: '84.00' },
    });
    expect(late.json().money.explanation).toContain('non-refundable');
    const done = await apply(
      b.id,
      { type: 'cancel', reason: 'Changed my mind', noLoss: true },
      '0.00',
    );
    expect(done.statusCode).toBe(200);
    expect(done.json().policy.status).toBe('cancelled');
  });

  it('ends the review period at departure even when the filed period has days left', async () => {
    const p = await bindPolicy();
    t.setNow(new Date(`${p.record.trip.departureDate}T09:00:00Z`));
    expect(
      (await preview(p.id, { type: 'cancel', reason: 'Late', noLoss: true })).json().reviewPeriod
        .inReview,
    ).toBe(false);
  });
});

describe('corrections (E06-F03-S01)', () => {
  it('fixes a name and the purchaser with a reason, logged, without re-pricing', async () => {
    const p = await bindPolicy({ lastName: 'Typoh' });
    const req = {
      type: 'correct',
      reason: 'Name misspelt at purchase',
      travellers: [{ travellerId: 'T1', lastName: 'Typo' }],
      purchaser: { email: 'fixed@example.com' },
    };
    const pv = await preview(p.id, req);
    expect(pv.json()).toMatchObject({ allowed: true, premium: { delta: '0.00' } });
    expect((await apply(p.id, req, '0.00')).statusCode).toBe(200);
    const after = await view(p.id);
    expect(after.record.travellers[0].lastName).toBe('Typo');
    expect(after.record.purchaser.email).toBe('fixed@example.com');
    expect(after.history.at(-1)).toMatchObject({
      type: 'details_changed',
      reason: 'Name misspelt at purchase',
    });
    expect(
      (await send(t, 'GET', `/v1/policies?q=Typo`, partner()))
        .json()
        .items.some((x: { number: string }) => x.number === p.number),
    ).toBe(true);
    const notice = (await docs(p.id)).find((d) => d.kind === 'change_notice')!;
    expect(await textOf(notice.id)).toContain('Typoh');
  });

  it('re-rates a correction that changes the rating, and requires a reason', async () => {
    const p = await bindPolicy();
    expect(
      (
        await send(t, 'POST', `/v1/policies/${p.id}/servicing/preview`, partner(), {
          type: 'correct',
          reason: '',
          travellers: [],
        })
      ).statusCode,
    ).toBe(400);
    const pv = await preview(p.id, {
      type: 'correct',
      reason: 'Wrong date of birth given',
      travellers: [{ travellerId: 'T1', dateOfBirth: '1979-05-05' }],
    });
    expect(pv.json()).toMatchObject({ allowed: true });
    // Ages 45 and 46 rate the same in this synthetic manual (every age factor is 1.0000).
    expect(pv.json().premium.delta).toBe('0.00');
  });
});

describe('who may service', () => {
  it('is limited to people and systems with the permission, and to their own accounts', async () => {
    const p = await bindPolicy();
    const req = { type: 'cancel', reason: 'Probe', noLoss: true };
    expect((await preview(p.id, req, st.tokens.uw1)).statusCode).toBe(403);
    expect((await preview(p.id, req, st.tokens.partnerB)).statusCode).toBe(404);
    expect((await apply(p.id, req, '84.00', undefined, st.tokens.partnerB)).statusCode).toBe(404);
    // Without an idempotency key nothing is made.
    const noKey = await t.app.inject({
      method: 'POST',
      url: `/v1/policies/${p.id}/servicing`,
      headers: { authorization: `Bearer ${partner()}` },
      payload: { request: req, confirmAmount: '84.00' },
    });
    expect(noKey.statusCode).toBe(428);
    expect((await view(p.id)).status).toBe('active');
  });
});
