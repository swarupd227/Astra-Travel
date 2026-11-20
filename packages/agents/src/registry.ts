import { canonicalJson, systemContext, withTx, writeAudit, type Pool } from '@astra/platform';
import { configHash, type AgentManifest } from './manifest';

const REGISTRAR = 'system:agent-registry';

export interface SyncResult {
  agentId: string;
  version: number;
  newVersion: boolean;
}

/**
 * Registers every manifest the deployed code contains (E15-F01-S01). New code becomes a new *pending*
 * version: it cannot serve requests until a person approves it. Warrants and budgets are never created
 * here; only people set them.
 */
export async function syncRegistry(
  pool: Pool,
  manifests: readonly AgentManifest[],
): Promise<SyncResult[]> {
  const ctx = systemContext('agent-registry');
  const results: SyncResult[] = [];
  for (const m of manifests) {
    const hash = configHash(m);
    const result = await withTx(pool, ctx, async (tx) => {
      await tx.query(
        `INSERT INTO agents.agents (id, name, purpose, owner_role, autonomy, status_changed_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, purpose = EXCLUDED.purpose,
           owner_role = EXCLUDED.owner_role, autonomy = EXCLUDED.autonomy`,
        [m.id, m.name, m.purpose, m.ownerRole, m.autonomy, REGISTRAR],
      );
      // Serialise version numbering per agent across concurrently starting workers.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `agent-registry:${m.id}`,
      ]);
      const existing = await tx.query<{ version: number }>(
        `SELECT version FROM agents.agent_versions WHERE agent_id = $1 AND config_hash = $2`,
        [m.id, hash],
      );
      if (existing.rows[0])
        return { agentId: m.id, version: existing.rows[0].version, newVersion: false };

      const next = await tx.query<{ v: number }>(
        `SELECT coalesce(max(version), 0) + 1 AS v FROM agents.agent_versions WHERE agent_id = $1`,
        [m.id],
      );
      const version = next.rows[0]!.v;
      await tx.query(
        `INSERT INTO agents.agent_versions
           (agent_id, version, config_hash, model, prompt_version, system_prompt, tools, data_access,
            effort, max_tokens, registered_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          m.id,
          version,
          hash,
          m.model,
          m.promptVersion,
          m.systemPrompt,
          m.tools,
          m.dataAccess,
          m.effort,
          m.maxTokens,
          REGISTRAR,
        ],
      );
      await writeAudit(tx, ctx, {
        action: 'agent_version.registered',
        resourceType: 'agent',
        resourceId: m.id,
        data: {
          version,
          configHash: hash,
          model: m.model,
          promptVersion: m.promptVersion,
          tools: m.tools,
        },
      });
      return { agentId: m.id, version, newVersion: true };
    });

    await withTx(pool, ctx, async (tx) => {
      for (const set of m.evalSets) {
        const latest = await tx.query<{ version: number; threshold: string; cases: unknown }>(
          `SELECT version, threshold, cases FROM agents.eval_sets
            WHERE agent_id = $1 AND name = $2 ORDER BY version DESC LIMIT 1`,
          [m.id, set.name],
        );
        const row = latest.rows[0];
        const unchanged =
          row &&
          Number(row.threshold) === set.threshold &&
          canonicalJson(row.cases) === canonicalJson(set.cases);
        if (unchanged) continue;
        await tx.query(
          `INSERT INTO agents.eval_sets (agent_id, name, version, threshold, cases) VALUES ($1, $2, $3, $4, $5)`,
          [m.id, set.name, (row?.version ?? 0) + 1, set.threshold, JSON.stringify(set.cases)],
        );
      }
    });
    results.push(result);
  }
  return results;
}
