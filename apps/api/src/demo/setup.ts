/**
 * The product configuration of the sample data: reference data, the filed forms, the benefit catalogue, the
 * Voyager plans and their state versions with rate manuals, filings, eligibility rules and document templates.
 * Every step is skipped where it was already done, so a run that stopped can be started again.
 */
import type { Actor, Client, Json } from './client';
import {
  AGE_FACTORS,
  BENEFITS,
  COUNTRIES,
  LENGTH_FACTORS,
  NOTICE,
  PROHIBITED,
  REGIONS,
  SALE_STATES,
  SANCTIONED,
  SEGMENTS,
  SYNTHETIC_SOURCE,
  US_STATES,
  type SampleBenefit,
} from './content';

const person = (role: Actor['role'], sub: string, name: string): Actor => ({
  role,
  sub: `sample-${sub}`,
  name: `${name} (sample)`,
});

export const PEOPLE = {
  product: person('product_manager', 'product', 'Priya Raman'),
  compliance: person('compliance_officer', 'compliance', 'Carmen Ortiz'),
  analyst: person('rating_analyst', 'analyst-1', 'Anil Mehta'),
  analyst2: person('rating_analyst', 'analyst-2', 'Joanna Frost'),
  uw1: person('underwriter', 'underwriter-1', 'Marcus Bell'),
  uw2: person('underwriter', 'underwriter-2', 'Ingrid Solberg'),
  accounts: person('account_manager', 'account-manager', 'Dana Whitaker'),
  service: person('service_rep', 'service', 'Luis Romero'),
  finance: person('finance_analyst', 'finance', 'Mei Lin Zhao'),
  card: person('card_programme_manager', 'card', 'Robert Okoye'),
};

export type Log = (message: string) => void;

export const PLAN_LINES = [
  { code: 'VOY-ESS', name: 'Voyager Essential', tier: 'essential' as const },
  { code: 'VOY-PREF', name: 'Voyager Preferred', tier: 'preferred' as const },
];
export const planCode = (line: string, state: string) => `${line}-${state}`;
export const benefitsOf = (tier: 'essential' | 'preferred') =>
  BENEFITS.filter((b) => b[tier]) as (SampleBenefit & { [k: string]: unknown })[];

const FROM = '2026-01-01';
export const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
export const today = () => new Date().toISOString().slice(0, 10);

const scheduleText = () =>
  [
    'SCHEDULE OF BENEFITS (synthetic sample schedule, not a filed form)',
    'Virginia Surety Company, Inc. travel protection plan. Sample wording for demonstration only.',
    ...BENEFITS.map((b) => `${b.name} maximum ${b.bracket} per person`),
    'The time-sensitive period is [ten (10) - twenty-one (21)] days.',
    'You may cancel within the [ten (10) - fifteen (15)] day review period.',
    `ELIGIBILITY NOTICE (synthetic): ${NOTICE}`,
  ].join('\n');

async function referenceData(c: Client, log: Log): Promise<void> {
  const held = (await c.call(PEOPLE.analyst, 'GET', '/v1/reference-data')).items as Json[];
  const load = async (dataset: string, entries: unknown[]) => {
    if (held.find((d) => d.code === dataset)?.inForce) return;
    const version = await c.call(PEOPLE.analyst, 'POST', `/v1/reference-data/${dataset}/versions`, {
      effectiveFrom: FROM,
      source: SYNTHETIC_SOURCE,
      entries,
    });
    await c.call(
      PEOPLE.compliance,
      'POST',
      `/v1/reference-data/${dataset}/versions/${version.id}/decision`,
      { decision: 'approve', reason: 'Sample data for the development environment.' },
    );
    log(`reference data ${dataset}: ${entries.length} entries`);
  };
  await load(
    'us_states',
    US_STATES.map(([code, name, kind]) => ({ code, name, kind })),
  );
  await load(
    'countries',
    COUNTRIES.map(([code, alpha3, numeric, name]) => ({ code, alpha3, numeric, name })),
  );
  await load('destination_regions', REGIONS);
  await load(
    'prohibited_destinations',
    PROHIBITED.map((country) => ({ country, reason: 'Comprehensive sanctions (sample entry).' })),
  );
  await load(
    'business_segments',
    SEGMENTS.map(([code, name]) => ({ code, name })),
  );
  await load(
    'premium_tax_rates',
    SALE_STATES.flatMap(([state], i) =>
      (['VSC', 'ABIC'] as const).map((insurer) => ({
        key: `${state}:${insurer}`,
        state,
        insurer,
        ratePercent: 1.5 + (i % 5) * 0.4,
        basis: 'Gross premium (invented sample rate)',
      })),
    ),
  );
  const names = new Map(US_STATES.map(([code, name]) => [code, name]));
  await load(
    'state_disclosures',
    SALE_STATES.map(([state]) => ({
      state,
      title: `${names.get(state)} travel insurance disclosure (synthetic sample)`,
      text: `This synthetic text stands in for the disclosure ${names.get(state)} requires before travel cover is bound. It is not a filed notice and must not be used to sell insurance.`,
    })),
  );
}

async function sanctions(c: Client, log: Log): Promise<void> {
  const lists = (await c.call(PEOPLE.compliance, 'GET', '/v1/sanctions-lists')).items as Json[];
  if (lists.some((l) => l.status === 'approved')) return;
  const list = await c.call(PEOPLE.compliance, 'POST', '/v1/sanctions-lists', {
    source: 'SYNTHETIC sample list (invented names)',
    sdnCsv: SANCTIONED.sdn,
  });
  await c.call(PEOPLE.uw1, 'POST', `/v1/sanctions-lists/${list.id}/decision`, {
    decision: 'approve',
    reason: 'Sample list for the development environment.',
  });
  log('sanctions list: approved');
}

/** The filed schedule, its variable map and the benefit catalogue; returns the form edition and catalogue. */
async function forms(c: Client, log: Log): Promise<{ edition: string; catalogue: string }> {
  const base = (await c.call(PEOPLE.product, 'GET', '/v1/plans')).items as Json[];
  const existing = base.find((p) => p.code === PLAN_LINES[0]!.code);
  if (existing) {
    const plan = await c.call(PEOPLE.product, 'GET', `/v1/plans/${existing.id}`);
    const version = (plan.versions ?? [])[0];
    return {
      edition: existing.scheduleEditionId,
      catalogue: version?.catalogueId ?? plan.catalogueId,
    };
  }
  const created = await c.call(
    PEOPLE.compliance,
    'POST',
    '/v1/form-editions?formNumber=voy_sch_sample&edition=2026-04&title=Voyager%20schedule%20of%20benefits%20(synthetic%20sample)&kind=schedule&insurer=VSC&fileName=voyager-schedule-sample.txt',
    Buffer.from(scheduleText()),
    { contentType: 'text/plain' },
  );
  const edition = created.id as string;
  const map = (await c.call(PEOPLE.product, 'POST', `/v1/form-editions/${edition}/maps`)).id;
  const spans = (await c.call(PEOPLE.product, 'GET', `/v1/form-editions/${edition}/brackets`))
    .items as Json[];
  const keys = new Map<string, string>([
    ...BENEFITS.map((b): [string, string] => [b.bracket, b.key]),
    ['[ten (10) - twenty-one (21)]', 'ts_period'],
    ['[ten (10) - fifteen (15)]', 'review'],
  ]);
  for (const span of spans) {
    const key = keys.get(span.text);
    if (!key) continue;
    const name = BENEFITS.find((b) => b.key === key)?.name;
    await c.call(PEOPLE.product, 'PUT', `/v1/variable-maps/${map}/variables/${key}`, {
      key,
      label: name
        ? `${name} maximum`
        : key === 'review'
          ? 'Review period'
          : 'Time-sensitive period',
      type: span.suggestion.type,
      constraints: span.suggestion.constraints,
      textStart: span.start,
      textEnd: span.end,
      excerpt: span.text,
    });
  }
  await c.call(PEOPLE.compliance, 'POST', `/v1/variable-maps/${map}/approve`, {
    note: 'Checked against the sample schedule.',
  });
  const catalogue = (
    await c.call(PEOPLE.product, 'POST', `/v1/form-editions/${edition}/catalogues`, {})
  ).id as string;
  for (const b of BENEFITS) {
    await c.call(PEOPLE.product, 'PUT', `/v1/benefit-catalogues/${catalogue}/benefits/${b.code}`, {
      code: b.code,
      name: b.name,
      group: b.group,
      maximum: {
        variable: { source: 'schedule', key: b.key },
        basis: { kind: 'fixed', basis: b.basis },
      },
    });
  }
  const reasons: [string, string, string][] = [
    ['sickness', 'Sickness of the traveller (synthetic wording)', 'Medical and Health'],
    ['injury', 'Accidental injury of the traveller (synthetic wording)', 'Medical and Health'],
    ['severe_weather', 'Severe weather stops the trip (synthetic wording)', 'Travel disruption'],
  ];
  for (const [i, [code, text, category]] of reasons.entries()) {
    await c.call(
      PEOPLE.product,
      'PUT',
      `/v1/benefit-catalogues/${catalogue}/covered-reasons/${code}`,
      {
        code,
        text,
        category,
        appliesTo: ['trip_cancellation', 'trip_interruption'],
        coverageLevels: ['self'],
        perilNumber: String(i + 1),
      },
    );
  }
  await c.call(PEOPLE.compliance, 'POST', `/v1/benefit-catalogues/${catalogue}/approve`, {
    note: 'Matches the sample schedule.',
  });
  await file(c, { itemType: 'form_edition', itemId: edition });
  log('form, variable map and benefit catalogue: approved');
  return { edition, catalogue };
}

async function file(c: Client, item: Record<string, unknown>, states?: string[]): Promise<void> {
  const filed = (
    await c.call(PEOPLE.compliance, 'POST', '/v1/filings', {
      states: states ?? SALE_STATES.map(([s]) => s),
      insurer: 'VSC',
      ...item,
    })
  ).items as Json[];
  for (const f of filed) {
    await c.call(PEOPLE.compliance, 'POST', `/v1/filings/${f.id}/status`, {
      status: 'submitted',
      on: '2025-10-01',
      reason: 'Sample filing record.',
    });
    await c.call(PEOPLE.compliance, 'POST', `/v1/filings/${f.id}/status`, {
      status: 'approved',
      on: '2025-12-01',
      effectiveFrom: FROM,
      reason: 'Sample approval record.',
    });
  }
}

const table = (id: string, name: string, input: string, rows: [number, number][]) => ({
  id,
  name,
  page: `SYNTH-${id}`,
  keys: [{ input, match: 'band' }],
  rows: rows.map(([bound, factor]) => ({ keys: [bound], factor: factor.toFixed(4) })),
  unused: '1.0000',
  unknown: '1.0000',
});

const baseCost = (benefit: SampleBenefit, factor: number) =>
  (benefit.rating!.base * factor).toFixed(4);
/** The premium of the check case: age 45, a $4,000 trip of ten days, where every factor is 1. */
const caseAmount = (benefit: SampleBenefit, factor: number) =>
  (Number(baseCost(benefit, factor)) * 40).toFixed(2);

async function manuals(c: Client, log: Log): Promise<void> {
  const held = (await c.call(PEOPLE.analyst, 'GET', '/v1/rate-manuals')).items as Json[];
  for (const [state, factor] of SALE_STATES) {
    for (const benefit of BENEFITS.filter((b) => b.rating)) {
      const code = `VOY-${benefit.rating!.code}-${state}-SMP`;
      if (held.some((m) => m.code === code && m.status === 'published')) continue;
      const manual = await c.call(PEOPLE.analyst, 'POST', '/v1/rate-manuals', {
        code,
        state,
        benefit: benefit.rating!.code,
        effectiveFrom: FROM,
        source: SYNTHETIC_SOURCE,
        document: {
          baseLossCost: baseCost(benefit, factor),
          exposure: { kind: 'per_100_trip_cost', table: 'exposure' },
          variables: [
            { label: 'Age', tables: ['age'] },
            { label: 'Trip length', tables: ['length'] },
          ],
          tables: [
            table('exposure', 'Trip cost per $100', 'tripCost', [[0, 1]]),
            table('age', 'Age', 'age', AGE_FACTORS),
            table('length', 'Trip length', 'tripLength', LENGTH_FACTORS),
          ],
          conversion: { lossCostMultiplier: '1.0000', minimumPremium: '5.00', roundTo: 2 },
        },
      });
      await c.call(PEOPLE.analyst2, 'POST', `/v1/rate-manuals/${manual.id}/approve`, {
        note: 'Tables checked against the sample pages.',
      });
      await c.call(
        PEOPLE.analyst,
        'POST',
        `/v1/rate-manuals/${manual.id}/parity-cases?source=Sample%20check%20cases&rateDate=2026-11-01`,
        [
          'name,expected_amount,age,cost_per_traveller,purchase_date,departure_date,return_date,package_type',
          `Sample case,${caseAmount(benefit, factor)},45,4000,2026-11-01,2026-12-01,2026-12-10,packaged`,
        ].join('\n'),
        { contentType: 'text/csv' },
      );
      const run = await c.call(PEOPLE.analyst, 'POST', `/v1/rate-manuals/${manual.id}/parity-runs`);
      if (run.passed !== run.total) {
        throw new Error(`Parity failed for ${code}: ${JSON.stringify(run).slice(0, 600)}`);
      }
      await file(c, { itemType: 'rate_manual', itemReference: code }, [state]);
      await c.call(PEOPLE.analyst2, 'POST', `/v1/rate-manuals/${manual.id}/publish`);
      log(`rate manual ${code}: published`);
    }
  }
}

function planDocument(tier: 'essential' | 'preferred') {
  const benefits = benefitsOf(tier);
  const setting = (name: string, key: string, value: number) => ({
    setting: name,
    variable: { source: 'schedule', key },
    value,
  });
  return {
    benefits: benefits.map((b) => ({
      code: b.code,
      packaging: b[tier]!.packaging,
      ratingBenefit: b.rating?.code ?? null,
      underwriter: b.underwriter,
    })),
    coveredReasons: ['sickness', 'injury', 'severe_weather'].map((code) => ({
      code,
      levels: ['self'],
    })),
    values: {
      ...Object.fromEntries(benefits.map((b) => [`schedule:${b.key}`, b[tier]!.value])),
    },
    settings: [
      setting('time_sensitive_period', 'ts_period', tier === 'preferred' ? 21 : 14),
      setting('review_period', 'review', tier === 'preferred' ? 15 : 10),
    ],
    timing: {
      pre_departure: {
        start: { kind: 'day_after_premium_received' },
        end: { kind: 'return_date' },
      },
      post_departure: { start: { kind: 'departure' }, end: { kind: 'return_date' } },
    },
    servicing: { postReviewRefund: 'pro_rata', additionalCostDays: 120, addBenefitDays: 30 },
  };
}

export interface StatePlan {
  id: string;
  versionId: string;
  code: string;
  state: string;
  tier: 'essential' | 'preferred';
}

async function plans(
  c: Client,
  log: Log,
  ids: { edition: string; catalogue: string },
): Promise<StatePlan[]> {
  const out: StatePlan[] = [];
  const list = async () => (await c.call(PEOPLE.product, 'GET', '/v1/plans')).items as Json[];
  for (const line of PLAN_LINES) {
    let base = (await list()).find((p) => p.code === line.code);
    if (!base) {
      const created = await c.call(PEOPLE.product, 'POST', '/v1/plans', {
        kind: 'base',
        code: line.code,
        name: line.name,
        term: 'single_trip',
        catalogueId: ids.catalogue,
        effectiveFrom: FROM,
      });
      await c.call(PEOPLE.product, 'PUT', `/v1/plan-versions/${created.draft.id}`, {
        document: planDocument(line.tier),
      });
      await c.call(PEOPLE.compliance, 'POST', `/v1/plan-versions/${created.draft.id}/approve`, {
        note: 'Sample base plan checked.',
      });
      base = created.plan;
      log(`plan ${line.code}: approved`);
    }
    for (const [state, factor] of SALE_STATES) {
      const code = planCode(line.code, state);
      const found = (await list()).find((p) => p.code === code);
      if (found?.current?.status === 'published') {
        out.push({ id: found.id, versionId: found.current.id, code, state, tier: line.tier });
        continue;
      }
      const created = await c.call(PEOPLE.product, 'POST', '/v1/plans', {
        kind: 'state',
        code,
        name: `${line.name}, ${state}`,
        parentPlanId: base!.id,
        state,
        effectiveFrom: FROM,
      });
      const planId = created.plan.id as string;
      const versionId = created.draft.id as string;
      await c.call(PEOPLE.compliance, 'POST', `/v1/plan-versions/${versionId}/approve`, {
        note: 'Sample state plan checked.',
      });
      const rated = benefitsOf(line.tier).filter((b) => b.rating);
      const perBenefit = Object.fromEntries(
        rated.map((b) => [b.rating!.code, caseAmount(b, factor)]),
      );
      await c.call(PEOPLE.product, 'POST', `/v1/plans/${planId}/test-cases`, {
        name: 'One traveller, $4,000 trip',
        input: {
          rateDate: '2026-11-01',
          travellers: [{ id: 'A', age: 45, costPerTraveller: '4000' }],
          trip: {
            purchaseDate: '2026-11-01',
            departureDate: '2026-12-01',
            returnDate: '2026-12-10',
            destinations: [],
          },
          account: { notCollected: [] },
        },
        expected: {
          perBenefit,
          policyTotal: Object.values(perBenefit)
            .reduce((a, x) => a + Number(x), 0)
            .toFixed(2),
        },
      });
      await c.call(PEOPLE.product, 'POST', `/v1/plan-versions/${versionId}/test-runs`);
      await c.call(PEOPLE.compliance, 'POST', `/v1/plan-versions/${versionId}/publish`);
      out.push({ id: planId, versionId, code, state, tier: line.tier });
      log(`plan ${code}: published`);
    }
  }
  return out;
}

async function ruleSets(c: Client, log: Log, statePlans: StatePlan[]): Promise<void> {
  for (const plan of statePlans) {
    const held = (await c.call(PEOPLE.uw1, 'GET', `/v1/plans/${plan.id}/rule-sets`))
      .items as Json[];
    if (held.some((r) => r.status === 'published')) continue;
    const ruleSet = await c.call(PEOPLE.uw1, 'POST', `/v1/plans/${plan.id}/rule-sets`, {
      effectiveFrom: FROM,
    });
    await c.call(PEOPLE.uw1, 'PUT', `/v1/rule-sets/${ruleSet.id}`, {
      document: {
        limits: [
          { code: 'max_age', kind: 'max_age', value: 85 },
          { code: 'max_trip_length', kind: 'max_trip_days', value: 180 },
        ],
        referralRules: [
          {
            code: 'high_cost',
            name: 'High trip cost',
            when: { field: 'cost_per_traveller', op: 'gt', value: 12000 },
            action: 'refer',
            reason: 'Trip cost per traveller is above the amount accepted without review.',
          },
        ],
        timeBasedBenefits: [],
        duplicates: { enabled: true, allowSingleAndAnnual: false },
      },
    });
    const start = today();
    const input = (age: number, cost: string) => ({
      stage: 'quote',
      travellers: [
        {
          id: 'A',
          firstName: 'Rule',
          lastName: 'Check',
          dateOfBirth: `${Number(start.slice(0, 4)) - age}-01-02`,
          age,
          costPerTraveller: cost,
        },
      ],
      trip: {
        purchaseDate: start,
        initialDepositDate: addDays(start, -5),
        departureDate: addDays(start, 30),
        returnDate: addDays(start, 39),
        destinations: [{ country: 'FR', region: 'Europe' }],
      },
      insuredPercent: 100,
      ableToTravel: true,
    });
    for (const testCase of [
      { name: 'Typical adult', input: input(45, '4200'), expected: { outcome: 'eligible' } },
      { name: 'Over the age limit', input: input(90, '4200'), expected: { outcome: 'ineligible' } },
      {
        name: 'High trip cost',
        input: input(45, '15000'),
        expected: { outcome: 'referred', referralRules: ['high_cost'] },
      },
    ]) {
      await c.call(PEOPLE.uw1, 'POST', `/v1/plans/${plan.id}/rule-test-cases`, testCase);
    }
    await c.call(PEOPLE.uw2, 'POST', `/v1/rule-sets/${ruleSet.id}/approve`, {
      note: 'Limits and referral rule checked.',
    });
    await c.call(PEOPLE.uw1, 'POST', `/v1/rule-sets/${ruleSet.id}/test-runs`);
    await c.call(PEOPLE.uw2, 'POST', `/v1/rule-sets/${ruleSet.id}/publish`);
    log(`rules for ${plan.code}: published`);
  }
}

async function templates(c: Client, log: Log, statePlans: StatePlan[]): Promise<void> {
  const held = (await c.call(PEOPLE.product, 'GET', '/v1/document-templates')).items as Json[];
  for (const plan of statePlans) {
    if (held.some((t) => t.planVersionId === plan.versionId && t.status === 'released')) continue;
    const template = await c.call(PEOPLE.product, 'POST', '/v1/document-templates', {
      planVersionId: plan.versionId,
      kind: 'schedule',
    });
    if (template.problems?.length) {
      throw new Error(`Schedule for ${plan.code}: ${JSON.stringify(template.problems)}`);
    }
    await c.call(PEOPLE.compliance, 'POST', `/v1/document-templates/${template.id}/release`, {
      note: 'Checked against the sample schedule.',
    });
    log(`document template for ${plan.code}: released`);
  }
}

export async function configureProduct(c: Client, log: Log): Promise<StatePlan[]> {
  await referenceData(c, log);
  await sanctions(c, log);
  const ids = await forms(c, log);
  await manuals(c, log);
  const statePlans = await plans(c, log, ids);
  await ruleSets(c, log, statePlans);
  await templates(c, log, statePlans);
  return statePlans;
}
