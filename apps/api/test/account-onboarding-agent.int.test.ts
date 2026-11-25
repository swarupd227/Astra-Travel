/**
 * Increment 13: the Account Onboarding agent (AG-05, E07-F01-S02) end to end through the real API, database, agent
 * tokens and runtime. The model is scripted, so the platform's own checks are what is exercised: every drafted
 * field must carry wording that is really in the account's document and a valid value, and nothing is saved until
 * a person applies it. Live Claude runs need ANTHROPIC_API_KEY and are not made here. The contract is synthetic.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AG05, AgentRuntime, EvaluationRunner, syncRegistry, type AgentManifest, type BetaMessage, type ModelGateway, type ModelRequest } from '@astra/agents';
import { createLogger } from '@astra/platform';
import { AUDIENCE, bearer, createTestApp, insertAccount, resetDatabase, type TestContext } from './helpers';

type Block = Record<string, unknown>;
let n = 0;
const message = (content: Block[]): BetaMessage =>
  ({ id: `msg_ob_${++n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, stop_details: null, usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) as unknown as BetaMessage;
const text = (t: string) => ({ type: 'text', text: t, citations: null });
const toolUse = (name: string, input: Record<string, unknown> = {}) => ({ type: 'tool_use', id: `toolu_ob_${++n}`, name, input });
function lastTool(req: ModelRequest): { name: string; result: string; isError: boolean } | null {
  const last = req.messages.at(-1)!;
  if (!Array.isArray(last.content)) return null;
  const res = (last.content as unknown as Block[]).find((b) => b.type === 'tool_result');
  if (!res) return null;
  const before = req.messages.at(-2)!;
  const use = (before.content as unknown as Block[]).find((b) => b.type === 'tool_use' && b.id === res.tool_use_id);
  return { name: String(use?.name), result: typeof res.content === 'string' ? res.content : JSON.stringify(res.content), isError: res.is_error === true };
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
  if (s.includes('card')) return message([text('I can only refer to that card by its last four digits, 1111.')]);
  if (s.includes('take it live')) return message([text("I can't set the account up or take it live. I only draft fields, and a person reviews them.")]);
  if (s.includes('net 30')) return message([text("I can't add terms the contract does not state, so I will leave payment terms out.")]);
  return message([text('Which account should I draft? Please give me its id.')]);
}

let t: TestContext;
let apiBaseUrl: string;
let governance: string;
let manager: string;
const logger = createLogger('onboarding-agent-test', 'fatal');
const MANIFESTS: AgentManifest[] = [AG05];
let k = 0;
const api = (method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: unknown) =>
  t.app.inject({ method, url, headers: { ...bearer(token), 'idempotency-key': `ob-${Date.now()}-${k++}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const runtime = (model: ModelGateway) => new AgentRuntime({ pool: t.pool, gateway: model, signer: t.agentSigner, apiBaseUrl, apiAudience: AUDIENCE, logger, manifests: MANIFESTS });

beforeAll(async () => {
  t = await createTestApp();
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  apiBaseUrl = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  await resetDatabase();
  await syncRegistry(t.pool, MANIFESTS);
  governance = await t.idp.token({ roles: ['ai_governance_lead'], sub: 'gov-1', name: 'Sage Governance' });
  manager = await t.idp.token({ roles: ['account_manager'], sub: 'am-1', name: 'Ali Manager' });
  const m = AG05;
  expect((await api('PUT', `/v1/agents/${m.id}/warrant`, governance, { document: m.proposedWarrant, reason: 'Adopt for testing' })).statusCode).toBe(200);
  expect((await api('PUT', `/v1/agents/${m.id}/budget`, governance, { ...m.proposedBudget, reason: 'Budget for testing' })).statusCode).toBe(200);
  expect((await api('POST', `/v1/agents/${m.id}/evaluations`, governance, { evalSet: 'core-behaviour' })).statusCode).toBe(202);
  const runner = new EvaluationRunner(t.pool, runtime(new ScriptedModel(behaved)));
  await runner.execute((await runner.claimNext())!);
  const evals = (await api('GET', `/v1/agents/${m.id}/evaluations`, governance)).json().items;
  expect(evals[0], JSON.stringify(evals[0])).toMatchObject({ status: 'completed', passed: true });
  expect((await api('POST', `/v1/agents/${m.id}/versions/1/decision`, governance, { decision: 'approve', reason: 'Evaluation passed' })).statusCode).toBe(200);
}, 300_000);
afterAll(async () => t.close());

const CONTRACT = [
  'MASTER TRAVEL SERVICES AGREEMENT (synthetic test contract)',
  'Contract reference: CT-2026-0042.',
  'This agreement was signed on 1 February 2026.',
  'The Seller may sell the cover in Delaware and New York.',
  'The Seller will integrate through the Assurant API.',
  'Premium is settled by monthly statement, paid within 30 days of the statement date.',
].join('\n');

const draft = (accountId: string, documentId: string, fields: Record<string, unknown>[]) => ({ kind: 'account_onboarding', accountId, summary: 'Drafted from the contract: reference, signing date, states and settlement.', fields: fields.map((f) => ({ documentId, ...f })) });
const good = (documentId: string) => [
  { field: 'contractReference', value: 'CT-2026-0042', excerpt: 'Contract reference: CT-2026-0042.' },
  { field: 'contractSignedOn', value: '2026-02-01', excerpt: 'signed on 1 February 2026' },
  { field: 'states', value: ['DE', 'NY'], excerpt: 'may sell the cover in Delaware and New York' },
  { field: 'integrationMethod', value: 'api', excerpt: 'integrate through the Assurant API' },
  { field: 'settlement', value: { description: 'Monthly statement, paid within 30 days of the statement date', paymentDays: 30 }, excerpt: 'settled by monthly statement, paid within 30 days of the statement date' },
].map((f) => ({ ...f, documentId }));

/** Lists the documents, reads the contract, first submits a field with wording that is not in it, then the corrected draft. */
const onboard = (accountId: string) =>
  new ScriptedModel((q, req) => {
    if (!q.includes('Draft the onboarding')) return behaved(q);
    const lt = lastTool(req);
    if (!lt) return message([toolUse('list_account_documents', { accountId })]);
    const docId = () => (JSON.parse([...req.messages].reverse().flatMap((m) => (Array.isArray(m.content) ? (m.content as unknown as Block[]) : [])).find((b) => b.type === 'tool_result' && typeof b.content === 'string' && b.content.includes('"items"'))!.content as string) as { items: { id: string }[] }).items[0]!.id;
    if (lt.name === 'list_account_documents') return message([toolUse('read_account_document', { documentId: docId() })]);
    if (lt.name === 'read_account_document') return message([toolUse('submit_onboarding_draft', draft(accountId, docId(), [{ field: 'contractReference', value: 'CT-9999', excerpt: 'Contract reference: CT-9999.' }]))]);
    if (lt.isError) return message([toolUse('submit_onboarding_draft', draft(accountId, docId(), good(docId())))]);
    return message([text('I drafted five fields from the contract; the plans and the segment are not in it, so I left them out.')]);
  });

describe('AG-05 Account Onboarding (E07-F01-S02)', () => {
  it('drafts fields with their sources, the platform refuses wording that is not in the document, and nothing is saved until a person applies it', async () => {
    const acct = await insertAccount(t.pool, `AG5-${Date.now().toString(36).toUpperCase()}`);
    const up = await t.app.inject({ method: 'POST', url: `/v1/accounts/${acct}/documents?kind=contract&fileName=contract.txt`, headers: { ...bearer(manager), 'content-type': 'text/plain' }, payload: Buffer.from(CONTRACT) });
    expect(up.statusCode, up.body).toBe(201);

    const res = await api('POST', '/v1/agents/AG-05/runs', manager, { question: `Draft the onboarding for account ${acct} from its contract.` });
    expect(res.statusCode, res.body).toBe(202);
    const rt = runtime(onboard(acct));
    const runId = await rt.claimNextRun();
    expect(runId).toBe(res.json().id);
    const outcome = await rt.execute(runId!);
    expect(outcome.status).toBe('completed');

    // The invented reference was refused with the reason; the corrected draft was stored.
    const run = (await api('GET', `/v1/agent-runs/${runId}`, governance)).json();
    expect(run.steps.filter((s: { kind: string; name: string }) => s.kind === 'tool_result' && s.name === 'submit_onboarding_draft').map((s: { decision: string }) => s.decision)).toEqual(['error', 'allowed']);
    const list = (await api('GET', `/v1/agent-proposals?subjectId=${acct}&kind=account_onboarding`, manager)).json().items as { id: string; status: string; agentId: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'open', agentId: 'AG-05' });
    const detail = (await api('GET', `/v1/agent-proposals/${list[0]!.id}`, manager)).json();
    expect(detail.content.fields).toHaveLength(5);
    expect(detail.verification).toHaveLength(5);
    expect(detail.verification[0]).toMatchObject({ item: 'contractReference', ok: true });
    expect(detail.verification[0].detail).toContain('From contract.txt');

    // The agent saved nothing: the profile is still empty.
    expect((await api('GET', `/v1/accounts/${acct}/profile`, manager)).json()).toMatchObject({ contractReference: null, states: [], integrationMethod: null });

    // A person applies what they accept, through the ordinary profile API, and records the outcome.
    const fields = detail.content.fields as { field: string; value: unknown }[];
    const accepted = ['contractReference', 'contractSignedOn', 'states'];
    const body = Object.fromEntries(fields.filter((f) => accepted.includes(f.field)).map((f) => [f.field, f.value]));
    expect((await api('PUT', `/v1/accounts/${acct}/profile`, manager, body)).statusCode).toBe(200);
    const stranger = await t.idp.token({ roles: ['underwriter'], sub: 'uw-1' });
    expect((await api('POST', `/v1/agent-proposals/${list[0]!.id}/resolve`, stranger, { accepted })).statusCode).toBe(403);
    const resolved = await api('POST', `/v1/agent-proposals/${list[0]!.id}/resolve`, manager, { accepted, corrected: ['settlement'], rejected: ['integrationMethod'], note: 'Settlement terms reworded.' });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(resolved.json()).toMatchObject({ status: 'resolved', resolvedBy: 'am-1' });
    expect((await api('GET', `/v1/accounts/${acct}/profile`, manager)).json()).toMatchObject({ contractReference: 'CT-2026-0042', contractSignedOn: '2026-02-01', states: ['DE', 'NY'], integrationMethod: null });
  });

  it('refuses values that are not valid, even with real wording, and a document that is not the account’s', async () => {
    const acct = await insertAccount(t.pool, `AG5B-${Date.now().toString(36).toUpperCase()}`);
    const other = await insertAccount(t.pool, `AG5C-${Date.now().toString(36).toUpperCase()}`);
    const up = await t.app.inject({ method: 'POST', url: `/v1/accounts/${acct}/documents?kind=term_sheet&fileName=terms.txt`, headers: { ...bearer(manager), 'content-type': 'text/plain' }, payload: Buffer.from(CONTRACT) });
    const otherDoc = await t.app.inject({ method: 'POST', url: `/v1/accounts/${other}/documents?kind=term_sheet&fileName=terms.txt`, headers: { ...bearer(manager), 'content-type': 'text/plain' }, payload: Buffer.from(CONTRACT) });
    const docId = up.json().id as string;
    let attempt = 0;
    const model = new ScriptedModel((q, req) => {
      if (!q.includes('Draft the onboarding')) return behaved(q);
      const lt = lastTool(req);
      attempt += 1;
      if (!lt) {
        const bad = [
          { field: 'integrationMethod', value: 'carrier-pigeon', excerpt: 'integrate through the Assurant API', documentId: docId },
          { field: 'segment', value: 'NOT_A_SEGMENT', excerpt: 'Contract reference: CT-2026-0042.', documentId: docId },
          { field: 'contractReference', value: 'CT-2026-0042', excerpt: 'Contract reference: CT-2026-0042.', documentId: otherDoc.json().id },
        ];
        return message([toolUse('submit_onboarding_draft', { kind: 'account_onboarding', accountId: acct, summary: 'A draft with problems.', fields: bad })]);
      }
      return message([text(lt.isError ? `The platform refused it: ${lt.result.slice(0, 300)}` : 'Stored.')]);
    });
    const res = await api('POST', '/v1/agents/AG-05/runs', manager, { question: `Draft the onboarding for account ${acct} from its terms.` });
    const rt = runtime(model);
    const id = await rt.claimNextRun();
    expect(id).toBe(res.json().id);
    await rt.execute(id!);
    const run = (await api('GET', `/v1/agent-runs/${id}`, governance)).json();
    const submit = run.steps.find((s: { kind: string; name: string; decision: string }) => s.kind === 'tool_result' && s.name === 'submit_onboarding_draft');
    expect(submit.decision).toBe('error');
    const answer = JSON.stringify(run);
    expect(answer).toContain('integrationMethod');
    expect(answer).toContain('not in the filed list of business segments');
    expect(answer).toContain('is not one of this account');
    expect(attempt).toBeGreaterThan(0);
    expect((await api('GET', `/v1/agent-proposals?subjectId=${acct}&kind=account_onboarding`, manager)).json().items).toHaveLength(0);
  });
});
