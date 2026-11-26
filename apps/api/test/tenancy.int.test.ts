/**
 * E13-F02-S03: account data is separated at every layer.
 * "Automated tests attempt cross-account access on every API and all attempts fail."
 *
 * Every route in the catalogue must declare its tenancy. Every `account` route is probed by partner B
 * against partner A's resources, and every `platform` route is refused to partners. A new route that is
 * not covered by a probe fails this suite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer, createTestApp, insertAccount, resetDatabase, type TestContext } from './helpers';

let t: TestContext;
let accountA: string;
let accountB: string;
let tokenA: string;
let tokenB: string;
let subscriptionA: string;
let programmeA: string;
let feedA: string;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

beforeEach(async () => {
  await resetDatabase();
  accountA = await insertAccount(t.pool, 'TENANT-A', 'card_issuer');
  accountB = await insertAccount(t.pool, 'TENANT-B', 'card_issuer');
  tokenA = await t.idp.token({
    roles: ['partner_developer'],
    accountId: accountA,
    sub: 'svc-partner-a',
  });
  tokenB = await t.idp.token({
    roles: ['partner_developer'],
    accountId: accountB,
    sub: 'svc-partner-b',
  });
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/webhook-subscriptions',
    headers: { ...bearer(tokenA), 'idempotency-key': `tenancy-${Date.now()}` },
    payload: { url: 'https://203.0.113.10/astra/webhooks', eventTypes: ['AccountStatusChanged'] },
  });
  expect(res.statusCode, res.body).toBe(201);
  subscriptionA = res.json().id;

  // A card programme of account A, with a feed A uploaded itself.
  const staff = await t.idp.token({ roles: ['card_programme_manager'] });
  const staffPost = (url: string, payload: object) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: {
        ...bearer(staff),
        'idempotency-key': `tenancy-${Math.random().toString(36).slice(2)}`,
      },
      payload,
    });
  const mp = await staffPost('/v1/master-policies', {
    accountId: accountA,
    policyNumber: 'MP-TENANT-A',
    underwriter: 'ABIC',
    states: ['NY'],
    effectiveFrom: '2026-01-01',
  });
  expect(mp.statusCode, mp.body).toBe(201);
  const programme = await staffPost('/v1/card-programmes', {
    masterPolicyId: mp.json().id,
    code: 'TENANT-A-CARD',
    name: 'Tenant A card cover',
    cardProduct: 'Gold',
    states: ['NY'],
    effectiveFrom: '2026-01-01',
    paymentCondition: { rule: 'none' },
    eligibilityRule: 'purchase_date',
  });
  expect(programme.statusCode, programme.body).toBe(201);
  programmeA = programme.json().id;
  const feed = await t.app.inject({
    method: 'POST',
    url: `/v1/card-programmes/${programmeA}/feeds?mode=test`,
    headers: { ...bearer(tokenA), 'content-type': 'application/octet-stream' },
    payload: Buffer.from(
      'H|ASTRA-ELIG|1|TENANT-A-CARD|1|FULL|2026-02-01\nD|tok_tenant_a|GOLD|A|2026-01-01|\nT|1|1|0|0\n',
    ),
  });
  expect(feed.statusCode, feed.body).toBe(202);
  feedA = feed.json().id;
});

/** A well-formed ID that exists nowhere: the cross-account answer must be the same as for a missing resource. */
const ABSENT = '00000000-0000-4000-8000-0000000000aa';

type Probe = { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: () => string; payload?: () => unknown; headers?: Record<string, string> };

/** Partner B attacking partner A's data, one probe per account-scoped route. */
const PROBES: Record<string, Probe[]> = {
  'GET /v1/accounts': [{ method: 'GET', url: () => '/v1/accounts' }],
  'GET /v1/accounts/:accountId': [{ method: 'GET', url: () => `/v1/accounts/${accountA}` }],
  'GET /v1/webhook-subscriptions': [
    { method: 'GET', url: () => '/v1/webhook-subscriptions' },
    { method: 'GET', url: () => `/v1/webhook-subscriptions?accountId=${accountA}` },
  ],
  'POST /v1/webhook-subscriptions': [
    {
      method: 'POST',
      url: () => '/v1/webhook-subscriptions',
      payload: () => ({
        accountId: accountA,
        url: 'https://203.0.113.11/x',
        eventTypes: ['AccountStatusChanged'],
      }),
    },
  ],
  'GET /v1/webhook-subscriptions/:subscriptionId': [
    { method: 'GET', url: () => `/v1/webhook-subscriptions/${subscriptionA}` },
  ],
  'POST /v1/webhook-subscriptions/:subscriptionId/status': [
    {
      method: 'POST',
      url: () => `/v1/webhook-subscriptions/${subscriptionA}/status`,
      payload: () => ({ status: 'paused' }),
    },
  ],
  'DELETE /v1/webhook-subscriptions/:subscriptionId': [
    { method: 'DELETE', url: () => `/v1/webhook-subscriptions/${subscriptionA}` },
  ],
  'GET /v1/card-programmes': [
    { method: 'GET', url: () => '/v1/card-programmes' },
    { method: 'GET', url: () => `/v1/card-programmes?accountId=${accountA}` },
  ],
  'GET /v1/card-programmes/:programmeId': [
    { method: 'GET', url: () => `/v1/card-programmes/${programmeA}` },
  ],
  'POST /v1/card-programmes/:programmeId/feeds': [
    {
      method: 'POST',
      url: () => `/v1/card-programmes/${programmeA}/feeds?mode=test`,
      payload: () => ({}),
    },
  ],
  'GET /v1/card-programmes/:programmeId/feeds': [
    { method: 'GET', url: () => `/v1/card-programmes/${programmeA}/feeds` },
  ],
  'GET /v1/card-programmes/:programmeId/feeds/:feedId': [
    { method: 'GET', url: () => `/v1/card-programmes/${programmeA}/feeds/${feedA}` },
  ],
  'GET /v1/card-programmes/:programmeId/feeds/:feedId/rejections': [
    { method: 'GET', url: () => `/v1/card-programmes/${programmeA}/feeds/${feedA}/rejections` },
  ],
  'POST /v1/card-programmes/:programmeId/eligibility-checks': [
    {
      method: 'POST',
      url: () => `/v1/card-programmes/${programmeA}/eligibility-checks`,
      payload: () => ({ accountRef: 'tok_tenant_a', date: '2026-03-01' }),
    },
  ],
  'POST /v1/quotes': [
    {
      method: 'POST',
      url: () => '/v1/quotes',
      payload: () => ({
        accountId: accountA,
        planCode: 'ANY-PLAN',
        state: 'DE',
        travellers: [{ firstName: 'Pat', lastName: 'Sample', age: 40, costPerTraveller: '1000' }],
        trip: { departureDate: '2030-01-10', returnDate: '2030-01-20' },
      }),
    },
  ],
  'GET /v1/quotes': [
    { method: 'GET', url: () => '/v1/quotes' },
    { method: 'GET', url: () => `/v1/quotes?accountId=${accountA}` },
  ],
  'GET /v1/quotes/:quoteId': [{ method: 'GET', url: () => `/v1/quotes/${ABSENT}` }],
  'PUT /v1/quotes/:quoteId/selection': [{ method: 'PUT', url: () => `/v1/quotes/${ABSENT}/selection`, payload: () => ({ selection: [] }) }],
  'POST /v1/quotes/:quoteId/bind': [
    {
      method: 'POST',
      url: () => `/v1/quotes/${ABSENT}/bind`,
      payload: () => ({ ableToTravel: true, acknowledgement: { disclosureVersion: 'v1', acknowledgedBy: 'Pat Sample' }, payment: { reference: 'PAY-TENANT-1', amount: '10.00' }, purchaser: { name: 'Pat Sample' } }),
    },
  ],
  'GET /v1/reports/accounts': [{ method: 'GET', url: () => '/v1/reports/accounts?from=2026-01-01&to=2026-12-31' }, { method: 'GET', url: () => `/v1/reports/accounts?from=2026-01-01&to=2026-12-31&accountId=${accountA}` }],
  'GET /v1/reports/accounts.csv': [{ method: 'GET', url: () => `/v1/reports/accounts.csv?from=2026-01-01&to=2026-12-31&accountId=${accountA}` }],
  'POST /v1/service/customer-view': [{ method: 'POST', url: () => '/v1/service/customer-view', payload: () => ({ lastName: 'Sample', dateOfBirth: '1980-05-05' }) }],
  'POST /v1/policies/:policyId/documents/resend': [{ method: 'POST', url: () => `/v1/policies/${ABSENT}/documents/resend`, payload: () => ({ reason: 'Probe' }) }],
  'POST /v1/card-programmes/:programmeId/mapped-feeds': [{ method: 'POST', url: () => `/v1/card-programmes/${ABSENT}/mapped-feeds?mode=test&sequence=1&kind=CHANGE&asOfDate=2026-01-01`, payload: () => 'a\nb\n', headers: { 'content-type': 'application/octet-stream' } }],
  'POST /v1/card-programmes/:programmeId/samples': [{ method: 'POST', url: () => `/v1/card-programmes/${ABSENT}/samples`, payload: () => 'a,b\n1,2\n', headers: { 'content-type': 'text/plain' } }],
  'GET /v1/card-programmes/:programmeId/samples': [{ method: 'GET', url: () => `/v1/card-programmes/${ABSENT}/samples` }],
  'GET /v1/card-programmes/:programmeId/samples/:sampleId': [{ method: 'GET', url: () => `/v1/card-programmes/${ABSENT}/samples/${ABSENT}` }],
  'POST /v1/card-programmes/:programmeId/mapping-preview': [{ method: 'POST', url: () => `/v1/card-programmes/${ABSENT}/mapping-preview`, payload: () => ({ sampleId: ABSENT, document: { delimiter: ',', columns: { accountRef: { column: 'a' }, productCode: { constant: 'X' }, action: { constant: 'A' }, eligibleFrom: { column: 'b', format: 'YYYY-MM-DD' }, eligibleTo: null } } }) }],
  'GET /v1/card-programmes/:programmeId/mappings': [{ method: 'GET', url: () => `/v1/card-programmes/${ABSENT}/mappings` }],
  'GET /v1/search': [{ method: 'GET', url: () => '/v1/search?q=ATP' }, { method: 'GET', url: () => '/v1/search?q=Sample' }],
  'GET /v1/policies': [
    { method: 'GET', url: () => '/v1/policies' },
    { method: 'GET', url: () => `/v1/policies?accountId=${accountA}` },
  ],
  'GET /v1/policies/:policyId': [{ method: 'GET', url: () => `/v1/policies/${ABSENT}` }],
  'GET /v1/policies/:policyId/documents': [{ method: 'GET', url: () => `/v1/policies/${ABSENT}/documents` }],
  'POST /v1/policies/:policyId/documents/issue': [{ method: 'POST', url: () => `/v1/policies/${ABSENT}/documents/issue`, payload: () => ({}) }],
  'POST /v1/policies/:policyId/notices': [{ method: 'POST', url: () => `/v1/policies/${ABSENT}/notices`, payload: () => ({ eventSeq: 1 }) }],
  'GET /v1/documents/:id': [{ method: 'GET', url: () => `/v1/documents/${ABSENT}` }],
  'GET /v1/documents/:id/file': [{ method: 'GET', url: () => `/v1/documents/${ABSENT}/file` }],
  'GET /v1/document-failures': [{ method: 'GET', url: () => '/v1/document-failures' }],
  'POST /v1/document-deliveries/:id/retry': [{ method: 'POST', url: () => `/v1/document-deliveries/${ABSENT}/retry`, payload: () => ({}) }],
  'POST /v1/card-programmes/:programmeId/guides': [{ method: 'POST', url: () => `/v1/card-programmes/${programmeA}/guides`, payload: () => ({ planCode: 'ANY-PLAN' }) }],
  'GET /v1/card-programmes/:programmeId/guides': [{ method: 'GET', url: () => `/v1/card-programmes/${programmeA}/guides` }],
  'POST /v1/policies/:policyId/servicing/preview': [{ method: 'POST', url: () => `/v1/policies/${ABSENT}/servicing/preview`, payload: () => ({ type: 'cancel', reason: 'Probe', noLoss: true }) }],
  'POST /v1/policies/:policyId/servicing': [{ method: 'POST', url: () => `/v1/policies/${ABSENT}/servicing`, payload: () => ({ request: { type: 'cancel', reason: 'Probe', noLoss: true }, confirmAmount: '0.00' }) }],
  'GET /v1/premium-records': [{ method: 'GET', url: () => '/v1/premium-records' }, { method: 'GET', url: () => `/v1/premium-records?accountId=${accountA}` }],
  'GET /v1/premium-records/:id': [{ method: 'GET', url: () => `/v1/premium-records/${ABSENT}` }],
  'GET /v1/policies/:policyId/premium-records': [{ method: 'GET', url: () => `/v1/policies/${ABSENT}/premium-records` }],
  'POST /v1/premium-records/:id/recalculate': [{ method: 'POST', url: () => `/v1/premium-records/${ABSENT}/recalculate`, payload: () => ({}) }],
  'POST /v1/commission-rules': [{ method: 'POST', url: () => '/v1/commission-rules', payload: () => ({ accountId: accountA, effectiveFrom: '2026-01-01', document: { kind: 'none' } }) }],
  'GET /v1/commission-rules': [{ method: 'GET', url: () => '/v1/commission-rules' }, { method: 'GET', url: () => `/v1/commission-rules?accountId=${accountA}` }],
  'POST /v1/commission-rules/:id/approve': [{ method: 'POST', url: () => `/v1/commission-rules/${ABSENT}/approve`, payload: () => ({}) }],
  'POST /v1/programme-premium-rules': [{ method: 'POST', url: () => '/v1/programme-premium-rules', payload: () => ({ programmeId: programmeA, effectiveFrom: '2026-01-01', rate: '1.0000' }) }],
  'GET /v1/programme-premium-rules': [{ method: 'GET', url: () => '/v1/programme-premium-rules' }, { method: 'GET', url: () => `/v1/programme-premium-rules?programmeId=${programmeA}` }],
  'POST /v1/programme-premium-rules/:id/approve': [{ method: 'POST', url: () => `/v1/programme-premium-rules/${ABSENT}/approve`, payload: () => ({}) }],
  'POST /v1/programme-premium': [{ method: 'POST', url: () => '/v1/programme-premium', payload: () => ({ programmeId: programmeA, month: '2026-03' }) }],
  'GET /v1/accounts/:id/profile': [{ method: 'GET', url: () => `/v1/accounts/${accountA}/profile` }],
  'GET /v1/accounts/:id/onboarding': [{ method: 'GET', url: () => `/v1/accounts/${accountA}/onboarding` }],
  'GET /v1/accounts/:id/segment-changes': [{ method: 'GET', url: () => `/v1/accounts/${accountA}/segment-changes` }],
  'GET /v1/segment-changes': [{ method: 'GET', url: () => '/v1/segment-changes' }],
  'GET /v1/accounts/:id/collected-variables': [{ method: 'GET', url: () => `/v1/accounts/${accountA}/collected-variables` }],
  'GET /v1/licences': [{ method: 'GET', url: () => '/v1/licences' }, { method: 'GET', url: () => `/v1/licences?accountId=${accountA}` }],
  'GET /v1/accounts/:id/documents': [{ method: 'GET', url: () => `/v1/accounts/${accountA}/documents` }],
  'GET /v1/account-documents/:id/text': [{ method: 'GET', url: () => `/v1/account-documents/${ABSENT}/text` }],
  'GET /v1/accounts/:id/sandbox': [{ method: 'GET', url: () => `/v1/accounts/${accountA}/sandbox` }],
  'GET /v1/accounts/:id/channels': [{ method: 'GET', url: () => `/v1/accounts/${accountA}/channels` }],
  'POST /v1/quotes/:quoteId/widget-sessions': [{ method: 'POST', url: () => `/v1/quotes/${ABSENT}/widget-sessions`, payload: () => ({}) }],
  'GET /v1/quotes/:quoteId/offer': [{ method: 'GET', url: () => `/v1/quotes/${ABSENT}/offer` }],
  'GET /v1/quotes/:quoteId/wording': [{ method: 'GET', url: () => `/v1/quotes/${ABSENT}/wording` }],
  'POST /v1/booking-files': [{ method: 'POST', url: () => `/v1/booking-files?fileName=probe.csv&accountId=${accountA}`, payload: () => 'booking_ref\nX\n', headers: { 'content-type': 'text/csv' } }],
  'GET /v1/booking-files': [{ method: 'GET', url: () => '/v1/booking-files' }, { method: 'GET', url: () => `/v1/booking-files?accountId=${accountA}` }],
  'GET /v1/booking-files/:id/result': [{ method: 'GET', url: () => `/v1/booking-files/${ABSENT}/result` }],
};

describe('route catalogue', () => {
  it('declares a tenancy for every route', () => {
    expect(t.app.routeCatalogue.length).toBeGreaterThan(10);
    for (const r of t.app.routeCatalogue)
      expect(['public', 'self', 'account', 'platform']).toContain(r.tenancy);
  });

  it('has a cross-account probe for every account-scoped route', () => {
    const accountRoutes = t.app.routeCatalogue
      .filter((r) => r.tenancy === 'account')
      .map((r) => `${r.method} ${r.url}`);
    expect(accountRoutes.sort()).toEqual(Object.keys(PROBES).sort());
  });
});

describe('cross-account access', () => {
  it('never lets partner B see or change partner A data', async () => {
    for (const [route, probes] of Object.entries(PROBES)) {
      for (const probe of probes) {
        const res = await t.app.inject({
          method: probe.method,
          url: probe.url(),
          headers: {
            ...bearer(tokenB),
            'idempotency-key': `probe-${Math.random().toString(36).slice(2)}`,
            ...probe.headers,
          },
          ...(probe.payload ? { payload: probe.payload() as object } : {}),
        });
        const body = res.body;
        if (res.statusCode === 200) {
          // List endpoints succeed but must contain nothing from account A.
          expect(body, route).not.toContain(accountA);
          expect(body, route).not.toContain(subscriptionA);
          expect(body, route).not.toContain(programmeA);
          expect(body, route).not.toContain(feedA);
        } else {
          expect([403, 404], `${route} answered ${res.statusCode} ${body.slice(0, 300)}`).toContain(res.statusCode);
        }
      }
    }
    // A's subscription is untouched.
    const own = await t.app.inject({
      method: 'GET',
      url: `/v1/webhook-subscriptions/${subscriptionA}`,
      headers: bearer(tokenA),
    });
    expect(own.json().status).toBe('active');
  });

  it('refuses every platform route to account-scoped principals', async () => {
    const platformRoutes = t.app.routeCatalogue.filter((r) => r.tenancy === 'platform');
    expect(platformRoutes.length).toBeGreaterThan(5);
    for (const r of platformRoutes) {
      const url = r.url
        .replace(':accountId', accountA)
        .replace(':eventId', '00000000-0000-4000-8000-000000000000')
        .replace(':key', 'api.partner-access');
      const res = await t.app.inject({
        method: r.method as 'GET',
        url,
        headers: bearer(tokenB),
        payload: r.method === 'GET' ? undefined : {},
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
    }
  });

  it('enforces isolation in the database itself (row-level security)', async () => {
    const client = await t.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.account_ids', $1, true)`, [accountB]);
      const visible = await client.query<{ id: string }>('SELECT id FROM platform.accounts');
      expect(visible.rows.map((r) => r.id)).toEqual([accountB]);
      const subs = await client.query('SELECT id FROM integration.webhook_subscriptions');
      expect(subs.rowCount).toBe(0);
      const update = await client.query(
        `UPDATE integration.webhook_subscriptions SET status = 'paused' WHERE id = $1`,
        [subscriptionA],
      );
      expect(update.rowCount).toBe(0);
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      const none = await client.query('SELECT id FROM platform.accounts');
      expect(none.rowCount, 'no scope set means no rows').toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('lets a partner see its own account only', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/accounts', headers: bearer(tokenA) });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((a: { id: string }) => a.id)).toEqual([accountA]);
  });
});
