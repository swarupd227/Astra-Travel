import type { FilingItemType } from '@astra/contracts';
import type { Tx } from '@astra/platform';

/**
 * The configuration check against filings (E10-F01-S02): an item may be used in a state on a date only
 * while an approved filing for it is in effect. A withdrawn approval still covers the dates before its
 * withdrawal, so policies sold then stay valid. Plan publishing (Increment 6) and quoting (Increment 9)
 * call this; the answer explains why when the item may not be used.
 */

export interface FilingRow {
  id: string;
  state: string;
  insurer: string;
  item_type: FilingItemType;
  item_id: string | null;
  item_reference: string;
  serff_tracking: string | null;
  status: string;
  submitted_on: string | null;
  decided_on: string | null;
  effective_from: string | null;
  effective_to: string | null;
  notes: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface Approval {
  approved: boolean;
  reason: string;
  filing: FilingRow | null;
}

export type FilingItem =
  | { itemType: 'form_edition'; itemId: string }
  | { itemType: 'rate_manual' | 'rule_set'; itemReference: string };

const wasApproved = (r: FilingRow) =>
  (r.status === 'approved' || r.status === 'withdrawn') && r.effective_from !== null;

export async function filingsFor(tx: Tx, item: FilingItem, state?: string): Promise<FilingRow[]> {
  const { rows } = await tx.query<FilingRow>(
    `SELECT * FROM compliance.filings
      WHERE item_type = $1 AND ($2::text IS NULL OR state = $2)
        AND (($1 = 'form_edition' AND item_id = $3::uuid) OR ($1 <> 'form_edition' AND item_reference = $4))
      ORDER BY state, created_at DESC`,
    [
      item.itemType,
      state ?? null,
      item.itemType === 'form_edition' ? item.itemId : null,
      item.itemType === 'form_edition' ? null : item.itemReference,
    ],
  );
  return rows;
}

export function decide(rows: FilingRow[], state: string, date: string): Approval {
  const inState = rows.filter((r) => r.state === state);
  const inForce = inState.find(
    (r) =>
      wasApproved(r) &&
      r.effective_from! <= date &&
      (r.effective_to === null || r.effective_to > date),
  );
  if (inForce) {
    const serff = inForce.serff_tracking ? ` (SERFF ${inForce.serff_tracking})` : '';
    const until = inForce.effective_to ? ` until ${inForce.effective_to}` : '';
    return {
      approved: true,
      reason: `Approved in ${state} from ${inForce.effective_from}${until}${serff}.`,
      filing: inForce,
    };
  }
  const approvals = inState.filter(wasApproved);
  const future = approvals
    .filter((r) => r.effective_from! > date)
    .sort((a, b) => (a.effective_from! < b.effective_from! ? -1 : 1))[0];
  if (future) {
    return {
      approved: false,
      reason: `Approved in ${state}, but not in effect until ${future.effective_from}.`,
      filing: future,
    };
  }
  const ended = approvals
    .filter((r) => r.effective_to !== null && r.effective_to <= date)
    .sort((a, b) => (a.effective_to! > b.effective_to! ? -1 : 1))[0];
  if (ended) {
    const how = ended.status === 'withdrawn' ? 'was withdrawn' : 'ended';
    return {
      approved: false,
      reason: `The approval in ${state} ${how} on ${ended.effective_to}.`,
      filing: ended,
    };
  }
  const latest = inState[0];
  if (!latest)
    return { approved: false, reason: `No filing is recorded for ${state}.`, filing: null };
  const phrase: Record<string, string> = {
    draft: 'is being prepared and has not been submitted',
    submitted: 'is awaiting the regulator’s decision',
    disapproved: 'was disapproved',
    withdrawn: 'was withdrawn before approval',
  };
  return {
    approved: false,
    reason: `The filing for ${state} ${phrase[latest.status] ?? `is ${latest.status}`}.`,
    filing: latest,
  };
}

export async function approvalFor(
  tx: Tx,
  item: FilingItem,
  state: string,
  date: string,
): Promise<Approval> {
  return decide(await filingsFor(tx, item, state), state, date);
}
