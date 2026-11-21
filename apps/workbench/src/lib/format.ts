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
