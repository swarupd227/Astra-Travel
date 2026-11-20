import { systemContext, withTx, type Pool } from '@astra/platform';

/**
 * Answers "is this agent active?" for every agent-token request (the kill switch, E15-F03-S03).
 * Cached for a few seconds, so a pause takes effect at the API within that time; the runtime also
 * re-checks before every model and tool call.
 */
export function agentStatusChecker(pool: Pool, ttlMs = 5_000) {
  const cache = new Map<string, { active: boolean; at: number }>();
  return async (agentId: string): Promise<boolean> => {
    const hit = cache.get(agentId);
    if (hit && Date.now() - hit.at < ttlMs) return hit.active;
    const active = await withTx(pool, systemContext('agent-status'), async (tx) => {
      const { rows } = await tx.query<{ status: string }>(
        `SELECT status FROM agents.agents WHERE id = $1`,
        [agentId],
      );
      return rows[0]?.status === 'active';
    });
    cache.set(agentId, { active, at: Date.now() });
    return active;
  };
}
