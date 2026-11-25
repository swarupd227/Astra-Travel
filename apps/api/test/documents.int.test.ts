/**
 * Increment 10: policy documents (E09, E04-F02-S03, E21-F05-S01) through the API and database on a complete
 * published stack (see fixtures.ts), with the worker's delivery processing. Every form, rate and name is SYNTHETIC.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractText } from '@astra/studio';
import { deliverNext, NoMailServer, type EmailMessage, type EmailSender } from '../../worker/src/documents';
import { createLogger } from '@astra/platform';
import { createTestApp, insertAccount, resetDatabase, type TestContext } from './helpers';
import { addDays, publishedStack, send, today, type Stack } from './fixtures';

let t: TestContext;
let st: Stack;
const logger = createLogger('documents-test', 'fatal');

beforeAll(async () => {
  t = await createTestApp();
  await resetDatabase();
  st = await publishedStack(t);
}, 240_000);
afterAll(async () => t.close());

const partner = () => st.tokens.partner;
let refN = 0;
const bindBody = (amount = '84.00', email: string | null = 'pat@example.com') => ({
  ableToTravel: true,
  acknowledgement: { disclosureVersion: st.disclosureVersion, acknowledgedBy: 'Pat Sample' },
  payment: { reference: `PAY-DOC-${Date.now()}-${refN++}`, amount },
  purchaser: { name: 'Pat Sample', ...(email ? { email } : {}) },
});
/** Quotes and binds the stack's traveller; returns the policy. */
async function bindPolicy(email: string | null = 'pat@example.com', lastName = 'Sample') {
  const q = await send(t, 'POST', '/v1/quotes', partner(), st.quoteBody({ travellers: [{ firstName: `Pat${refN}`, lastName, dateOfBirth: '1980-05-05', costPerTraveller: '4200' }] }));
  expect(q.statusCode, q.body).toBe(201);
  const b = await send(t, 'POST', `/v1/quotes/${q.json().id}/bind`, partner(), bindBody('84.00', email), { 'idempotency-key': `bind-doc-${Date.now()}-${refN++}` });
  expect(b.statusCode, b.body).toBe(201);
  return b.json() as { id: string; number: string };
}
const docsOf = async (policyId: string, token = partner()) => (await send(t, 'GET', `/v1/policies/${policyId}/documents`, token)).json().items as {
  id: string;
  kind: string;
  status: string;
  failure: string | null;
  sha256: string | null;
  templateId: string | null;
  deliveries: { id: string; channel: string; status: string; recipient: string | null; attempts: number; lastError: string | null }[];
}[];
const strip = (s: string) => s.replace(/\s+/g, '');

async function asPlatform<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>): Promise<T> {
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

class Outbox implements EmailSender {
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
    this.sent.push(m);
    return 'accepted by the test mail server';
  }
}
class Down implements EmailSender {
  async send(): Promise<string> {
    throw new Error('mailbox unavailable');
  }
}
/** Sends everything that is due. */
async function drain(files = t.files, sender: EmailSender = new Outbox(), delays: readonly number[] = [5, 5]) {
  let n = 0;
  while (await deliverNext(t.pool, files, sender, logger, delays)) n++;
  return n;
}

describe('assembly of the filed schedule (E09-F01-S01)', () => {
  it('fills every bracket with the plan’s value in the filed format and leaves none behind', async () => {
    const res = await send(t, 'GET', `/v1/document-templates/${st.scheduleTemplateId}`, st.tokens.product);
    expect(res.statusCode, res.body).toBe(200);
    const tpl = res.json();
    expect(tpl).toMatchObject({ kind: 'schedule', version: 1, status: 'released', problems: [], planCode: 'Q-DE', planVersion: 1 });
    expect(tpl.text).toContain('Trip Cancellation maximum $5,000 per person');
    expect(tpl.text).toContain('Trip Interruption maximum $7,500 per person');
    expect(tpl.text).toContain('Trip Delay maximum $1,000 per person');
    // Periods are words and figures, as filed.
    expect(tpl.text).toContain('The time-sensitive period is twenty (20) days.');
    expect(tpl.text).toContain('within the ten (10) day review period');
    expect(tpl.text).not.toMatch(/[[\]]/);
    expect(tpl.checks.every((c: { passed: boolean }) => c.passed)).toBe(true);
    expect(tpl.checks.map((c: { check: string }) => c.check)).toEqual(['assembled', 'accounted', 'in_range', 'quality']);
    expect(tpl.form).toMatchObject({ formNumber: 'q_sch', edition: '2026-04', mapVersion: 1 });
    expect(tpl.releasedBy).not.toBe(tpl.createdBy);
  });

  it('refuses a template for a form the plan does not have', async () => {
    const res = await send(t, 'POST', '/v1/document-templates', st.tokens.product, { planVersionId: st.planVersionId, kind: 'policy' });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().detail ?? res.json().title).toMatch(/no policy form/i);
  });

  it('is released by someone other than its maker, and a new one replaces the released one (E09-F02-S01)', async () => {
    const made = await send(t, 'POST', '/v1/document-templates', st.tokens.compliance, { planVersionId: st.planVersionId, kind: 'schedule' });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json()).toMatchObject({ version: 2, status: 'draft', releasable: true });
    const id = made.json().id as string;
    // The maker cannot release; a person without the permission cannot either.
    expect((await send(t, 'POST', `/v1/document-templates/${id}/release`, st.tokens.compliance, {})).statusCode).toBe(403);
    expect((await send(t, 'POST', `/v1/document-templates/${id}/release`, st.tokens.product, {})).statusCode).toBe(403);
    const released = await send(t, 'POST', `/v1/document-templates/${id}/release`, st.tokens.admin, { note: 'Same wording as version 1.' });
    expect(released.statusCode, released.body).toBe(200);
    expect(released.json()).toMatchObject({ status: 'released', releasedBy: 'admin-1' });
    const list = (await send(t, 'GET', `/v1/document-templates?planVersionId=${st.planVersionId}`, st.tokens.product)).json().items as { id: string; status: string }[];
    expect(list.find((x) => x.id === st.scheduleTemplateId)!.status).toBe('superseded');
    expect(list.filter((x) => x.status === 'released')).toHaveLength(1);
    // Released content cannot change.
    await expect(t.pool.query(`UPDATE documents.templates SET text = 'changed' WHERE id = $1`, [id])).rejects.toThrow(/cannot change/);
    expect((await send(t, 'POST', `/v1/document-templates/${id}/release`, st.tokens.admin, {})).statusCode).toBe(409);
  });
});

describe('documents issued at bind (E04-F02-S03, E09-F01-S02)', () => {
  it('issues the purchase confirmation and the schedule within the bind, with the PDF and its proof', async () => {
    const started = Date.now();
    const policy = await bindPolicy();
    expect(Date.now() - started).toBeLessThan(30_000);
    const docs = await docsOf(policy.id);
    expect(docs.map((d) => d.kind).sort()).toEqual(['purchase_confirmation', 'schedule']);
    for (const d of docs) {
      expect(d, d.kind).toMatchObject({ status: 'issued', failure: null });
      expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(d.deliveries.map((x) => `${x.channel}:${x.status}`).sort()).toEqual(['account:available', 'email:queued']);
      expect(d.deliveries.find((x) => x.channel === 'email')!.recipient).toBe('pat@example.com');
    }

    // The confirmation states trip cost, benefits, limits, premium and the insurer.
    const conf = docs.find((d) => d.kind === 'purchase_confirmation')!;
    const text = ((await send(t, 'GET', `/v1/documents/${conf.id}`, partner())).json().text as string);
    for (const expected of [policy.number, '$4,200.00', 'Trip Cancellation', '$5,000 per person', '$84.00', 'Virginia Surety Company, Inc.', 'Total premium: $84.00']) expect(text, expected).toContain(expected);

    // The schedule is the assembled wording with the policy's declarations; no bracket reaches the traveller.
    const sch = docs.find((d) => d.kind === 'schedule')!;
    expect(sch.templateId).not.toBeNull();
    const schText = ((await send(t, 'GET', `/v1/documents/${sch.id}`, partner())).json().text as string);
    expect(schText).toContain(`Policy number: ${policy.number}`);
    expect(schText).toContain('Trip Cancellation maximum $5,000 per person');
    expect(schText).not.toMatch(/[[\]]/);

    // The PDF is the document: its hash is recorded, and reading it back gives the same wording.
    const pdf = await send(t, 'GET', `/v1/documents/${sch.id}/file`, partner());
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const bytes = pdf.rawPayload;
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sch.sha256);
    const read = await extractText(new Uint8Array(bytes), 'application/pdf');
    const wording = schText.slice(schText.indexOf('SCHEDULE OF BENEFITS'));
    expect(strip(read.text)).toContain(strip(wording));
  });

  it('keeps issued documents unchangeable and invisible to other accounts', async () => {
    const policy = await bindPolicy();
    const [doc] = await docsOf(policy.id);
    await expect(asPlatform((q) => q(`UPDATE documents.documents SET title = 'x' WHERE id = $1`, [doc!.id]))).rejects.toThrow(/cannot change/);
    await expect(asPlatform((q) => q(`DELETE FROM documents.documents WHERE id = $1`, [doc!.id]))).rejects.toThrow(/cannot be deleted|permission denied/);
    expect((await send(t, 'GET', `/v1/documents/${doc!.id}`, st.tokens.partnerB)).statusCode).toBe(404);
    expect((await send(t, 'GET', `/v1/documents/${doc!.id}/file`, st.tokens.partnerB)).statusCode).toBe(404);
    expect((await send(t, 'GET', `/v1/policies/${policy.id}/documents`, st.tokens.partnerB)).statusCode).toBe(404);
  });
});

describe('delivery and its status (E09-F03-S01)', () => {
  it('emails the PDF, records every attempt and shows the delivery as sent', async () => {
    await drain();
    const policy = await bindPolicy('traveller@example.com');
    const outbox = new Outbox();
    await drain(t.files, outbox);
    const mine = outbox.sent.filter((m) => m.subject.includes(policy.number));
    expect(mine.map((m) => m.to)).toEqual(['traveller@example.com', 'traveller@example.com']);
    expect(mine[0]!.attachment.content.subarray(0, 5).toString()).toBe('%PDF-');
    const docs = await docsOf(policy.id);
    for (const d of docs) {
      expect(d.deliveries.find((x) => x.channel === 'email'), d.kind).toMatchObject({ status: 'sent', attempts: 1, lastError: null });
      expect(d.deliveries.find((x) => x.channel === 'account')!.status).toBe('available');
    }
    const attempts = await asPlatform((q) => q(`SELECT ok, detail FROM documents.delivery_attempts WHERE delivery_id = $1`, [docs[0]!.deliveries.find((x) => x.channel === 'email')!.id]));
    expect(attempts.rows).toEqual([{ ok: true, detail: 'accepted by the test mail server' }]);
  });

  it('retries a failing send with back-off, then marks it failed, lists it and sends it again on request', async () => {
    await drain();
    const policy = await bindPolicy('bounce@example.com');
    const down = new Down();
    const slow = [60_000, 60_000];
    const makeDue = () => asPlatform((q) => q(`UPDATE documents.deliveries SET next_attempt_at = now() WHERE status = 'queued' AND channel = 'email'`));
    expect(await drain(t.files, down, slow)).toBeGreaterThan(0);
    // The first failure is scheduled for another attempt, not final.
    let docs = await docsOf(policy.id);
    expect(docs[0]!.deliveries.find((x) => x.channel === 'email')).toMatchObject({ status: 'queued', attempts: 1, lastError: 'mailbox unavailable' });
    await makeDue();
    await drain(t.files, down, slow);
    docs = await docsOf(policy.id);
    expect(docs[0]!.deliveries.find((x) => x.channel === 'email')).toMatchObject({ status: 'queued', attempts: 2 });
    await makeDue();
    await drain(t.files, down, slow);
    docs = await docsOf(policy.id);
    for (const d of docs) expect(d.deliveries.find((x) => x.channel === 'email'), d.kind).toMatchObject({ status: 'failed', attempts: 3, lastError: 'mailbox unavailable' });
    // The failure is raised as an event and appears in the failed list.
    const ev = await asPlatform((q) => q(`SELECT count(*)::int AS n FROM platform.outbox WHERE type = 'DocumentDeliveryFailed'`));
    expect(ev.rows[0]!.n).toBeGreaterThanOrEqual(2);
    const failures = (await send(t, 'GET', '/v1/document-failures', st.tokens.admin)).json();
    const failed = failures.deliveries.filter((x: { policyNumber: string }) => x.policyNumber === policy.number);
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatchObject({ channel: 'email', recipient: 'bounce@example.com', lastError: 'mailbox unavailable' });
    // Staff retry it; with the mail server back it is sent.
    expect((await send(t, 'POST', `/v1/document-deliveries/${failed[0].id}/retry`, st.tokens.uw1, {})).statusCode).toBe(403);
    const retried = await send(t, 'POST', `/v1/document-deliveries/${failed[0].id}/retry`, st.tokens.admin, {});
    expect(retried.statusCode, retried.body).toBe(200);
    expect((await send(t, 'POST', `/v1/document-deliveries/${failed[0].id}/retry`, st.tokens.admin, {})).statusCode).toBe(409);
    await drain();
    docs = await docsOf(policy.id);
    expect(docs.flatMap((d) => d.deliveries).filter((x) => x.channel === 'email').map((x) => x.status).sort()).toEqual(['failed', 'sent']);
  });

  it('fails at once, with that reason, when no mail server is configured', async () => {
    await drain();
    const policy = await bindPolicy('nomail@example.com');
    await drain(t.files, new NoMailServer());
    const docs = await docsOf(policy.id);
    for (const d of docs) expect(d.deliveries.find((x) => x.channel === 'email'), d.kind).toMatchObject({ status: 'failed', attempts: 1 });
    expect(docs[0]!.deliveries.find((x) => x.channel === 'email')!.lastError).toContain('No mail server is configured');
  });

  it('has no email delivery when the purchaser gave no address, but the account copy is available', async () => {
    const policy = await bindPolicy(null);
    for (const d of await docsOf(policy.id)) expect(d.deliveries.map((x) => x.channel)).toEqual(['account']);
  });
});

describe('documents that could not be produced', () => {
  it('records the failure, keeps the bind, and settles it when a template is released', async () => {
    await asPlatform((q) => q(`UPDATE documents.templates SET status = 'superseded' WHERE plan_version_id = $1 AND kind = 'schedule' AND status = 'released'`, [st.planVersionId]));
    const policy = await bindPolicy();
    let docs = await docsOf(policy.id);
    const sch = docs.find((d) => d.kind === 'schedule')!;
    expect(docs.find((d) => d.kind === 'purchase_confirmation')!.status).toBe('issued');
    expect(sch).toMatchObject({ status: 'failed', sha256: null });
    expect(sch.failure).toContain('no released schedule template');
    expect(sch.deliveries).toEqual([]);
    expect((await send(t, 'GET', `/v1/documents/${sch.id}/file`, partner())).statusCode).toBe(409);
    const failures = (await send(t, 'GET', '/v1/document-failures', st.tokens.admin)).json();
    expect(failures.documents.map((d: { id: string }) => d.id)).toContain(sch.id);

    // Release a template, then issue what is missing: the failed record is settled, not duplicated.
    const made = await send(t, 'POST', '/v1/document-templates', st.tokens.product, { planVersionId: st.planVersionId, kind: 'schedule' });
    expect((await send(t, 'POST', `/v1/document-templates/${made.json().id}/release`, st.tokens.compliance, {})).statusCode).toBe(200);
    const issued = await send(t, 'POST', `/v1/policies/${policy.id}/documents/issue`, st.tokens.admin, {});
    expect(issued.statusCode, issued.body).toBe(200);
    docs = await docsOf(policy.id);
    expect(docs).toHaveLength(2);
    expect(docs.find((d) => d.kind === 'schedule')).toMatchObject({ id: sch.id, status: 'issued', failure: null });
    expect(docs.find((d) => d.kind === 'schedule')!.deliveries.map((x) => x.channel).sort()).toEqual(['account', 'email']);
    const after = (await send(t, 'GET', '/v1/document-failures', st.tokens.admin)).json();
    expect(after.documents.map((d: { id: string }) => d.id)).not.toContain(sch.id);
  });
});

describe('documents for changes and cancellations (E09-F01-S03)', () => {
  it('states what changed, once per event, and the end of cover for a cancellation', async () => {
    const policy = await bindPolicy();
    const full = (await send(t, 'GET', `/v1/policies/${policy.id}`, st.tokens.admin)).json();
    const newDeparture = addDays(full.record.trip.departureDate, 2);
    const event = async (type: string, data: unknown, reason: string) =>
      asPlatform(async (q) =>
        Number(
          (
            await q(`INSERT INTO policies.policy_events (policy_id, account_id, type, actor, actor_name, reason, data) VALUES ($1, $2, $3, 'svc-1', 'Sam Service', $4, $5) RETURNING seq`, [policy.id, full.accountId, type, reason, JSON.stringify(data)])
          ).rows[0]!.seq,
        ),
      );
    const changed = await event('details_changed', { patch: { trip: { departureDate: newDeparture } } }, 'Traveller moved the departure');
    const res = await send(t, 'POST', `/v1/policies/${policy.id}/notices`, st.tokens.admin, { eventSeq: changed });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ kind: 'change_notice', status: 'issued' });
    const text = (await send(t, 'GET', `/v1/documents/${res.json().id}`, st.tokens.admin)).json().text as string;
    expect(text).toContain('Departure date | ' + full.record.trip.departureDate + ' | ' + newDeparture);
    expect(text).toContain('Reason: Traveller moved the departure');
    expect((await send(t, 'POST', `/v1/policies/${policy.id}/notices`, st.tokens.admin, { eventSeq: changed })).statusCode).toBe(409);

    const cancelled = await event('status_changed', { from: 'active', to: 'cancelled' }, 'Cancelled at the traveller’s request');
    await asPlatform((q) => q(`UPDATE policies.policies SET status = 'cancelled' WHERE id = $1`, [policy.id]));
    const cn = await send(t, 'POST', `/v1/policies/${policy.id}/notices`, st.tokens.admin, { eventSeq: cancelled });
    expect(cn.statusCode, cn.body).toBe(201);
    expect(cn.json()).toMatchObject({ kind: 'cancellation_notice' });
    expect(((await send(t, 'GET', `/v1/documents/${cn.json().id}`, st.tokens.admin)).json().text as string)).toContain(`Cancelled on: ${new Date().toISOString().slice(0, 10)}`);

    const bound = (full.history as { seq: number; type: string }[]).find((e) => e.type === 'bound')!;
    expect((await send(t, 'POST', `/v1/policies/${policy.id}/notices`, st.tokens.admin, { eventSeq: bound.seq })).statusCode).toBe(400);
    expect((await send(t, 'POST', `/v1/policies/${policy.id}/notices`, st.tokens.admin, { eventSeq: 999999 })).statusCode).toBe(404);
    expect(today()).toBeTruthy();
  });
});

describe('Guide to Benefits (E21-F05-S01)', () => {
  it('is versioned with the card programme, from the master policy and the plan’s benefits and limits', async () => {
    const manager = await t.idp.token({ roles: ['card_programme_manager'], sub: 'cpm-1', name: 'Carla Programme' });
    const issuer = await insertAccount(t.pool, `DOC-ISSUER-${Date.now().toString(36).toUpperCase()}`, 'card_issuer');
    const mp = await send(t, 'POST', '/v1/master-policies', manager, { accountId: issuer, policyNumber: `MP-DOC-${Date.now()}`, underwriter: 'VSC', states: ['DE'], effectiveFrom: '2026-01-01' });
    expect(mp.statusCode, mp.body).toBe(201);
    const prog = await send(t, 'POST', '/v1/card-programmes', manager, { masterPolicyId: mp.json().id, code: `DOC-CARD-${Date.now().toString(36).toUpperCase()}`, name: 'Synthetic Gold card cover', cardProduct: 'Gold', states: ['DE'], effectiveFrom: '2026-01-01', paymentCondition: { rule: 'none' }, eligibilityRule: 'purchase_date' });
    expect(prog.statusCode, prog.body).toBe(201);
    const id = prog.json().id as string;

    const g1 = await send(t, 'POST', `/v1/card-programmes/${id}/guides`, manager, { planCode: 'Q-DE' });
    expect(g1.statusCode, g1.body).toBe(201);
    expect(g1.json()).toMatchObject({ kind: 'guide_to_benefits', version: 1, programmeId: id, status: 'issued' });
    const g2 = await send(t, 'POST', `/v1/card-programmes/${id}/guides`, manager, { planCode: 'Q-DE' });
    expect(g2.json().version).toBe(2);
    const text = (await send(t, 'GET', `/v1/documents/${g1.json().id}`, manager)).json().text as string;
    for (const expected of ['Synthetic Gold card cover', mp.json().policyNumber, 'Trip Cancellation | $5,000 per person', 'Trip Delay | $1,000 per person', 'version 1']) expect(text, expected).toContain(expected);
    const list = (await send(t, 'GET', `/v1/card-programmes/${id}/guides`, manager)).json().items as { version: number }[];
    expect(list.map((x) => x.version)).toEqual([2, 1]);
    // A plan that is not published gives no guide.
    expect((await send(t, 'POST', `/v1/card-programmes/${id}/guides`, manager, { planCode: 'NO-SUCH-PLAN' })).statusCode).toBe(400);
    // The issuer's own account sees its guide through the same API; other accounts do not.
    const issuerToken = await t.idp.token({ roles: ['partner_developer'], accountId: issuer, sub: 'svc-issuer' });
    expect((await send(t, 'GET', `/v1/documents/${g1.json().id}`, issuerToken)).statusCode).toBe(200);
    expect((await send(t, 'GET', `/v1/documents/${g1.json().id}`, st.tokens.partnerB)).statusCode).toBe(404);
  });
});
