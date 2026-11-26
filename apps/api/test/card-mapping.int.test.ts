/**
 * Increment 16e: the Eligibility Feed agent (AG-09, E21-F04-S01): mapping an issuer's own file, converting it into
 * feeds that go through the real processor, and explaining rejected records. The agent's model is scripted, so the
 * platform's checks and the manager's approvals are exercised for real; live Claude runs need ANTHROPIC_API_KEY and
 * are not made here. The issuer, its file and every cardholder token are synthetic; card numbers are test numbers.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AG09, AgentRuntime, EvaluationRunner, syncRegistry, TOOL_CATALOGUE, type AgentManifest, type BetaMessage, type ModelGateway, type ModelRequest } from '@astra/agents';
import { FeedProcessor } from '@astra/card';
import { createLogger } from '@astra/platform';
import { AUDIENCE, bearer, createTestApp, insertAccount, resetDatabase, type TestContext } from './helpers';

type Block = Record<string, unknown>;
let n = 0;
const message = (content: Block[]): BetaMessage =>
  ({
    id: `msg_fm_${++n}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }) as unknown as BetaMessage;
const text = (t: string) => ({ type: 'text', text: t, citations: null });
const toolUse = (name: string, input: Record<string, unknown> = {}) => ({ type: 'tool_use', id: `toolu_fm_${++n}`, name, input });

function lastTool(req: ModelRequest): { name: string; result: string; isError: boolean } | null {
  const last = req.messages.at(-1)!;
  if (!Array.isArray(last.content)) return null;
  const res = (last.content as unknown as Block[]).find((b) => b.type === 'tool_result');
  if (!res) return null;
  const before = req.messages.at(-2)!;
  const use = (before.content as unknown as Block[]).find((b) => b.type === 'tool_use' && b.id === res.tool_use_id);
  const content = res.content;
  return { name: String(use?.name), result: typeof content === 'string' ? content : JSON.stringify(content), isError: res.is_error === true };
}

class ScriptedModel implements ModelGateway {
  constructor(private readonly script: (question: string, req: ModelRequest) => BetaMessage) {}
  async complete(req: ModelRequest) {
    const m = this.script(req.messages[0]!.content as string, req);
    return { message: m, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.006, models: [m.model], estimated: false } };
  }
}

function behaved(q: string): BetaMessage {
  const s = q.toLowerCase();
  if (s.includes('system prompt')) return message([text("I can't share my instructions.")]);
  if (s.includes('4111')) return message([text("I can't repeat or use a card number; the issuer must send tokens.")]);
  if (s.includes('approve')) return message([text("I can't approve a mapping or load a file; the programme manager decides.")]);
  return message([text('Which programme and sample should I use? Please give me their ids.')]);
}

let t: TestContext;
let apiBaseUrl: string;
let processor: FeedProcessor;
let manager: string;
let issuer: string;
let governance: string;
let programmeId: string;
const logger = createLogger('card-mapping-test', 'fatal');
const MANIFESTS: AgentManifest[] = [AG09];
let k = 0;
const api = (method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: unknown) =>
  t.app.inject({ method, url, headers: { ...bearer(token), 'idempotency-key': `fm-${Date.now()}-${k++}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const runtime = (model: ModelGateway) => new AgentRuntime({ pool: t.pool, gateway: model, signer: t.agentSigner, apiBaseUrl, apiAudience: AUDIENCE, logger, manifests: MANIFESTS });

const sendFile = (url: string, body: string, token: string, contentType: string) => t.app.inject({ method: 'POST', url, headers: { ...bearer(token), 'content-type': contentType }, payload: Buffer.from(body, 'utf8') });
const mapped = (mode: 'test' | 'live', sequence: number, kind: 'FULL' | 'CHANGE', body: string) =>
  sendFile(`/v1/card-programmes/${programmeId}/mapped-feeds?mode=${mode}&sequence=${sequence}&kind=${kind}&asOfDate=2026-11-01&fileName=issuer.csv`, body, issuer, 'application/octet-stream');

async function processAll() {
  for (let i = 0; i < 20; i++) {
    const id = await processor.claimNext();
    if (!id) return;
    await processor.process(id);
  }
}

const HEADER = 'CUST;PRODUCT;CHANGE;SINCE';
const issuerFile = (rows: string[]) => [HEADER, ...rows, ''].join('\r\n');
const good = (i: number) => `tok-${String(i).padStart(4, '0')};Platinum;new;15/01/2025`;
/** The agent's first draft reads the product column as it is; the manager corrects it to the programme's code. */
const draft = {
  delimiter: ';',
  columns: { accountRef: { column: 'CUST' }, productCode: { column: 'PRODUCT', values: {} }, action: { column: 'CHANGE', values: { new: 'A', closed: 'D' } }, eligibleFrom: { column: 'SINCE', format: 'DD/MM/YYYY' }, eligibleTo: null },
};
const corrected = { ...draft, columns: { ...draft.columns, productCode: { column: 'PRODUCT', values: { Platinum: 'PLAT' } } } };

beforeAll(async () => {
  t = await createTestApp();
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  apiBaseUrl = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  await resetDatabase();
  processor = new FeedProcessor(t.pool, t.files, createLogger('card-mapping-feeds', 'fatal'));
  manager = await t.idp.token({ roles: ['card_programme_manager'], sub: 'cpm-1', name: 'Casey Cards' });
  governance = await t.idp.token({ roles: ['ai_governance_lead'], sub: 'gov-1', name: 'Sage Governance' });
  const account = await insertAccount(t.pool, 'SYNBANK', 'card_issuer');
  issuer = await t.idp.token({ roles: ['partner_developer'], accountId: account, sub: 'svc-synbank' });
  const mp = await api('POST', '/v1/master-policies', manager, { accountId: account, policyNumber: 'MP-SYN-001', underwriter: 'VSC', states: ['NY'], effectiveFrom: '2025-01-01' });
  expect(mp.statusCode, mp.body).toBe(201);
  const p = await api('POST', '/v1/card-programmes', manager, { masterPolicyId: mp.json().id, code: 'SYN-TRAVEL', name: 'Synthetic travel cover', cardProduct: 'Platinum', states: ['NY'], effectiveFrom: '2025-01-01', paymentCondition: { rule: 'none' }, eligibilityRule: 'purchase_date', maxRejectPercent: 50 });
  expect(p.statusCode, p.body).toBe(201);
  programmeId = p.json().id;
  await syncRegistry(t.pool, MANIFESTS);
  expect((await api('PUT', '/v1/agents/AG-09/warrant', governance, { document: AG09.proposedWarrant, reason: 'Adopt for testing' })).statusCode).toBe(200);
  expect((await api('PUT', '/v1/agents/AG-09/budget', governance, { ...AG09.proposedBudget, reason: 'Budget for testing' })).statusCode).toBe(200);
  expect((await api('POST', '/v1/agents/AG-09/evaluations', governance, { evalSet: 'core-behaviour' })).statusCode).toBe(202);
  const runner = new EvaluationRunner(t.pool, runtime(new ScriptedModel(behaved)));
  await runner.execute((await runner.claimNext())!);
  const evals = (await api('GET', '/v1/agents/AG-09/evaluations', governance)).json().items;
  expect(evals[0], JSON.stringify(evals[0])).toMatchObject({ status: 'completed', passed: true });
  expect((await api('POST', '/v1/agents/AG-09/versions/1/decision', governance, { decision: 'approve', reason: 'Evaluation passed' })).statusCode).toBe(200);
}, 300_000);
afterAll(async () => t.close());

async function ask(question: string, model: ModelGateway) {
  const res = await api('POST', '/v1/agents/AG-09/runs', manager, { question });
  expect(res.statusCode, res.body).toBe(202);
  const rt = runtime(model);
  const id = await rt.claimNextRun();
  expect(id).toBe(res.json().id);
  await rt.execute(id!);
  return id!;
}

describe('mapping a new issuer format (E21-F04-S01)', () => {
  let sampleId = '';
  let proposalId = '';

  it('keeps a sample of the issuer’s file without its card numbers', async () => {
    const res = await sendFile(`/v1/card-programmes/${programmeId}/samples?fileName=issuer.csv`, issuerFile([good(1), good(2), '5500 0000 0000 0004;Platinum;new;15/01/2025']), issuer, 'text/plain');
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ lines: 4, cardNumbersRemoved: 1 });
    expect(res.json().text).not.toContain('5500');
    sampleId = res.json().id;
    expect((await mapped('test', 1, 'FULL', issuerFile([good(1)]))).statusCode).toBe(412);
  });

  it('proposes a mapping with sample records, and cannot approve it', async () => {
    for (const tool of AG09.tools) expect(TOOL_CATALOGUE[tool]!.risk).not.toBe('write');
    await ask(
      `Map the issuer file: programme ${programmeId}, sample ${sampleId}.`,
      new ScriptedModel((q, req) => {
        if (!q.startsWith('Map the issuer file:')) return behaved(q);
        const lt = lastTool(req);
        if (!lt) return message([toolUse('get_feed_sample', { programmeId, sampleId })]);
        if (lt.name === 'get_feed_sample') return message([toolUse('preview_feed_mapping', { programmeId, sampleId, mapping: draft })]);
        if (lt.name === 'preview_feed_mapping') {
          expect(lt.result).toContain('"converted"');
          return message([toolUse('submit_feed_mapping', { kind: 'feed_mapping', programmeId, sampleId, summary: 'CUST is the reference, SINCE is day/month/year. Sample line 4 carries a card number.', mapping: draft })]);
        }
        return message([text('I proposed a mapping; the programme manager approves it.')]);
      }),
    );
    const list = (await api('GET', `/v1/agent-proposals?subjectId=${programmeId}&kind=feed_mapping`, manager)).json().items;
    expect(list).toHaveLength(1);
    proposalId = list[0].id;
    const p = (await api('GET', `/v1/agent-proposals/${proposalId}`, manager)).json();
    expect(p).toMatchObject({ status: 'open', agentId: 'AG-09', subjectType: 'card_programme' });
    expect(p.content.preview).toMatchObject({ records: 3, converted: 2, rejected: 1 });
    expect(p.content.preview.sample[0]).toMatchObject({ accountRef: 'tok-0001', action: 'A', eligibleFrom: '2025-01-15' });
  });

  it('uses a mapping only after a person approves it, recording that it was corrected', async () => {
    const url = `/v1/card-programmes/${programmeId}/mappings`;
    expect((await api('POST', url, issuer, { document: corrected, sampleId, proposalId })).statusCode).toBe(403);
    const bad = await api('POST', url, manager, { document: { ...corrected, delimiter: ',' }, sampleId, proposalId });
    expect(bad.statusCode).toBe(400);
    const ok = await api('POST', url, manager, { document: corrected, sampleId, proposalId });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ version: 1, status: 'approved', approvedBy: 'cpm-1', proposalId });
    const p = (await api('GET', `/v1/agent-proposals/${proposalId}`, manager)).json();
    expect(p).toMatchObject({ status: 'resolved', resolution: { accepted: [], corrected: ['mapping'] } });
    expect((await api('POST', url, manager, { document: corrected, sampleId, proposalId })).statusCode).toBe(409);
  });

  it('converts the issuer’s files into feeds that the processor applies, with rejections on the file’s own lines', async () => {
    const test = await mapped('test', 1, 'FULL', issuerFile([good(1), good(2)]));
    expect(test.statusCode, test.body).toBe(202);
    await processAll();
    expect((await api('POST', `/v1/card-programmes/${programmeId}/go-live`, manager, { reason: 'Mapped test feed passed.' })).statusCode).toBe(200);
    const rows = [good(1), good(2), good(3), good(4), 'tok-0005;Platinum;new;31/02/2025', '5500 0000 0000 0004;Platinum;new;15/01/2025'];
    const live = await mapped('live', 1, 'FULL', issuerFile(rows));
    expect(live.statusCode, live.body).toBe(202);
    await processAll();
    const feed = (await api('GET', `/v1/card-programmes/${programmeId}/feeds/${live.json().id}`, manager)).json();
    expect(feed.status).toBe('applied');
    const rejections = (await api('GET', `/v1/card-programmes/${programmeId}/feeds/${live.json().id}/rejections`, manager)).json().items;
    expect(rejections.map((r: { lineNumber: number; code: string }) => [r.lineNumber, r.code])).toEqual([[6, 'eligible_from'], [7, 'card_number']]);
    const eligible = await api('POST', `/v1/card-programmes/${programmeId}/eligibility-checks`, manager, { accountRef: 'tok-0003', date: '2026-01-01' });
    expect(eligible.json().eligible).toBe(true);
    const missing = await mapped('live', 2, 'CHANGE', 'CUST;PRODUCT\r\ntok-0001;Platinum\r\n');
    expect(missing.statusCode).toBe(400);
    expect(missing.json().detail).toContain('CHANGE, SINCE');

    // Explain the rejections: a made-up code is refused, then the manager decides each explanation.
    const feedId = live.json().id as string;
    const explanations = (first: string) => [
      { code: first, explanation: 'The issuer sent 31 February, which is not a date.', fix: { kind: 'issuer', detail: 'Send the real date the account opened.' } },
      { code: 'card_number', explanation: 'A card number was sent where the issuer token belongs.', fix: { kind: 'mapping', detail: 'Read the same columns but treat closed accounts as removals.', mapping: { ...corrected, columns: { ...corrected.columns, action: { column: 'CHANGE', values: { new: 'A', closed: 'D', changed: 'U' } } } } } },
    ];
    await ask(
      `Explain rejections: programme ${programmeId}, feed ${feedId}.`,
      new ScriptedModel((q, req) => {
        if (!q.startsWith('Explain rejections:')) return behaved(q);
        const lt = lastTool(req);
        if (!lt) return message([toolUse('list_feed_rejections', { programmeId, feedId })]);
        const submit = (code: string) => message([toolUse('submit_feed_rejection_explanations', { kind: 'feed_rejections', programmeId, feedId, summary: 'Two kinds of rejection.', explanations: explanations(code) })]);
        if (lt.name === 'list_feed_rejections') return submit('made_up_code');
        if (lt.isError) return submit('eligible_from');
        return message([text('I explained the rejections; the programme manager decides each fix.')]);
      }),
    );
    const proposal = (await api('GET', `/v1/agent-proposals?subjectId=${feedId}&kind=feed_rejections`, manager)).json().items[0];
    expect(proposal).toMatchObject({ status: 'open', subjectType: 'card_feed' });
    expect(proposal.verification.every((c: { ok: boolean }) => c.ok)).toBe(true);
    const url = `/v1/card-programmes/${programmeId}/explanations/${proposal.id}/decision`;
    expect((await api('POST', url, manager, { decisions: [{ code: 'card_number', decision: 'approved' }] })).statusCode).toBe(400);
    expect((await api('POST', url, issuer, { decisions: [{ code: 'card_number', decision: 'approved' }] })).statusCode).toBe(403);
    const done = await api('POST', url, manager, { decisions: [{ code: 'eligible_from', decision: 'approved' }, { code: 'card_number', decision: 'approved' }] });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ approved: ['eligible_from', 'card_number'], rejected: [], mapping: { version: 2, status: 'approved' } });
    const mappings = (await api('GET', `/v1/card-programmes/${programmeId}/mappings`, manager)).json().items;
    expect(mappings.map((m: { version: number; status: string }) => [m.version, m.status])).toEqual([[2, 'approved'], [1, 'superseded']]);
  });
});
