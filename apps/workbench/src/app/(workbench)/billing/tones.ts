export const RECORD_TONES = {
  held: 'warning',
  ready: 'primary',
  batched: 'neutral',
  sent: 'neutral',
  confirmed: 'success',
  rejected: 'danger',
} as const;
export const BATCH_TONES = {
  ready: 'warning',
  sent: 'primary',
  confirmed: 'success',
  mismatch: 'danger',
  unconfirmed: 'danger',
  rejected: 'danger',
} as const;
