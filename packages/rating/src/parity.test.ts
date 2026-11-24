import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { ManualDocumentSchema } from '@astra/contracts';
import { parseParityCsv, runCase } from './parity';
import { SPEC_QUOTED_DE_TCAN } from './fixtures';

/** Cases built from the specification's illustrative lookup; the expected amounts are recomputed here by hand. */
const manual = {
  id: '00000000-0000-4000-8000-000000000001',
  code: 'RETR-SP-VU-DE-0426',
  version: 1,
  benefit: 'TCAN',
  state: 'DE',
  illustrative: false,
  document: ManualDocumentSchema.parse({ ...SPEC_QUOTED_DE_TCAN, perilPackage: null }),
};
const expected = new Decimal('1.475')
  .mul(42)
  .mul(
    ['0.72', '1.288', '0.768', '1', '1.6286', '1.3333', '1.28'].reduce(
      (a, f) => a.mul(f),
      new Decimal(1),
    ),
  )
  .toFixed(2, Decimal.ROUND_HALF_UP);

const header =
  'name,expected_amount,age,pre_existing_waived,cost_per_traveller,purchase_date,departure_date,return_date,destination_region,business_segment,package_type,penalty_days,factor:table.2.1.4,factor:table.2.1.8';
const row = (name: string, amount: string, waived: string, f4: string) =>
  `${name},${amount},45,${waived},4200,2026-11-21,2026-12-11,2026-12-20,Europe,OTA - Cruise,optional,60,${f4},0.7680`;

describe('workbook parity (E02-F07-S02)', () => {
  const csv = [
    header,
    row('Spec illustrative', expected, 'true', '0.7200'),
    row('Waiver column wrong', expected, 'false', '0.7200'),
    'Missing destination,1.00,45,true,4200,2026-11-21,2026-12-11,2026-12-20,,OTA - Cruise,optional,60,,',
  ].join('\n');
  const { cases, problems } = parseParityCsv(csv, {
    state: 'DE',
    benefit: 'TCAN',
    rateDate: '2026-11-01',
  });

  it('imports cases from a spreadsheet export', () => {
    expect(problems).toEqual([]);
    expect(cases).toHaveLength(3);
    expect(cases[0]!.expectedFactors).toEqual({ 'table.2.1.4': '0.7200', 'table.2.1.8': '0.7680' });
  });

  it('matches to the cent and by factor, and shows where results diverge', () => {
    const [ok, wrong, error] = cases.map((c) => runCase(manual, c));
    expect(ok).toMatchObject({ passed: true, actualAmount: expected, factorDifferences: [] });
    expect(wrong!.passed).toBe(false);
    expect(wrong!.factorDifferences).toEqual([
      { step: 'table.2.1.4', expected: '0.7200', actual: '0.6' },
    ]);
    expect(error).toMatchObject({
      passed: false,
      actualAmount: null,
      error: expect.stringContaining('Destination region is not given'),
    });
  });

  it('reports rows it cannot read', () => {
    const bad = parseParityCsv(`${header},extra\n${row('x', 'abc', 'true', '')},1`, {
      state: 'DE',
      benefit: 'TCAN',
      rateDate: '2026-11-01',
    });
    expect(bad.problems.map((p) => p.message)).toEqual([
      'Unknown columns: extra',
      'expected_amount must be a number.',
    ]);
  });
});
