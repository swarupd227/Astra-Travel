import { describe, expect, it } from 'vitest';
import {
  CatalogueDocumentSchema,
  type CatalogueDocument,
  type VariableType,
} from '@astra/contracts';
import {
  effectiveLimits,
  problemsFor,
  UpgradeConflictError,
  validateCatalogue,
  type VariableTypes,
} from './catalogue';

/** Synthetic catalogue: names follow the specification's benefit list, variables and amounts are invented for the test. */
const maps: VariableTypes = {
  schedule: new Map<string, VariableType>([
    ['med_max', 'numeric_range'],
    ['med_dental', 'numeric_range'],
    ['med_upgrade_max', 'numeric_range'],
    ['evac_max', 'numeric_range'],
    ['evac_upgrade_max', 'numeric_range'],
    ['basis_med', 'limit_basis'],
    ['imbp_offered', 'optional_benefit'],
    ['pet_offered', 'optional_benefit'],
    ['ti_event_tarmac', 'numeric_range'],
    ['med_deductible', 'numeric_range'],
  ]),
  policy: new Map<string, VariableType>([['reasons_employment', 'optional_benefit']]),
};
const s = (key: string) => ({ source: 'schedule' as const, key });
const amt = (key: string) => ({
  variable: s(key),
  basis: { kind: 'fixed' as const, basis: 'per_person' as const },
});

const doc = (): CatalogueDocument =>
  CatalogueDocumentSchema.parse({
    benefits: [
      {
        code: 'medical',
        name: 'Accident and Sickness Medical Expense',
        group: 'medical_evacuation',
        maximum: { variable: s('med_max'), basis: { kind: 'variable', variable: s('basis_med') } },
        deductible: amt('med_deductible'),
        subLimits: [
          { code: 'dental', name: 'Dental', amount: amt('med_dental'), includedInParent: true },
        ],
      },
      {
        code: 'evacuation',
        name: 'Medical Evacuation and Repatriation of Remains',
        group: 'medical_evacuation',
        maximum: amt('evac_max'),
      },
      {
        code: 'travel_inconvenience',
        name: 'Travel Inconvenience',
        group: 'post_departure',
        maximum: amt('ti_event_tarmac'),
        eventAmounts: [
          { code: 'tarmac_delay', event: 'Tarmac delay', amount: s('ti_event_tarmac') },
        ],
      },
    ],
    coveredReasons: [
      {
        code: 'job_loss',
        text: 'Involuntary loss of employment (synthetic wording)',
        category: 'Employment and Service',
        appliesTo: ['trip_cancellation', 'trip_interruption'],
        coverageLevels: ['self', 'travelling_companion'],
        perilNumber: '27',
        upgrade: 'employment_reasons',
      },
    ],
    upgrades: [
      {
        code: 'imbp',
        name: 'Increased Medical Benefit Package',
        kind: 'limit_replacement',
        offeredBy: s('imbp_offered'),
        replacements: [
          {
            target: { kind: 'benefit', benefit: 'medical', field: 'maximum' },
            amount: amt('med_upgrade_max'),
          },
          {
            target: { kind: 'benefit', benefit: 'evacuation', field: 'maximum' },
            amount: amt('evac_upgrade_max'),
          },
        ],
      },
      {
        code: 'employment_reasons',
        name: 'Employment and Service reasons',
        kind: 'covered_reason_set',
        offeredBy: { source: 'policy', key: 'reasons_employment' },
      },
    ],
  });

describe('benefit catalogue checks', () => {
  it('accepts a consistent catalogue', () => {
    expect(validateCatalogue(doc(), maps)).toEqual([]);
  });

  it('checks every reference against the approved variable maps, by type', () => {
    const d = doc();
    d.benefits[0]!.maximum.variable = s('basis_med');
    d.benefits[0]!.subLimits[0]!.amount.variable = s('nope');
    d.upgrades[1]!.offeredBy = { source: 'policy', key: 'missing' };
    expect(validateCatalogue(d, maps).map((p) => p.path)).toEqual([
      'benefits.medical.maximum.variable',
      'benefits.medical.subLimits.dental.amount.variable',
      'upgrades.employment_reasons.offeredBy',
    ]);
    expect(validateCatalogue(d, maps)[0]!.message).toContain(
      'is a limit basis; an amount needs a numeric range',
    );
    expect(validateCatalogue(doc(), { ...maps, policy: null })[0]!.message).toContain(
      'no policy form',
    );
  });

  it('requires peril numbers for approval but not for saving an item', () => {
    const d = doc();
    d.coveredReasons[0]!.perilNumber = null;
    const problems = validateCatalogue(d, maps);
    expect(problems).toEqual([
      {
        path: 'coveredReasons.job_loss.perilNumber',
        message: 'The peril number from the rating manual is missing.',
      },
    ]);
    expect(problemsFor(problems, 'coveredReasons.job_loss')).toEqual([]);
  });

  it('checks replacements, duplicate codes and reason sets', () => {
    const d = doc();
    d.upgrades[0]!.replacements.push({
      target: { kind: 'sub_limit', benefit: 'medical', subLimit: 'therapy' },
      amount: amt('med_max'),
    });
    d.upgrades[0]!.replacements.push({
      target: { kind: 'benefit', benefit: 'evacuation', field: 'perDay' },
      amount: amt('med_max'),
    });
    d.benefits.push({ ...d.benefits[1]! });
    d.coveredReasons[0]!.upgrade = null;
    const paths = validateCatalogue(d, maps).map((p) => p.message);
    expect(paths).toEqual(
      expect.arrayContaining([
        'The code evacuation is used more than once.',
        'Accident and Sickness Medical Expense has no sub-limit therapy.',
        'Medical Evacuation and Repatriation of Remains has no per-day limit to replace.',
        'No covered reasons belong to this reason set yet.',
      ]),
    );
  });
});

describe('amounts against each other', () => {
  it('refuses an included sub-limit filed above its benefit maximum, but not one paid in addition', () => {
    const withRanges = {
      ...maps,
      maximums: new Map([
        ['schedule:med_max', 1_000],
        ['schedule:med_dental', 500_000],
      ]),
    };
    expect(validateCatalogue(doc(), withRanges)[0]).toEqual({
      path: 'benefits.medical.subLimits.dental.amount',
      message:
        "Dental is included in the maximum benefit but can be up to 500,000, more than the maximum's 1,000.",
    });
    const extra = doc();
    extra.benefits[0]!.subLimits[0]!.includedInParent = false;
    expect(validateCatalogue(extra, withRanges)).toEqual([]);
  });
});

describe('effective limits (E01-F02-S03)', () => {
  it('replaces the base medical and evacuation limits when the Increased Medical Benefit Package is bought', () => {
    const base = effectiveLimits(doc(), []);
    expect(base.get('medical')!.maximum.variable.key).toBe('med_max');
    const upgraded = effectiveLimits(doc(), ['imbp']);
    expect(upgraded.get('medical')!.maximum.variable.key).toBe('med_upgrade_max');
    expect(upgraded.get('evacuation')!.maximum.variable.key).toBe('evac_upgrade_max');
    expect(upgraded.get('medical')!.replacedBy).toEqual({
      maximum: 'Increased Medical Benefit Package',
    });
    // Untouched amounts stay as they were.
    expect(upgraded.get('medical')!.deductible!.variable.key).toBe('med_deductible');
    expect(upgraded.get('medical')!.subLimits.dental!.variable.key).toBe('med_dental');
  });

  it('refuses two upgrades replacing the same limit, and unknown upgrades', () => {
    const d = doc();
    d.upgrades.push({ ...d.upgrades[0]!, code: 'imbp2', name: 'Second package' });
    expect(() => effectiveLimits(d, ['imbp', 'imbp2'])).toThrow(UpgradeConflictError);
    expect(() => effectiveLimits(d, ['ghost'])).toThrow(/No upgrade ghost/);
  });
});
