import type { PolicyEvent, PolicySnapshot } from '@astra/contracts';
import { paragraphs, type Block, type DocModel } from './model';

/**
 * Builders for the documents the platform writes itself from the policy record (E09-F01-S02, E09-F01-S03):
 * the declarations that head the schedule and policy, the purchase confirmation, notices of change and
 * cancellation, and the Guide to Benefits. The filed wording of the schedule and policy comes from assembly,
 * not from here. Design: docs/adr/0011.
 */

export const BUILDER_VERSION = '2026-11-25.1';

const when = (s: string) => s.replace('T', ' ');
const money = (s: string) =>
  `$${Number(s).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const limit = (l: { maximum: number | null; basis: string | null }) =>
  l.maximum === null
    ? 'As stated in the policy'
    : `$${l.maximum.toLocaleString('en-US')}${l.basis ? ` ${l.basis}` : ''}`;
const names = (s: PolicySnapshot) =>
  s.travellers.map((t) => `${t.firstName} ${t.lastName}`).join(', ');
const destinations = (trip: Record<string, unknown>): string => {
  const d = (trip.destinations ?? []) as { country?: string; region?: string }[];
  return (
    d
      .map((x) => [x.region, x.country].filter(Boolean).join(' / '))
      .filter(Boolean)
      .join('; ') || 'Not stated'
  );
};

export const ARRANGEMENT_NAMES = {
  VSC: 'Virginia Surety Company, Inc.',
  ABIC: 'American Bankers Insurance Company of Florida',
  VSC_CLIP: 'Virginia Surety Company, Inc. (contractual liability insurance policy)',
} as const;

/** The block that heads the schedule and the policy: who and what is covered, for how long. */
export function declarations(s: PolicySnapshot): Block {
  return {
    kind: 'pairs',
    rows: [
      ['Policy number', s.number],
      ['Plan', `${s.plan.name} (${s.plan.code})`],
      ['Insured travellers', names(s)],
      ['Policy term', `${when(s.term.start)} to ${when(s.term.end)}`],
      ['Purchased on', s.purchasedOn],
      ['Premium', money(s.premium.total)],
    ],
  };
}

/** A filed form assembled for a policy: the declarations, then the filed wording. */
export function filedFormDocument(
  title: string,
  s: PolicySnapshot,
  formRef: string,
  assembled: string,
): DocModel {
  return {
    title,
    subtitle: `${s.number} · ${formRef}`,
    blocks: [
      declarations(s),
      { kind: 'heading', text: 'The wording of the form' },
      ...paragraphs(assembled),
    ],
  };
}

export function purchaseConfirmation(s: PolicySnapshot): DocModel {
  const trip = s.trip as {
    departureDate?: string;
    returnDate?: string;
    supplier?: string;
    initialDepositDate?: string;
    finalPaymentDate?: string;
  };
  const blocks: Block[] = [
    {
      kind: 'pairs',
      rows: [
        ['Policy number', s.number],
        ['Purchaser', `${s.purchaser.name}${s.purchaser.email ? ` (${s.purchaser.email})` : ''}`],
        ['Purchased on', s.purchasedOn],
        ['Payment reference', s.payment.reference],
        ['Plan', `${s.plan.name} (${s.plan.code}), version ${s.plan.version}`],
      ],
    },
    { kind: 'heading', text: 'Travellers and trip cost' },
    {
      kind: 'table',
      head: ['Traveller', 'Trip cost insured'],
      rows: s.travellers.map((t) => [`${t.firstName} ${t.lastName}`, money(t.costPerTraveller)]),
    },
    {
      kind: 'pairs',
      rows: (
        [
          ['Departure', trip.departureDate ?? ''],
          ['Return', trip.returnDate ?? ''],
          ['Destinations', destinations(s.trip)],
          ...(trip.supplier ? ([['Supplier', trip.supplier]] as [string, string][]) : []),
          ...(trip.initialDepositDate
            ? ([['Initial deposit', trip.initialDepositDate]] as [string, string][])
            : []),
          ...(trip.finalPaymentDate
            ? ([['Final payment', trip.finalPaymentDate]] as [string, string][])
            : []),
        ] as [string, string][]
      ).filter(([, v]) => v),
    },
    { kind: 'heading', text: 'Benefits, limits and premium' },
    {
      kind: 'table',
      head: ['Benefit', 'Limit', 'Cover starts', 'Cover ends', 'Insurer', 'Premium'],
      rows: s.benefits.map((b) => [
        b.name,
        limit(b.limits),
        when(b.coverageStart),
        when(b.coverageEnd),
        b.underwriter ? ARRANGEMENT_NAMES[b.underwriter] : 'To be confirmed',
        b.premium ? money(b.premium) : 'Included',
      ]),
    },
    {
      kind: 'pairs',
      rows: [
        ['Total premium', money(s.premium.total)],
        ...(s.reviewPeriodEndsAt
          ? ([['Review period ends', when(s.reviewPeriodEndsAt)]] as [string, string][])
          : []),
      ],
    },
    { kind: 'heading', text: 'Disclosure' },
    {
      kind: 'paragraph',
      text: `${s.disclosure.title} was acknowledged by ${s.disclosure.acknowledgedBy} on ${s.disclosure.acknowledgedAt.slice(0, 10)} (version ${s.disclosure.version}).`,
    },
  ];
  return { title: 'Purchase Confirmation', subtitle: `${s.number} · ${names(s)}`, blocks };
}

// ---------------- Change and cancellation (E09-F01-S03) ----------------

export interface Change {
  path: string;
  before: string;
  after: string;
}

const show = (v: unknown): string =>
  v === undefined || v === null ? 'not set' : typeof v === 'object' ? JSON.stringify(v) : String(v);

/** What differs between two records of a policy, as plain statements; benefits are matched by code, travellers by id. */
export function diffRecords(before: PolicySnapshot, after: PolicySnapshot): Change[] {
  const out: Change[] = [];
  const walk = (path: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (
      a &&
      b &&
      typeof a === 'object' &&
      typeof b === 'object' &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    ) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
        walk(
          path ? `${path}.${k}` : k,
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        );
      return;
    }
    out.push({ path, before: show(a), after: show(b) });
  };
  const keyed = <T extends { [k: string]: unknown }>(xs: T[], key: string) =>
    Object.fromEntries(xs.map((x) => [String(x[key]), x]));
  const { benefits: ba, travellers: ta, ...restA } = before;
  const { benefits: bb, travellers: tb, ...restB } = after;
  walk('', restA, restB);
  walk('benefits', keyed(ba, 'code'), keyed(bb, 'code'));
  walk('travellers', keyed(ta, 'id'), keyed(tb, 'id'));
  return out.filter((c) => !['purchasedOn'].includes(c.path));
}

const LABELS: Record<string, string> = {
  'trip.departureDate': 'Departure date',
  'trip.returnDate': 'Return date',
  'trip.supplier': 'Supplier',
  'premium.total': 'Total premium',
  'term.start': 'Cover starts',
  'term.end': 'Cover ends',
  reviewPeriodEndsAt: 'Review period ends',
};
const labelFor = (path: string) =>
  LABELS[path] ??
  path
    .replace(
      /^benefits\.([^.]+)\.(.*)$/,
      (_m, code: string, rest: string) => `${code.replace(/_/g, ' ')}: ${rest}`,
    )
    .replace(
      /^travellers\.([^.]+)\.(.*)$/,
      (_m, id: string, rest: string) => `Traveller ${id}: ${rest}`,
    )
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\./g, ' › ');

export function changeNotice(
  before: PolicySnapshot,
  after: PolicySnapshot,
  event: Pick<PolicyEvent, 'occurredAt' | 'actorName' | 'actor' | 'reason'>,
): DocModel {
  const changes = diffRecords(before, after);
  const blocks: Block[] = [
    {
      kind: 'pairs',
      rows: [
        ['Policy number', after.number],
        ['Insured travellers', names(after)],
        ['Changed on', event.occurredAt.slice(0, 10)],
        ...(event.reason ? ([['Reason', event.reason]] as [string, string][]) : []),
      ],
    },
    { kind: 'heading', text: 'What changed' },
    changes.length
      ? {
          kind: 'table',
          head: ['What', 'Before', 'Now'],
          rows: changes.map((c) => [labelFor(c.path), c.before, c.after]),
        }
      : { kind: 'paragraph', text: 'Nothing on the policy record changed.' },
    {
      kind: 'paragraph',
      text: 'Everything else in your policy and schedule stays as it was. Keep this notice with your policy documents.',
    },
  ];
  return { title: 'Notice of Change', subtitle: `${after.number} · ${names(after)}`, blocks };
}

export function cancellationNotice(
  s: PolicySnapshot,
  event: Pick<PolicyEvent, 'occurredAt' | 'reason'>,
  to: 'cancelled' | 'expired',
): DocModel {
  return {
    title: to === 'cancelled' ? 'Notice of Cancellation' : 'Notice of Expiry',
    subtitle: `${s.number} · ${names(s)}`,
    blocks: [
      {
        kind: 'pairs',
        rows: [
          ['Policy number', s.number],
          ['Insured travellers', names(s)],
          [to === 'cancelled' ? 'Cancelled on' : 'Expired on', event.occurredAt.slice(0, 10)],
          ...(event.reason ? ([['Reason', event.reason]] as [string, string][]) : []),
          ['Premium paid', money(s.premium.total)],
        ],
      },
      {
        kind: 'paragraph',
        text:
          to === 'cancelled'
            ? 'Cover under this policy has ended. Any refund due is calculated under the policy’s terms and paid by the billing system; it is not stated on this notice.'
            : 'Cover under this policy has ended because its term is over.',
      },
    ],
  };
}

// ---------------- Guide to Benefits (E21-F05-S01) ----------------

export interface GuideInput {
  programme: { code: string; name: string; cardProduct: string; states: string[] };
  masterPolicy: {
    policyNumber: string;
    underwriter: 'VSC' | 'ABIC';
    effectiveFrom: string;
    effectiveTo: string | null;
  };
  plan: { code: string; name: string; version: number };
  benefits: {
    name: string;
    limit: { maximum: number | null; basis: string | null };
    underwriter: string | null;
  }[];
  version: number;
}

export function guideToBenefits(g: GuideInput): DocModel {
  return {
    title: 'Guide to Benefits',
    subtitle: `${g.programme.name} · ${g.programme.cardProduct} · version ${g.version}`,
    blocks: [
      {
        kind: 'pairs',
        rows: [
          ['Programme', `${g.programme.name} (${g.programme.code})`],
          ['Master policy', g.masterPolicy.policyNumber],
          ['Insurer', ARRANGEMENT_NAMES[g.masterPolicy.underwriter]],
          ['Available in', g.programme.states.join(', ')],
          [
            'In force from',
            `${g.masterPolicy.effectiveFrom}${g.masterPolicy.effectiveTo ? ` to ${g.masterPolicy.effectiveTo}` : ''}`,
          ],
          ['Benefits taken from', `${g.plan.name} (${g.plan.code}), version ${g.plan.version}`],
        ],
      },
      { kind: 'heading', text: 'What your card includes' },
      {
        kind: 'table',
        head: ['Benefit', 'Limit', 'Insurer'],
        rows: g.benefits.map((b) => [b.name, limit(b.limit), b.underwriter ?? 'To be confirmed']),
      },
      {
        kind: 'paragraph',
        text: 'This guide summarises your benefits. The master policy governs; read its terms and exclusions.',
      },
    ],
  };
}
