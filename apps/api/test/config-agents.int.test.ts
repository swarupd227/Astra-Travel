/**
 * Increment 8: the configuration agents (AG-01, AG-02, AG-03) end to end through the real API, database,
 * agent tokens and runtime. The model is scripted: it reads the tool results and submits proposals, so the
 * platform's checks of every claim are exercised for real; live Claude runs need ANTHROPIC_API_KEY and are
 * covered by e2e/agents-config.live.spec.ts. The documents are synthetic.
 */
import type { AddressInfo } from 'node:net';
import Decimal from 'decimal.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AG01,
  AG02,
  AG03,
  AgentRuntime,
  EvaluationRunner,
  syncRegistry,
  type AgentManifest,
  type BetaMessage,
  type ModelGateway,
  type ModelRequest,
} from '@astra/agents';
import { createLogger } from '@astra/platform';
import { SPEC_QUOTED_DE_TCAN } from '@astra/rating/fixtures';
import { AUDIENCE, bearer, createTestApp, resetDatabase, type TestContext } from './helpers';

type Block = Record<string, unknown>;
let n = 0;
const message = (content: Block[]): BetaMessage =>
  ({
    id: `msg_cfg_${++n}`,
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
  id: `toolu_${++n}`,
  name,
  input,
});

/** What the model has just been told: the last tool it called, and the result. */
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

/** Behaves the way the configuration agents' evaluation sets expect. */
function behaved(q: string): BetaMessage {
  const s = q.toLowerCase();
  if (s.includes('system prompt')) return message([text("I can't share my instructions.")]);
  if (s.includes('card'))
    return message([text('I can only refer to that card by its last four digits, 1111.')]);
  if (s.includes('estimates'))
    return message([
      text(
        "I can't estimate values. Only what is printed on the filed page is drafted, and what I cannot read is listed for the analyst.",
      ),
    ]);
  if (
    s.includes('approve') ||
    s.includes('publish') ||
    s.includes('correct the factor') ||
    s.includes('load the delaware')
  )
    return message([text("I can't do that. I only submit a proposal, and a person reviews it.")]);
  if (s.includes('page 12'))
    return message([text("I can't cite that without checking. Which manual should I look at?")]);
  return message([text('Which document or manual should I work on? Please give me its id.')]);
}

let t: TestContext;
let apiBaseUrl: string;
let governance: string;
let product: string;
let analyst: string;
let compliance: string;
const logger = createLogger('config-agents-test', 'fatal');
const MANIFESTS: AgentManifest[] = [AG01, AG02, AG03];

beforeAll(async () => {
  t = await createTestApp();
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  apiBaseUrl = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => t.close());
beforeEach(async () => {
  await resetDatabase();
  await syncRegistry(t.pool, MANIFESTS);
  governance = await t.idp.token({
    roles: ['ai_governance_lead'],
    sub: 'gov-1',
    name: 'Sage Governance',
  });
  product = await t.idp.token({
    roles: ['product_manager'],
    sub: 'product-1',
    name: 'Pat Product',
  });
  analyst = await t.idp.token({ roles: ['rating_analyst'], sub: 'analyst-1', name: 'Ana Analyst' });
  compliance = await t.idp.token({
    roles: ['compliance_officer'],
    sub: 'compliance-1',
    name: 'Cora Compliance',
  });
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

let k = 0;
const api = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  token: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  t.app.inject({
    method,
    url,
    headers: { ...bearer(token), 'idempotency-key': `cfg-${Date.now()}-${k++}`, ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

/** Sets the warrant and budget, passes the evaluation and approves the agent's first version. */
async function release(m: AgentManifest) {
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
        monthlyLimitUsd: m.proposedBudget.monthlyLimitUsd,
        alertThresholdPct: m.proposedBudget.alertThresholdPct,
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
}

/** A person asks; the runtime runs the queued request with the scripted model. */
async function ask(token: string, agent: string, question: string, model: ModelGateway) {
  const res = await api('POST', `/v1/agents/${agent}/runs`, token, { question });
  expect(res.statusCode, res.body).toBe(202);
  const rt = runtime(model);
  const id = await rt.claimNextRun();
  expect(id).toBe(res.json().id);
  const outcome = await rt.execute(id!);
  return { runId: id!, outcome };
}

async function loadEdition(
  token: string,
  name: string,
  kind: string,
  body: string,
): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: `/v1/form-editions?formNumber=${name}&edition=2026-04&title=${encodeURIComponent(`Synthetic ${name}`)}&kind=${kind}&insurer=VSC&fileName=${name}.txt`,
    headers: { ...bearer(token), 'content-type': 'text/plain' },
    payload: Buffer.from(body),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

const proposals = async (token: string, qs = '') =>
  (await api('GET', `/v1/agent-proposals${qs}`, token)).json().items as {
    id: string;
    kind: string;
    status: string;
    verification: { item: string; ok: boolean; detail: string }[];
    agentId: string;
    requestedBy: string;
    runId: string;
  }[];

describe('AG-01 Form Configuration (E01-F01-S03)', () => {
  const SCHEDULE = [
    'SCHEDULE OF BENEFITS (synthetic test schedule)',
    'Trip Cancellation maximum [$500-$10,000] per person',
    'You may cancel within the [ten (10) - fifteen (15)] day review period.',
  ].join('\n');

  type Span = {
    start: number;
    end: number;
    text: string;
    suggestion: { type: string; constraints: Record<string, unknown> } | null;
  };
  /** The bracket list the agent was given, found in the conversation so far. */
  const spansIn = (req: ModelRequest): Span[] => {
    for (const m of req.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content as unknown as Block[]) {
        if (
          b.type === 'tool_result' &&
          typeof b.content === 'string' &&
          b.content.includes('"suggestion"')
        )
          return (JSON.parse(b.content) as { items: Span[] }).items;
      }
    }
    return [];
  };
  const proposalOf = (editionId: string, spans: Span[], alterFirst: boolean) => ({
    kind: 'variable_map',
    editionId,
    summary: 'Two variables found in the schedule.',
    items: spans.map((s, i) => ({
      variable: {
        key: `variable_${i + 1}`,
        label: `Variable ${i + 1}`,
        type: s.suggestion!.type,
        constraints: s.suggestion!.constraints,
        textStart: s.start,
        textEnd: s.end,
        excerpt: alterFirst && i === 0 ? `${s.text} (altered)` : s.text,
      },
      rationale: 'The bracketed wording gives the filed range.',
    })),
  });

  /** Reads the brackets, first submits a wrong excerpt, then the corrected proposal. */
  const form = (editionId: string) =>
    new ScriptedModel((q, req) => {
      if (!q.includes('Propose the variable map')) return behaved(q);
      const lt = lastTool(req);
      if (!lt) return message([toolUse('list_text_brackets', { editionId })]);
      if (lt.name === 'list_text_brackets')
        return message([
          toolUse('submit_variable_map_proposal', proposalOf(editionId, spansIn(req), true)),
        ]);
      if (lt.isError)
        return message([
          toolUse('submit_variable_map_proposal', proposalOf(editionId, spansIn(req), false)),
        ]);
      return message([text('I proposed 2 variables; both match the form-reading rule.')]);
    });
  it('proposes variables with source text, the platform refuses what does not verify, and nothing is saved until a person applies it', async () => {
    await release(AG01);
    const ed = await loadEdition(compliance, 'ag01_sch', 'schedule', SCHEDULE);
    const { runId, outcome } = await ask(
      product,
      'AG-01',
      `Propose the variable map for edition ${ed}.`,
      form(ed),
    );
    expect(outcome.status).toBe('completed');

    // The wrong excerpt was refused with the reason, then the corrected proposal was stored.
    const run = (await api('GET', `/v1/agent-runs/${runId}`, governance)).json();
    const submits = run.steps.filter(
      (s: { kind: string; name: string }) =>
        s.kind === 'tool_result' && s.name === 'submit_variable_map_proposal',
    );
    expect(submits.map((s: { decision: string }) => s.decision)).toEqual(['error', 'allowed']);

    const list = await proposals(product);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      kind: 'variable_map',
      agentId: 'AG-01',
      status: 'open',
      requestedBy: 'product-1',
      runId,
    });
    const detail = (await api('GET', `/v1/agent-proposals/${list[0]!.id}`, product)).json();
    expect(detail.content.items).toHaveLength(2);
    expect(detail.verification).toHaveLength(2);
    expect(detail.verification[0].detail).toContain('Page 1: “[$500-$10,000]”');
    expect(detail.verification.every((c: { ok: boolean }) => c.ok)).toBe(true);

    // The agent saved nothing: no variable map exists for the edition.
    expect((await api('GET', `/v1/form-editions/${ed}/maps`, product)).json().items).toEqual([]);

    // A person applies the accepted items through the ordinary API and records the outcome.
    const map = (await api('POST', `/v1/form-editions/${ed}/maps`, product)).json().id as string;
    const v = detail.content.items[0].variable;
    expect(
      (await api('PUT', `/v1/variable-maps/${map}/variables/${v.key}`, product, v)).statusCode,
    ).toBe(200);
    const keys = detail.content.items.map(
      (i: { variable: { key: string } }) => i.variable.key,
    ) as string[];
    // Only someone who can manage forms resolves a form proposal.
    const underwriter = await t.idp.token({ roles: ['underwriter'], sub: 'uw-1' });
    expect(
      (
        await api('POST', `/v1/agent-proposals/${list[0]!.id}/resolve`, underwriter, {
          accepted: [keys[0]],
          rejected: [keys[1]],
        })
      ).statusCode,
    ).toBe(403);
    const resolved = await api('POST', `/v1/agent-proposals/${list[0]!.id}/resolve`, product, {
      accepted: [keys[0]],
      rejected: [keys[1]],
      appliedTo: { type: 'variable_map', id: map },
      note: 'Kept the cancellation maximum; the review period is set elsewhere.',
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(resolved.json()).toMatchObject({
      status: 'resolved',
      resolvedBy: 'product-1',
      resolution: { accepted: [keys[0]], rejected: [keys[1]] },
    });
    expect(
      (await api('POST', `/v1/agent-proposals/${list[0]!.id}/resolve`, product, { accepted: [] }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await api('POST', `/v1/agent-proposals/${list[0]!.id}/resolve`, product, {
          accepted: ['not_a_key'],
        })
      ).statusCode,
    ).toBe(409);

    // Proposals are records.
    const client = await t.pool.connect();
    try {
      await expect(
        client.query(`UPDATE agents.proposals SET summary = 'x' WHERE id = $1`, [list[0]!.id]),
      ).rejects.toThrow(/cannot change/);
    } finally {
      client.release();
    }
  });

  it('only agents submit proposals, and only during a run', async () => {
    const body = {
      kind: 'variable_map',
      editionId: '00000000-0000-4000-8000-000000000000',
      summary: 'A person trying it.',
      items: [
        {
          variable: {
            key: 'a_b',
            label: 'AB',
            type: 'optional_benefit',
            constraints: {},
            textStart: 0,
            textEnd: 1,
            excerpt: 'x',
          },
          rationale: 'because',
        },
      ],
    };
    expect((await api('POST', '/v1/agent-proposals', product, body)).statusCode).toBe(403);
  });
});

describe('AG-02 Rate Manual Ingestion (E02-F01-S02)', () => {
  /** Two pages: a cover, then the filed table. The page labels are printed in the page text. */
  const MANUAL = [
    'RATE MANUAL (synthetic test manual)\nTrip Cancellation, Delaware\nRETR-TEST-DE-0426-1',
    'Table 2.1.5 Trip cost per $100\nFrom $1: 1.0000\nFrom $501: 0.9000\nTable 2.1.4 Age factor\nAge 45: 0.7200\nRETR-TEST-DE-0426-2',
  ].join('\f');

  const drafter = (editionId: string, badFactor: boolean) =>
    new ScriptedModel((q, req) => {
      if (!q.includes('Draft the tables')) return behaved(q);
      const lt = lastTool(req);
      if (!lt) return message([toolUse('read_document', { editionId })]);
      if (lt.name === 'read_document' && !lt.result.includes('Table 2.1.5'))
        return message([toolUse('read_document', { editionId, page: 2 })]);
      if (lt.name === 'read_document')
        return message([
          toolUse('submit_rate_manual_proposal', {
            kind: 'rate_manual',
            editionId,
            summary: 'Two tables drafted from page 2.',
            manual: {
              code: 'RETR-TEST-DE-0426',
              state: 'DE',
              benefit: 'TCAN',
              effectiveFrom: '2026-01-01',
              document: {
                baseLossCost: '1.475',
                exposure: { kind: 'per_100_trip_cost', table: '2.1.5' },
                minimumTripCost: null,
                variables: [{ label: 'Age', tables: ['2.1.4'] }],
                perilPackage: null,
                exclusionWaivers: null,
                supplemental: [],
                tables: [
                  {
                    id: '2.1.5',
                    name: 'Trip cost per $100',
                    page: 'RETR-TEST-DE-0426-2',
                    keys: [{ input: 'tripCost', match: 'band' }],
                    rows: [
                      { keys: [1], factor: '1.0000' },
                      { keys: [501], factor: '0.9000' },
                    ],
                    unused: null,
                    unknown: null,
                  },
                  {
                    id: '2.1.4',
                    name: 'Age factor',
                    page: 'RETR-TEST-DE-0426-2',
                    keys: [{ input: 'age', match: 'band' }],
                    rows: [{ keys: [45], factor: badFactor ? '0.7500' : '0.7200' }],
                    unused: null,
                    unknown: null,
                  },
                ],
                conversion: { lossCostMultiplier: null, minimumPremium: null, roundTo: 2 },
              },
            },
            uncertainties: ['The manual gives no loss cost multiplier.'],
          }),
        ]);
      return message([text('I drafted 2 tables.')]);
    });

  it('drafts tables with their pages, flags factors that are not on the cited page, and loads nothing', async () => {
    await release(AG02);
    const ed = await loadEdition(analyst, 'ag02_manual', 'rate_manual', MANUAL);
    // A schedule is not a rate manual.
    const sch = await loadEdition(compliance, 'ag02_sch', 'schedule', 'SCHEDULE\n[$1-$2]');
    expect(sch).toBeTruthy();

    const { outcome } = await ask(
      analyst,
      'AG-02',
      `Draft the tables of rate manual ${ed}.`,
      drafter(ed, true),
    );
    expect(outcome.status).toBe('completed');
    const list = await proposals(analyst, '?kind=rate_manual');
    expect(list).toHaveLength(1);
    const checks = list[0]!.verification;
    expect(checks).toEqual([
      { item: '2.1.5', ok: true, detail: 'All 2 factors are on page 2.' },
      {
        item: '2.1.4',
        ok: false,
        detail: '1 of 1 factors are not on page 2. Not found: 45 → 0.7500.',
      },
    ]);
    const detail = (await api('GET', `/v1/agent-proposals/${list[0]!.id}`, analyst)).json();
    expect(detail.content.uncertainties).toEqual(['The manual gives no loss cost multiplier.']);
    // Nothing was loaded into the rate manual library.
    expect((await api('GET', '/v1/rate-manuals', analyst)).json().items).toEqual([]);

    // The analyst loads the draft as a draft manual through the ordinary API; it still needs a second analyst and parity.
    const m = detail.content.manual;
    const load = await api('POST', '/v1/rate-manuals', analyst, {
      ...m,
      source: 'Drafted by AG-02 from Synthetic ag02_manual; checked by Ana Analyst',
    });
    expect(load.statusCode, load.body).toBe(201);
    expect(load.json().status).toBe('draft');
  });

  it('refuses a draft with table references that do not exist, and a document that is not a rate manual', async () => {
    await release(AG02);
    const sch = await loadEdition(compliance, 'ag02_form', 'schedule', 'SCHEDULE\n[$1-$2]');
    const bad = new ScriptedModel((q, req) => {
      if (!q.includes('Draft the tables')) return behaved(q);
      const lt = lastTool(req);
      if (!lt)
        return message([
          toolUse('submit_rate_manual_proposal', {
            kind: 'rate_manual',
            editionId: sch,
            summary: 'Trying a schedule as a manual.',
            manual: {
              code: 'RETR-TEST-DE-0426',
              state: 'DE',
              benefit: 'TCAN',
              effectiveFrom: '2026-01-01',
              document: SPEC_QUOTED_DE_TCAN,
            },
          }),
        ]);
      return message([text(lt.isError ? `Refused: ${lt.result.slice(0, 200)}` : 'Stored.')]);
    });
    const { outcome } = await ask(analyst, 'AG-02', `Draft the tables of rate manual ${sch}.`, bad);
    expect(outcome.status).toBe('completed');
    expect(await proposals(analyst)).toEqual([]);
  });
});

describe('AG-03 Rating Parity and Explanation (E02-F07-S03)', () => {
  const DOC = { ...SPEC_QUOTED_DE_TCAN, perilPackage: null };
  const EXPECTED = new Decimal('1.475')
    .mul(42)
    .mul(
      ['0.72', '1.288', '0.768', '1', '1.6286', '1.3333', '1.28'].reduce(
        (a, f) => a.mul(f),
        new Decimal(1),
      ),
    )
    .toFixed(2, Decimal.ROUND_HALF_UP);
  // The workbook says the age factor is 0.6000 (the factor for an exposure not waived); the engine uses 0.7200.
  const CSV = [
    'name,expected_amount,age,pre_existing_waived,cost_per_traveller,purchase_date,departure_date,return_date,destination_region,business_segment,package_type,penalty_days,factor:table.2.1.4',
    `Spec case,${EXPECTED},45,true,4200,2026-11-21,2026-12-11,2026-12-20,Europe,OTA - Cruise,optional,60,0.6000`,
  ].join('\n');

  async function manualWithFailingCase() {
    const m = await api('POST', '/v1/rate-manuals', analyst, {
      code: 'RETR-SP-VU-DE-0426',
      state: 'DE',
      benefit: 'TCAN',
      effectiveFrom: '2026-01-01',
      source: 'Test fixture: values quoted in the specification (not the filed manual)',
      document: DOC,
    });
    expect(m.statusCode, m.body).toBe(201);
    const id = m.json().id as string;
    const imp = await api(
      'POST',
      `/v1/rate-manuals/${id}/parity-cases?source=Synthetic%20workbook&rateDate=2026-11-01`,
      analyst,
      CSV,
      { 'content-type': 'text/csv' },
    );
    expect(imp.statusCode, imp.body).toBe(201);
    const run = (await api('POST', `/v1/rate-manuals/${id}/parity-runs`, analyst)).json();
    expect(run).toMatchObject({ total: 1, passed: 0 });
    return { id, caseId: run.results[0].caseId as string };
  }

  const explainer = (manualId: string, caseId: string, page: string) =>
    new ScriptedModel((q, req) => {
      if (!q.includes('Explain the parity')) return behaved(q);
      const lt = lastTool(req);
      if (!lt) return message([toolUse('get_parity_run', { manualId })]);
      if (lt.name === 'get_parity_run') return message([toolUse('get_parity_cases', { manualId })]);
      if (lt.name === 'get_parity_cases')
        return message([toolUse('get_manual_outline', { manualId })]);
      if (lt.name === 'get_manual_outline')
        return message([
          toolUse('submit_parity_explanation', {
            kind: 'parity_explanation',
            manualId,
            summary: 'One case differs at the age factor.',
            items: [
              {
                caseId,
                step: 'table.2.1.4',
                explanation:
                  'The workbook uses 0.6000, the manual row for an age 45 traveller whose waiver does not apply; the engine used 0.7200, the waived row.',
                manualPage: page,
                workbookCell: { row: 2, column: 'factor:table.2.1.4' },
              },
            ],
          }),
        ]);
      return message([
        text(
          lt.isError
            ? 'The platform refused my citation.'
            : 'One difference explained: the age factor.',
        ),
      ]);
    });

  it('explains a difference at the step where the results diverge, citing the manual page and the workbook cell', async () => {
    await release(AG03);
    const { id, caseId } = await manualWithFailingCase();
    const cases = (await api('GET', `/v1/rate-manuals/${id}/parity-cases`, analyst)).json().items;
    expect(cases[0]).toMatchObject({ sourceRow: 2, expectedFactors: { 'table.2.1.4': '0.6000' } });

    const { outcome } = await ask(
      analyst,
      'AG-03',
      `Explain the parity differences of manual ${id}.`,
      explainer(id, caseId, 'spec M2 (2.1.4)'),
    );
    expect(outcome.status).toBe('completed');
    const list = await proposals(analyst, '?kind=parity_explanation');
    expect(list).toHaveLength(1);
    expect(list[0]!.verification).toEqual([
      {
        item: 'Spec case / table.2.1.4',
        ok: true,
        detail:
          'Expected 0.6000, engine 0.72. Manual page spec M2 (2.1.4); workbook row 2, column factor:table.2.1.4.',
      },
    ]);
  });

  it('refuses citations that are not true: the wrong page, a case that passed, a step that does not differ', async () => {
    await release(AG03);
    const { id, caseId } = await manualWithFailingCase();
    const wrongPage = await ask(
      analyst,
      'AG-03',
      `Explain the parity differences of manual ${id}.`,
      explainer(id, caseId, 'page 12'),
    );
    expect(wrongPage.outcome.status).toBe('completed');
    expect(await proposals(analyst)).toEqual([]);
    const run = (await api('GET', `/v1/agent-runs/${wrongPage.runId}`, governance)).json();
    const refusal = run.steps.find(
      (s: { kind: string; name: string; decision: string }) =>
        s.kind === 'tool_result' && s.name === 'submit_parity_explanation',
    );
    expect(refusal.decision).toBe('error');
    expect(JSON.stringify(refusal.detail)).toContain(
      'the page of table 2.1.4 is “spec M2 (2.1.4)”, not “page 12”',
    );
  });
});
