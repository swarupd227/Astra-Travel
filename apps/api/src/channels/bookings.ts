import { BOOKING_COLUMNS, MAX_BOOKINGS_PER_FILE } from '@astra/contracts';
import { parseCsv } from '@astra/studio';

/**
 * Reading a booking file (E04-F03-S02): a CSV with one row per traveller, rows that share a booking reference
 * being the travellers of one booking. Everything here is checking and shaping: the quote and bind themselves go
 * through the API's own routes, so the rules are the same as for any caller. Design: docs/adr/0015.
 */

export interface Booking {
  ref: string;
  /** The row numbers in the file (1 is the header), for the result file. */
  rows: number[];
  planCode: string;
  state: string;
  travellers: {
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    costPerTraveller: string;
  }[];
  trip: {
    departureDate: string;
    returnDate: string;
    destinations: { country?: string; region?: string }[];
  };
  selection: string[];
  purchaser: { name: string; email?: string };
  payment: { reference: string; amount: string };
  acknowledgement: { disclosureVersion: string; acknowledgedBy: string };
}

export interface Rejected {
  ref: string;
  rows: number[];
  reasons: string[];
}

export interface ParsedFile {
  /** Why the whole file is refused (missing columns, too many bookings), or null. */
  fileProblem: string | null;
  bookings: Booking[];
  /** Bookings that cannot be tried, with every reason. */
  rejected: Rejected[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY = /^\d+(\.\d{1,2})?$/;
const CODE = /^[A-Z0-9][A-Z0-9-]{2,39}$/;

export function parseBookingFile(text: string): ParsedFile {
  let rows: Record<string, string>[];
  try {
    rows = parseCsv(text);
  } catch (err) {
    return {
      fileProblem: err instanceof Error ? err.message : 'The file could not be read as CSV.',
      bookings: [],
      rejected: [],
    };
  }
  if (rows.length === 0)
    return { fileProblem: 'The file has no bookings.', bookings: [], rejected: [] };
  const header = Object.keys(rows[0]!);
  const missing = BOOKING_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length)
    return {
      fileProblem: `The file is missing these columns: ${missing.join(', ')}.`,
      bookings: [],
      rejected: [],
    };

  const groups = new Map<string, { row: Record<string, string>; line: number }[]>();
  rows.forEach((row, i) => {
    const ref = (row.booking_ref ?? '').trim();
    const key = ref || `(row ${i + 2} has no booking reference)`;
    const list = groups.get(key) ?? [];
    list.push({ row, line: i + 2 });
    groups.set(key, list);
  });
  if (groups.size > MAX_BOOKINGS_PER_FILE)
    return {
      fileProblem: `A file holds at most ${MAX_BOOKINGS_PER_FILE} bookings; this one has ${groups.size}. Send it in several files.`,
      bookings: [],
      rejected: [],
    };

  const bookings: Booking[] = [];
  const rejected: Rejected[] = [];
  for (const [ref, members] of groups) {
    const first = members[0]!.row;
    const lines = members.map((m) => m.line);
    const problems: string[] = [];
    const v = (k: string) => (first[k] ?? '').trim();
    if (!(first.booking_ref ?? '').trim()) problems.push('The booking reference is empty.');
    if (!CODE.test(v('plan_code'))) problems.push('The plan code is missing or not a plan code.');
    if (!/^[A-Z]{2}$/.test(v('state'))) problems.push('The state must be a two-letter code.');
    if (!DATE.test(v('departure_date'))) problems.push('The departure date must be YYYY-MM-DD.');
    if (!DATE.test(v('return_date'))) problems.push('The return date must be YYYY-MM-DD.');
    else if (DATE.test(v('departure_date')) && v('return_date') < v('departure_date'))
      problems.push('The return date is before the departure date.');
    if (v('purchaser_name').length < 2) problems.push('The purchaser name is missing.');
    if (v('purchaser_email') && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v('purchaser_email')))
      problems.push('The purchaser email is not an address.');
    if (v('payment_reference').length < 3) problems.push('The payment reference is missing.');
    if (!MONEY.test(v('payment_amount')))
      problems.push('The payment amount must be a number such as 84.00.');
    if (!v('disclosure_version')) problems.push('The disclosure version acknowledged is missing.');
    if (v('acknowledged_by').length < 2)
      problems.push('Who acknowledged the disclosure is missing.');
    if (v('able_to_travel').toLowerCase() !== 'true')
      problems.push('The traveller must confirm they are able to travel (able_to_travel = true).');

    // Booking-level columns must agree across a booking's rows (blank is allowed on later rows).
    for (const k of [
      'plan_code',
      'state',
      'departure_date',
      'return_date',
      'purchaser_name',
      'payment_reference',
      'payment_amount',
    ] as const) {
      const other = members
        .slice(1)
        .find((m) => (m.row[k] ?? '').trim() !== '' && (m.row[k] ?? '').trim() !== v(k));
      if (other)
        problems.push(
          `Row ${other.line} gives a different ${k.replace(/_/g, ' ')} from row ${members[0]!.line}.`,
        );
    }

    const travellers: Booking['travellers'] = [];
    for (const m of members) {
      const r = m.row;
      const who = `Row ${m.line}`;
      const first_ = (r.first_name ?? '').trim();
      const last = (r.last_name ?? '').trim();
      if (!first_ || !last)
        problems.push(`${who}: the traveller’s first and last name are needed.`);
      if (!DATE.test((r.date_of_birth ?? '').trim()))
        problems.push(`${who}: the date of birth must be YYYY-MM-DD.`);
      if (!MONEY.test((r.trip_cost ?? '').trim()))
        problems.push(`${who}: the trip cost must be a number such as 4200.`);
      travellers.push({
        firstName: first_,
        lastName: last,
        dateOfBirth: (r.date_of_birth ?? '').trim(),
        costPerTraveller: (r.trip_cost ?? '').trim(),
      });
    }
    const destinations = members
      .map((m) => ({
        country: (m.row.destination_country ?? '').trim().toUpperCase(),
        region: (m.row.destination_region ?? '').trim(),
      }))
      .filter((d) => d.country || d.region)
      .filter(
        (d, i, all) => all.findIndex((x) => x.country === d.country && x.region === d.region) === i,
      )
      .map((d) => ({
        ...(d.country ? { country: d.country } : {}),
        ...(d.region ? { region: d.region } : {}),
      }));
    if (destinations.some((d) => d.country && !/^[A-Z]{2}$/.test(d.country)))
      problems.push('A destination country must be a two-letter code.');

    if (problems.length) {
      rejected.push({ ref, rows: lines, reasons: problems });
      continue;
    }
    bookings.push({
      ref,
      rows: lines,
      planCode: v('plan_code'),
      state: v('state'),
      travellers,
      trip: { departureDate: v('departure_date'), returnDate: v('return_date'), destinations },
      selection: [
        ...new Set(
          (first.optional_benefits ?? '')
            .split(/[;|]/)
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ],
      purchaser: {
        name: v('purchaser_name'),
        ...(v('purchaser_email') ? { email: v('purchaser_email') } : {}),
      },
      payment: { reference: v('payment_reference'), amount: v('payment_amount') },
      acknowledgement: {
        disclosureVersion: v('disclosure_version'),
        acknowledgedBy: v('acknowledged_by'),
      },
    });
  }
  return { fileProblem: null, bookings, rejected };
}

const esc = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export interface BookingResult {
  ref: string;
  rows: number[];
  status: 'accepted' | 'rejected';
  policyNumber?: string;
  premium?: string;
  reasons: string[];
}

/** The result file: one line per booking, in the order the file gave them, with every reason a booking was rejected. */
export function resultCsv(results: BookingResult[]): string {
  const lines = ['booking_ref,rows,status,policy_number,premium,reasons'];
  for (const r of results)
    lines.push(
      [
        r.ref,
        r.rows.join(' '),
        r.status,
        r.policyNumber ?? '',
        r.premium ?? '',
        r.reasons.join(' | '),
      ]
        .map(esc)
        .join(','),
    );
  return `${lines.join('\n')}\n`;
}
