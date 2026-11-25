import { LicenceExpiring, LICENCE_ALERT_DAYS } from '@astra/contracts';
import { publishEvent, systemContext, withTx, writeAudit, type Logger, type Pool } from '@astra/platform';
import type { WorkerConfig } from './config';
import { Loop } from './loops';

/**
 * Licence and registration expiry alerts (E07-F03-S01): at 60 and 30 days before expiry, once each. A licence
 * recorded when it is already inside a threshold gets the tightest alert only, and the wider one is marked as
 * covered. Sales are blocked by the quote and bind checks, not here. Design: docs/adr/0014.
 */
export async function alertExpiring(pool: Pool, logger: Logger, now: Date = new Date()): Promise<number> {
  const ctx = systemContext('licence-alerts');
  const today = now.toISOString().slice(0, 10);
  return withTx(pool, ctx, async (tx) => {
    const { rows } = await tx.query<{ id: string; account_id: string; kind: string; state: string; number: string; expires_on: string; days_left: number; sent: number[] | null }>(
      `SELECT l.id, l.account_id, l.kind, l.state, l.number, l.expires_on::text, (l.expires_on - $1::date) AS days_left,
              (SELECT array_agg(a.days) FROM onboarding.licence_alerts a WHERE a.licence_id = l.id) AS sent
         FROM onboarding.licences l WHERE l.status = 'active' AND l.expires_on >= $1::date AND l.expires_on - $1::date <= $2`,
      [today, Math.max(...LICENCE_ALERT_DAYS)],
    );
    let raised = 0;
    for (const l of rows) {
      const sent = l.sent ?? [];
      const due = [...LICENCE_ALERT_DAYS].filter((d) => l.days_left <= d && !sent.includes(d)).sort((a, b) => a - b);
      if (due.length === 0) continue;
      const tightest = due[0]!;
      for (const d of due) await tx.query(`INSERT INTO onboarding.licence_alerts (licence_id, account_id, days) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [l.id, l.account_id, d]);
      await publishEvent(tx, ctx, LicenceExpiring, { accountId: l.account_id, licenceId: l.id, kind: l.kind, state: l.state, number: l.number, expiresOn: l.expires_on, daysLeft: l.days_left, threshold: tightest }, { accountId: l.account_id });
      await writeAudit(tx, ctx, { action: 'licence.expiring', resourceType: 'licence', resourceId: l.id, accountId: l.account_id, data: { state: l.state, number: l.number, expiresOn: l.expires_on, daysLeft: l.days_left, threshold: tightest } });
      logger.warn({ licenceId: l.id, state: l.state, daysLeft: l.days_left }, 'Licence expiring');
      raised += 1;
    }
    return raised;
  });
}

export function licenceAlertLoop(pool: Pool, config: WorkerConfig, logger: Logger): Loop {
  // Once a day; the first pass runs at start-up.
  return new Loop('licence-alerts', 24 * 3_600_000, async () => (await alertExpiring(pool, logger)) < 0, logger);
}
