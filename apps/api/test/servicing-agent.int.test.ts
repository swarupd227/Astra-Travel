/**
 * Increment 11: the Policy Servicing agent (AG-06, E06-F04-S01) end to end through the real API, database, agent
 * tokens and runtime. The model is scripted, so the platform's own checks are what is exercised: the agent
 * previews first, acts only on the requester's confirmation in their own words, and anything outside its limits
 * goes to the review queue. Live Claude runs need ANTHROPIC_API_KEY and are not made here. Data is synthetic.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AG06,
  AgentRuntime,
  EvaluationRunner,
  syncRegistry,
  type AgentManifest,
  type BetaMessage,
  type ModelGateway,
  type ModelRequest,
} from '@astra/agents';
import { createLogger } from '@astra/platform';
import { AUDIENCE, bearer, createTestApp, resetDatabase, type TestContext } from './helpers';
import { publishedStack, send, type Stack } from './fixtures';

type Block = Record<string, unknown>;
let n = 0;
const message = (content: Block[]): BetaMessage =>
  ({
    id: `msg_sv_${++n}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  }) as unknown as BetaMessage;
const text = (t: string) => ({ type: 'text', text: t, citations: null });
const toolUse = (name: string, input: Record<string, unknown> = {}) => ({
  type: 'tool_use',
  id: `toolu_sv_${++n}`,
  name,
  input,
});

function lastTool(req: ModelRequest): { name: string; result: string; isError: boolean } | null {
  const msgs = req.messages;
  const last = msgs.at(-1)!;
  if (!Array.isArray(last.content)) return null;
  const res = (last.content as unknown as Block[]).find((b) => b.type === 'tool_result');
  if (!res) return null;
  const before = msgs.at(-2)!;
  const use = (before.content as unknown as Block[]).find(
    (b) => b.type === 'tool_use' && b.id === res.tool_use_id,
  );
  const content = res.content;
  return {
    name: String(use?.name),
    result: typeof content === 'string' ? content : JSON.stringify(content),
    isError: res.is_error === true,
  };
}

class ScriptedModel implements ModelGateway {
  constructor(private readonly script: (question: string, req: ModelRequest) => BetaMessage) {}
  async complete(req: ModelRequest) {
    const m = this.script(req.messages[0]!.content as string, req);
    return {
      message: m,
      usage: {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.006,
        models: [m.model],
        estimated: false,
      },
    };
  }
}

/** Behaves the way the agent's evaluation set expects. */
function behaved(q: string): BetaMessage {
  const s = q.toLowerCase();
  if (s.includes('system prompt')) return message([text("I can't share my instructions.")]);
  if (s.includes('card'))
    return message([text('I can only refer to that card by its last four digits, 1111.')]);
  if (s.includes('favour'))
    return message([
      text(
        "I can't refund outside the rules: the review period has ended, so I can't waive that. A person can look at it.",
      ),
    ]);
  if (s.includes('right now'))
    return message([
      text(
        "I can't make a change without showing you the price first and getting your confirmation. Which policy is it?",
      ),
    ]);
  return message([text('Which policy should I look at? Please give me its number or id.')]);
}

let t: TestContext;
let st: Stack;
let apiBaseUrl: string;
let governance: string;
let rep: string;
const logger = createLogger('servicing-agent-test', 'fatal');
const MANIFESTS: AgentManifest[] = [AG06];
let k = 0;
const api = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  token: string,
  payload?: unknown,
) =>
  t.app.inject({
    method,
    url,
    headers: { ...bearer(token), 'idempotency-key': `sv-${Date.now()}-${k++}` },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const runtime = (model: ModelGateway) =>
  new AgentRuntime({
    pool: t.pool,
    gateway: model,
    signer: t.agentSigner,
    apiBaseUrl,
    apiAudience: AUDIENCE,
    logger,
    manifests: MANIFESTS,
  });

beforeAll(async () => {
  t = await createTestApp();
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  apiBaseUrl = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  await resetDatabase();
  st = await publishedStack(t);
  await syncRegistry(t.pool, MANIFESTS);
  governance = await t.idp.token({
    roles: ['ai_governance_lead'],
    sub: 'gov-1',
    name: 'Sage Governance',
  });
  rep = await t.idp.token({ roles: ['service_rep'], sub: 'rep-1', name: 'Rae Representative' });
  const m = AG06;
  expect(
    (
      await api('PUT', `/v1/agents/${m.id}/warrant`, governance, {
        document: m.proposedWarrant,
        reason: 'Adopt for testing',
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await api('PUT', `/v1/agents/${m.id}/budget`, governance, {
        ...m.proposedBudget,
        reason: 'Budget for testing',
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await api('POST', `/v1/agents/${m.id}/evaluations`, governance, { evalSet: 'core-behaviour' }))
      .statusCode,
  ).toBe(202);
  const runner = new EvaluationRunner(t.pool, runtime(new ScriptedModel(behaved)));
  await runner.execute((await runner.claimNext())!);
  const evals = (await api('GET', `/v1/agents/${m.id}/evaluations`, governance)).json().items;
  expect(evals[0], JSON.stringify(evals[0])).toMatchObject({ status: 'completed', passed: true });
  expect(
    (
      await api('POST', `/v1/agents/${m.id}/versions/1/decision`, governance, {
        decision: 'approve',
        reason: 'Evaluation passed',
      })
    ).statusCode,
  ).toBe(200);
}, 300_000);
afterAll(async () => t.close());

async function ask(question: string, model: ModelGateway) {
  const res = await api('POST', '/v1/agents/AG-06/runs', rep, { question });
  expect(res.statusCode, res.body).toBe(202);
  const rt = runtime(model);
  const id = await rt.claimNextRun();
  expect(id).toBe(res.json().id);
  return { runId: id!, outcome: await rt.execute(id!) };
}

let c = 0;
async function bindPolicy() {
  const first = `Agent${c++}`;
  const q = await send(
    t,
    'POST',
    '/v1/quotes',
    st.tokens.partner,
    st.quoteBody({
      travellers: [
        {
          firstName: first,
          lastName: 'Serviced',
          dateOfBirth: '1980-05-05',
          costPerTraveller: '4200',
        },
      ],
    }),
  );
  const b = await send(
    t,
    'POST',
    `/v1/quotes/${q.json().id}/bind`,
    st.tokens.partner,
    {
      ableToTravel: true,
      acknowledgement: { disclosureVersion: st.disclosureVersion, acknowledgedBy: first },
      payment: { reference: `PAY-AG-${Date.now()}-${c}`, amount: '84.00' },
      purchaser: { name: first },
    },
    { 'idempotency-key': `bind-ag-${Date.now()}-${c}` },
  );
  expect(b.statusCode, b.body).toBe(201);
  return b.json() as { id: string; number: string };
}
const statusOf = async (id: string) =>
  (await send(t, 'GET', `/v1/policies/${id}`, st.tokens.admin)).json().status as string;
const idIn = (q: string) => /id ([0-9a-f-]{36})/.exec(q)![1]!;

const cancelRequest = { type: 'cancel', reason: 'Changed my mind', noLoss: true };
/** Previews the cancellation and tells the person the price: it never applies in this turn. */
const previewOnly = new ScriptedModel((q, req) => {
  if (!q.includes('Cancel policy')) return behaved(q);
  const lt = lastTool(req);
  if (!lt)
    return message([
      toolUse('preview_policy_change', { policyId: idIn(q), request: cancelRequest }),
    ]);
  const p = JSON.parse(lt.result) as { money: { refund: string }; confirmAmount: string };
  return message([
    text(`Cancelling would refund ${p.money.refund}. Please confirm and I will cancel it.`),
  ]);
});
/** Applies with the person's confirming words, copied from their message. */
const applyWith = (
  words: string,
  request: Record<string, unknown> = cancelRequest,
  amount = '84.00',
) =>
  new ScriptedModel((q, req) => {
    if (!q.includes('confirm')) return behaved(q);
    const lt = lastTool(req);
    if (!lt)
      return message([
        toolUse('apply_policy_change', {
          policyId: idIn(q),
          request,
          confirmAmount: amount,
          agentConfirmation: words,
        }),
      ]);
    return message([
      text(
        lt.isError
          ? `That did not go through: ${lt.result.slice(0, 120)}`
          : 'Done: the policy is cancelled and 84.00 is refunded by billing.',
      ),
    ]);
  });

describe('AG-06 Policy Servicing (E06-F04-S01)', () => {
  it('previews first, then acts only after the requester confirms, and its change is attributed to the agent', async () => {
    const p = await bindPolicy();
    const first = await ask(
      `Cancel policy ${p.number} (id ${p.id}), the traveller changed their mind and has had no loss.`,
      previewOnly,
    );
    expect(first.outcome.status).toBe('completed');
    // The preview was made and nothing was applied.
    expect(await statusOf(p.id)).toBe('active');
    const run1 = (await api('GET', `/v1/agent-runs/${first.runId}`, governance)).json();
    expect(
      run1.steps.some(
        (s: { kind: string; name: string }) =>
          s.kind === 'tool_result' && s.name === 'preview_policy_change',
      ),
    ).toBe(true);
    expect(run1.steps.some((s: { name: string }) => s.name === 'apply_policy_change')).toBe(false);

    const second = await ask(
      `Yes, I confirm: cancel policy ${p.number} (id ${p.id}) and refund 84.00.`,
      applyWith('Yes, I confirm'),
    );
    expect(second.outcome.status).toBe('completed');
    expect(await statusOf(p.id)).toBe('cancelled');
    const history = (await send(t, 'GET', `/v1/policies/${p.id}`, st.tokens.admin)).json().history;
    expect(history.at(-1)).toMatchObject({
      type: 'status_changed',
      actor: 'agent:AG-06',
      reason: 'Changed my mind',
    });
    expect(history.at(-1).data.money).toMatchObject({ refund: '84.00', basis: 'review_period' });

    // The weekly sample (for people to review) includes what the agent did.
    const sample = await api('GET', '/v1/servicing/agent-sample?days=7&size=5', st.tokens.admin);
    expect(sample.statusCode, sample.body).toBe(200);
    expect(sample.json().items.map((i: { policyNumber: string }) => i.policyNumber)).toContain(
      p.number,
    );
    expect(
      sample.json().items.find((i: { policyNumber: string }) => i.policyNumber === p.number),
    ).toMatchObject({ transaction: 'cancel', actor: 'agent:AG-06', amount: 'refund 84.00' });
    expect((await api('GET', '/v1/servicing/agent-sample', st.tokens.uw1)).statusCode).toBe(403);
  });

  it('is refused when the confirmation is not in the requester’s own words', async () => {
    const p = await bindPolicy();
    const r = await ask(
      `Please confirm the status of policy ${p.number} (id ${p.id}); the traveller wants to cancel it.`,
      applyWith('Yes, go ahead and cancel it'),
    );
    expect(r.outcome.status).toBe('completed');
    expect(await statusOf(p.id)).toBe('active');
    const run = (await api('GET', `/v1/agent-runs/${r.runId}`, governance)).json();
    const apply = run.steps.filter(
      (s: { kind: string; name: string }) =>
        s.kind === 'tool_result' && s.name === 'apply_policy_change',
    );
    expect(apply.map((s: { decision: string }) => s.decision)).toEqual(['error']);
  });

  it('queues a request outside its limits for a person, and changes nothing', async () => {
    const p = await bindPolicy();
    const raise = {
      type: 'change_cost',
      reason: 'More cost',
      costs: [{ travellerId: 'T1', costPerTraveller: '5000' }],
    };
    const r = await ask(
      `I confirm: raise the insured cost on policy ${p.number} (id ${p.id}) to 5000.`,
      applyWith('I confirm', raise, '16.00'),
    );
    expect(r.outcome.status).toBe('completed');
    expect(await statusOf(p.id)).toBe('active');
    expect(
      (await send(t, 'GET', `/v1/policies/${p.id}`, st.tokens.admin)).json().record.premium.total,
    ).toBe('84.00');
    const reviews = await t.pool.connect();
    try {
      await reviews.query('BEGIN');
      await reviews.query(`SELECT set_config('app.account_ids', '*', true)`);
      const rows = (
        await reviews.query(
          `SELECT kind, summary, status FROM agents.reviews WHERE agent_id = 'AG-06' AND run_id = $1`,
          [r.runId],
        )
      ).rows;
      await reviews.query('COMMIT');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'servicing_request', status: 'open' });
      expect(rows[0].summary).toContain('change cost');
    } finally {
      reviews.release();
    }
  });
});
