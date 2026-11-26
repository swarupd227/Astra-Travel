import { describe, expect, it } from 'vitest';
import { checkRows } from './data-load';

const policy = { policy_id: 'p1', policy_number: 'ATP-2026-000001', account_id: 'a1', plan_id: 'pl1', plan_version: 1, state: 'DE', status: 'active', purchased_on: '2026-01-01', term_start: '2026-02-01T00:01', term_end: '2026-02-09T23:59', premium_total: '84.00' };
const premium = { premium_id: 'r1', record_number: 'BR-1', type: 'bind', account_id: 'a1', policy_id: 'p1', status: 'ready', premium: '84.00', charge: '84.00', refund: '0.00', per_benefit: [{ code: 'x', premium: '80.00' }, { code: 'y', premium: '4.00' }], allocation: [], occurred_at: '2026-01-01T00:00:00Z' };
const trip = { policy_id: 'p1', account_id: 'a1', departure_date: '2026-02-01', return_date: '2026-02-09', destinations: [] };

describe('data load quality checks', () => {
  it('passes sound rows', () => {
    const r = checkRows(new Map([['policies', [policy]], ['premiums', [premium]], ['trips', [trip]]]), new Set());
    expect(r.rejects).toEqual([]);
    expect(r.checks.every((c) => c.passed)).toBe(true);
    expect(r.files.get('premiums')).toHaveLength(1);
  });

  it('moves a failing row to the rejects with the reason, and keeps the rest', () => {
    const r = checkRows(
      new Map([
        ['policies', [policy, { ...policy }, { ...policy, policy_id: 'p2', state: null }]],
        ['premiums', [premium, { ...premium, premium_id: 'r2', per_benefit: [{ code: 'x', premium: '80.00' }] }, { ...premium, premium_id: 'r3', policy_id: 'unknown' }]],
        ['trips', [{ ...trip, return_date: '2026-01-01' }]],
      ]),
      new Set(),
    );
    expect(r.rejects.map((x) => `${x.entity}:${x.key}`)).toEqual(['policies:p1', 'policies:p2', 'premiums:r2', 'premiums:r3', 'trips:p1']);
    expect(r.files.get('policies')).toHaveLength(1);
    expect(r.files.get('premiums')).toHaveLength(1);
    expect(r.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual(['required_fields', 'unique_keys', 'references', 'premium_lines', 'trip_dates']);
  });
});
