/**
 * E21 card-linked cover: programme set-up and go-live (E21-F01), eligibility feeds and the ledger
 * (E21-F02), and cover verification for claims (E21-F03-S01). Feeds go through the real API, file
 * store and processor against PostgreSQL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FeedProcessor } from '@astra/card';
import { createLogger } from '@astra/platform';
import { bearer, createTestApp, insertAccount, resetDatabase, type TestContext } from './helpers';

let t: TestContext;
let processor: FeedProcessor;
let manager: string;
let issuerAccount: string;
let issuerToken: string;

beforeAll(async () => {
  t = await createTestApp();
  processor = new FeedProcessor(t.pool, t.files, createLogger('card-test', 'fatal'));
});
afterAll(async () => t.close());

beforeEach(async () => {
  await resetDatabase();
  manager = await t.idp.token({ roles: ['card_programme_manager'], sub: 'cpm-1' });
  issuerAccount = await insertAccount(t.pool, 'SWANBANK', 'card_issuer');
  issuerToken = await t.idp.token({
    roles: ['partner_developer'],
    accountId: issuerAccount,
    sub: 'svc-swanbank',
  });
});

let keySeq = 0;
async function post(url: string, token: string, payload: unknown) {
  return t.app.inject({
    method: 'POST',
    url,
    headers: { ...bearer(token), 'idempotency-key': `card-${Date.now()}-${keySeq++}` },
    payload: payload as object,
  });
}

async function setUpProgramme(overrides: Record<string, unknown> = {}) {
  const mp = await post('/v1/master-policies', manager, {
    accountId: issuerAccount,
    policyNumber: 'MP-SWAN-001',
    underwriter: 'VSC',
    states: ['NY', 'CA', 'TX'],
    effectiveFrom: '2025-01-01',
  });
  expect(mp.statusCode, mp.body).toBe(201);
  const res = await post('/v1/card-programmes', manager, {
    masterPolicyId: mp.json().id,
    code: 'SWAN-TRAVEL',
    name: 'Swan Bank Platinum travel cover',
    cardProduct: 'Platinum Visa',
    states: ['NY', 'CA'],
    effectiveFrom: '2025-01-01',
    paymentCondition: { rule: 'partial', minimumPercent: 50 },
    eligibilityRule: 'purchase_date',
    maxRejectPercent: 10,
    ...overrides,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; status: string };
}

function feed(seq: number, kind: 'FULL' | 'CHANGE', asOf: string, details: string[]) {
  const counts = { A: 0, U: 0, D: 0 } as Record<string, number>;
  for (const d of details) {
    const action = d.split('|')[3];
    if (action && action in counts) counts[action]! += 1;
  }
  return [
    `H|ASTRA-ELIG|1|SWAN-TRAVEL|${seq}|${kind}|${asOf}`,
    ...details,
    `T|${details.length}|${counts.A}|${counts.U}|${counts.D}`,
    '',
  ].join('\n');
}

async function upload(
  programmeId: string,
  mode: 'live' | 'test',
  body: string,
  token = issuerToken,
) {
  return t.app.inject({
    method: 'POST',
    url: `/v1/card-programmes/${programmeId}/feeds?mode=${mode}&fileName=feed.txt`,
    headers: { ...bearer(token), 'content-type': 'application/octet-stream' },
    payload: Buffer.from(body, 'utf8'),
  });
}

async function processAll() {
  for (let i = 0; i < 20; i++) {
    const id = await processor.claimNext();
    if (!id) return;
    await processor.process(id);
  }
  throw new Error('feed processing did not settle');
}

async function getFeed(programmeId: string, feedId: string) {
  const res = await t.app.inject({
    method: 'GET',
    url: `/v1/card-programmes/${programmeId}/feeds/${feedId}`,
    headers: bearer(manager),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function eligibility(programmeId: string, accountRef: string, date: string) {
  const res = await post(`/v1/card-programmes/${programmeId}/eligibility-checks`, manager, {
    accountRef,
    date,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function goLive(programmeId: string) {
  const testFeed = await upload(
    programmeId,
    'test',
    feed(1, 'FULL', '2026-01-01', ['D|tok_test1|PLAT|A|2025-01-01|']),
  );
  expect(testFeed.statusCode, testFeed.body).toBe(202);
  await processAll();
  const res = await post(`/v1/card-programmes/${programmeId}/go-live`, manager, {
    reason: 'Test feed passed; go-live approved.',
  });
  expect(res.statusCode, res.body).toBe(200);
}

describe('programme set-up and go-live (E21-F01)', () => {
  it('keeps a programme in draft until a test feed passes, and test feeds never touch the ledger', async () => {
    const p = await setUpProgramme();
    expect(p.status).toBe('draft');

    const early = await post(`/v1/card-programmes/${p.id}/go-live`, manager, {
      reason: 'Trying to skip testing.',
    });
    expect(early.statusCode).toBe(412);

    const live = await upload(
      p.id,
      'live',
      feed(1, 'FULL', '2026-01-01', ['D|tok_a1|PLAT|A|2025-01-01|']),
    );
    expect(live.statusCode).toBe(412);

    const bad = await upload(
      p.id,
      'test',
      'H|ASTRA-ELIG|1|SWAN-TRAVEL|1|FULL|2026-01-01\nD|tok_a1|PLAT|A|2025-01-01|\n',
    );
    expect(bad.statusCode).toBe(202);
    await processAll();
    const failed = await getFeed(p.id, bad.json().id);
    expect(failed.status).toBe('failed');
    expect(failed.statusReason).toContain('no trailer');

    const good = await upload(
      p.id,
      'test',
      feed(1, 'FULL', '2026-01-01', ['D|tok_a1|PLAT|A|2025-01-01|', 'D|tok_a2|GOLD|A|2025-01-01|']),
    );
    await processAll();
    const passed = await getFeed(p.id, good.json().id);
    expect(passed.status).toBe('passed');
    expect(passed.stats).toMatchObject({ detailRecords: 2, added: 2, certificatesIssued: 0 });
    expect((await eligibility(p.id, 'tok_a1', '2026-02-01')).eligible).toBe(false);

    const res = await post(`/v1/card-programmes/${p.id}/go-live`, manager, {
      reason: 'Test feed passed; go-live approved.',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('live');
  });

  it('refuses programme states outside the master policy', async () => {
    await setUpProgramme();
    const policies = await t.app.inject({
      method: 'GET',
      url: '/v1/master-policies',
      headers: bearer(manager),
    });
    const res = await post('/v1/card-programmes', manager, {
      masterPolicyId: policies.json().items[0].id,
      code: 'SWAN-OTHER',
      name: 'Other',
      cardProduct: 'Gold',
      states: ['FL'],
      effectiveFrom: '2025-01-01',
      paymentCondition: { rule: 'none' },
      eligibilityRule: 'purchase_date',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('FL');
  });
});

describe('eligibility feeds (E21-F02)', () => {
  it('applies a full feed, issues certificates and never stores card numbers', async () => {
    const p = await setUpProgramme({ maxRejectPercent: 50 });
    await goLive(p.id);
    const res = await upload(
      p.id,
      'live',
      feed(1, 'FULL', '2026-03-01', [
        'D|tok_a1|PLAT|A|2025-06-01|',
        'D|tok_a2|GOLD|A|2025-06-01|2026-12-31',
        'D|4111111111111111|PLAT|A|2025-06-01|',
      ]),
    );
    expect(res.statusCode, res.body).toBe(202);
    await processAll();
    const f = await getFeed(p.id, res.json().id);
    expect(f.status, f.statusReason).toBe('applied');
    expect(f.stats).toMatchObject({
      detailRecords: 3,
      rejectedRecords: 1,
      added: 2,
      certificatesIssued: 2,
    });

    const rejections = await t.app.inject({
      method: 'GET',
      url: `/v1/card-programmes/${p.id}/feeds/${f.id}/rejections`,
      headers: bearer(manager),
    });
    expect(rejections.json().items).toEqual([
      expect.objectContaining({ lineNumber: 4, code: 'card_number', accountRef: null }),
    ]);
    const owner = await t.pool.connect();
    try {
      await owner.query('BEGIN');
      await owner.query(`SELECT set_config('app.account_ids', '*', true)`);
      for (const table of [
        'feed_records',
        'feed_rejections',
        'eligibility_periods',
        'certificates',
      ]) {
        const found = await owner.query(
          `SELECT 1 FROM card.${table} WHERE account_ref LIKE '%4111%'`,
        );
        expect(found.rowCount, table).toBe(0);
      }
      await owner.query('ROLLBACK');
    } finally {
      owner.release();
    }

    const a2 = await eligibility(p.id, 'tok_a2', '2026-12-31');
    expect(a2).toMatchObject({
      eligible: true,
      productCode: 'GOLD',
      period: { from: '2025-06-01', to: '2026-12-31' },
    });
    expect(a2.supportedByFeed).toMatchObject({ id: f.id, sequence: 1, asOfDate: '2026-03-01' });
    expect((await eligibility(p.id, 'tok_a2', '2027-01-01')).eligible).toBe(false);

    const programme = await t.app.inject({
      method: 'GET',
      url: `/v1/card-programmes/${p.id}`,
      headers: bearer(manager),
    });
    expect(programme.json()).toMatchObject({
      lastAppliedSequence: 1,
      certificates: 2,
      accountsOnFile: 2,
      // tok_a2's eligibility ends on 2026-12-31.
      eligibleToday: new Date().toISOString().slice(0, 10) <= '2026-12-31' ? 2 : 1,
    });

    // The same file again is the same feed.
    const again = await upload(
      p.id,
      'live',
      feed(1, 'FULL', '2026-03-01', [
        'D|tok_a1|PLAT|A|2025-06-01|',
        'D|tok_a2|GOLD|A|2025-06-01|2026-12-31',
        'D|4111111111111111|PLAT|A|2025-06-01|',
      ]),
    );
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(f.id);
  });

  it('requires the first live feed to be full', async () => {
    const p = await setUpProgramme();
    await goLive(p.id);
    const res = await upload(
      p.id,
      'live',
      feed(1, 'CHANGE', '2026-03-01', ['D|tok_a1|PLAT|A|2025-06-01|']),
    );
    await processAll();
    const f = await getFeed(p.id, res.json().id);
    expect(f.status).toBe('held');
    expect(f.statusReason).toContain('must be a full feed');
  });

  it('applies changes from the as-of date and keeps the earlier answer reproducible', async () => {
    const p = await setUpProgramme({ maxRejectPercent: 50 });
    await goLive(p.id);
    const full = await upload(
      p.id,
      'live',
      feed(1, 'FULL', '2026-03-01', [
        'D|tok_a1|PLAT|A|2025-06-01|',
        'D|tok_a2|GOLD|A|2025-06-01|',
        'D|tok_a3|GOLD|A|2025-06-01|',
      ]),
    );
    await processAll();
    const change = await upload(
      p.id,
      'live',
      feed(2, 'CHANGE', '2026-04-01', [
        'D|tok_a1|BLACK|U|2025-06-01|', // product change from 1 April
        'D|tok_a2|GOLD|D|2025-06-01|2026-04-15', // removed after 15 April
        'D|tok_a4|PLAT|A|2026-03-20|', // new, eligible from its own date
        'D|tok_zz|PLAT|U|2025-06-01|', // unknown: rejected
      ]),
    );
    await processAll();
    const f = await getFeed(p.id, change.json().id);
    expect(f.status, f.statusReason).toBe('applied');
    expect(f.stats).toMatchObject({
      added: 1,
      updated: 1,
      removed: 1,
      rejectedRecords: 1,
      certificatesIssued: 1,
    });

    const before = await eligibility(p.id, 'tok_a1', '2026-03-31');
    expect(before).toMatchObject({
      eligible: true,
      productCode: 'PLAT',
      supportedByFeed: { id: full.json().id },
    });
    const after = await eligibility(p.id, 'tok_a1', '2026-04-01');
    expect(after).toMatchObject({
      eligible: true,
      productCode: 'BLACK',
      supportedByFeed: { id: f.id },
    });
    expect((await eligibility(p.id, 'tok_a2', '2026-04-15')).eligible).toBe(true);
    expect((await eligibility(p.id, 'tok_a2', '2026-04-16')).eligible).toBe(false);
    expect((await eligibility(p.id, 'tok_a4', '2026-03-20')).eligible).toBe(true);

    // A later full feed removes accounts it no longer lists, from its as-of date.
    await upload(
      p.id,
      'live',
      feed(3, 'FULL', '2026-05-01', [
        'D|tok_a1|BLACK|A|2025-06-01|',
        'D|tok_a4|PLAT|A|2026-03-20|',
      ]),
    );
    await processAll();
    expect((await eligibility(p.id, 'tok_a3', '2026-04-30')).eligible).toBe(true);
    expect((await eligibility(p.id, 'tok_a3', '2026-05-01')).eligible).toBe(false);
    // Unchanged accounts keep their period and the feed that established it.
    expect((await eligibility(p.id, 'tok_a1', '2026-06-01')).supportedByFeed.id).toBe(f.id);

    // The ledger has no foreign keys (for load speed); its references are checked instead.
    const client = await t.pool.connect();
    try {
      expect((await client.query('SELECT * FROM card.verify_ledger()')).rows).toEqual([]);
    } finally {
      client.release();
    }
  });

  it('processes feeds strictly in sequence', async () => {
    const p = await setUpProgramme();
    await goLive(p.id);
    await upload(p.id, 'live', feed(1, 'FULL', '2026-03-01', ['D|tok_a1|PLAT|A|2025-06-01|']));
    await processAll();
    const third = await upload(
      p.id,
      'live',
      feed(3, 'CHANGE', '2026-03-03', ['D|tok_a3|PLAT|A|2025-06-01|']),
    );
    await processAll();
    expect((await getFeed(p.id, third.json().id)).status).toBe('waiting');
    expect((await eligibility(p.id, 'tok_a3', '2026-03-10')).eligible).toBe(false);

    const second = await upload(
      p.id,
      'live',
      feed(2, 'CHANGE', '2026-03-02', ['D|tok_a2|PLAT|A|2025-06-01|']),
    );
    await processAll();
    expect((await getFeed(p.id, second.json().id)).status).toBe('applied');
    expect((await getFeed(p.id, third.json().id)).status).toBe('applied');
    expect((await eligibility(p.id, 'tok_a3', '2026-03-10')).eligible).toBe(true);

    const replay = await upload(
      p.id,
      'live',
      feed(2, 'CHANGE', '2026-03-02', ['D|tok_a9|PLAT|A|2025-06-01|']),
    );
    await processAll();
    const r = await getFeed(p.id, replay.json().id);
    expect(r.status).toBe('rejected');
    expect(r.statusReason).toContain('already been applied');
  });

  it('holds a feed that fails its controls and keeps the previous eligibility in force', async () => {
    const p = await setUpProgramme();
    await goLive(p.id);
    await upload(
      p.id,
      'live',
      feed(1, 'FULL', '2026-03-01', ['D|tok_a1|PLAT|A|2025-06-01|', 'D|tok_a2|PLAT|A|2025-06-01|']),
    );
    await processAll();

    // Control totals do not match: the trailer claims 3 records.
    const broken = await upload(
      p.id,
      'live',
      'H|ASTRA-ELIG|1|SWAN-TRAVEL|2|FULL|2026-04-01\nD|tok_a1|PLAT|A|2025-06-01|\nT|3|3|0|0\n',
    );
    await processAll();
    const held = await getFeed(p.id, broken.json().id);
    expect(held.status).toBe('held');
    expect(held.sequence).toBe(2);
    expect(held.statusReason).toContain('Control total');
    expect((await eligibility(p.id, 'tok_a2', '2026-05-01')).eligible).toBe(true);

    // A broken file reusing an applied sequence is rejected, not held.
    const stale = await upload(
      p.id,
      'live',
      'H|ASTRA-ELIG|1|SWAN-TRAVEL|1|FULL|2026-04-01\nD|tok_a9|PLAT|A|2025-06-01|\n',
    );
    await processAll();
    expect((await getFeed(p.id, stale.json().id)).status).toBe('rejected');

    // A corrected file for the same sequence is refused until the held one is rejected.
    const early = await upload(
      p.id,
      'live',
      feed(2, 'FULL', '2026-04-01', ['D|tok_a1|PLAT|A|2025-06-01|', 'D|tok_a2|PLAT|A|2025-06-01|']),
    );
    await processAll();
    const refused = await getFeed(p.id, early.json().id);
    expect(refused.status).toBe('rejected');
    expect(refused.statusReason).toContain('already waiting or held');

    const rejected = await post(`/v1/card-programmes/${p.id}/feeds/${held.id}/reject`, manager, {
      reason: 'Issuer resending a corrected file.',
    });
    expect(rejected.statusCode, rejected.body).toBe(200);

    // Too many rejections: 2 of 3 records are bad, over the 10% limit.
    const noisy = await upload(
      p.id,
      'live',
      feed(2, 'FULL', '2026-04-01', [
        'D|tok_a1|PLAT|A|2025-06-01|',
        'D|ab|PLAT|A|2025-06-01|',
        'D|tok_a3|PLAT|A|2025-13-01|',
      ]),
    );
    await processAll();
    const tooMany = await getFeed(p.id, noisy.json().id);
    expect(tooMany.status).toBe('held');
    expect(tooMany.statusReason).toContain('2 of 3 records');
    const listed = await t.app.inject({
      method: 'GET',
      url: `/v1/card-programmes/${p.id}/feeds/${tooMany.id}/rejections`,
      headers: bearer(manager),
    });
    expect(listed.json().items.map((r: { code: string }) => r.code)).toEqual([
      'account_ref',
      'eligible_from',
    ]);
    expect((await eligibility(p.id, 'tok_a2', '2026-05-01')).eligible).toBe(true);
  });
});

describe('cover verification (E21-F03-S01)', () => {
  it('answers covered or not, with reasons, for the claims system', async () => {
    const p = await setUpProgramme({ eligibilityRule: 'purchase_and_loss_date' });
    await goLive(p.id);
    await upload(
      p.id,
      'live',
      feed(1, 'FULL', '2026-03-01', ['D|tok_a1|PLAT|A|2025-06-01|2026-06-30']),
    );
    await processAll();
    const claims = await t.idp.token({ roles: ['cover_verifier'], sub: 'svc-claims' });
    const check = (body: Record<string, unknown>) =>
      post('/v1/cover-verifications', claims, {
        type: 'certificate',
        programmeCode: 'SWAN-TRAVEL',
        accountRef: 'tok_a1',
        purchaseDate: '2026-05-01',
        lossDate: '2026-06-10',
        payment: { tripCost: 2000, amountPaidWithAccount: 1000 },
        ...body,
      });

    const ok = await check({});
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({
      covered: true,
      reasons: [],
      paymentCondition: { met: true },
    });
    expect(ok.json().certificateNumber).toMatch(/^SWAN-TRAVEL-\d{9}$/);

    const underpaid = await check({ payment: { tripCost: 2000, amountPaidWithAccount: 999.99 } });
    expect(underpaid.json().covered).toBe(false);
    expect(underpaid.json().reasons.join(' ')).toContain('at least 50%');

    const afterEnd = await check({ lossDate: '2026-07-02' });
    expect(afterEnd.json().covered).toBe(false);
    expect(afterEnd.json().reasons.join(' ')).toContain('loss date');

    const card = await check({ accountRef: '4111111111111111' });
    expect(card.statusCode).toBe(400);
    expect(card.body).not.toContain('4111111111111111');

    // Staff without cover:verify, and issuers, cannot use it.
    const underwriter = await t.idp.token({ roles: ['underwriter'] });
    expect((await post('/v1/cover-verifications', underwriter, {})).statusCode).toBe(403);
    expect((await post('/v1/cover-verifications', issuerToken, {})).statusCode).toBe(403);

    const audit = await t.pool.connect();
    try {
      await audit.query('BEGIN');
      await audit.query(`SELECT set_config('app.account_ids', '*', true)`);
      const rows = await audit.query(
        `SELECT actor_type, actor_id FROM audit.audit_log WHERE action = 'cover.verified' ORDER BY seq DESC LIMIT 1`,
      );
      expect(rows.rows[0]).toEqual({ actor_type: 'system', actor_id: 'svc-claims' });
      await audit.query('ROLLBACK');
    } finally {
      audit.release();
    }
  });
});
