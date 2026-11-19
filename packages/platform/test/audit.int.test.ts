/** Tamper-evident, append-only audit trail (E15-F03-S02 foundation, E10-F02-S01 foundation). */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPool,
  sealAudit,
  systemContext,
  verifyAudit,
  withTx,
  writeAudit,
  type Pool,
} from '../src/index';

let pool: Pool;
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL!;

beforeAll(() => {
  pool = createPool(process.env.TEST_DATABASE_URL!, { max: 2 });
});
afterAll(async () => pool.end());

const ctx = systemContext('audit-test', 'corr-audit-test');

describe('audit trail', () => {
  it('cannot be updated or deleted by the application role', async () => {
    await withTx(pool, ctx, (tx) =>
      writeAudit(tx, ctx, { action: 'test.write', resourceType: 'test', data: { n: 1 } }),
    );
    await expect(
      withTx(pool, ctx, (tx) =>
        tx.query(`UPDATE audit.audit_log SET action = 'forged' WHERE action = 'test.write'`),
      ),
    ).rejects.toThrow(/permission denied|append-only/);
    await expect(
      withTx(pool, ctx, (tx) =>
        tx.query(`DELETE FROM audit.audit_log WHERE action = 'test.write'`),
      ),
    ).rejects.toThrow(/permission denied|append-only/);
  });

  it('seals records into a hash chain that verifies', async () => {
    await withTx(pool, ctx, (tx) =>
      writeAudit(tx, ctx, { action: 'test.seal', resourceType: 'test' }),
    );
    const sealId = await withTx(pool, ctx, (tx) => sealAudit(tx, 0));
    expect(sealId).not.toBeNull();
    const result = await withTx(pool, ctx, verifyAudit);
    expect(result.ok).toBe(true);
    expect(result.sealsChecked).toBeGreaterThan(0);
    expect(result.lastSealedSeq).not.toBeNull();
  });

  it('detects a record changed behind the application (even by the schema owner)', async () => {
    await withTx(pool, ctx, (tx) =>
      writeAudit(tx, ctx, {
        action: 'test.tamper',
        resourceType: 'test',
        data: { amount: '100.00' },
      }),
    );
    await withTx(pool, ctx, (tx) => sealAudit(tx, 0));
    const owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      await owner.query('ALTER TABLE audit.audit_log DISABLE TRIGGER audit_log_immutable');
      await owner.query(
        `UPDATE audit.audit_log SET data = '{"amount":"1.00"}' WHERE action = 'test.tamper'`,
      );
      const { rows } = await owner.query('SELECT * FROM audit.verify()');
      expect(rows[0]).toMatchObject({ ok: false, mismatch_kind: 'row' });
      await owner.query('ROLLBACK');
    } finally {
      await owner.end();
    }
    expect((await withTx(pool, ctx, verifyAudit)).ok).toBe(true);
  });
});
