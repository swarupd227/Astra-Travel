import { POLICY_TRANSITIONS, type PolicyEvent, type PolicySnapshot } from '@astra/contracts';

/**
 * The policy record is the projection of its events (E05-F01). Status changes only along the lifecycle's
 * edges, and the record at any moment is the fold of the events up to it.
 */

export type PolicyStatus = keyof typeof POLICY_TRANSITIONS;

export const canTransition = (from: PolicyStatus, to: PolicyStatus): boolean =>
  (POLICY_TRANSITIONS[from] as readonly string[]).includes(to);

export interface ProjectedPolicy {
  status: PolicyStatus;
  record: PolicySnapshot;
  appliedEvents: number;
}

/** A shallow merge of a details change: each key replaces what was there. */
const merge = (record: PolicySnapshot, patch: Record<string, unknown>): PolicySnapshot =>
  ({ ...record, ...patch }) as PolicySnapshot;

/**
 * Folds events (oldest first) into the policy as it was after the last one at or before `asOf`. Returns null
 * if the policy did not yet exist.
 */
export function project(events: PolicyEvent[], asOf?: string): ProjectedPolicy | null {
  let status: PolicyStatus = 'active';
  let record: PolicySnapshot | null = null;
  let applied = 0;
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (asOf && Date.parse(e.occurredAt) > Date.parse(asOf)) break;
    if (e.type === 'bound') {
      record = e.data as unknown as PolicySnapshot;
      status = 'active';
    } else if (!record) {
      throw new Error('A policy event came before the policy was bound.');
    } else if (e.type === 'status_changed') {
      const to = e.data.to as PolicyStatus;
      if (!canTransition(status, to))
        throw new Error(
          `The history changes the policy from ${status} to ${to}, which is not allowed.`,
        );
      status = to;
    } else {
      record = merge(record, (e.data.patch ?? {}) as Record<string, unknown>);
    }
    applied += 1;
  }
  return record ? { status, record, appliedEvents: applied } : null;
}

/** Whether cover is in force on a local date-time: active and within a benefit's window. */
export function inForce(
  status: PolicyStatus,
  window: { start: string; end: string },
  on: string,
): boolean {
  return status === 'active' && on >= window.start && on <= window.end;
}

/** A policy number such as ATP-2026-000123 (the sequence number is the database's). */
export const policyNumber = (year: number, seq: number): string =>
  `ATP-${year}-${String(seq).padStart(6, '0')}`;
