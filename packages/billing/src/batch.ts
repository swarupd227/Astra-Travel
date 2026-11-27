import type { ControlTotals } from '@astra/contracts';
import { fromCents, toCents } from './money';

/**
 * The batch format and its control totals (E08-F03, E08-F04-S01). A batch is newline-delimited JSON: a header
 * with the batch ID, then one line per record, then a trailer. Header and trailer carry the same control
 * totals, so a reader can check that a file is whole before it trusts the records.
 */

export interface TotalsInput {
  premiumCents: number;
  commissionCents: number;
  taxCents: number;
}

export function emptyTotals(): {
  count: number;
  premium: number;
  charges: number;
  refunds: number;
  commission: number;
  tax: number;
} {
  return { count: 0, premium: 0, charges: 0, refunds: 0, commission: 0, tax: 0 };
}

export type TotalsAccumulator = ReturnType<typeof emptyTotals>;

export function addToTotals(t: TotalsAccumulator, r: TotalsInput): void {
  t.count += 1;
  t.premium += r.premiumCents;
  if (r.premiumCents >= 0) t.charges += r.premiumCents;
  else t.refunds += -r.premiumCents;
  t.commission += r.commissionCents;
  t.tax += r.taxCents;
}

export const totalsOf = (t: TotalsAccumulator): ControlTotals => ({
  count: t.count,
  premium: fromCents(t.premium),
  charges: fromCents(t.charges),
  refunds: fromCents(t.refunds),
  commission: fromCents(t.commission),
  tax: fromCents(t.tax),
});

export interface BatchHeader {
  type: 'header';
  batchId: string;
  number: number;
  createdAt: string;
  format: 'astra-premium-records/1';
}

/** The trailer closes the file with the totals the header promised. */
export const trailerLine = (totals: ControlTotals): string =>
  JSON.stringify({ type: 'trailer', totals });
export const headerLine = (
  h: Omit<BatchHeader, 'type' | 'format'>,
  totals: ControlTotals,
): string => JSON.stringify({ type: 'header', format: 'astra-premium-records/1', ...h, totals });

export interface CheckResult {
  ok: boolean;
  differences: string[];
}

/** Compares what billing says it received with the batch's control totals. */
export function compareTotals(
  sent: ControlTotals,
  received: { count: number; premium: string; commission: string; tax: string },
): CheckResult {
  const differences: string[] = [];
  if (received.count !== sent.count)
    differences.push(`record count: sent ${sent.count}, received ${received.count}`);
  for (const k of ['premium', 'commission', 'tax'] as const) {
    if (toCents(received[k]) !== toCents(sent[k]))
      differences.push(`${k}: sent ${sent[k]}, received ${received[k]}`);
  }
  return { ok: differences.length === 0, differences };
}
