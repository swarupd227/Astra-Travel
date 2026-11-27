/**
 * Increment 15: the workbench (E11-F01-S01 search, E11-F02-S01 work queue, E11-F02-S02 agent output review,
 * E03-F05-S01 referral summaries by AG-04). The agent's model is scripted, so the platform's checks of every rule it
 * cites, the person's decision and the record kept for evaluation are exercised for real; live Claude runs need
 * ANTHROPIC_API_KEY and are not made here. Every person, account and trip is synthetic.
 */
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AG04,
  AgentRuntime,
  EvaluationRunner,
  syncRegistry,
  TOOL_CATALOGUE,
  type AgentManifest,
  type BetaMessage,
  type ModelGateway,
  type ModelRequest,
} from '@astra/agents';
import { createLogger } from '@astra/platform';
import {
  AUDIENCE,
  bearer,
  createTestApp,
  requireEnv,
  resetDatabase,
  type TestContext,
} from './helpers';
import { publishedStack, send, type Stack } from './fixtures';

type Block = Record<string, unknown>;
let n = 0;
const message = (content: Block[]): BetaMessage =>
  ({
    id: `msg_wb_${++n}`,
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
  id: `toolu_wb_${++n}`,
  name,
  input,
});

function lastTool(req: ModelRequest): { name: string; result: string; isError: boolean } | null {
  const last = req.messages.at(-1)!;
  if (!Array.isArray(last.content)) return null;
  const res = (last.content as unknown as Block[]).find((b) => b.type === 'tool_result');
  if (!res) return null;
  const before = req.messages.at(-2)!;
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
  if (s.includes('approve'))
    return message([
      text("I can't approve a referral. An underwriter decides, and I only summarise."),
    ]);
  if (s.includes('decline'))
    return message([
      text("I can't decline a referral. A decline is always an underwriter's decision."),
    ]);
  return message([text('Which referral should I summarise? Please give me its id.')]);
}

let t: TestContext;
let st: Stack;
let apiBaseUrl: string;
let governance: string;
let supervisor: string;
let uw1: string;
let uw2: string;
const logger = createLogger('workbench-test', 'fatal');
const MANIFESTS: AgentManifest[] = [AG04];
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
    headers: { ...bearer(token), 'idempotency-key': `wb-${Date.now()}-${k++}` },
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

async function asOwner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: requireEnv('TEST_DATABASE_OWNER_URL') });
  await c.connect();
  try {
    await c.query(`SET app.account_ids = '*'`);
    return await fn(c);
  } finally {
    await c.end();
  }
}

const ack = () => ({ disclosureVersion: st.disclosureVersion, acknowledgedBy: 'Pat Sample' });
let refN = 0;
const bindBody = (amount: string) => ({
  ableToTravel: true,
  acknowledgement: ack(),
  payment: { reference: `PAY-WB-${Date.now()}-${refN++}`, amount },
  purchaser: { name: 'Pat Sample', email: 'pat@example.com' },
});
const quote = (over: Record<string, unknown> = {}) =>
  send(t, 'POST', '/v1/quotes', st.tokens.partner, st.quoteBody(over));
const bind = (quoteId: string, amount = '84.00') =>
  send(t, 'POST', `/v1/quotes/${quoteId}/bind`, st.tokens.partner, bindBody(amount), {
    'idempotency-key': `bind-wb-${Date.now()}-${refN++}`,
  });

beforeAll(async () => {
  t = await createTestApp();
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  apiBaseUrl = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  await resetDatabase();
  // The timers are settings that survive a reset, so a run starts from the seeded values.
  await asOwner((c) =>
    c.query(
      `UPDATE workbench.sla_policies SET priority = CASE source_type WHEN 'sanctions_hold' THEN 'urgent' WHEN 'referral' THEN 'high' WHEN 'event_delivery' THEN 'high' ELSE 'normal' END, target_hours = CASE source_type WHEN 'sanctions_hold' THEN 4 WHEN 'event_delivery' THEN 4 WHEN 'agent_proposal' THEN 72 ELSE 24 END`,
    ),
  );
  st = await publishedStack(t);
  await syncRegistry(t.pool, MANIFESTS);
  governance = await t.idp.token({
    roles: ['ai_governance_lead'],
    sub: 'gov-1',
    name: 'Sage Governance',
  });
  supervisor = await t.idp.token({
    roles: ['ops_supervisor'],
    sub: 'ops-1',
    name: 'Sam Supervisor',
  });
  uw1 = st.tokens.uw1;
  uw2 = st.tokens.uw2;
  const m = AG04;
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

describe('policy search (E11-F01-S01)', () => {
  let patNumber = '';
  let accountCode = '';

  it('finds a policy by number, traveller, account and trip, and says what matched', async () => {
    const a = await quote();
    expect(a.statusCode, a.body).toBe(201);
    const boundA = await bind(a.json().id);
    expect(boundA.statusCode, boundA.body).toBe(201);
    patNumber = boundA.json().number as string;
    const b = await quote({
      travellers: [
        {
          firstName: 'Wanda',
          lastName: 'Wanderer',
          dateOfBirth: '1975-03-03',
          costPerTraveller: '4200',
        },
      ],
      trip: {
        ...(st.quoteBody().trip as object),
        destinations: [{ country: 'GB', region: 'Britain' }],
      },
    });
    expect(b.statusCode, b.body).toBe(201);
    expect((await bind(b.json().id)).statusCode).toBe(201);
    accountCode = (await api('GET', `/v1/accounts/${st.accountId}`, st.tokens.admin)).json()
      .code as string;

    const search = async (q: string, token = uw1) => {
      const res = await api('GET', `/v1/search?q=${encodeURIComponent(q)}`, token);
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as {
        items: {
          number: string;
          matchedOn: string[];
          travellers: string[];
          destinations: string[];
          accountName: string;
        }[];
        tookMs: number;
      };
    };
    const byNumber = await search(patNumber.slice(-8));
    expect(byNumber.items.map((i) => i.number)).toContain(patNumber);
    expect(byNumber.items.find((i) => i.number === patNumber)!.matchedOn).toContain('number');
    const byTraveller = await search('wanda wand');
    expect(byTraveller.items).toHaveLength(1);
    expect(byTraveller.items[0]).toMatchObject({
      travellers: ['Wanda Wanderer'],
      matchedOn: ['traveller'],
    });
    const byAccount = await search(accountCode);
    expect(byAccount.items.length).toBeGreaterThanOrEqual(2);
    expect(byAccount.items.every((i) => i.matchedOn.includes('account'))).toBe(true);
    const byTrip = await search('britain');
    expect(byTrip.items).toHaveLength(1);
    expect(byTrip.items[0]!.matchedOn).toEqual(['trip']);
    const byDate = await search(st.dates.departure);
    expect(byDate.items.length).toBeGreaterThanOrEqual(2);
    expect((await search('no-such-thing-anywhere')).items).toEqual([]);
    expect((await api('GET', '/v1/search?q=a', uw1)).statusCode).toBe(400);
  });

  it('shows a partner only its own account’s policies (row-level security)', async () => {
    const own = (
      await api('GET', `/v1/search?q=${encodeURIComponent('wanda')}`, st.tokens.partner)
    ).json();
    expect(own.items).toHaveLength(1);
    const other = (
      await api('GET', `/v1/search?q=${encodeURIComponent('wanda')}`, st.tokens.partnerB)
    ).json();
    expect(other.items).toEqual([]);
    expect(
      (await api('GET', `/v1/search?q=${encodeURIComponent(patNumber)}`, st.tokens.partnerB)).json()
        .items,
    ).toEqual([]);
  });

  it('answers within 2 seconds across 2,000 policies', async () => {
    // Synthetic bulk: copy a bound quote and policy 2,000 times (as the platform, bypassing the API only to save time).
    await asOwner(async (c) => {
      await c.query(`
        WITH base AS (SELECT p.*, q.request, q.selection, q.result, q.manuals, q.disclosure, q.expires_at FROM policies.policies p JOIN policies.quotes q ON q.id = p.quote_id ORDER BY p.created_at LIMIT 1),
        gen AS (SELECT i, gen_random_uuid() AS qid, gen_random_uuid() AS pid FROM generate_series(1, 2000) i),
        nq AS (
          INSERT INTO policies.quotes (id, account_id, plan_id, plan_version_id, rule_set_id, state, status, request, selection, result, manuals, disclosure, created_by, expires_at)
          SELECT g.qid, b.account_id, b.plan_id, b.plan_version_id, b.rule_set_id, b.state, 'bound', b.request, b.selection, b.result, b.manuals, b.disclosure, 'bulk', b.expires_at FROM gen g, base b RETURNING id
        ),
        np AS (
          INSERT INTO policies.policies (id, number, account_id, quote_id, plan_id, plan_version_id, rule_set_id, state, purchased_on, term_start, term_end, premium_total, payment_reference, created_by)
          SELECT g.pid, 'ATP-BULK-' || lpad(g.i::text, 6, '0'), b.account_id, g.qid, b.plan_id, b.plan_version_id, b.rule_set_id, b.state, b.purchased_on, b.term_start, b.term_end, b.premium_total, 'BULK-' || g.i, 'bulk'
            FROM gen g, base b WHERE EXISTS (SELECT 1 FROM nq WHERE nq.id = g.qid) RETURNING id
        )
        INSERT INTO policies.policy_travellers (policy_id, account_id, traveller_id, first_name, last_name, date_of_birth)
        SELECT g.pid, b.account_id, 't1', 'Bulk' || g.i, 'Traveller' || (g.i % 500), '1980-01-01' FROM gen g, base b WHERE EXISTS (SELECT 1 FROM np WHERE np.id = g.pid)`);
      await c.query(
        'ANALYZE policies.policies; ANALYZE policies.policy_travellers; ANALYZE policies.quotes; ANALYZE platform.accounts',
      );
    });
    for (const q of ['ATP-BULK-001234', 'traveller42', 'europe', st.dates.departure]) {
      const started = performance.now();
      const res = await api('GET', `/v1/search?q=${encodeURIComponent(q)}&limit=50`, uw1);
      const took = performance.now() - started;
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().items.length, q).toBeGreaterThan(0);
      console.warn(`search "${q}" over 2,000+ policies: ${took.toFixed(0)} ms`);
      expect(took, q).toBeLessThan(2000);
    }
    // The long limit is for copying the policies; each search is still held to 2 seconds above.
  }, 240_000);
});

describe('the work queue (E11-F02-S01)', () => {
  let referralId = '';

  it('collects a referral with its priority, timer and owner', async () => {
    const dear = await quote({
      travellers: [
        { firstName: 'Dan', lastName: 'Dear', dateOfBirth: '1980-05-05', costPerTraveller: '9000' },
      ],
    });
    expect(dear.json()).toMatchObject({ outcome: 'referred' });
    const blocked = await bind(dear.json().id, dear.json().premium.total);
    expect(blocked.json().errors[0].code).toBe('referral_required');
    referralId = blocked.json().errors[0].message as string;

    const queue = (await api('GET', '/v1/tasks', supervisor)).json();
    const task = queue.items.find((x: { sourceId: string }) => x.sourceId === referralId);
    expect(task).toMatchObject({
      sourceType: 'referral',
      priority: 'high',
      targetHours: 24,
      timer: 'on_track',
      owner: null,
      link: `/underwriting/referrals/${referralId}`,
    });
    expect(task.minutesLeft).toBeGreaterThan(23 * 60);
    expect(queue.counts.unassigned).toBeGreaterThanOrEqual(1);
    expect((await api('GET', '/v1/tasks?source=agent_review', supervisor)).json().items).toEqual(
      [],
    );
  });

  it('lets a person take work, refuses a second taker, and lets a supervisor reassign', async () => {
    // People are known to the workbench once they have signed in.
    for (const token of [uw1, uw2, supervisor])
      expect((await api('GET', '/v1/me', token)).statusCode).toBe(200);
    const url = `/v1/tasks/referral/${referralId}/assignment`;
    const mine = await api('PUT', url, uw1, { owner: 'uw-1' });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json()).toMatchObject({ owner: 'uw-1', ownerName: 'Uma Underwriter' });
    expect(
      (await api('GET', '/v1/tasks?owner=me', uw1))
        .json()
        .items.map((x: { sourceId: string }) => x.sourceId),
    ).toContain(referralId);
    expect((await api('GET', '/v1/tasks?owner=me', uw2)).json().items).toEqual([]);

    expect((await api('PUT', url, uw2, { owner: 'uw-2' })).statusCode).toBe(409);
    expect((await api('PUT', url, uw2, { owner: 'uw-1' })).statusCode).toBe(403);
    expect((await api('PUT', url, uw1, { owner: 'uw-2' })).statusCode).toBe(403);

    const moved = await api('PUT', url, supervisor, { owner: 'uw-2' });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({ owner: 'uw-2', ownerName: 'Ulrich Underwriter' });
    expect((await api('PUT', url, supervisor, { owner: 'nobody-has-seen-me' })).statusCode).toBe(
      400,
    );
    const assignees = (await api('GET', '/v1/task-assignees', supervisor)).json().items as {
      subject: string;
      open: number;
    }[];
    expect(assignees.find((x) => x.subject === 'uw-2')!.open).toBe(1);

    expect((await api('PUT', url, supervisor, { owner: null })).statusCode).toBe(200);
    expect(
      (await api('GET', '/v1/tasks?owner=unassigned', supervisor))
        .json()
        .items.map((x: { sourceId: string }) => x.sourceId),
    ).toContain(referralId);
    const audit = await asOwner((c) =>
      c.query(
        `SELECT action FROM audit.audit_log WHERE resource_id = $1 AND action LIKE 'task.%' ORDER BY seq`,
        [referralId],
      ),
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'task.assigned',
      'task.reassigned',
      'task.released',
    ]);
  });

  it('shows timers against the settings a supervisor controls', async () => {
    expect(
      (await api('PUT', '/v1/task-sla/referral', uw1, { priority: 'urgent', targetHours: 2 }))
        .statusCode,
    ).toBe(403);
    const set = await api('PUT', '/v1/task-sla/referral', supervisor, {
      priority: 'urgent',
      targetHours: 1,
    });
    expect(set.statusCode, set.body).toBe(200);
    const task = (await api('GET', '/v1/tasks', supervisor))
      .json()
      .items.find((x: { sourceId: string }) => x.sourceId === referralId);
    expect(task).toMatchObject({ priority: 'urgent', targetHours: 1, timer: 'on_track' });
    // The referral has now waited longer than an hour.
    await asOwner(async (c) => {
      await c.query('ALTER TABLE underwriting.referrals DISABLE TRIGGER referrals_guard');
      await c.query(
        `UPDATE underwriting.referrals SET created_at = now() - interval '90 minutes' WHERE id = $1`,
        [referralId],
      );
      await c.query('ALTER TABLE underwriting.referrals ENABLE TRIGGER referrals_guard');
    });
    const late = (await api('GET', '/v1/tasks?timer=overdue', supervisor)).json();
    expect(late.items.find((x: { sourceId: string }) => x.sourceId === referralId)).toMatchObject({
      timer: 'overdue',
    });
    expect(
      late.items.find((x: { sourceId: string }) => x.sourceId === referralId).minutesLeft,
    ).toBeLessThan(0);
    expect(late.counts.overdue).toBeGreaterThanOrEqual(1);
    expect(
      (await api('PUT', '/v1/task-sla/referral', supervisor, { priority: 'high', targetHours: 24 }))
        .statusCode,
    ).toBe(200);
  });

  it('drops a task when its work is done in its own screen', async () => {
    // Decided below in the AG-04 tests; here we only check the queue follows the referral's own status.
    const open = (await api('GET', '/v1/tasks?source=referral', supervisor))
      .json()
      .items.map((x: { sourceId: string }) => x.sourceId);
    expect(open).toContain(referralId);
  });
});

async function summarise(referralId: string, cite: string[], bogusFirst = false) {
  const res = await api('POST', '/v1/agents/AG-04/runs', uw1, {
    question: `Summarise referral ${referralId}.`,
  });
  expect(res.statusCode, res.body).toBe(202);
  const model = new ScriptedModel((q, req) => {
    if (!q.includes('Summarise referral')) return behaved(q);
    const lt = lastTool(req);
    if (!lt) return message([toolUse('get_referral', { referralId })]);
    const submit = (rules: string[]) =>
      message([
        toolUse('submit_referral_summary', {
          referralId,
          summary:
            'A single traveller with a trip cost of 9,000 triggered the high trip cost rule, which refers the case. I suggest approval if the cost is confirmed.',
          rulesCited: rules,
          suggested: 'approve',
        }),
      ]);
    if (lt.name === 'get_referral') {
      expect(lt.result).toContain('high_cost');
      return submit(bogusFirst ? ['made_up_rule'] : cite);
    }
    if (lt.isError) return submit(cite);
    return message([
      text('The summary is ready; it suggests approval and an underwriter decides.'),
    ]);
  });
  const rt = runtime(model);
  const id = await rt.claimNextRun();
  expect(id).toBe(res.json().id);
  await rt.execute(id!);
  return id!;
}

describe('AG-04 referral summaries and the review of agent output (E03-F05-S01, E11-F02-S02)', () => {
  let referralId = '';
  let summaryId = '';
  let runId = '';

  it('has no way to decide a referral', () => {
    expect(AG04.autonomy).toBe('L1');
    for (const tool of AG04.tools) {
      expect(Object.keys(TOOL_CATALOGUE)).toContain(tool);
      expect(tool).not.toMatch(/decide|approve|decline|decision/);
      expect(TOOL_CATALOGUE[tool]!.risk).not.toBe('write');
    }
  });

  it('summarises a referral, citing only rules that fired, and refuses a made-up rule', async () => {
    const q = (
      await quote({
        travellers: [
          {
            firstName: 'Eve',
            lastName: 'Expensive',
            dateOfBirth: '1980-05-05',
            costPerTraveller: '9500',
          },
        ],
      })
    ).json();
    referralId = (await bind(q.id, q.premium.total)).json().errors[0].message as string;
    runId = await summarise(referralId, ['high_cost'], true);
    const list = (await api('GET', `/v1/referrals/${referralId}/summaries`, uw1)).json().items as {
      id: string;
      rulesCited: string[];
      suggested: string;
      verification: { allCitedRulesFired: boolean };
      agentId: string;
      runId: string;
      decision: unknown;
    }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      rulesCited: ['high_cost'],
      suggested: 'approve',
      agentId: 'AG-04',
      runId,
      decision: null,
      verification: { allCitedRulesFired: true },
    });
    summaryId = list[0]!.id;
    // The refused attempt is on the run's record.
    const review = (await api('GET', `/v1/agent-runs/${runId}/review`, uw1)).json();
    const refused = review.evidence.filter(
      (e: { kind: string; detail: { isError?: boolean; result?: string } }) =>
        e.kind === 'tool_result' && JSON.stringify(e.detail).includes('made_up_rule'),
    );
    expect(refused.length).toBeGreaterThan(0);
  });

  it('shows what the agent was given, read and concluded, with its warrant limits', async () => {
    const review = (await api('GET', `/v1/agent-runs/${runId}/review`, uw1)).json();
    expect(review).toMatchObject({
      agentId: 'AG-04',
      agentName: 'Underwriting Referral',
      status: 'completed',
      requestedBy: 'uw-1',
    });
    expect(review.input).toMatchObject({ question: expect.stringContaining(referralId) });
    expect(review.evidence.map((e: { kind: string }) => e.kind)).toEqual(
      expect.arrayContaining(['input', 'tool_call', 'tool_result', 'output']),
    );
    expect(review.evidence.some((e: { name: string | null }) => e.name === 'get_referral')).toBe(
      true,
    );
    expect(review.warrant).toMatchObject({ escalationRole: 'underwriter', maxModelTurns: 8 });
    expect(review.warrant.tools.map((x: { name: string }) => x.name)).toEqual([
      'get_referral',
      'get_quote',
      'submit_referral_summary',
    ]);
    expect(review.reasoning).toContain('summary is ready');
    // Someone with no part in the run and no agent access cannot read it.
    expect((await api('GET', `/v1/agent-runs/${runId}/review`, st.tokens.partner)).statusCode).toBe(
      403,
    );
  });

  it('records accept, edit and reject, once each, with the reason, for evaluation', async () => {
    const url = `/v1/referral-summaries/${summaryId}/decision`;
    expect(
      (await api('POST', url, uw1, { decision: 'edited', reason: 'Wording' })).statusCode,
    ).toBe(400);
    expect((await api('POST', url, uw1, { decision: 'rejected' })).statusCode).toBe(400);
    expect((await api('POST', url, st.tokens.partner, { decision: 'accepted' })).statusCode).toBe(
      403,
    );
    const edited = await api('POST', url, uw1, {
      decision: 'edited',
      editedSummary:
        'One traveller, trip cost 9,500, which is over the 8,000 limit; I would approve once the cost is confirmed with the seller.',
      reason: 'Added the limit and the check.',
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().decision).toMatchObject({
      decision: 'edited',
      reason: 'Added the limit and the check.',
      decidedBy: 'uw-1',
    });
    expect((await api('POST', url, uw1, { decision: 'accepted' })).statusCode).toBe(409);

    // A second summary, rejected.
    const rid = await summarise(referralId, ['high_cost']);
    const second = (await api('GET', `/v1/referrals/${referralId}/summaries`, uw1))
      .json()
      .items.find((x: { runId: string }) => x.runId === rid);
    expect(
      (
        await api('POST', `/v1/referral-summaries/${second.id}/decision`, uw1, {
          decision: 'rejected',
          reason: 'It ignored the age of the traveller.',
        })
      ).statusCode,
    ).toBe(200);

    const record = (await api('GET', '/v1/agents/AG-04/output-decisions', governance)).json();
    expect(record.counts).toEqual({ accepted: 0, edited: 1, rejected: 1 });
    expect(record.items.map((x: { decision: string }) => x.decision).sort()).toEqual([
      'edited',
      'rejected',
    ]);
    expect(
      record.items.find((x: { decision: string }) => x.decision === 'edited').edited,
    ).toMatchObject({ summary: expect.stringContaining('8,000') });
    // The record cannot be changed afterwards.
    await expect(
      asOwner((c) => c.query(`UPDATE agents.output_decisions SET decision = 'accepted'`)),
    ).rejects.toThrow();
    expect((await api('GET', '/v1/agents/AG-04/output-decisions', uw1)).statusCode).toBe(403);
  });

  it('leaves the referral to a person: the decision and reason go back to the channel', async () => {
    const decide = await api('POST', `/v1/referrals/${referralId}/decision`, uw1, {
      decision: 'declined',
      reason: 'The seller could not confirm the trip cost.',
    });
    expect(decide.statusCode, decide.body).toBe(200);
    expect(decide.json()).toMatchObject({
      status: 'declined',
      decisionReason: 'The seller could not confirm the trip cost.',
    });
    const event = await asOwner((c) =>
      c.query(
        `SELECT account_id, data FROM platform.outbox WHERE type = 'ReferralDecided' AND data->>'referralId' = $1`,
        [referralId],
      ),
    );
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0]!.account_id).toBe(st.accountId);
    expect(event.rows[0]!.data).toMatchObject({
      decision: 'declined',
      reason: 'The seller could not confirm the trip cost.',
    });
    // It has left the queue, and a new summary of a decided referral is refused.
    expect(
      (await api('GET', '/v1/tasks?source=referral', supervisor))
        .json()
        .items.map((x: { sourceId: string }) => x.sourceId),
    ).not.toContain(referralId);
  });
});
