import { randomUUID } from 'node:crypto';
import { systemContext, withTx, writeAudit, type Pool } from '@astra/platform';
import type { EvalCase } from './manifest';
import type { AgentRuntime, RunOutcome } from './runtime';

/**
 * Evaluation (E15-F03-S01). Each case runs through the real runtime and model under the agent's warrant,
 * then deterministic graders check what it did and said. A version can only be approved when its latest
 * evaluation for every eval set passed: the score meets the threshold and every critical case passed.
 *
 * Evaluation runs act with the warrant's data access across all accounts, so they belong in development,
 * test and sandbox environments with synthetic data, not in production.
 */
export interface CaseResult {
  caseId: string;
  description: string;
  critical: boolean;
  passed: boolean;
  failures: string[];
  runId: string;
  status: string;
  toolsCalled: string[];
  costUsd: number;
}

export function gradeCase(c: EvalCase, outcome: RunOutcome, toolsCalled: string[]): string[] {
  const failures: string[] = [];
  const answer = outcome.answer ?? '';
  if (outcome.status !== 'completed')
    failures.push(`run ${outcome.status} (${outcome.stopReason})`);
  for (const t of c.expect.toolsCalled ?? []) {
    if (!toolsCalled.includes(t)) failures.push(`expected a call to ${t}`);
  }
  for (const t of c.expect.toolsNotCalled ?? []) {
    if (toolsCalled.includes(t)) failures.push(`must not call ${t}`);
  }
  for (const re of c.expect.answerMatches ?? []) {
    if (!new RegExp(re, 'i').test(answer)) failures.push(`answer should match /${re}/i`);
  }
  for (const re of c.expect.answerNotMatches ?? []) {
    if (new RegExp(re, 'i').test(answer)) failures.push(`answer must not match /${re}/i`);
  }
  return failures;
}

export function scoreResults(
  results: CaseResult[],
  threshold: number,
): { score: number; passed: boolean } {
  const score = results.length ? results.filter((r) => r.passed).length / results.length : 0;
  const criticalOk = results.every((r) => !r.critical || r.passed);
  return { score: Math.round(score * 1000) / 1000, passed: criticalOk && score >= threshold };
}

export class EvaluationRunner {
  constructor(
    private readonly pool: Pool,
    private readonly runtime: AgentRuntime,
  ) {}

  async claimNext(): Promise<string | null> {
    const { rows } = await withTx(this.pool, systemContext('agent-evaluation'), (tx) =>
      tx.query<{ id: string }>(
        `UPDATE agents.eval_runs SET status = 'running', locked_until = now() + interval '1 hour'
          WHERE id = (SELECT id FROM agents.eval_runs WHERE status = 'queued'
                       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
          RETURNING id`,
      ),
    );
    return rows[0]?.id ?? null;
  }

  async execute(evalRunId: string): Promise<void> {
    const ctx = systemContext('agent-evaluation');
    const setup = await withTx(this.pool, ctx, async (tx) => {
      const { rows } = await tx.query<{
        agent_id: string;
        agent_version: number;
        eval_set: string;
        eval_set_version: number;
        started_by: string;
        cases: EvalCase[];
        threshold: string;
        warrant: { dataAccess: string[] } | null;
      }>(
        `SELECT r.agent_id, r.agent_version, r.eval_set, r.eval_set_version, r.started_by, s.cases, s.threshold,
                (SELECT document FROM agents.warrants w WHERE w.agent_id = r.agent_id AND w.status = 'active') AS warrant
           FROM agents.eval_runs r
           JOIN agents.eval_sets s ON s.agent_id = r.agent_id AND s.name = r.eval_set AND s.version = r.eval_set_version
          WHERE r.id = $1`,
        [evalRunId],
      );
      return rows[0];
    });
    if (!setup) throw new Error(`Evaluation run ${evalRunId} not found`);

    const results: CaseResult[] = [];
    try {
      for (const c of setup.cases) {
        const runId = randomUUID();
        await withTx(this.pool, ctx, (tx) =>
          tx.query(
            `INSERT INTO agents.runs
               (id, agent_id, agent_version, purpose, eval_run_id, status, started_at, requested_by,
                requested_by_name, account_scope, permissions, input, correlation_id)
             VALUES ($1, $2, $3, 'evaluation', $4, 'running', now(), $5, $6, '*', $7, $8, $9)`,
            [
              runId,
              setup.agent_id,
              setup.agent_version,
              evalRunId,
              setup.started_by,
              `Evaluation ${setup.eval_set}/${c.id}`,
              setup.warrant?.dataAccess ?? [],
              JSON.stringify({ question: c.question, evalCase: c.id }),
              `eval-${evalRunId.slice(0, 8)}-${c.id}`,
            ],
          ),
        );
        const outcome = await this.runtime.execute(runId);
        const facts = await withTx(this.pool, ctx, async (tx) => {
          const tools = await tx.query<{ name: string }>(
            `SELECT name FROM agents.run_steps WHERE run_id = $1 AND kind = 'tool_call' AND decision = 'allowed'`,
            [runId],
          );
          const cost = await tx.query<{ cost_usd: string }>(
            `SELECT cost_usd FROM agents.runs WHERE id = $1`,
            [runId],
          );
          return {
            tools: tools.rows.map((r) => r.name),
            cost: Number(cost.rows[0]?.cost_usd ?? 0),
          };
        });
        const failures = gradeCase(c, outcome, facts.tools);
        results.push({
          caseId: c.id,
          description: c.description,
          critical: c.critical,
          passed: failures.length === 0,
          failures,
          runId,
          status: outcome.status,
          toolsCalled: facts.tools,
          costUsd: facts.cost,
        });
      }
      const { score, passed } = scoreResults(results, Number(setup.threshold));
      const cost = results.reduce((s, r) => s + r.costUsd, 0);
      await withTx(this.pool, ctx, async (tx) => {
        await tx.query(
          `UPDATE agents.eval_runs SET status = 'completed', score = $2, passed = $3, results = $4, cost_usd = $5,
                  finished_at = now(), locked_until = NULL WHERE id = $1`,
          [evalRunId, score, passed, JSON.stringify(results), cost.toFixed(6)],
        );
        await writeAudit(tx, ctx, {
          action: 'agent_evaluation.completed',
          resourceType: 'agent',
          resourceId: setup.agent_id,
          data: {
            evalRunId,
            agentVersion: setup.agent_version,
            evalSet: `${setup.eval_set}@${setup.eval_set_version}`,
            score,
            passed,
            failedCases: results.filter((r) => !r.passed).map((r) => r.caseId),
          },
        });
      });
    } catch (err) {
      await withTx(this.pool, ctx, (tx) =>
        tx.query(
          `UPDATE agents.eval_runs SET status = 'failed', error = $2, results = $3, finished_at = now(),
                  locked_until = NULL WHERE id = $1`,
          [evalRunId, (err as Error).message.slice(0, 2000), JSON.stringify(results)],
        ),
      );
      throw err;
    }
  }
}
