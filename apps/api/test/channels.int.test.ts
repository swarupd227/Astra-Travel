/**
 * Increment 14: sales channels (E04-F03) through the API and database on a complete published stack (see
 * fixtures.ts): staff issue, the widget's tokens and offer, the hosted journey's public configuration and payment
 * rule, and booking files. Names, origins, slugs and payment references are SYNTHETIC.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signChannelToken } from '@astra/contracts/channel-token';
import { BOOKING_COLUMNS } from '@astra/contracts';
import { CHANNEL_SECRET, createTestApp, insertAccount, resetDatabase, type TestContext } from './helpers';
import { publishedStack, send, type Stack } from './fixtures';

let t: TestContext;
let st: Stack;
let manager: string;
const ORIGIN = 'https://book.example.test';
const BRANDING = { displayName: 'Acme Travel', logoUrl: null, primaryColor: '#0b5cad', textOnPrimary: '#ffffff' };
const stamp = () => Date.now().toString(36).toUpperCase();

beforeAll(async () => {
  t = await createTestApp();
  await resetDatabase();
  st = await publishedStack(t);
  manager = await t.idp.token({ roles: ['account_manager'], sub: 'am-1', name: 'Ali Manager' });
}, 240_000);
afterAll(async () => t.close());

const settings = (accountId: string, over: Record<string, unknown> = {}, token = st.tokens.admin) =>
  send(t, 'PUT', `/v1/accounts/${accountId}/channels`, token, { branding: BRANDING, widget: { enabled: true, allowedOrigins: [ORIGIN] }, journey: { enabled: false, slug: null, planCodes: [], headline: '' }, ...over });
let n = 0;
const names = () => `Chan${n++}`;
const quote = (over: Record<string, unknown> = {}, token = st.tokens.partner) => send(t, 'POST', '/v1/quotes', token, st.quoteBody({ travellers: [{ firstName: names(), lastName: 'Channelled', dateOfBirth: '1980-05-05', costPerTraveller: '4200' }], ...over }));
const get = (url: string, token: string) => t.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

describe('channel settings and branding (E04-F03-S01, S04)', () => {
  it('refuses brand colours that would fail WCAG AA, and saves ones that pass', async () => {
    const low = await settings(st.accountId, { branding: { ...BRANDING, primaryColor: '#7fb2e5' } });
    expect(low.statusCode, low.body).toBe(400);
    expect(JSON.stringify(low.json())).toContain('WCAG 2.2 AA needs 4.5:1');
    expect((await settings(st.accountId, { widget: { enabled: true, allowedOrigins: ['not-an-origin'] } })).statusCode).toBe(400);
    const ok = await settings(st.accountId);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ branding: { displayName: 'Acme Travel' }, widget: { enabled: true, allowedOrigins: [ORIGIN] } });
    expect((await settings(st.accountId, {}, manager)).statusCode).toBe(200);
    expect((await settings(st.accountId, {}, st.tokens.partner)).statusCode).toBe(403);
    expect((await get(`/v1/accounts/${st.accountId}/channels`, st.tokens.partner)).json()).toMatchObject({ widget: { enabled: true } });
    expect((await get(`/v1/accounts/${st.accountId}/channels`, st.tokens.partnerB)).statusCode).toBe(404);
  });
});

describe('the embeddable widget (E04-F03-S01)', () => {
  it('serves its script without sign-in', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/widget/v1/astra-widget.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.body).toContain("customElements.define('astra-cover-offer'");
    // Nothing from the API is ever parsed as HTML.
    expect(res.body).not.toMatch(/innerHTML\s*=/);
  });

  it('gives a traveller’s browser a token that reads one quote and changes its options, and nothing else', async () => {
    const q = (await quote()).json();
    const session = await send(t, 'POST', `/v1/quotes/${q.id}/widget-sessions`, st.tokens.partner, {});
    expect(session.statusCode, session.body).toBe(201);
    const { token, snippet, scriptUrl } = session.json();
    expect(snippet).toContain('<astra-cover-offer');
    expect(snippet).toContain(`quote="${q.id}"`);
    expect(scriptUrl).toMatch(/\/widget\/v1\/astra-widget\.js$/);

    // The offer: branding, benefits with their filed limits, the premium and the link to the wording.
    const offer = (await get(`/v1/quotes/${q.id}/offer`, token)).json();
    expect(offer).toMatchObject({ quoteId: q.id, accountName: expect.any(String), branding: { displayName: 'Acme Travel', primaryColor: '#0b5cad' }, plan: { code: 'Q-DE' }, status: 'open', outcome: 'eligible', total: '84.00' });
    const tc = offer.benefits.find((b: { code: string }) => b.code === 'trip_cancellation');
    expect(tc).toMatchObject({ selected: true, packaging: 'packaged', limit: '$5,000 per person', premium: '84.00' });
    expect(offer.benefits.find((b: { code: string }) => b.code === 'trip_interruption')).toMatchObject({ selected: false, available: true, limit: '$7,500 per person' });
    expect(offer.wordingUrl).toMatch(new RegExp(`/v1/quotes/${q.id}/wording$`));
    expect(offer.disclosureTitle).toContain('Delaware');

    // It can add an option (re-rated by the same engine) ...
    const added = await send(t, 'PUT', `/v1/quotes/${q.id}/selection`, token, { selection: ['trip_interruption'] });
    expect(added.statusCode, added.body).toBe(200);
    expect((await get(`/v1/quotes/${q.id}/offer`, token)).json().total).toBe('126.00');
    // ... read the filed wording ...
    const wording = await get(`/v1/quotes/${q.id}/wording`, token);
    expect(wording.statusCode).toBe(200);
    expect(wording.body).toContain('SCHEDULE OF BENEFITS');
    // ... and nothing more: it cannot make a quote, bind, read policies, or touch another quote.
    expect((await send(t, 'POST', '/v1/quotes', token, st.quoteBody())).statusCode).toBe(403);
    expect((await send(t, 'POST', `/v1/quotes/${q.id}/bind`, token, { ableToTravel: true, acknowledgement: { disclosureVersion: st.disclosureVersion, acknowledgedBy: 'X Y' }, payment: { reference: 'PAY-WIDGET-1', amount: '126.00' }, purchaser: { name: 'X Y' } }, { 'idempotency-key': `w-${stamp()}` })).statusCode).toBe(403);
    expect((await get('/v1/policies', token)).statusCode).toBe(403);
    const other = (await quote()).json();
    expect((await get(`/v1/quotes/${other.id}/offer`, token)).statusCode).toBe(403);
    expect((await send(t, 'PUT', `/v1/quotes/${other.id}/selection`, token, { selection: [] })).statusCode).toBe(403);
  });

  it('refuses a session when the widget is off, a token for another account’s quote, a forged token and an expired one', async () => {
    const q = (await quote()).json();
    // Another account's partner cannot start a session for this quote.
    expect((await send(t, 'POST', `/v1/quotes/${q.id}/widget-sessions`, st.tokens.partnerB, {})).statusCode).toBe(404);
    const forged = signChannelToken('a-different-signing-secret-0123456789ab', { scope: 'widget', accountId: st.accountId, sub: q.id, permissions: ['quotes:read'], quoteId: q.id }, 600).token;
    expect((await get(`/v1/quotes/${q.id}/offer`, forged)).statusCode).toBe(401);
    const old = signChannelToken(CHANNEL_SECRET, { scope: 'widget', accountId: st.accountId, sub: q.id, permissions: ['quotes:read'], quoteId: q.id }, 60, new Date(Date.now() - 3_600_000)).token;
    expect((await get(`/v1/quotes/${q.id}/offer`, old)).statusCode).toBe(401);
    // A token minted for one account cannot see another account's quote, even if it names it.
    const wrongAccount = signChannelToken(CHANNEL_SECRET, { scope: 'widget', accountId: st.accountBId, sub: q.id, permissions: ['quotes:read'], quoteId: q.id }, 600).token;
    expect((await get(`/v1/quotes/${q.id}/offer`, wrongAccount)).statusCode).toBe(404);
    // With the widget switched off, no session is given.
    expect((await settings(st.accountId, { widget: { enabled: false, allowedOrigins: [] } })).statusCode).toBe(200);
    expect((await send(t, 'POST', `/v1/quotes/${q.id}/widget-sessions`, st.tokens.partner, {})).statusCode).toBe(409);
    expect((await settings(st.accountId)).statusCode).toBe(200);
  });

  it('answers browsers only from the origins the account lists', async () => {
    const q = (await quote()).json();
    const pre = (origin: string) => t.app.inject({ method: 'OPTIONS', url: `/v1/quotes/${q.id}/offer`, headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
    const ok = await pre(ORIGIN);
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ok.headers['access-control-allow-methods']).toContain('PUT');
    expect(ok.headers['access-control-allow-origin'] === 'https://evil.example.test').toBe(false);
    const bad = await pre('https://evil.example.test');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('staff quote and issue (E04-F03-S03)', () => {
  it('uses the same rules as the API and records the staff user who issued the policy', async () => {
    const rep = await t.idp.token({ roles: ['service_rep'], sub: 'rep-7', name: 'Rae Representative' });
    const q = await quote({}, rep);
    expect(q.statusCode, q.body).toBe(201);
    expect(q.json().premium.total).toBe('84.00');
    const b = await send(t, 'POST', `/v1/quotes/${q.json().id}/bind`, rep, { ableToTravel: true, acknowledgement: { disclosureVersion: st.disclosureVersion, acknowledgedBy: 'Traveller, by phone' }, payment: { reference: `PAY-STAFF-${stamp()}`, amount: '84.00' }, purchaser: { name: 'Traveller By Phone' } }, { 'idempotency-key': `staff-${stamp()}` });
    expect(b.statusCode, b.body).toBe(201);
    const policy = (await get(`/v1/policies/${b.json().id}`, st.tokens.admin)).json();
    expect(policy.history[0]).toMatchObject({ type: 'bound', actor: 'rep-7', actorName: 'Rae Representative' });
    // The same rules: a wrong payment amount is refused exactly as it is for a partner.
    const q2 = await quote({}, rep);
    const bad = await send(t, 'POST', `/v1/quotes/${q2.json().id}/bind`, rep, { ableToTravel: true, acknowledgement: { disclosureVersion: st.disclosureVersion, acknowledgedBy: 'X Y' }, payment: { reference: `PAY-STAFF-${stamp()}`, amount: '10.00' }, purchaser: { name: 'X Y' } }, { 'idempotency-key': `staff2-${stamp()}` });
    expect(bad.statusCode).toBe(400);
  });
});

describe('hosted journey (E04-F03-S04)', () => {
  it('is configured without code, and public only for what a traveller may see', async () => {
    // A journey is public only for an account that is live.
    const c = await t.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.account_ids', '*', true)`);
      await c.query(`UPDATE platform.accounts SET status = 'active' WHERE id = $1`, [st.accountId]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const slug = `acme-${stamp().toLowerCase()}`;
    expect((await settings(st.accountId, { journey: { enabled: true, slug, planCodes: ['NOPE-PLAN'], headline: 'Cover your trip' } })).statusCode).toBe(400);
    expect((await settings(st.accountId, { branding: null, journey: { enabled: true, slug, planCodes: ['Q-DE'], headline: 'x' } })).statusCode).toBe(400);
    const on = await settings(st.accountId, { journey: { enabled: true, slug, planCodes: ['Q-DE'], headline: 'Cover your trip' } });
    expect(on.statusCode, on.body).toBe(200);
    const cfg = await t.app.inject({ method: 'GET', url: `/v1/journeys/${slug}` });
    expect(cfg.statusCode, cfg.body).toBe(200);
    expect(cfg.json()).toMatchObject({ slug, accountName: expect.any(String), headline: 'Cover your trip', branding: { displayName: 'Acme Travel' }, plans: [{ code: 'Q-DE', state: 'DE' }], payment: 'unavailable' });
    // What is public is what the journey needs; nothing of the account's contract, licences or policies.
    expect(Object.keys(cfg.json()).sort()).toEqual(['accountId', 'accountName', 'branding', 'headline', 'payment', 'plans', 'slug']);
    expect((await t.app.inject({ method: 'GET', url: '/v1/journeys/not-a-journey' })).statusCode).toBe(404);
    // An address belongs to one account.
    const other = await insertAccount(t.pool, `JNY-${stamp()}`);
    expect((await settings(other, { journey: { enabled: true, slug, planCodes: ['Q-DE'], headline: 'x' } })).statusCode).toBe(409);
    // Switching it off removes it.
    await settings(st.accountId, { journey: { enabled: false, slug, planCodes: ['Q-DE'], headline: 'x' } });
    expect((await t.app.inject({ method: 'GET', url: `/v1/journeys/${slug}` })).statusCode).toBe(404);
  });

  it('cannot complete a purchase for a live account (no payment provider), but can for a sandbox with a test payment', async () => {
    // A journey token (minted by the journey's server) can quote but a live account's bind is refused.
    const live = signChannelToken(CHANNEL_SECRET, { scope: 'journey', accountId: st.accountId, sub: 'acme', permissions: ['quotes:create', 'quotes:read'] }, 600).token;
    const q = await send(t, 'POST', '/v1/quotes', live, st.quoteBody({ travellers: [{ firstName: names(), lastName: 'Journey', dateOfBirth: '1980-05-05', costPerTraveller: '4200' }] }));
    expect(q.statusCode, q.body).toBe(201);
    const refused = await send(t, 'POST', `/v1/quotes/${q.json().id}/bind`, live, { ableToTravel: true, acknowledgement: { disclosureVersion: st.disclosureVersion, acknowledgedBy: 'X Y' }, payment: { reference: `TEST-${stamp()}`, amount: '84.00' }, purchaser: { name: 'X Y' } }, { 'idempotency-key': `j-${stamp()}` });
    expect(refused.statusCode, refused.body).toBe(412);
    expect(refused.json().detail).toContain('Payment is not set up');
    // A journey token cannot do what staff do.
    expect((await get('/v1/accounts', live)).statusCode).toBe(403);

    // The sandbox twin: the journey is configured, shows a test payment, and the purchase completes.
    const acct = await insertAccount(t.pool, `JB-${stamp()}`);
    const twin = (await send(t, 'POST', `/v1/accounts/${acct}/sandbox`, manager, {})).json().accountId as string;
    const slug = `sbx-${stamp().toLowerCase()}`;
    expect((await settings(twin, { journey: { enabled: true, slug, planCodes: ['Q-DE'], headline: 'Try it' } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: `/v1/journeys/${slug}` })).json().payment).toBe('test');
    const token = signChannelToken(CHANNEL_SECRET, { scope: 'journey', accountId: twin, sub: slug, permissions: ['quotes:create', 'quotes:read', 'policies:read', 'documents:read'] }, 600).token;
    const sq = await send(t, 'POST', '/v1/quotes', token, { ...st.quoteBody({ travellers: [{ firstName: names(), lastName: 'Sandboxed', dateOfBirth: '1980-05-05', costPerTraveller: '4200' }] }), accountId: twin });
    expect(sq.statusCode, sq.body).toBe(201);
    const bound = await send(t, 'POST', `/v1/quotes/${sq.json().id}/bind`, token, { ableToTravel: true, acknowledgement: { disclosureVersion: st.disclosureVersion, acknowledgedBy: 'Sam Sandbox' }, payment: { reference: `TEST-${stamp()}`, amount: sq.json().premium.total }, purchaser: { name: 'Sam Sandbox' } }, { 'idempotency-key': `jb-${stamp()}` });
    expect(bound.statusCode, bound.body).toBe(201);
    const docs = await get(`/v1/policies/${bound.json().id}/documents`, token);
    expect(docs.json().items.map((d: { kind: string }) => d.kind).sort()).toEqual(['purchase_confirmation', 'schedule']);
    // The channel principal is named in the history.
    expect((await get(`/v1/policies/${bound.json().id}`, token)).json().history[0].actor).toBe(`channel:journey:${slug}`);
  });
});

describe('booking files (E04-F03-S02)', () => {
  const row = (o: Record<string, string> = {}) => ({
    booking_ref: 'B1', plan_code: 'Q-DE', state: 'DE', first_name: names(), last_name: 'Filed', date_of_birth: '1980-05-05', trip_cost: '4200',
    departure_date: st.dates.departure, return_date: st.dates.return, destination_country: 'FR', destination_region: 'Europe', optional_benefits: '',
    purchaser_name: 'Pat Filed', purchaser_email: 'pat@example.com', payment_reference: `PAY-FILE-${stamp()}-${n}`, payment_amount: '84.00',
    disclosure_version: st.disclosureVersion, acknowledged_by: 'Pat Filed', able_to_travel: 'true', ...o,
  });
  const csv = (rows: Record<string, string>[]) => [BOOKING_COLUMNS.join(','), ...rows.map((r) => BOOKING_COLUMNS.map((c) => (/[,"]/.test(r[c] ?? '') ? `"${(r[c] ?? '').replace(/"/g, '""')}"` : (r[c] ?? ''))).join(','))].join('\n');
  const upload = (body: string, token = st.tokens.partner, fileName = `bookings-${stamp()}.csv`, extra = '') => t.app.inject({ method: 'POST', url: `/v1/booking-files?fileName=${fileName}${extra}`, headers: { authorization: `Bearer ${token}`, 'content-type': 'text/csv' }, payload: body });

  it('quotes and binds each booking through the real rules, and returns a result file with every reason', async () => {
    const body = csv([
      row({ booking_ref: 'GOOD-1' }),
      row({ booking_ref: 'GOOD-2', optional_benefits: 'trip_interruption', payment_amount: '126.00' }),
      row({ booking_ref: 'WRONG-PAY', payment_amount: '10.00' }),
      row({ booking_ref: 'BAD-ROW', departure_date: '20/12/2026' }),
      row({ booking_ref: 'OLD', date_of_birth: '1930-01-01' }),
    ]);
    const res = await upload(body);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ status: 'completed', bookings: 5, accepted: 2, rejected: 3, reason: null });
    const result = await t.app.inject({ method: 'GET', url: `/v1/booking-files/${res.json().id}/result`, headers: { authorization: `Bearer ${st.tokens.partner}` } });
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-type']).toContain('text/csv');
    const lines = result.body.trim().split('\n');
    expect(lines[0]).toBe('booking_ref,rows,status,policy_number,premium,reasons');
    const byRef = Object.fromEntries(lines.slice(1).map((l) => [l.split(',')[0], l]));
    expect(byRef['GOOD-1']).toMatch(/^GOOD-1,2,accepted,ATP-\d{4}-\d{6},84\.00,$/);
    expect(byRef['GOOD-2']).toMatch(/^GOOD-2,3,accepted,ATP-\d{4}-\d{6},126\.00,$/);
    expect(byRef['WRONG-PAY']).toContain('rejected');
    expect(byRef['WRONG-PAY']).toContain('does not match the premium');
    expect(byRef['BAD-ROW']).toContain('departure date must be YYYY-MM-DD');
    expect(byRef.OLD).toContain('rejected');
    // The accepted bookings are real policies, bound by the account's own credentials.
    const policies = (await get('/v1/policies?limit=100', st.tokens.partner)).json().items as { number: string }[];
    expect(policies.map((p) => p.number)).toEqual(expect.arrayContaining([lines.slice(1).find((l) => l.startsWith('GOOD-1'))!.split(',')[3]]));
  });

  it('cannot be loaded twice, refuses a file with missing columns as a whole, and is private to the account', async () => {
    const body = csv([row({ booking_ref: 'ONCE-1' })]);
    const first = await upload(body, st.tokens.partner, 'once.csv');
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().accepted).toBe(1);
    const again = await upload(body, st.tokens.partner, 'once-again.csv');
    expect(again.statusCode).toBe(409);
    expect(createHash('sha256').update(body).digest('hex')).toBe(first.json().sha256);
    const broken = await upload('booking_ref,plan_code\nX,Q-DE\n');
    expect(broken.statusCode).toBe(201);
    expect(broken.json()).toMatchObject({ status: 'rejected', reason: expect.stringContaining('missing these columns') });
    const noResult = await t.app.inject({ method: 'GET', url: `/v1/booking-files/${broken.json().id}/result`, headers: { authorization: `Bearer ${st.tokens.partner}` } });
    expect(noResult.statusCode).toBe(409);
    // Another account sees nothing of it.
    expect((await get('/v1/booking-files', st.tokens.partnerB)).json().items).toEqual([]);
    expect((await get(`/v1/booking-files/${first.json().id}/result`, st.tokens.partnerB)).statusCode).toBe(404);
    // Staff send on an account's behalf by naming it.
    const staff = await upload(csv([row({ booking_ref: 'STAFF-1' })]), st.tokens.admin, 'staff.csv', `&accountId=${st.accountId}`);
    expect(staff.statusCode, staff.body).toBe(201);
    expect(staff.json()).toMatchObject({ accepted: 1, createdBy: 'admin-1' });
    expect((await upload(csv([row({ booking_ref: 'STAFF-2' })]), st.tokens.admin, 'staff2.csv')).statusCode).toBe(400);
  });
});
