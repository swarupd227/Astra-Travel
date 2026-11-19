// Local development seed: registers the two synthetic sandbox accounts that the local Keycloak
// partner clients (astra-partner-a / astra-partner-b) are bound to. Synthetic data only; never run
// against a shared or production environment.
import {
  createPool,
  publishEvent,
  systemContext,
  withTx,
  writeAudit,
} from '../packages/platform/src/index';
import { AccountRegistered } from '../packages/contracts/src/index';

const SANDBOX_ACCOUNTS = [
  {
    id: '7d1f6c2a-3b4e-4f5a-8b6c-9d0e1f2a3b01',
    code: 'SANDBOX-AIR',
    name: 'Sandbox Airline (synthetic)',
    kind: 'travel_account',
  },
  {
    id: '7d1f6c2a-3b4e-4f5a-8b6c-9d0e1f2a3b02',
    code: 'SANDBOX-BANK',
    name: 'Sandbox Bank (synthetic)',
    kind: 'bank',
  },
] as const;

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
if (!/localhost|127\.0\.0\.1/.test(url))
  throw new Error('The dev seed only runs against a local database.');

const pool = createPool(url, { max: 2, applicationName: 'astra-seed' });
const ctx = systemContext('dev-seed');
try {
  await withTx(pool, ctx, async (tx) => {
    for (const a of SANDBOX_ACCOUNTS) {
      const res = await tx.query(
        `INSERT INTO platform.accounts (id, code, name, kind, created_by)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
        [a.id, a.code, a.name, a.kind, ctx.principal.subject],
      );
      if (res.rowCount === 0) {
        console.log(`exists   ${a.code}`);
        continue;
      }
      await writeAudit(tx, ctx, {
        action: 'account.registered',
        resourceType: 'account',
        resourceId: a.id,
        accountId: a.id,
        reason: 'Local development seed (synthetic sandbox account)',
        data: { code: a.code, name: a.name, kind: a.kind },
      });
      await publishEvent(
        tx,
        ctx,
        AccountRegistered,
        { accountId: a.id, code: a.code, name: a.name, kind: a.kind },
        { accountId: a.id },
      );
      console.log(`created  ${a.code}`);
    }
  });
} finally {
  await pool.end();
}
