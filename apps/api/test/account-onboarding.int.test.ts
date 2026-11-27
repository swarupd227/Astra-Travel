/**
 * Increment 13: account onboarding and configuration (E07) through the API and database on a complete published
 * stack (see fixtures.ts). Names, licence numbers and segments are SYNTHETIC test values.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@astra/platform';
import { alertExpiring } from '../../worker/src/licences';
import { createTestApp, insertAccount, resetDatabase, type TestContext } from './helpers';
import { addDays, publishedStack, send, today, type Stack } from './fixtures';

let t: TestContext;
let st: Stack;
let manager: string;
let analyst: string;
const logger = createLogger('accounts-test', 'fatal');
const issued: { id: string; code: string }[] = [];
const revoked: string[] = [];

beforeAll(async () => {
  t = await createTestApp();
  await resetDatabase();
  st = await publishedStack(t);
  manager = await t.idp.token({ roles: ['account_manager'], sub: 'am-1', name: 'Ali Manager' });
  analyst = await t.idp.token({ roles: ['rating_analyst'], sub: 'ra-9', name: 'Ria Analyst' });
  t.setCredentials({
    issue: async (a) => {
      issued.push(a);
      return {
        clientId: `astra-sbx-test-${issued.length}`,
        clientSecret: `test-secret-${issued.length}`,
        tokenUrl: 'https://idp.example.test/token',
      };
    },
    revoke: async (id) => {
      revoked.push(id);
    },
  });
  // The filed list of business segments.
  const v = await send(
    t,
    'POST',
    '/v1/reference-data/business_segments/versions',
    st.tokens.analyst,
    {
      effectiveFrom: '2026-01-01',
      source: 'Synthetic test list',
      entries: [
        { code: 'OTA_CRUISE', name: 'OTA - Cruise' },
        { code: 'DIRECT', name: 'Direct to traveller' },
      ],
    },
  );
  expect(v.statusCode, v.body).toBe(201);
  expect(
    (
      await send(
        t,
        'POST',
        `/v1/reference-data/business_segments/versions/${v.json().id}/decision`,
        st.tokens.compliance,
        { decision: 'approve', reason: 'Test list.' },
      )
    ).statusCode,
  ).toBe(200);
}, 240_000);
afterAll(async () => t.close());

async function asPlatform<T>(
  fn: (
    q: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>,
  ) => Promise<T>,
): Promise<T> {
  const c = await t.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.account_ids', '*', true)`);
    const out = await fn((sql, p) => c.query(sql, p));
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}
const tokenFor = (accountId: string) =>
  t.idp.token({ roles: ['partner_developer'], accountId, sub: `svc-${accountId.slice(0, 8)}` });
const quoteFor = (accountId: string, token: string, over: Record<string, unknown> = {}) =>
  send(t, 'POST', '/v1/quotes', token, { ...st.quoteBody(over), accountId });
const onboarding = async (id: string) =>
  (await send(t, 'GET', `/v1/accounts/${id}/onboarding`, st.tokens.admin)).json() as {
    complete: boolean;
    accountStatus: string;
    items: { item: string; complete: boolean; detail: string }[];
    sandboxAccountId: string | null;
  };
const stamp = () => Date.now().toString(36).toUpperCase();

describe('segment with underwriter approval (E07-F02-S01)', () => {
  it('takes segments from the filed list, needs another person’s approval, and is used by the quote', async () => {
    const id = st.accountId;
    const bad = await send(t, 'POST', `/v1/accounts/${id}/segment-changes`, manager, {
      segment: 'NOT_LISTED',
      effectiveFrom: '2026-01-01',
      reason: 'Contract says so',
    });
    expect(bad.statusCode, bad.body).toBe(400);
    const req = await send(t, 'POST', `/v1/accounts/${id}/segment-changes`, st.tokens.admin, {
      segment: 'OTA_CRUISE',
      effectiveFrom: '2026-01-01',
      reason: 'Per the signed contract',
    });
    expect(req.statusCode, req.body).toBe(201);
    expect(req.json()).toMatchObject({
      status: 'pending',
      segment: 'OTA_CRUISE',
      segmentName: 'OTA - Cruise',
    });
    // One at a time; neither the requester nor a person without the permission decides it.
    expect(
      (
        await send(t, 'POST', `/v1/accounts/${id}/segment-changes`, manager, {
          segment: 'DIRECT',
          effectiveFrom: '2026-01-01',
          reason: 'Another',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await send(t, 'POST', `/v1/segment-changes/${req.json().id}/decision`, manager, {
          decision: 'approve',
          note: 'Looks right',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await send(t, 'POST', `/v1/segment-changes/${req.json().id}/decision`, st.tokens.admin, {
          decision: 'approve',
          note: 'Looks right',
        })
      ).statusCode,
    ).toBe(403);
    const ok = await send(
      t,
      'POST',
      `/v1/segment-changes/${req.json().id}/decision`,
      st.tokens.uw1,
      { decision: 'approve', note: 'Matches the filed list and the contract.' },
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'approved', decidedBy: 'uw-1' });
    // The quote uses the account's segment, never the caller's.
    const mismatch = await quoteFor(id, st.tokens.partner, { businessSegment: 'DIRECT' });
    expect(mismatch.statusCode, mismatch.body).toBe(400);
    expect(mismatch.json().detail).toContain('approved business segment is OTA_CRUISE');
    expect((await quoteFor(id, st.tokens.partner)).statusCode).toBe(201);
    expect(
      (await quoteFor(id, st.tokens.partner, { businessSegment: 'OTA_CRUISE' })).statusCode,
    ).toBe(201);
    // A change from a later date applies from then.
    const later = await send(t, 'POST', `/v1/accounts/${id}/segment-changes`, st.tokens.admin, {
      segment: 'DIRECT',
      effectiveFrom: addDays(today(), 30),
      reason: 'Moves to direct selling next month',
    });
    await send(t, 'POST', `/v1/segment-changes/${later.json().id}/decision`, st.tokens.uw1, {
      decision: 'approve',
      note: 'Agreed with the account.',
    });
    expect(
      (await quoteFor(id, st.tokens.partner, { businessSegment: 'OTA_CRUISE' })).statusCode,
    ).toBe(201);
    const history = (
      await send(t, 'GET', `/v1/accounts/${id}/segment-changes`, st.tokens.admin)
    ).json().items;
    expect(history.map((h: { status: string }) => h.status)).toEqual(['approved', 'approved']);
  });
});

describe('collected rating variables (E07-F02-S02)', () => {
  it('is recorded by a rating analyst and applied by the rating engine at once', async () => {
    const id = st.accountId;
    expect(
      (await send(t, 'GET', `/v1/accounts/${id}/collected-variables`, st.tokens.admin)).json(),
    ).toMatchObject({ decided: false, notCollected: [] });
    expect(
      (
        await send(t, 'PUT', `/v1/accounts/${id}/collected-variables`, manager, {
          notCollected: ['age'],
          reason: 'The account does not ask ages',
        })
      ).statusCode,
    ).toBe(403);
    const set = await send(t, 'PUT', `/v1/accounts/${id}/collected-variables`, analyst, {
      notCollected: ['age'],
      reason: 'The account does not ask ages',
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toMatchObject({ decided: true, notCollected: ['age'], decidedBy: 'ra-9' });
    // The synthetic manual gives no "not collected" factor for age, so the engine refuses to guess one.
    const q = await quoteFor(id, st.tokens.partner);
    expect(q.statusCode, q.body).toBe(400);
    expect(JSON.stringify(q.json())).toMatch(/age/i);
    expect(
      (
        await send(t, 'PUT', `/v1/accounts/${id}/collected-variables`, analyst, {
          notCollected: [],
          reason: 'The account now asks ages',
        })
      ).statusCode,
    ).toBe(200);
    expect((await quoteFor(id, st.tokens.partner)).statusCode).toBe(201);
  });
});

describe('licences, expiry alerts and the sales block (E07-F03-S01)', () => {
  it('blocks sales in a state without an unexpired licence once enforcement is on, and unblocks it with one', async () => {
    const acct = await insertAccount(t.pool, `LIC-${stamp()}`);
    const token = await tokenFor(acct);
    await asPlatform((q) =>
      q(`UPDATE platform.accounts SET licences_enforced = true WHERE id = $1`, [acct]),
    );
    const none = await quoteFor(acct, token);
    expect(none.statusCode, none.body).toBe(400);
    expect(none.json().detail).toContain(
      'may not sell in DE: it has no registration or licence there',
    );
    // Only compliance records licences.
    const lic = {
      kind: 'retailer_registration',
      state: 'DE',
      number: `TR-${stamp()}`,
      holder: 'Synthetic Travel LLC',
      validFrom: addDays(today(), -400),
      expiresOn: addDays(today(), -1),
    };
    expect((await send(t, 'POST', `/v1/accounts/${acct}/licences`, manager, lic)).statusCode).toBe(
      403,
    );
    const expired = await send(
      t,
      'POST',
      `/v1/accounts/${acct}/licences`,
      st.tokens.compliance,
      lic,
    );
    expect(expired.statusCode, expired.body).toBe(201);
    expect(expired.json()).toMatchObject({ inForce: false, daysLeft: -1 });
    expect((await quoteFor(acct, token)).json().detail).toContain('expired on');
    const live = await send(t, 'POST', `/v1/accounts/${acct}/licences`, st.tokens.compliance, {
      ...lic,
      kind: 'producer_licence',
      number: `PL-${stamp()}`,
      validFrom: addDays(today(), -10),
      expiresOn: addDays(today(), 300),
    });
    expect(live.statusCode, live.body).toBe(201);
    expect(live.json().inForce).toBe(true);
    expect((await quoteFor(acct, token)).statusCode).toBe(201);
    // A quote made while licensed cannot be bound after the licence is revoked.
    const q = await quoteFor(acct, token, {
      travellers: [
        {
          firstName: 'Lia',
          lastName: 'Licensed',
          dateOfBirth: '1980-05-05',
          costPerTraveller: '4200',
        },
      ],
    });
    expect(
      (
        await send(t, 'POST', `/v1/licences/${live.json().id}/revoke`, manager, {
          reason: 'Revoked by the state',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await send(t, 'POST', `/v1/licences/${live.json().id}/revoke`, st.tokens.compliance, {
          reason: 'Revoked by the state',
        })
      ).statusCode,
    ).toBe(200);
    const bind = await send(
      t,
      'POST',
      `/v1/quotes/${q.json().id}/bind`,
      token,
      {
        ableToTravel: true,
        acknowledgement: {
          disclosureVersion: st.disclosureVersion,
          acknowledgedBy: 'Lia Licensed',
        },
        payment: { reference: `PAY-LIC-${stamp()}`, amount: q.json().premium.total },
        purchaser: { name: 'Lia Licensed' },
      },
      { 'idempotency-key': `bind-lic-${stamp()}` },
    );
    expect(bind.statusCode, bind.body).toBe(412);
    expect(bind.json().detail).toContain('revoked');
    // An account that has not gone live is not blocked.
    expect((await quoteFor(st.accountId, st.tokens.partner)).statusCode).toBe(201);
  });

  it('raises an alert 60 and 30 days before expiry, once each, and only the tightest for a late entry', async () => {
    const acct = await insertAccount(t.pool, `EXP-${stamp()}`);
    const mk = async (days: number, state: string) =>
      (
        await send(t, 'POST', `/v1/accounts/${acct}/licences`, st.tokens.compliance, {
          kind: 'producer_licence',
          state,
          number: `P-${stamp()}-${days}`,
          holder: 'Synthetic Producer',
          validFrom: addDays(today(), -100),
          expiresOn: addDays(today(), days),
        })
      ).json() as { id: string };
    const a = await mk(70, 'DE');
    const b = await mk(20, 'NY');
    const c = await mk(200, 'TX');
    const count = async (id: string) =>
      Number(
        (
          await asPlatform((q) =>
            q(
              `SELECT count(*)::int AS n FROM platform.outbox WHERE type = 'LicenceExpiring' AND data->>'licenceId' = $1`,
              [id],
            ),
          )
        ).rows[0]!.n,
      );
    const now = new Date();
    expect(await alertExpiring(t.pool, logger, now)).toBe(1); // only b is inside 60 days
    expect(await count(b.id)).toBe(1);
    expect(await count(a.id)).toBe(0);
    expect(await alertExpiring(t.pool, logger, now)).toBe(0); // once each
    const in15 = new Date(now.getTime() + 15 * 86_400_000);
    expect(await alertExpiring(t.pool, logger, in15)).toBe(1); // a is now at 55 days
    const in45 = new Date(now.getTime() + 45 * 86_400_000);
    expect(await alertExpiring(t.pool, logger, in45)).toBe(1); // a is now at 25 days: the 30-day alert
    expect(await count(a.id)).toBe(2);
    expect(await count(c.id)).toBe(0);
    const soon = (
      await send(
        t,
        'GET',
        `/v1/licences?accountId=${acct}&expiringWithinDays=60`,
        st.tokens.compliance,
      )
    ).json().items as { id: string }[];
    expect(soon.map((l) => l.id)).toEqual([b.id]);
    const list = (
      await send(
        t,
        'GET',
        `/v1/licences?accountId=${acct}&expiringWithinDays=100`,
        st.tokens.compliance,
      )
    ).json().items as { id: string; alertsSent: number[] }[];
    expect(list.map((l) => l.id)).toEqual([b.id, a.id]);
    // The late entry (20 days left) got the tightest alert only, and the wider one is marked as covered.
    expect(list.find((l) => l.id === b.id)!.alertsSent).toEqual([60, 30]);
    expect(list.find((l) => l.id === a.id)!.alertsSent).toEqual([60, 30]);
  });
});

describe('onboarding checklist, sandbox and go-live (E07-F01-S01, E07-F03-S02)', () => {
  it('cannot go live until every item is complete and tested, then goes live with licences enforced', async () => {
    const acct = await insertAccount(t.pool, `GL-${stamp()}`);
    const gl = (token = manager) =>
      send(t, 'POST', `/v1/accounts/${acct}/go-live`, token, { note: 'All items checked' });
    const empty = await onboarding(acct);
    expect(empty).toMatchObject({ complete: false, accountStatus: 'onboarding' });
    expect(empty.items.every((i) => !i.complete)).toBe(true);
    const refused = await gl();
    expect(refused.statusCode, refused.body).toBe(412);
    expect(refused.json().detail).toContain('Contract signed and referenced');

    // The profile, one item at a time.
    const profile = await send(t, 'PUT', `/v1/accounts/${acct}/profile`, manager, {
      contractReference: 'CT-2026-0042',
      contractSignedOn: '2026-02-01',
      states: ['DE'],
      plans: ['Q-DE'],
      integrationMethod: 'api',
      rateBasis: { basis: 'per_policy' },
      settlement: { description: 'Monthly statement, paid within 30 days', paymentDays: 30 },
    });
    expect(profile.statusCode, profile.body).toBe(200);
    let o = await onboarding(acct);
    expect(Object.fromEntries(o.items.map((i) => [i.item, i.complete]))).toMatchObject({
      contract: true,
      states: true,
      plans: true,
      integration: true,
      rate_basis: true,
      settlement: true,
      licences: false,
      segment: false,
      collected_variables: false,
      tested: false,
    });
    // An unpublished or unknown plan keeps the item open.
    await send(t, 'PUT', `/v1/accounts/${acct}/profile`, manager, { plans: ['NOPE-PLAN'] });
    expect((await onboarding(acct)).items.find((i) => i.item === 'plans')!.detail).toContain(
      'Not published today: NOPE-PLAN',
    );
    await send(t, 'PUT', `/v1/accounts/${acct}/profile`, manager, { plans: ['Q-DE'] });

    // Licence, segment, collected variables.
    expect(
      (
        await send(t, 'POST', `/v1/accounts/${acct}/licences`, st.tokens.compliance, {
          kind: 'retailer_registration',
          state: 'DE',
          number: `TR-${stamp()}`,
          holder: 'Synthetic Travel LLC',
          validFrom: addDays(today(), -30),
          expiresOn: addDays(today(), 330),
        })
      ).statusCode,
    ).toBe(201);
    const seg = await send(t, 'POST', `/v1/accounts/${acct}/segment-changes`, manager, {
      segment: 'DIRECT',
      effectiveFrom: addDays(today(), -1),
      reason: 'Per the contract',
    });
    expect((await onboarding(acct)).items.find((i) => i.item === 'segment')!.detail).toContain(
      'waiting for an underwriter',
    );
    expect(
      (
        await send(t, 'POST', `/v1/segment-changes/${seg.json().id}/decision`, st.tokens.uw2, {
          decision: 'approve',
          note: 'Matches the contract.',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await send(t, 'PUT', `/v1/accounts/${acct}/collected-variables`, analyst, {
          notCollected: [],
          reason: 'Collects everything',
        })
      ).statusCode,
    ).toBe(200);
    o = await onboarding(acct);
    expect(o.items.filter((i) => !i.complete).map((i) => i.item)).toEqual(['tested']);

    // The sandbox: a twin account, credentials issued once, and a test policy bound through the API.
    expect(
      (await send(t, 'POST', `/v1/accounts/${acct}/sandbox`, st.tokens.compliance, {})).statusCode,
    ).toBe(403);
    const sb = await send(t, 'POST', `/v1/accounts/${acct}/sandbox`, manager, {});
    expect(sb.statusCode, sb.body).toBe(201);
    expect(sb.json().code).toMatch(/-SBX$/);
    expect((await send(t, 'POST', `/v1/accounts/${acct}/sandbox`, manager, {})).statusCode).toBe(
      409,
    );
    const cred = await send(t, 'POST', `/v1/accounts/${acct}/sandbox/credentials`, manager, {});
    expect(cred.statusCode, cred.body).toBe(201);
    expect(cred.json()).toMatchObject({
      clientSecret: expect.stringContaining('test-secret'),
      accountId: sb.json().accountId,
    });
    expect(issued.at(-1)).toMatchObject({ id: sb.json().accountId });
    // The secret is not kept.
    const stored = await asPlatform((q) =>
      q(`SELECT * FROM onboarding.credentials WHERE account_id = $1`, [sb.json().accountId]),
    );
    expect(JSON.stringify(stored.rows)).not.toContain('test-secret');
    const status = (await send(t, 'GET', `/v1/accounts/${acct}/sandbox`, manager)).json();
    expect(status.credentials).toHaveLength(1);
    expect(JSON.stringify(status)).not.toContain('test-secret');
    expect((await onboarding(acct)).items.find((i) => i.item === 'tested')!.complete).toBe(false);

    const twinToken = await tokenFor(sb.json().accountId);
    const q = await quoteFor(sb.json().accountId, twinToken);
    expect(q.statusCode, q.body).toBe(201);
    const bound = await send(
      t,
      'POST',
      `/v1/quotes/${q.json().id}/bind`,
      twinToken,
      {
        ableToTravel: true,
        acknowledgement: { disclosureVersion: st.disclosureVersion, acknowledgedBy: 'Sam Sandbox' },
        payment: { reference: `PAY-SBX-${stamp()}`, amount: q.json().premium.total },
        purchaser: { name: 'Sam Sandbox', email: 'sam@example.com' },
      },
      { 'idempotency-key': `bind-sbx-${stamp()}` },
    );
    expect(bound.statusCode, bound.body).toBe(201);
    // Sandbox transactions are synthetic: no premium record, no email.
    expect(
      (
        await asPlatform((q2) =>
          q2(`SELECT count(*)::int AS n FROM billing.premium_records WHERE account_id = $1`, [
            sb.json().accountId,
          ]),
        )
      ).rows[0]!.n,
    ).toBe(0);
    expect(
      (
        await asPlatform((q2) =>
          q2(
            `SELECT count(*)::int AS n FROM documents.deliveries WHERE account_id = $1 AND channel = 'email'`,
            [sb.json().accountId],
          ),
        )
      ).rows[0]!.n,
    ).toBe(0);
    o = await onboarding(acct);
    expect(o).toMatchObject({ complete: true });
    expect(o.items.find((i) => i.item === 'tested')!.detail).toContain('bound 1 policy');

    // Go live: only someone with the permission; the account becomes active and enforcement turns on.
    expect((await gl(st.tokens.partner)).statusCode).toBe(403);
    const live = await gl();
    expect(live.statusCode, live.body).toBe(200);
    expect(live.json()).toMatchObject({
      accountStatus: 'active',
      complete: true,
      liveAt: expect.any(String),
    });
    expect(
      (
        await asPlatform((q2) =>
          q2(`SELECT licences_enforced FROM platform.accounts WHERE id = $1`, [acct]),
        )
      ).rows[0]!.licences_enforced,
    ).toBe(true);
    expect((await gl()).statusCode).toBe(409);
    const real = await quoteFor(acct, await tokenFor(acct));
    expect(real.statusCode, real.body).toBe(201);

    // Revoking credentials goes through the identity provider and is recorded.
    const rv = await send(
      t,
      'POST',
      `/v1/accounts/${acct}/sandbox/credentials/${cred.json().clientId}/revoke`,
      manager,
      {},
    );
    expect(rv.statusCode, rv.body).toBe(200);
    expect(revoked).toContain(cred.json().clientId);
    expect(rv.json().credentials[0].revokedAt).not.toBeNull();
  });

  it('refuses to issue credentials when the identity provider is not configured, and says why', async () => {
    const acct = await insertAccount(t.pool, `NOI-${stamp()}`);
    expect((await send(t, 'POST', `/v1/accounts/${acct}/sandbox`, manager, {})).statusCode).toBe(
      201,
    );
    t.setCredentials(undefined);
    try {
      const res = await send(t, 'POST', `/v1/accounts/${acct}/sandbox/credentials`, manager, {});
      expect(res.statusCode, res.body).toBe(412);
      expect(res.json().detail).toContain('identity provider');
    } finally {
      t.setCredentials({
        issue: async () => ({ clientId: 'x', clientSecret: 'y', tokenUrl: 'z' }),
        revoke: async () => undefined,
      });
    }
  });

  it('is visible only to the account itself and to staff', async () => {
    const acct = await insertAccount(t.pool, `RLS-${stamp()}`);
    const other = await tokenFor(await insertAccount(t.pool, `RLS2-${stamp()}`));
    expect((await send(t, 'GET', `/v1/accounts/${acct}/onboarding`, other)).statusCode).toBe(404);
    expect((await send(t, 'GET', `/v1/accounts/${acct}/profile`, other)).statusCode).toBe(404);
    expect((await send(t, 'GET', `/v1/accounts/${acct}/sandbox`, other)).statusCode).toBe(404);
    expect(
      (await send(t, 'GET', `/v1/accounts/${acct}/onboarding`, await tokenFor(acct))).statusCode,
    ).toBe(200);
  });
});

describe('contract documents (E07-F01-S02)', () => {
  it('are uploaded as text, listed, read back and not duplicated', async () => {
    const acct = await insertAccount(t.pool, `DOC-${stamp()}`);
    const body =
      'MASTER TRAVEL SERVICES AGREEMENT\nContract reference: CT-2026-0042\nSigned on 1 February 2026.\n';
    const up = await t.app.inject({
      method: 'POST',
      url: `/v1/accounts/${acct}/documents?kind=contract&fileName=contract.txt`,
      headers: {
        authorization: `Bearer ${manager}`,
        'content-type': 'text/plain',
        'idempotency-key': `doc-${stamp()}`,
      },
      payload: Buffer.from(body),
    });
    expect(up.statusCode, up.body).toBe(201);
    expect(up.json()).toMatchObject({ kind: 'contract', fileName: 'contract.txt', pages: 1 });
    const again = await t.app.inject({
      method: 'POST',
      url: `/v1/accounts/${acct}/documents?kind=contract&fileName=contract.txt`,
      headers: { authorization: `Bearer ${manager}`, 'content-type': 'text/plain' },
      payload: Buffer.from(body),
    });
    expect(again.statusCode).toBe(409);
    const text = (
      await send(t, 'GET', `/v1/account-documents/${up.json().id}/text`, manager)
    ).json();
    expect(text.text).toContain('CT-2026-0042');
    expect(
      (await send(t, 'GET', `/v1/accounts/${acct}/documents`, manager)).json().items,
    ).toHaveLength(1);
    const wrong = await t.app.inject({
      method: 'POST',
      url: `/v1/accounts/${acct}/documents?kind=contract&fileName=c.docx`,
      headers: { authorization: `Bearer ${manager}`, 'content-type': 'application/zip' },
      payload: Buffer.from('x'),
    });
    expect(wrong.statusCode).toBeGreaterThanOrEqual(400);
  });
});
