import { normaliseName } from './sanctions';

/** Duplicate cover (E03-F04-S02): same traveller, overlapping trip dates, same company. */

export interface ExistingCover {
  firstName: string;
  lastName: string;
  dateOfBirth?: string | undefined;
  policyRef: string;
  tripStart: string;
  tripEnd: string;
  term: 'single_trip' | 'annual';
}

/** Traveller identity: normalised name and date of birth. Without a date of birth the identity cannot be established. */
export function travellerKey(t: {
  firstName: string;
  lastName: string;
  dateOfBirth?: string | undefined;
}): string | null {
  if (!t.dateOfBirth) return null;
  const tokens = normaliseName(`${t.firstName} ${t.lastName}`).sort();
  return `${tokens.join(' ')}|${t.dateOfBirth}`;
}

export function findDuplicates(
  traveller: { id: string; firstName: string; lastName: string; dateOfBirth?: string | undefined },
  trip: {
    start: string;
    end: string;
    term: 'single_trip' | 'annual';
    policyRef?: string | undefined;
  },
  covers: ExistingCover[],
  allowSingleAndAnnual: boolean,
): ExistingCover[] {
  const key = travellerKey(traveller);
  if (!key) return [];
  return covers.filter((c) => {
    if (c.policyRef === trip.policyRef) return false;
    if (travellerKey(c) !== key) return false;
    if (!(c.tripStart <= trip.end && trip.start <= c.tripEnd)) return false;
    // One single-trip and one annual policy may coexist when the plan allows it.
    if (allowSingleAndAnnual && c.term !== trip.term) return false;
    return true;
  });
}
