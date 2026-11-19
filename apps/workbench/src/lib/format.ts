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
