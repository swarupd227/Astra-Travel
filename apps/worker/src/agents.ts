import {
  AgentRuntime,
  AgentTokenSigner,
  AGENT_MANIFESTS,
  ConfiguredModelGateway,
  EvaluationRunner,
  raiseReview,
  savedModelKey,
  syncRegistry,
} from '@astra/agents';
import { systemContext, withTx, type Logger, type Pool, type SecretBox } from '@astra/platform';
import type { WorkerConfig } from './config';
import { Loop } from './loops';

/**
 * Agent work in the worker: registers the agents in this build, runs queued requests and evaluations,
 * and routes runs interrupted by a crash or restart to people.
 */
export async function startAgentLoops(
  pool: Pool,
  config: WorkerConfig,
  logger: Logger,
  secrets: SecretBox,
): Promise<Loop[]> {
  const registered = await syncRegistry(pool, AGENT_MANIFESTS);
  for (const r of registered) {
    logger.info(
      { agentId: r.agentId, version: r.version, newVersion: r.newVersion },
      'Agent registered',
    );
  }
  if (!config.AGENT_TOKEN_PRIVATE_KEY) {
    logger.warn('AGENT_TOKEN_PRIVATE_KEY is not set: agent runs and evaluations are disabled');
    return [];
  }

  const runtime = new AgentRuntime({
    pool,
    // The key saved in the application; without one, ANTHROPIC_API_KEY from the environment.
    gateway: new ConfiguredModelGateway(
      async () => (await savedModelKey(pool, secrets))?.apiKey ?? null,
    ),
    signer: await AgentTokenSigner.fromPrivateKey(config.AGENT_TOKEN_PRIVATE_KEY),
    apiBaseUrl: config.API_BASE_URL,
    apiAudience: config.OIDC_AUDIENCE,
    logger,
    manifests: AGENT_MANIFESTS,
  });
  const evaluations = new EvaluationRunner(pool, runtime);

  const runs = new Loop(
    'agent-runs',
    config.WORKER_POLL_MS,
    async () => {
      const claimed: string[] = [];
      for (let i = 0; i < config.AGENT_CONCURRENCY; i++) {
        const id = await runtime.claimNextRun();
        if (!id) break;
        claimed.push(id);
      }
      await Promise.all(
        claimed.map((id) =>
          runtime.execute(id).catch(async (err: unknown) => {
            logger.error({ err, runId: id }, 'Agent run crashed');
            await markCrashed(pool, id, (err as Error).message);
          }),
        ),
      );
      return claimed.length === config.AGENT_CONCURRENCY;
    },
    logger,
  );

  const evals = new Loop(
    'agent-evaluations',
    config.WORKER_POLL_MS * 2,
    async () => {
      const id = await evaluations.claimNext();
      if (!id) return false;
      await evaluations
        .execute(id)
        .catch((err: unknown) => logger.error({ err, evalRunId: id }, 'Evaluation failed'));
      return true;
    },
    logger,
  );

  const recovery = new Loop(
    'agent-recovery',
    60_000,
    async () => {
      const ctx = systemContext('agent-recovery');
      await withTx(pool, ctx, async (tx) => {
        const { rows } = await tx.query<{ id: string; agent_id: string }>(
          `UPDATE agents.runs SET status = 'failed', stop_reason = 'interrupted', finished_at = now(), locked_until = NULL
            WHERE status = 'running' AND locked_until < now() RETURNING id, agent_id`,
        );
        for (const r of rows) {
          await raiseReview(tx, ctx, {
            agentId: r.agent_id,
            runId: r.id,
            kind: 'run_failed',
            summary: 'An agent run was interrupted before it finished; the request needs a person.',
          });
        }
        await tx.query(
          `UPDATE agents.eval_runs SET status = 'failed', error = 'interrupted', finished_at = now(), locked_until = NULL
            WHERE status = 'running' AND locked_until < now()`,
        );
      });
      return false;
    },
    logger,
  );

  return [runs, evals, recovery];
}

async function markCrashed(pool: Pool, runId: string, message: string): Promise<void> {
  const ctx = systemContext('agent-runtime');
  await withTx(pool, ctx, async (tx) => {
    const { rows } = await tx.query<{ agent_id: string }>(
      `UPDATE agents.runs SET status = 'failed', stop_reason = 'runtime_error', error = $2, finished_at = now(),
              locked_until = NULL
        WHERE id = $1 AND status = 'running' RETURNING agent_id`,
      [runId, message.slice(0, 2000)],
    );
    if (rows[0]) {
      await raiseReview(tx, ctx, {
        agentId: rows[0].agent_id,
        runId,
        kind: 'run_failed',
        summary: 'An agent run failed with an internal error; the request needs a person.',
        detail: { error: message.slice(0, 500) },
      });
    }
  });
}
