import type { Tone } from '@/components/ui/primitives';

export const ACCOUNT_KIND_LABELS = {
  travel_account: 'Travel seller',
  card_issuer: 'Card issuer',
  bank: 'Bank',
} as const;

export const ACCOUNT_STATUS_TONES: Record<string, Tone> = {
  onboarding: 'primary',
  active: 'success',
  suspended: 'warning',
  closed: 'neutral',
};

export const WEBHOOK_STATUS_TONES: Record<string, Tone> = {
  active: 'success',
  paused: 'warning',
  disabled: 'neutral',
};

export const DELIVERY_STATUS_TONES: Record<string, Tone> = {
  pending: 'primary',
  delivered: 'success',
  dead: 'danger',
};

export const PROGRAMME_STATUS_TONES: Record<string, Tone> = {
  draft: 'primary',
  live: 'success',
  suspended: 'warning',
  closed: 'neutral',
};

export const FEED_STATUS_TONES: Record<string, Tone> = {
  received: 'primary',
  waiting: 'warning',
  applied: 'success',
  passed: 'success',
  held: 'danger',
  failed: 'danger',
  rejected: 'neutral',
};

export const FEED_STATUS_HELP: Record<string, string> = {
  received: 'Queued for processing.',
  waiting: 'Valid, waiting for the previous sequence to be applied.',
  applied: 'Applied to the eligibility ledger.',
  passed: 'Test feed passed; nothing was applied.',
  held: 'Held: nothing was applied and the previous eligibility stays in force.',
  failed: 'Test feed failed its checks.',
  rejected: 'Rejected; its sequence can be sent again.',
};

export const FILING_STATUS_TONES: Record<string, Tone> = {
  draft: 'neutral',
  submitted: 'primary',
  approved: 'success',
  disapproved: 'danger',
  withdrawn: 'warning',
};

export const FILING_ITEM_LABELS: Record<string, string> = {
  form_edition: 'Form edition',
  rate_manual: 'Rate manual',
  rule_set: 'Rule set',
};

/** Approved and in effect on the date (a withdrawn approval still covers the dates before withdrawal). */
export function filingInForce(
  f: { status: string; effectiveFrom: string | null; effectiveTo: string | null },
  date: string,
): boolean {
  return (
    (f.status === 'approved' || f.status === 'withdrawn') &&
    !!f.effectiveFrom &&
    f.effectiveFrom <= date &&
    (!f.effectiveTo || f.effectiveTo > date)
  );
}

export const ELIGIBILITY_RULE_LABELS: Record<string, string> = {
  purchase_date: 'Eligible on the trip purchase date',
  purchase_and_loss_date: 'Eligible on both the purchase date and the loss date',
};

export function paymentConditionLabel(
  rule: { rule: 'none' } | { rule: 'full' } | { rule: 'partial'; minimumPercent: number },
): string {
  if (rule.rule === 'none') return 'No payment condition';
  if (rule.rule === 'full') return 'Full trip cost paid with the card';
  return `At least ${rule.minimumPercent}% of the trip cost paid with the card`;
}

export const integer = (n: number) => new Intl.NumberFormat('en-US').format(n);

/** "2 h 10 min left" or "Overdue by 1 h 30 min", from the minutes left on a work queue timer. */
export function timeLeft(minutes: number): string {
  const m = Math.abs(minutes);
  const days = Math.floor(m / 1440);
  const hours = Math.floor((m % 1440) / 60);
  const mins = m % 60;
  const span =
    days > 0 ? `${days} d ${hours} h` : hours > 0 ? `${hours} h ${mins} min` : `${mins} min`;
  return minutes < 0 ? `Overdue by ${span}` : `${span} left`;
}

// Policy dates carry no time zone: they are read and shown as written.
const asWritten = (value: string) => new Date(`${value.length === 10 ? `${value}T00:00` : value}Z`);
const day = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const clock = new Intl.DateTimeFormat('en-US', { timeStyle: 'short', timeZone: 'UTC' });

/** "Nov 28, 2026". */
export const formatDay = (value: string | null | undefined) =>
  value ? day.format(asWritten(value)) : '—';

/** "Nov 28 – Dec 29, 2026". */
export const dayRange = (from: string | null | undefined, to: string | null | undefined) =>
  from && to
    ? day.formatRange(asWritten(from), asWritten(to))
    : `${formatDay(from)} – ${formatDay(to)}`;

/** "Nov 28, 2026, 12:01 AM". */
export const formatDayTime = (value: string) =>
  `${day.format(asWritten(value))}, ${clock.format(asWritten(value))}`;

const regions = new Intl.DisplayNames(['en-US'], { type: 'region' });

/** "France" for "FR"; anything that is not a country code is shown as given. */
export const countryName = (code: string) =>
  /^[A-Z]{2}$/.test(code) ? (regions.of(code) ?? code) : code;

export const money = (value: string | number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(value));

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function sentenceCase(value: string): string {
  const s = value.replace(/[._]/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function readParams(
  searchParams: SearchParams,
): Promise<Record<string, string | undefined>> {
  const raw = await searchParams;
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = Array.isArray(v) ? v[0] : v;
  return out;
}
