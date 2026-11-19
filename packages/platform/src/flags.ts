import type { FeatureFlag } from '@astra/contracts';
import { systemContext } from './context';
import { withTx, type Pool, type Tx } from './db';

/** Flags that code depends on. Each one is created by a migration. */
export const FLAGS = {
  webhookDelivery: 'integration.webhooks-delivery',
  partnerApiAccess: 'api.partner-access',
} as const;

export type FlagKey = (typeof FLAGS)[keyof typeof FLAGS];

interface Snapshot {
  loadedAt: number;
  global: Map<string, boolean>;
  overrides: Map<string, boolean>; // `${key}|${accountId}`
}

/**
 * Feature flags with per-account overrides (E13-F03-S02: releases use feature flags).
 * Values are cached briefly; a change takes effect everywhere within `ttlMs`.
 * Unknown flags evaluate to false (fail closed).
 */
export class FeatureFlags {
  private snapshot: Snapshot | null = null;
  private loading: Promise<Snapshot> | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly ttlMs = 5_000,
  ) {}

  async isEnabled(key: FlagKey, accountId?: string | null): Promise<boolean> {
    const snap = await this.current();
    if (accountId) {
      const override = snap.overrides.get(`${key}|${accountId}`);
      if (override !== undefined) return override;
    }
    return snap.global.get(key) ?? false;
  }

  invalidate(): void {
    this.snapshot = null;
  }

  private async current(): Promise<Snapshot> {
    if (this.snapshot && Date.now() - this.snapshot.loadedAt < this.ttlMs) return this.snapshot;
    if (!this.loading) {
      this.loading = withTx(this.pool, systemContext('feature-flags'), loadSnapshot).finally(() => {
        this.loading = null;
      });
    }
    this.snapshot = await this.loading;
    return this.snapshot;
  }
}

async function loadSnapshot(tx: Tx): Promise<Snapshot> {
  const flags = await tx.query<{ key: string; enabled: boolean }>(
    'SELECT key, enabled FROM platform.feature_flags',
  );
  const overrides = await tx.query<{ flag_key: string; account_id: string; enabled: boolean }>(
    'SELECT flag_key, account_id, enabled FROM platform.feature_flag_overrides',
  );
  return {
    loadedAt: Date.now(),
    global: new Map(flags.rows.map((r) => [r.key, r.enabled])),
    overrides: new Map(overrides.rows.map((r) => [`${r.flag_key}|${r.account_id}`, r.enabled])),
  };
}

export async function listFlags(tx: Tx): Promise<FeatureFlag[]> {
  const { rows } = await tx.query<{
    key: string;
    description: string;
    enabled: boolean;
    updated_at: Date;
    updated_by: string | null;
    overrides: { accountId: string; enabled: boolean }[];
  }>(
    `SELECT f.key, f.description, f.enabled, f.updated_at, f.updated_by,
            coalesce(json_agg(json_build_object('accountId', o.account_id, 'enabled', o.enabled)
                     ORDER BY o.account_id) FILTER (WHERE o.account_id IS NOT NULL), '[]') AS overrides
       FROM platform.feature_flags f
       LEFT JOIN platform.feature_flag_overrides o ON o.flag_key = f.key
      GROUP BY f.key ORDER BY f.key`,
  );
  return rows.map((r) => ({
    key: r.key,
    description: r.description,
    enabled: r.enabled,
    overrides: r.overrides,
    updatedAt: r.updated_at.toISOString(),
    updatedBy: r.updated_by,
  }));
}
