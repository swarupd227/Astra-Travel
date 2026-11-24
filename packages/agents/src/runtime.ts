import { metrics } from '@opentelemetry/api';
import Anthropic from '@anthropic-ai/sdk';
import {
  AgentReviewRaised,
  AgentRunFinished,
  WarrantDocumentSchema,
  type WarrantDocument,
} from '@astra/contracts';
import {
  publishEvent,
  systemContext,
  withTx,
  writeAudit,
  type Logger,
  type Pool,
  type RequestContext,
  type Tx,
} from '@astra/platform';
import { AgentApiClient, ToolCallError } from './api-client';
import type { AgentTokenSigner } from './agent-token';
import type {
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
  ModelGateway,
} from './gateway';
import { redact, redactValue, type Finding } from './guardrails';
import { configHash, type AgentManifest } from './manifest';
import { TOOL_CATALOGUE, toolInputSchema } from './tools';

const meter = metrics.getMeter('astra.agents');
const runCounter = meter.createCounter('astra.agents.runs', {
  description: 'Agent runs by agent and outcome',
});
const costCounter = meter.createCounter('astra.agents.cost_usd', {
  description: 'Agent model spend in US dollars',
});
const refusalCounter = meter.createCounter('astra.agents.warrant_refusals');
const guardrailCounter = meter.createCounter('astra.agents.guardrail_findings');

const MAX_TOOL_RESULT_CHARS = 30_000;

export type RunStatus = 'completed' | 'failed' | 'stopped' | 'escalated';

export interface RunOutcome {
  status: RunStatus;
  stopReason: string;
  answer: string | null;
}

export interface RuntimeDeps {
  pool: Pool;
  gateway: ModelGateway;
  signer: AgentTokenSigner;
  apiBaseUrl: string;
  apiAudience: string;
  logger: Logger;
  manifests: readonly AgentManifest[];
  fetchImpl?: typeof fetch;
}

interface RunRow {
  id: string;
  agent_id: string;
  agent_version: number;
  purpose: 'request' | 'evaluation';
  requested_by: string;
  requested_by_name: string | null;
  account_scope: string;
  permissions: string[];
  input: { question?: string };
  correlation_id: string;
}

interface VersionRow {
  config_hash: string;
  approval_status: string;
  model: string;
  prompt_version: string;
  data_access: string[];
}

interface Totals {
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  models: Set<string>;
}

class StepRecorder {
  private seq = 0;
  constructor(
    private readonly pool: Pool,
    private readonly ctx: RequestContext,
    private readonly runId: string,
  ) {}

  async record(
    kind: string,
    name: string | null,
    decision: 'allowed' | 'refused' | 'redacted' | 'stopped' | 'error' | null,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    this.seq += 1;
    const seq = this.seq;
    await withTx(this.pool, this.ctx, (tx) =>
      tx.query(
        `INSERT INTO agents.run_steps (run_id, seq, kind, name, decision, detail) VALUES ($1, $2, $3, $4, $5, $6)`,
        [this.runId, seq, kind, name, decision, JSON.stringify(detail)],
      ),
    );
  }
}

/** Spend this calendar month (UTC) for an agent, in US dollars. */
export async function monthSpend(tx: Tx, agentId: string): Promise<number> {
  const { rows } = await tx.query<{ spent: string }>(
    `SELECT coalesce(sum(cost_usd), 0) AS spent FROM agents.runs
      WHERE agent_id = $1 AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [agentId],
  );
  return Number(rows[0]!.spent);
}

export async function raiseReview(
  tx: Tx,
  ctx: RequestContext,
  review: {
    agentId: string;
    runId: string | null;
    kind: string;
    summary: string;
    detail?: Record<string, unknown>;
  },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO agents.reviews (agent_id, run_id, kind, summary, detail) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      review.agentId,
      review.runId,
      review.kind,
      review.summary,
      JSON.stringify(review.detail ?? {}),
    ],
  );
  const id = rows[0]!.id;
  await writeAudit(tx, ctx, {
    action: 'agent_review.raised',
    resourceType: 'agent_review',
    resourceId: id,
    data: {
      agentId: review.agentId,
      runId: review.runId,
      kind: review.kind,
      summary: review.summary,
    },
  });
  await publishEvent(
    tx,
    ctx,
    AgentReviewRaised,
    { reviewId: id, agentId: review.agentId, kind: review.kind, runId: review.runId },
    { accountId: null },
  );
  return id;
}

function intersect(...lists: string[][]): string[] {
  const [first, ...rest] = lists;
  return (first ?? []).filter((x) => rest.every((l) => l.includes(x)));
}

/**
 * Executes agent runs under governance (E15). Before every model call it re-reads the kill switch and
 * the budget; before every tool call it checks the warrant. Every step is appended to the run record.
 */
export class AgentRuntime {
  constructor(private readonly deps: RuntimeDeps) {}

  /** Claims the oldest queued request run, or returns null. */
  async claimNextRun(): Promise<string | null> {
    const { rows } = await withTx(this.deps.pool, systemContext('agent-runtime'), (tx) =>
      tx.query<{ id: string }>(
        `UPDATE agents.runs SET status = 'running', started_at = now(), locked_until = now() + interval '15 minutes'
          WHERE id = (SELECT id FROM agents.runs WHERE status = 'queued' AND purpose = 'request'
                       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
          RETURNING id`,
      ),
    );
    return rows[0]?.id ?? null;
  }

  async execute(runId: string): Promise<RunOutcome> {
    const pool = this.deps.pool;
    const run = await withTx(pool, systemContext('agent-runtime'), async (tx) => {
      const { rows } = await tx.query<RunRow>(
        `SELECT id, agent_id, agent_version, purpose, requested_by, requested_by_name, account_scope,
                permissions, input, correlation_id
           FROM agents.runs WHERE id = $1`,
        [runId],
      );
      return rows[0];
    });
    if (!run) throw new Error(`Agent run ${runId} not found`);

    const ctx = systemContext(`agent-runtime:${run.agent_id}`, run.correlation_id);
    const steps = new StepRecorder(pool, ctx, run.id);
    const totals: Totals = {
      turns: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      models: new Set(),
    };
    let warrantVersion: number | null = null;
    let promptVersion: string | null = null;
    let modelRequested: string | null = null;

    const finish = async (
      status: RunStatus,
      stopReason: string,
      answer: string | null,
      review?: { kind: string; summary: string; detail?: Record<string, unknown> },
      error?: string,
    ): Promise<RunOutcome> => {
      await withTx(pool, ctx, async (tx) => {
        await tx.query(
          `UPDATE agents.runs
              SET status = $2, stop_reason = $3, output = $4, error = $5, warrant_version = $6,
                  model_requested = $7, models_served = $8, prompt_version = $9, turns = $10,
                  tool_calls = $11, input_tokens = $12, output_tokens = $13, cache_read_tokens = $14,
                  cache_write_tokens = $15, cost_usd = $16, finished_at = now(), locked_until = NULL
            WHERE id = $1`,
          [
            run.id,
            status,
            stopReason,
            answer === null ? null : JSON.stringify({ answer }),
            error ?? null,
            warrantVersion,
            modelRequested,
            [...totals.models],
            promptVersion,
            totals.turns,
            totals.toolCalls,
            totals.inputTokens,
            totals.outputTokens,
            totals.cacheReadTokens,
            totals.cacheWriteTokens,
            totals.costUsd.toFixed(6),
          ],
        );
        if (review) await raiseReview(tx, ctx, { agentId: run.agent_id, runId: run.id, ...review });
        await writeAudit(tx, ctx, {
          action: 'agent_run.finished',
          resourceType: 'agent_run',
          resourceId: run.id,
          reason: stopReason,
          data: {
            agentId: run.agent_id,
            agentVersion: run.agent_version,
            warrantVersion,
            purpose: run.purpose,
            status,
            requestedBy: run.requested_by,
            modelsServed: [...totals.models],
            promptVersion,
            toolCalls: totals.toolCalls,
            costUsd: totals.costUsd.toFixed(6),
          },
        });
        await publishEvent(
          tx,
          ctx,
          AgentRunFinished,
          { runId: run.id, agentId: run.agent_id, status, costUsd: totals.costUsd.toFixed(6) },
          { accountId: null },
        );
      });
      runCounter.add(1, { agent: run.agent_id, status, purpose: run.purpose });
      costCounter.add(totals.costUsd, { agent: run.agent_id });
      if (run.purpose === 'request') await this.checkBudgetAlert(run.agent_id, ctx);
      return { status, stopReason, answer };
    };

    // ---------- Preconditions ----------
    const manifest = this.deps.manifests.find((m) => m.id === run.agent_id);
    if (!manifest) return finish('stopped', 'unregistered_agent', null);

    const pre = await withTx(pool, ctx, async (tx) => {
      const agent = await tx.query<{ status: string; autonomy: string }>(
        `SELECT status, autonomy FROM agents.agents WHERE id = $1`,
        [run.agent_id],
      );
      const version = await tx.query<VersionRow>(
        `SELECT config_hash, approval_status, model, prompt_version, data_access
           FROM agents.agent_versions WHERE agent_id = $1 AND version = $2`,
        [run.agent_id, run.agent_version],
      );
      const warrant = await tx.query<{ version: number; document: unknown }>(
        `SELECT version, document FROM agents.warrants WHERE agent_id = $1 AND status = 'active'`,
        [run.agent_id],
      );
      const budget = await tx.query<{ monthly_limit_usd: string }>(
        `SELECT monthly_limit_usd FROM agents.budgets WHERE agent_id = $1`,
        [run.agent_id],
      );
      return {
        agent: agent.rows[0],
        version: version.rows[0],
        warrant: warrant.rows[0],
        budget: budget.rows[0],
        spent: await monthSpend(tx, run.agent_id),
      };
    });

    if (!pre.agent || !pre.version) return finish('stopped', 'unregistered_agent', null);
    promptVersion = pre.version.prompt_version;
    modelRequested = pre.version.model;
    if (configHash(manifest) !== pre.version.config_hash) {
      await steps.record('warrant', 'code_matches_registered_version', 'refused', {});
      return finish('stopped', 'code_does_not_match_registered_version', null);
    }
    if (pre.agent.status !== 'active') {
      await steps.record('kill_switch', 'agent_status', 'stopped', { status: pre.agent.status });
      return finish('stopped', 'agent_paused', null, {
        kind: 'agent_paused',
        summary: `${manifest.name} is ${pre.agent.status}; this request needs a person.`,
        detail: {
          question: run.input.question ?? null,
          requestedBy: run.requested_by_name ?? run.requested_by,
        },
      });
    }
    const versionOk =
      run.purpose === 'evaluation'
        ? pre.version.approval_status === 'pending' || pre.version.approval_status === 'approved'
        : pre.version.approval_status === 'approved';
    if (!versionOk) {
      await steps.record('warrant', 'version_approved', 'refused', {
        approvalStatus: pre.version.approval_status,
      });
      return finish('stopped', 'version_not_approved', null);
    }
    if (!pre.warrant) {
      await steps.record('warrant', 'warrant_present', 'refused', {});
      return finish('stopped', 'no_active_warrant', null);
    }
    const warrantParse = WarrantDocumentSchema.safeParse(pre.warrant.document);
    if (!warrantParse.success)
      return finish('failed', 'invalid_warrant', null, undefined, warrantParse.error.message);
    const warrant: WarrantDocument = warrantParse.data;
    warrantVersion = pre.warrant.version;
    if (!pre.budget) {
      await steps.record('budget', 'budget_present', 'refused', {});
      return finish('stopped', 'no_budget', null);
    }
    const monthlyLimit = Number(pre.budget.monthly_limit_usd);
    if (pre.spent >= monthlyLimit) {
      await steps.record('budget', 'monthly_budget', 'stopped', {
        spent: pre.spent,
        limit: monthlyLimit,
      });
      return finish('stopped', 'budget_exhausted', null, {
        kind: 'budget',
        summary: `${manifest.name} has used its monthly budget of $${monthlyLimit.toFixed(2)}.`,
        detail: { spentUsd: pre.spent.toFixed(4) },
      });
    }

    // ---------- Scope: warrant ∩ registered data access ∩ the requester's own permissions ----------
    const permissions = intersect(warrant.dataAccess, pre.version.data_access, run.permissions);
    const accountScope: '*' | string[] =
      warrant.accountScope === 'none'
        ? []
        : run.account_scope === '*'
          ? '*'
          : run.account_scope.split(',').filter(Boolean);
    const writeAllowed = pre.agent.autonomy === 'L2' || pre.agent.autonomy === 'L3';
    // Proposals only ask a person to act, so any agent above L0 may submit them.
    const proposeAllowed = pre.agent.autonomy !== 'L0';
    const warrantTools = new Map(warrant.tools.map((t) => [t.name, t.maxCallsPerRun]));
    const offered = manifest.tools.filter((name) => {
      const t = TOOL_CATALOGUE[name];
      return (
        t &&
        warrantTools.has(name) &&
        permissions.includes(t.permission) &&
        (t.risk === 'read' || (t.risk === 'propose' && proposeAllowed) || writeAllowed)
      );
    });
    await steps.record('warrant', 'scope', 'allowed', {
      warrantVersion,
      permissions,
      accountScope,
      toolsOffered: offered,
      toolsWithheld: manifest.tools.filter((t) => !offered.includes(t)),
    });

    const token = await this.deps.signer.sign(
      {
        agentId: run.agent_id,
        agentName: manifest.name,
        runId: run.id,
        onBehalfOf: run.requested_by,
        onBehalfOfName: run.requested_by_name,
        permissions,
        accountScope,
      },
      this.deps.apiAudience,
    );
    const api = new AgentApiClient(
      this.deps.apiBaseUrl,
      token,
      run.correlation_id,
      this.deps.fetchImpl,
    );
    const tools: BetaTool[] = offered.map((name) => {
      const t = TOOL_CATALOGUE[name]!;
      return {
        name,
        description: t.description,
        input_schema: toolInputSchema(t) as BetaTool['input_schema'],
      };
    });

    // ---------- Input guardrail ----------
    const question = String(run.input.question ?? '');
    const inGuard = redact(question);
    await steps.record('input', 'question', inGuard.findings.length ? 'redacted' : 'allowed', {
      text: inGuard.text,
      findings: inGuard.findings,
    });
    if (inGuard.findings.length)
      guardrailCounter.add(inGuard.findings.length, { agent: run.agent_id, stage: 'input' });

    const messages: BetaMessageParam[] = [{ role: 'user', content: inGuard.text }];
    const callCounts = new Map<string, number>();
    let refusalReviewRaised = false;

    for (let turn = 1; turn <= warrant.maxModelTurns; turn++) {
      // Kill switch and budget, re-read before every model call.
      const live = await withTx(pool, ctx, async (tx) => {
        const s = await tx.query<{ status: string }>(
          `SELECT status FROM agents.agents WHERE id = $1`,
          [run.agent_id],
        );
        return { status: s.rows[0]?.status, spent: await monthSpend(tx, run.agent_id) };
      });
      if (live.status !== 'active') {
        await steps.record('kill_switch', 'agent_status', 'stopped', { status: live.status, turn });
        return finish('stopped', 'agent_paused', null, {
          kind: 'agent_paused',
          summary: `${manifest.name} was paused during a run; the request needs a person.`,
          detail: {
            question: inGuard.text,
            requestedBy: run.requested_by_name ?? run.requested_by,
          },
        });
      }
      if (totals.costUsd >= warrant.maxCostPerRunUsd) {
        await steps.record('budget', 'run_cost_limit', 'stopped', { costUsd: totals.costUsd });
        return finish('stopped', 'run_cost_limit', null, {
          kind: 'budget',
          summary: `A ${manifest.name} run reached its per-run cost limit of $${warrant.maxCostPerRunUsd}.`,
        });
      }
      if (live.spent + totals.costUsd >= monthlyLimit) {
        await steps.record('budget', 'monthly_budget', 'stopped', { spent: live.spent });
        return finish('stopped', 'budget_exhausted', null, {
          kind: 'budget',
          summary: `${manifest.name} reached its monthly budget during a run.`,
        });
      }

      let result;
      try {
        result = await this.deps.gateway.complete({
          model: pre.version.model,
          system: manifest.systemPrompt,
          tools,
          messages,
          maxTokens: manifest.maxTokens,
          effort: manifest.effort,
        });
      } catch (err) {
        const message =
          err instanceof Anthropic.APIError
            ? `Model API error ${err.status ?? ''}: ${err.message}`
            : String(err);
        await steps.record('model_call', pre.version.model, 'error', { turn, error: message });
        return finish(
          'failed',
          'model_error',
          null,
          {
            kind: 'run_failed',
            summary: `${manifest.name} could not reach the model.`,
            detail: { error: message },
          },
          message,
        );
      }

      const { message, usage } = result;
      totals.turns = turn;
      totals.inputTokens += usage.inputTokens;
      totals.outputTokens += usage.outputTokens;
      totals.cacheReadTokens += usage.cacheReadTokens;
      totals.cacheWriteTokens += usage.cacheWriteTokens;
      totals.costUsd += usage.costUsd;
      for (const m of usage.models) totals.models.add(m);

      const toolUses = message.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use');
      const rawText = message.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      const outGuard = redact(rawText);
      await steps.record('model_call', message.model, 'allowed', {
        turn,
        stopReason: message.stop_reason,
        modelsServed: usage.models,
        promptVersion,
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
        },
        costUsd: usage.costUsd,
        costEstimated: usage.estimated,
        text: outGuard.text,
        toolUses: toolUses.map((t) => ({ id: t.id, name: t.name })),
      });

      if (outGuard.findings.length) {
        guardrailCounter.add(outGuard.findings.length, { agent: run.agent_id, stage: 'output' });
        await steps.record('guardrail', 'output_sensitive_data', 'stopped', {
          findings: outGuard.findings,
        });
        return finish('escalated', 'output_guardrail', null, {
          kind: 'guardrail',
          summary: `${manifest.name} produced an answer containing sensitive data; it was withheld.`,
          detail: { findings: outGuard.findings },
        });
      }

      if (message.stop_reason === 'refusal') {
        return finish('escalated', 'model_refusal', outGuard.text || null, {
          kind: 'model_refusal',
          summary: `The model declined a ${manifest.name} request.`,
          detail: { category: message.stop_details?.category ?? null },
        });
      }

      if (toolUses.length === 0) {
        const truncated = message.stop_reason === 'max_tokens';
        await steps.record('output', 'answer', 'allowed', { truncated });
        return finish('completed', truncated ? 'max_tokens' : 'end_turn', outGuard.text);
      }
      if (message.stop_reason === 'max_tokens') {
        // A tool call cut off mid-input is never run.
        return finish('failed', 'tool_input_truncated', null, {
          kind: 'run_failed',
          summary: `${manifest.name} ran out of output tokens while calling a tool.`,
        });
      }

      messages.push({ role: 'assistant', content: message.content });
      const results: BetaToolResultBlockParam[] = [];

      for (const use of toolUses) {
        const status = await withTx(pool, ctx, (tx) =>
          tx.query<{ status: string }>(`SELECT status FROM agents.agents WHERE id = $1`, [
            run.agent_id,
          ]),
        );
        if (status.rows[0]?.status !== 'active') {
          await steps.record('kill_switch', 'agent_status', 'stopped', { before: use.name });
          return finish('stopped', 'agent_paused', null, {
            kind: 'agent_paused',
            summary: `${manifest.name} was paused before a tool call; the request needs a person.`,
            detail: { question: inGuard.text, pendingTool: use.name },
          });
        }

        const tool = TOOL_CATALOGUE[use.name];
        const used = callCounts.get(use.name) ?? 0;
        const limit = warrantTools.get(use.name);
        let refusal: string | null = null;
        if (!tool || !offered.includes(use.name))
          refusal = 'The tool is not permitted by this agent’s warrant.';
        else if (limit !== undefined && used >= limit)
          refusal = `The warrant allows at most ${limit} calls to ${use.name} per run.`;
        else if (tool.risk === 'write' && !writeAllowed)
          refusal = 'This agent may not take actions.';
        else if (tool.risk === 'propose' && !proposeAllowed)
          refusal = 'This agent may not submit proposals.';

        if (refusal) {
          refusalCounter.add(1, { agent: run.agent_id, tool: use.name });
          await steps.record('warrant', use.name, 'refused', { reason: refusal });
          if (!refusalReviewRaised) {
            refusalReviewRaised = true;
            await withTx(pool, ctx, (tx) =>
              raiseReview(tx, ctx, {
                agentId: run.agent_id,
                runId: run.id,
                kind: 'warrant_refusal',
                summary: `${manifest.name} tried ${use.name}, which its warrant does not allow.`,
                detail: { tool: use.name, reason: refusal, escalationRole: warrant.escalationRole },
              }),
            );
          }
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            is_error: true,
            content: `Refused: ${refusal}`,
          });
          continue;
        }
        await steps.record('warrant', use.name, 'allowed', { call: used + 1, limit });

        const parsed = tool!.input.safeParse(use.input);
        if (!parsed.success) {
          await steps.record('tool_call', use.name, 'error', {
            input: use.input,
            error: 'invalid input',
          });
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            is_error: true,
            content: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          });
          continue;
        }

        callCounts.set(use.name, used + 1);
        totals.toolCalls += 1;
        await steps.record('tool_call', use.name, 'allowed', { input: parsed.data });
        try {
          const raw = await tool!.run(parsed.data, api);
          const guarded = redactValue(raw);
          let text = JSON.stringify(guarded.value);
          const truncated = text.length > MAX_TOOL_RESULT_CHARS;
          if (truncated)
            text = `${text.slice(0, MAX_TOOL_RESULT_CHARS)} …[truncated: ask for fewer rows]`;
          if (guarded.findings.length) {
            guardrailCounter.add(guarded.findings.length, {
              agent: run.agent_id,
              stage: 'tool_result',
            });
          }
          await steps.record(
            'tool_result',
            use.name,
            guarded.findings.length ? 'redacted' : 'allowed',
            {
              chars: text.length,
              truncated,
              findings: guarded.findings as Finding[],
            },
          );
          results.push({ type: 'tool_result', tool_use_id: use.id, content: text });
        } catch (err) {
          const msg =
            err instanceof ToolCallError ? err.message : 'The platform API could not be reached.';
          await steps.record('tool_result', use.name, 'error', {
            error: msg,
            status: err instanceof ToolCallError ? err.status : null,
          });
          results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: msg });
        }
      }
      messages.push({ role: 'user', content: results });
    }

    await steps.record('escalation', 'max_model_turns', 'stopped', {
      maxModelTurns: warrant.maxModelTurns,
    });
    return finish('stopped', 'max_model_turns', null, {
      kind: 'run_failed',
      summary: `${manifest.name} used its ${warrant.maxModelTurns} model turns without finishing.`,
    });
  }

  /** Raises one review per agent per month when spend crosses the alert threshold (E15-F03-S04). */
  private async checkBudgetAlert(agentId: string, ctx: RequestContext): Promise<void> {
    await withTx(this.deps.pool, ctx, async (tx) => {
      const { rows } = await tx.query<{
        monthly_limit_usd: string;
        alert_threshold_pct: number;
        last_alerted_period: string | null;
      }>(
        `SELECT monthly_limit_usd, alert_threshold_pct, last_alerted_period FROM agents.budgets
          WHERE agent_id = $1 FOR UPDATE`,
        [agentId],
      );
      const b = rows[0];
      if (!b) return;
      const period = new Date().toISOString().slice(0, 7);
      if (b.last_alerted_period === period) return;
      const limit = Number(b.monthly_limit_usd);
      const spent = await monthSpend(tx, agentId);
      if (limit === 0 || spent < (limit * b.alert_threshold_pct) / 100) return;
      await tx.query(`UPDATE agents.budgets SET last_alerted_period = $2 WHERE agent_id = $1`, [
        agentId,
        period,
      ]);
      await raiseReview(tx, ctx, {
        agentId,
        runId: null,
        kind: 'budget',
        summary: `${agentId} has used ${((spent / limit) * 100).toFixed(0)}% of its $${limit.toFixed(2)} monthly budget.`,
        detail: {
          spentUsd: spent.toFixed(4),
          limitUsd: limit,
          thresholdPct: b.alert_threshold_pct,
          period,
        },
      });
      this.deps.logger.warn(
        { agentId, spent, limit, alert: 'agent_budget_threshold' },
        'Agent budget threshold reached',
      );
    });
  }
}
