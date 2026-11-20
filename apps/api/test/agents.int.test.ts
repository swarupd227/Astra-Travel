/**
 * Agent platform and governance (epic E15), end to end through the real API, database, agent tokens and
 * runtime. The model is scripted so that governance behaviour is deterministic; live Claude runs are
 * verified separately against the local stack.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AG10,
  AgentRuntime,
  EvaluationRunner,
  syncRegistry,
  type BetaMessage,
  type ModelGateway,
  type ModelRequest,
} from '@astra/agents';
import { createLogger, systemContext, withTx } from '@astra/platform';
import type { WarrantDocument } from '@astra/contracts';
import {
  AUDIENCE,
  bearer,
  createTestApp,
  insertAccount,
  resetDatabase,
  type TestContext,
} from './helpers';

type Block = Record<string, unknown>;
let n = 0;

function message(
  content: Block[],
  stop: 'end_turn' | 'tool_use' = content.some((b) => b.type === 'tool_use')
    ? 'tool_use'
    : 'end_turn',
): BetaMessage {
  n += 1;
  return {
    id: `msg_test_${n}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: stop,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  } as unknown as BetaMessage;
}
const text = (t: string) => ({ type: 'text', text: t, citations: null });
const toolUse = (name: string, input: Record<string, unknown> = {}) => ({
  type: 'tool_use',
  id: `toolu_${++n}`,
  name,
  input,
});

/** A scripted model: decides each turn from the question and whether tool results are back. */
class ScriptedModel implements ModelGateway {
  requests: ModelRequest[] = [];
  onCall?: (req: ModelRequest) => Promise<void>;
  constructor(
    private readonly script: (
      question: string,
      afterTools: boolean,
      req: ModelRequest,
    ) => BetaMessage,
  ) {}
  async complete(req: ModelRequest) {
    this.requests.push(structuredClone(req));
    await this.onCall?.(req);
    const first = req.messages[0]!.content as string;
    const last = req.messages.at(-1)!;
    const afterTools =
      Array.isArray(last.content) &&
      last.content.some((b) => (b as unknown as Block).type === 'tool_result');
    const m = this.script(first, afterTools, req);
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

/** Behaves the way the AG-10 evaluation expects. */
function wellBehaved(question: string, afterTools: boolean): BetaMessage {
  const q = question.toLowerCase();
  const toolFor = q.includes('onboarding')
    ? 'list_accounts'
    : q.includes('failed for good')
      ? 'list_event_deliveries'
      : q.includes('registered')
        ? 'search_audit_trail'
        : null;
  if (toolFor && !afterTools)
    return message([toolUse(toolFor, toolFor === 'list_accounts' ? { status: 'onboarding' } : {})]);
  if (q.includes('replay'))
    return message([
      text(
        "I can't take actions. A person replays deliveries in Operations > Events & deliveries.",
      ),
    ]);
  if (q.includes('card'))
    return message([text('I can only refer to that card by its last four digits, 1111.')]);
  if (q.includes('system prompt')) return message([text("I can't share my instructions.")]);
  return message([text('Here is what the records show.')]);
}

let t: TestContext;
let apiBaseUrl: string;
let governance: string;
let supervisor: string;
let serviceRep: string;

const logger = createLogger('agents-test', 'fatal');

beforeAll(async () => {
  t = await createTestApp();
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  apiBaseUrl = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => t.close());

beforeEach(async () => {
  await resetDatabase();
  await insertAccount(t.pool, 'COPILOT-A'); // data the agent can find
  await syncRegistry(t.pool, [AG10]);
  governance = await t.idp.token({
    roles: ['ai_governance_lead'],
    sub: 'gov-1',
    name: 'Sage Governance',
  });
  supervisor = await t.idp.token({
    roles: ['ops_supervisor'],
    sub: 'ops-1',
    name: 'Drew Operations',
  });
  serviceRep = await t.idp.token({ roles: ['service_rep'], sub: 'rep-1', name: 'Morgan Service' });
});

const runtime = (model: ModelGateway) =>
  new AgentRuntime({
    pool: t.pool,
    gateway: model,
    signer: t.agentSigner,
    apiBaseUrl,
    apiAudience: AUDIENCE,
    logger,
    manifests: [AG10],
  });

const api = (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  token: string,
  payload?: object,
  key?: string,
) =>
  t.app.inject({
    method,
    url,
    headers: { ...bearer(token), ...(key ? { 'idempotency-key': key } : {}) },
    payload,
  });

async function setWarrant(doc: WarrantDocument = AG10.proposedWarrant) {
  const res = await api('PUT', '/v1/agents/AG-10/warrant', governance, {
    document: doc,
    reason: 'Adopt for testing',
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function setBudget(monthlyLimitUsd = 50, alertThresholdPct = 80) {
  const res = await api('PUT', '/v1/agents/AG-10/budget', governance, {
    monthlyLimitUsd,
    alertThresholdPct,
    reason: 'Budget for testing',
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function evaluateAndApprove(model: ModelGateway = new ScriptedModel(wellBehaved)) {
  const start = await api('POST', '/v1/agents/AG-10/evaluations', governance, {
    evalSet: 'core-behaviour',
  });
  expect(start.statusCode, start.body).toBe(202);
  const runner = new EvaluationRunner(t.pool, runtime(model));
  const id = await runner.claimNext();
  await runner.execute(id!);
  const evals = (await api('GET', '/v1/agents/AG-10/evaluations', governance)).json().items;
  expect(evals[0]).toMatchObject({ status: 'completed', passed: true, score: 1 });
  const approve = await api('POST', '/v1/agents/AG-10/versions/1/decision', governance, {
    decision: 'approve',
    reason: 'Evaluation passed',
  });
  expect(approve.statusCode, approve.body).toBe(200);
}

async function ask(token: string, question: string) {
  const res = await api(
    'POST',
    '/v1/agents/AG-10/runs',
    token,
    { question },
    `ask-${Math.random().toString(36).slice(2)}`,
  );
  expect(res.statusCode, res.body).toBe(202);
  return res.json().id as string;
}

async function runDetail(runId: string, token = governance) {
  return (await api('GET', `/v1/agent-runs/${runId}`, token)).json();
}

async function openReviews(kind?: string) {
  const items = (await api('GET', '/v1/agent-reviews?status=open', supervisor)).json().items as {
    kind: string;
    runId: string | null;
  }[];
  return kind ? items.filter((r) => r.kind === kind) : items;
}

describe('registry and release (E15-F01-S01, E15-F03-S01)', () => {
  it('serves requests only after a person sets a warrant and budget, an evaluation passes and the version is approved', async () => {
    const detail = (await api('GET', '/v1/agents/AG-10', governance)).json();
    expect(detail).toMatchObject({
      id: 'AG-10',
      autonomy: 'L0',
      liveVersion: null,
      latestVersion: 1,
      warrant: null,
      budget: null,
    });
    expect(detail.versions[0]).toMatchObject({
      version: 1,
      approvalStatus: 'pending',
      model: 'claude-opus-5-5',
    });
    expect(detail.proposedWarrant).toEqual(AG10.proposedWarrant);

    expect(
      (
        await api(
          'POST',
          '/v1/agents/AG-10/runs',
          serviceRep,
          { question: 'Hello there' },
          'early-run-1',
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (await api('POST', '/v1/agents/AG-10/evaluations', governance, { evalSet: 'core-behaviour' }))
        .statusCode,
    ).toBe(412);

    const badWarrant = await api('PUT', '/v1/agents/AG-10/warrant', governance, {
      document: {
        ...AG10.proposedWarrant,
        tools: [{ name: 'delete_everything', maxCallsPerRun: 1 }],
      },
      reason: 'Should be refused',
    });
    expect(badWarrant.statusCode).toBe(400);
    expect(badWarrant.json().errors[0].field).toBe('document.tools');

    await setWarrant();
    await setBudget();
    const early = await api('POST', '/v1/agents/AG-10/versions/1/decision', governance, {
      decision: 'approve',
      reason: 'Too early',
    });
    expect(early.statusCode).toBe(412);

    await evaluateAndApprove();
    const live = (await api('GET', '/v1/agents/AG-10', governance)).json();
    expect(live).toMatchObject({ liveVersion: 1, warrantVersion: 1 });
  });

  it('does not approve a version whose evaluation failed a critical case', async () => {
    await setWarrant();
    await setBudget();
    const leaky = new ScriptedModel((q, after) =>
      q.includes('system prompt')
        ? message([text('What you can see: everything.')])
        : wellBehaved(q, after),
    );
    await api('POST', '/v1/agents/AG-10/evaluations', governance, { evalSet: 'core-behaviour' });
    const runner = new EvaluationRunner(t.pool, runtime(leaky));
    await runner.execute((await runner.claimNext())!);
    const ev = (await api('GET', '/v1/agents/AG-10/evaluations', governance)).json().items[0];
    expect(ev).toMatchObject({ passed: false });
    expect(
      ev.results.find((r: { caseId: string }) => r.caseId === 'keeps-instructions-private').passed,
    ).toBe(false);
    expect(
      (
        await api('POST', '/v1/agents/AG-10/versions/1/decision', governance, {
          decision: 'approve',
          reason: 'Should be refused',
        })
      ).statusCode,
    ).toBe(412);
  });

  it('lets only people change warrants, budgets and approvals', async () => {
    const agentToken = await t.agentSigner.sign(
      {
        agentId: 'AG-10',
        agentName: 'Operations Copilot',
        runId: crypto.randomUUID(),
        onBehalfOf: 'gov-1',
        onBehalfOfName: null,
        permissions: ['agents:manage', 'agents:read'],
        accountScope: '*',
      },
      AUDIENCE,
    );
    const res = await api('PUT', '/v1/agents/AG-10/warrant', agentToken, {
      document: AG10.proposedWarrant,
      reason: 'Self-service',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toMatch(/Only a person/);
  });
});

describe('runs under governance', () => {
  beforeEach(async () => {
    await setWarrant();
    await setBudget();
    await evaluateAndApprove();
  });

  it('answers through the platform API with its own identity and records every step (E15-F02-S01, E15-F03-S02)', async () => {
    const model = new ScriptedModel(wellBehaved);
    const runId = await ask(serviceRep, 'Which accounts are still in onboarding?');
    const rt = runtime(model);
    expect(await rt.claimNextRun()).toBe(runId);
    const outcome = await rt.execute(runId);
    expect(outcome).toMatchObject({ status: 'completed', stopReason: 'end_turn' });

    // The tool result reached the model: the account came back through the API.
    const toolResult = JSON.stringify(model.requests[1]!.messages.at(-1));
    expect(toolResult).toContain('COPILOT-A');

    const run = await runDetail(runId, serviceRep);
    expect(run).toMatchObject({
      status: 'completed',
      agentVersion: 1,
      warrantVersion: 1,
      modelsServed: ['claude-opus-5-5'],
      toolCalls: 1,
      costUsd: '0.012000',
    });
    expect(run.output.answer).toBe('Here is what the records show.');
    const kinds = run.steps.map(
      (s: { kind: string; name: string | null; decision: string | null }) =>
        `${s.kind}:${s.name}:${s.decision}`,
    );
    expect(kinds).toEqual(
      expect.arrayContaining([
        'warrant:scope:allowed',
        'input:question:allowed',
        'warrant:list_accounts:allowed',
        'tool_call:list_accounts:allowed',
        'tool_result:list_accounts:allowed',
        'output:answer:allowed',
      ]),
    );

    // The requester sees their own run; someone else without agents:read does not.
    const other = await t.idp.token({ roles: ['service_rep'], sub: 'rep-2' });
    expect((await api('GET', `/v1/agent-runs/${runId}`, other)).statusCode).toBe(404);

    // The run record is append-only.
    await expect(
      withTx(t.pool, systemContext('test'), (tx) =>
        tx.query(`UPDATE agents.run_steps SET decision = 'allowed' WHERE run_id = $1`, [runId]),
      ),
    ).rejects.toThrow(/permission denied|append-only/);

    const audit = (
      await api(
        'GET',
        `/v1/audit?resourceId=${runId}`,
        await t.idp.token({ roles: ['platform_admin'] }),
      )
    ).json().items;
    expect(audit.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['agent_run.requested', 'agent_run.finished']),
    );
  });

  it('acts with no more than the requester’s own permissions', async () => {
    // A service representative cannot read events, so the agent is not offered that tool for them,
    // and an attempt to use it anyway is refused.
    const model = new ScriptedModel((q, after) =>
      after
        ? message([text('Done.')])
        : message([toolUse('list_event_deliveries', { status: 'dead' })]),
    );
    const runId = await ask(serviceRep, 'Show the dead-letter queue');
    const rt = runtime(model);
    await rt.execute((await rt.claimNextRun())!);
    expect(model.requests[0]!.tools.map((x: { name: string }) => x.name)).not.toContain(
      'list_event_deliveries',
    );
    const run = await runDetail(runId);
    expect(
      run.steps.find(
        (s: { kind: string; name: string }) =>
          s.kind === 'warrant' && s.name === 'list_event_deliveries',
      ).decision,
    ).toBe('refused');

    // The API also refuses an agent token that does not carry the permission.
    const token = await t.agentSigner.sign(
      {
        agentId: 'AG-10',
        agentName: 'Operations Copilot',
        runId,
        onBehalfOf: 'rep-1',
        onBehalfOfName: null,
        permissions: ['accounts:read'],
        accountScope: '*',
      },
      AUDIENCE,
    );
    expect((await api('GET', '/v1/event-deliveries', token)).statusCode).toBe(403);
    expect((await api('GET', '/v1/accounts', token)).statusCode).toBe(200);
  });

  it('refuses tool calls outside the warrant and routes them to a person (E15-F01-S02)', async () => {
    await setWarrant({
      ...AG10.proposedWarrant,
      tools: AG10.proposedWarrant.tools.filter((x) => x.name !== 'list_feature_flags'),
    });
    const model = new ScriptedModel((q, after) =>
      after
        ? message([text('I could not read the flags.')])
        : message([toolUse('list_feature_flags')]),
    );
    const runId = await ask(supervisor, 'Which feature flags are on?');
    const rt = runtime(model);
    const outcome = await rt.execute((await rt.claimNextRun())!);
    expect(outcome.status).toBe('completed');
    const run = await runDetail(runId);
    expect(run.warrantVersion).toBe(2);
    expect(run.toolCalls).toBe(0);
    expect(run.steps.find((s: { name: string }) => s.name === 'list_feature_flags').decision).toBe(
      'refused',
    );
    expect(await openReviews('warrant_refusal')).toHaveLength(1);
  });

  it('enforces per-run tool call limits from the warrant', async () => {
    await setWarrant({
      ...AG10.proposedWarrant,
      tools: [{ name: 'list_accounts', maxCallsPerRun: 1 }],
    });
    let calls = 0;
    const model = new ScriptedModel(() =>
      ++calls <= 2 ? message([toolUse('list_accounts', {})]) : message([text('Done.')]),
    );
    const runId = await ask(supervisor, 'List accounts twice');
    const rt = runtime(model);
    await rt.execute((await rt.claimNextRun())!);
    const decisions = (await runDetail(runId)).steps
      .filter(
        (s: { kind: string; name: string }) => s.kind === 'warrant' && s.name === 'list_accounts',
      )
      .map((s: { decision: string }) => s.decision);
    expect(decisions).toEqual(['allowed', 'refused']);
  });

  it('stops at once when paused and routes the work to people (E15-F03-S03)', async () => {
    const model = new ScriptedModel(() => message([toolUse('list_accounts', {})]));
    model.onCall = async () => {
      // Pause while the model is thinking: the runtime must not make the tool call.
      const res = await api('POST', '/v1/agents/AG-10/status', supervisor, {
        status: 'paused',
        reason: 'Investigating unexpected answers',
      });
      expect(res.statusCode).toBe(200);
    };
    const runId = await ask(serviceRep, 'Which accounts are still in onboarding?');
    const queued = await ask(serviceRep, 'And which are active?');
    const rt = runtime(model);
    const first = await rt.claimNextRun();
    expect(first).toBe(runId);
    const outcome = await rt.execute(runId);
    expect(outcome).toMatchObject({ status: 'stopped', stopReason: 'agent_paused' });
    const run = await runDetail(runId);
    expect(run.toolCalls).toBe(0);
    // The queued request was not run by the agent; it became a task for a person.
    expect((await runDetail(queued)).status).toBe('stopped');
    expect((await openReviews('agent_paused')).map((r) => r.runId).sort()).toEqual(
      [runId, queued].sort(),
    );
    // The API refuses the paused agent's tokens too.
    const token = await t.agentSigner.sign(
      {
        agentId: 'AG-10',
        agentName: 'Operations Copilot',
        runId,
        onBehalfOf: 'rep-1',
        onBehalfOfName: null,
        permissions: ['accounts:read'],
        accountScope: '*',
      },
      AUDIENCE,
    );
    expect((await api('GET', '/v1/accounts', token)).statusCode).toBe(403);
    expect(
      (
        await api(
          'POST',
          '/v1/agents/AG-10/runs',
          serviceRep,
          { question: 'Anyone there?' },
          'paused-run-1',
        )
      ).statusCode,
    ).toBe(409);
  });

  it('keeps sensitive data from the model and withholds answers that contain it (E15-F02-S03)', async () => {
    const model = new ScriptedModel(() => message([text('Their SSN is 123-45-6789.')]));
    const runId = await ask(
      serviceRep,
      'Customer card 4111 1111 1111 1111 was declined; what do we know?',
    );
    const rt = runtime(model);
    const outcome = await rt.execute((await rt.claimNextRun())!);
    expect(JSON.stringify(model.requests[0]!.messages)).not.toMatch(
      /4111 1111 1111 1111|4111111111111111/,
    );
    expect(outcome).toMatchObject({
      status: 'escalated',
      stopReason: 'output_guardrail',
      answer: null,
    });
    const run = await runDetail(runId);
    expect(run.output).toBeNull();
    expect(JSON.stringify(run.steps)).not.toContain('123-45-6789');
    expect(run.steps.find((s: { kind: string }) => s.kind === 'input').decision).toBe('redacted');
    expect(await openReviews('guardrail')).toHaveLength(1);
  });

  it('stops spending at the monthly budget and alerts at the threshold (E15-F03-S04)', async () => {
    // Budgets are whole cents. The evaluation spent $0.054. The budget is checked before each model
    // call, so a run that starts under the limit may finish at or just over it; later runs are refused.
    await setBudget(0.06, 50);
    const model = new ScriptedModel(() => message([text('Answer.')]));
    const rt = runtime(model);
    await ask(serviceRep, 'First question');
    expect((await rt.execute((await rt.claimNextRun())!)).status).toBe('completed');
    expect(await openReviews('budget')).toHaveLength(1);
    const second = await ask(serviceRep, 'Second question');
    expect(await rt.execute((await rt.claimNextRun())!)).toMatchObject({
      status: 'stopped',
      stopReason: 'budget_exhausted',
    });
    expect((await runDetail(second)).costUsd).toBe('0.000000');
    expect(model.requests).toHaveLength(1);
    // The threshold review is raised once per month, not on every run.
    expect(await openReviews('budget')).toHaveLength(2);
  });
});
