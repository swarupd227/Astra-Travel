/**
 * Increment 10: the Document Quality agent (AG-07, E09-F02-S01) end to end through the real API, database, agent
 * tokens and runtime. The model is scripted (it reads the tool results and submits findings), so the platform's
 * checks of every quote, the release hold and the person's review are exercised for real; live Claude runs
 * need ANTHROPIC_API_KEY and are not made here. The documents are synthetic.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AG07,
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
    id: `msg_dq_${++n}`,
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
  id: `toolu_dq_${++n}`,
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
  if (s.includes('release it now'))
    return message([
      text(
        "I can't release or edit a template. I only submit findings, and a person reviews them.",
      ),
    ]);
  if (s.includes('report that'))
    return message([
      text("I can't report a value without checking the plan. Which template should I check?"),
    ]);
  return message([text('Which template or document should I check? Please give me its id.')]);
}

let t: TestContext;
let st: Stack;
let apiBaseUrl: string;
let governance: string;
const logger = createLogger('document-quality-test', 'fatal');
const MANIFESTS: AgentManifest[] = [AG07];
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
    headers: { ...bearer(token), 'idempotency-key': `dq-${Date.now()}-${k++}` },
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
  const m = AG07;
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

async function ask(token: string, question: string, model: ModelGateway) {
  const res = await api('POST', '/v1/agents/AG-07/runs', token, { question });
  expect(res.statusCode, res.body).toBe(202);
  const rt = runtime(model);
  const id = await rt.claimNextRun();
  expect(id).toBe(res.json().id);
  return { runId: id!, outcome: await rt.execute(id!) };
}

type Finding = { quote: string; issue: string; severity?: 'hold' | 'note' };
/** The template text the agent was given, found in the conversation so far. */
const templateTextIn = (req: ModelRequest): string => {
  for (const m of req.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as unknown as Block[]) {
      if (
        b.type === 'tool_result' &&
        typeof b.content === 'string' &&
        b.content.includes('"planVersionId"')
      )
        return (JSON.parse(b.content) as { text: string }).text;
    }
  }
  return '';
};

/** Reads the template, then submits findings; with `bogusFirst` it first quotes text that is not in the document. */
const checkTemplate = (
  templateId: string,
  findings: Finding[],
  opts: { bogusFirst?: boolean; summary?: string } = {},
) =>
  new ScriptedModel((q, req) => {
    if (!q.includes('Check template')) return behaved(q);
    const lt = lastTool(req);
    if (!lt) return message([toolUse('get_document_template', { templateId })]);
    const submit = (fs: Finding[]) =>
      message([
        toolUse('submit_document_findings', {
          kind: 'document_quality',
          subjectType: 'document_template',
          subjectId: templateId,
          summary: opts.summary ?? 'Checked the assembled schedule against the plan.',
          findings: fs,
        }),
      ]);
    if (lt.name === 'get_document_template') {
      expect(templateTextIn(req)).toContain('Trip Cancellation maximum');
      return submit(
        opts.bogusFirst
          ? [
              {
                quote: 'a sentence the document does not contain',
                issue: 'This quote is made up.',
                severity: 'hold',
              },
            ]
          : findings,
      );
    }
    if (lt.isError) return submit(findings);
    return message([text('I checked the template and made my findings; a person reviews them.')]);
  });

const makeTemplate = async () => {
  const res = await send(t, 'POST', '/v1/document-templates', st.tokens.product, {
    planVersionId: st.planVersionId,
    kind: 'schedule',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
};
const proposalsFor = async (subjectId: string) =>
  (
    await api(
      'GET',
      `/v1/agent-proposals?subjectId=${subjectId}&kind=document_quality`,
      st.tokens.compliance,
    )
  ).json().items as {
    id: string;
    status: string;
    verification: { item: string; ok: boolean; detail: string }[];
    agentId: string;
  }[];

describe('AG-07 Document Quality (E09-F02-S01)', () => {
  it('holds a release while a finding is open, until a person reviews it', async () => {
    const id = await makeTemplate();
    const { runId, outcome } = await ask(
      st.tokens.compliance,
      `Check template ${id} against the plan.`,
      checkTemplate(
        id,
        [
          {
            quote: 'Trip Delay maximum $1,000 per person',
            issue: 'The plan values the delay limit at $1,000 per trip, not per person.',
            severity: 'hold',
          },
        ],
        { bogusFirst: true },
      ),
    );
    expect(outcome.status).toBe('completed');

    // The made-up quote was refused with the reason; the corrected finding was stored.
    const run = (await api('GET', `/v1/agent-runs/${runId}`, governance)).json();
    const submits = run.steps.filter(
      (s: { kind: string; name: string }) =>
        s.kind === 'tool_result' && s.name === 'submit_document_findings',
    );
    expect(submits.map((s: { decision: string }) => s.decision)).toEqual(['error', 'allowed']);
    const [p] = await proposalsFor(id);
    expect(p).toMatchObject({ status: 'open', agentId: 'AG-07' });
    expect(p!.verification).toHaveLength(1);
    expect(p!.verification[0]!.ok).toBe(true);

    // The template shows the hold and cannot be released.
    const tpl = (await send(t, 'GET', `/v1/document-templates/${id}`, st.tokens.compliance)).json();
    expect(tpl).toMatchObject({ releasable: false, holds: { open: 1, accepted: 0 } });
    expect(tpl.checks.find((c: { check: string }) => c.check === 'quality')).toMatchObject({
      passed: false,
    });
    const refused = await send(
      t,
      'POST',
      `/v1/document-templates/${id}/release`,
      st.tokens.admin,
      {},
    );
    expect(refused.statusCode, refused.body).toBe(412);
    expect(refused.json().detail).toContain('open finding');

    // Only someone who can release resolves findings; rejecting a finding records why it is not an issue.
    const body = {
      rejected: ['f1'],
      note: 'The form states the limit per person; the finding is wrong.',
    };
    expect(
      (await api('POST', `/v1/agent-proposals/${p!.id}/resolve`, st.tokens.product, body))
        .statusCode,
    ).toBe(403);
    const resolved = await api(
      'POST',
      `/v1/agent-proposals/${p!.id}/resolve`,
      st.tokens.compliance,
      body,
    );
    expect(resolved.statusCode, resolved.body).toBe(200);
    const released = await send(
      t,
      'POST',
      `/v1/document-templates/${id}/release`,
      st.tokens.admin,
      { note: 'Finding reviewed and rejected.' },
    );
    expect(released.statusCode, released.body).toBe(200);
    expect(released.json()).toMatchObject({ status: 'released', holds: { open: 0, accepted: 0 } });
  });

  it('blocks a template for good when a person accepts a finding: the defect must be fixed in a new template', async () => {
    const id = await makeTemplate();
    await ask(
      st.tokens.compliance,
      `Check template ${id} against the plan.`,
      checkTemplate(id, [
        {
          quote: 'The time-sensitive period is twenty (20) days.',
          issue: 'The period does not match the plan.',
          severity: 'hold',
        },
      ]),
    );
    const [p] = await proposalsFor(id);
    expect(
      (
        await api('POST', `/v1/agent-proposals/${p!.id}/resolve`, st.tokens.compliance, {
          accepted: ['f1'],
          note: 'Correct the plan and assemble again.',
        })
      ).statusCode,
    ).toBe(200);
    const refused = await send(
      t,
      'POST',
      `/v1/document-templates/${id}/release`,
      st.tokens.admin,
      {},
    );
    expect(refused.statusCode, refused.body).toBe(412);
    expect(refused.json().detail).toContain('accepted');
    expect(
      (await send(t, 'GET', `/v1/document-templates/${id}`, st.tokens.compliance)).json(),
    ).toMatchObject({ releasable: false, holds: { open: 0, accepted: 1 } });
  });

  it('does not hold on a note or an all-clear, which are kept on record', async () => {
    const id = await makeTemplate();
    await ask(
      st.tokens.compliance,
      `Check template ${id} against the plan.`,
      checkTemplate(id, [], {
        summary: 'Checked every limit, period and option against the plan: nothing is wrong.',
      }),
    );
    const [clear] = await proposalsFor(id);
    expect(clear).toMatchObject({ status: 'open', verification: [] });
    expect(
      (await send(t, 'GET', `/v1/document-templates/${id}`, st.tokens.compliance)).json(),
    ).toMatchObject({ releasable: true, holds: { open: 0, accepted: 0 } });

    await ask(
      st.tokens.compliance,
      `Check template ${id} once more.`,
      checkTemplate(id, [
        {
          quote: 'twenty (20) days',
          issue: 'Check the period against the filed range with the filing.',
          severity: 'note',
        },
      ]),
    );
    expect(
      (await send(t, 'GET', `/v1/document-templates/${id}`, st.tokens.compliance)).json(),
    ).toMatchObject({ releasable: true, holds: { open: 0, accepted: 0 } });
    expect(
      (await send(t, 'POST', `/v1/document-templates/${id}/release`, st.tokens.admin, {}))
        .statusCode,
    ).toBe(200);
  });

  it('checks an issued document too, and only accepts quotes that are in it', async () => {
    const q = await send(t, 'POST', '/v1/quotes', st.tokens.partner, st.quoteBody());
    const b = await send(
      t,
      'POST',
      `/v1/quotes/${q.json().id}/bind`,
      st.tokens.partner,
      {
        ableToTravel: true,
        acknowledgement: { disclosureVersion: st.disclosureVersion, acknowledgedBy: 'Pat Sample' },
        payment: { reference: `PAY-DQ-${Date.now()}`, amount: '84.00' },
        purchaser: { name: 'Pat Sample' },
      },
      { 'idempotency-key': `dq-bind-${Date.now()}` },
    );
    expect(b.statusCode, b.body).toBe(201);
    const docs = (
      await send(t, 'GET', `/v1/policies/${b.json().id}/documents`, st.tokens.admin)
    ).json().items as { id: string; kind: string }[];
    const conf = docs.find((d) => d.kind === 'purchase_confirmation')!;
    const model = new ScriptedModel((question, req) => {
      if (!question.includes('Check document')) return behaved(question);
      const lt = lastTool(req);
      if (!lt) return message([toolUse('get_issued_document', { documentId: conf.id })]);
      if (lt.name === 'get_issued_document')
        return message([
          toolUse('submit_document_findings', {
            kind: 'document_quality',
            subjectType: 'document',
            subjectId: conf.id,
            summary: 'Read the purchase confirmation.',
            findings: [
              {
                quote: 'Total premium: $84.00',
                issue: 'Confirm the premium equals the payment taken.',
                severity: 'note',
              },
            ],
          }),
        ]);
      return message([text('I noted one item for review.')]);
    });
    await ask(st.tokens.compliance, `Check document ${conf.id}.`, model);
    const [p] = await proposalsFor(conf.id);
    expect(p).toMatchObject({ status: 'open' });
    expect(p!.verification[0]).toMatchObject({ item: 'f1', ok: true });
  });
});
