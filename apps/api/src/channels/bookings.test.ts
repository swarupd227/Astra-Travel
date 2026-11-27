import { describe, expect, it } from 'vitest';
import { BOOKING_COLUMNS, BrandingSchema, contrastRatio } from '@astra/contracts';
import { parseBookingFile, resultCsv } from './bookings';

/** Names, dates and amounts here are SYNTHETIC. */
const row = (o: Record<string, string> = {}) => ({
  booking_ref: 'B1',
  plan_code: 'Q-DE',
  state: 'DE',
  first_name: 'Sam',
  last_name: 'Sample',
  date_of_birth: '1980-05-05',
  trip_cost: '4200',
  departure_date: '2026-12-20',
  return_date: '2026-12-29',
  destination_country: 'FR',
  destination_region: 'Europe',
  optional_benefits: '',
  purchaser_name: 'Sam Sample',
  purchaser_email: 'sam@example.com',
  payment_reference: 'PAY-0001',
  payment_amount: '84.00',
  disclosure_version: 'v1',
  acknowledged_by: 'Sam Sample',
  able_to_travel: 'true',
  ...o,
});
const csv = (rows: Record<string, string>[], columns: readonly string[] = BOOKING_COLUMNS) =>
  [
    columns.join(','),
    ...rows.map((r) =>
      columns
        .map((c) =>
          /[,"]/.test(r[c] ?? '') ? `"${(r[c] ?? '').replace(/"/g, '""')}"` : (r[c] ?? ''),
        )
        .join(','),
    ),
  ].join('\n');

describe('booking files (E04-F03-S02)', () => {
  it('turns rows into bookings, grouping the travellers of one booking', () => {
    const p = parseBookingFile(
      csv([
        row(),
        row({
          booking_ref: 'B1',
          first_name: 'Pat',
          date_of_birth: '1982-01-01',
          trip_cost: '3000',
          destination_country: '',
          destination_region: '',
        }),
        row({
          booking_ref: 'B2',
          optional_benefits: 'trip_interruption; trip_delay',
          payment_reference: 'PAY-0002',
        }),
      ]),
    );
    expect(p.fileProblem).toBeNull();
    expect(p.rejected).toEqual([]);
    expect(p.bookings.map((b) => [b.ref, b.rows, b.travellers.length])).toEqual([
      ['B1', [2, 3], 2],
      ['B2', [4], 1],
    ]);
    expect(p.bookings[0]!.travellers.map((t) => t.firstName)).toEqual(['Sam', 'Pat']);
    expect(p.bookings[0]!.trip.destinations).toEqual([{ country: 'FR', region: 'Europe' }]);
    expect(p.bookings[1]!.selection).toEqual(['trip_interruption', 'trip_delay']);
    expect(p.bookings[0]!.payment).toEqual({ reference: 'PAY-0001', amount: '84.00' });
  });

  it('refuses a file with missing columns or too many bookings, and says so for the whole file', () => {
    const noCols = parseBookingFile(
      csv(
        [row()],
        BOOKING_COLUMNS.filter((c) => c !== 'payment_amount' && c !== 'state'),
      ),
    );
    expect(noCols.fileProblem).toBe('The file is missing these columns: state, payment_amount.');
    expect(parseBookingFile('').fileProblem).toMatch(/no bookings|CSV|empty/i);
    const many = parseBookingFile(
      csv(Array.from({ length: 501 }, (_, i) => row({ booking_ref: `B${i}` }))),
    );
    expect(many.fileProblem).toContain('at most 500 bookings');
  });

  it('rejects a booking with every reason it has, and still reads the others', () => {
    const p = parseBookingFile(
      csv([
        row({
          booking_ref: 'BAD',
          departure_date: '20/12/2026',
          payment_amount: 'free',
          able_to_travel: 'false',
          purchaser_email: 'nope',
          state: 'Delaware',
        }),
        row({ booking_ref: 'GOOD' }),
      ]),
    );
    expect(p.bookings.map((b) => b.ref)).toEqual(['GOOD']);
    expect(p.rejected).toHaveLength(1);
    expect(p.rejected[0]!.ref).toBe('BAD');
    const reasons = p.rejected[0]!.reasons.join(' ');
    for (const expected of [
      'two-letter code',
      'departure date must be YYYY-MM-DD',
      'payment amount must be a number',
      'able to travel',
      'not an address',
    ])
      expect(reasons).toContain(expected);
  });

  it('catches a booking whose rows disagree, and a row with no reference', () => {
    const p = parseBookingFile(
      csv([row(), row({ first_name: 'Pat', payment_amount: '90.00' }), row({ booking_ref: '' })]),
    );
    expect(p.rejected.map((r) => r.ref)).toEqual(['B1', '(row 4 has no booking reference)']);
    expect(p.rejected[0]!.reasons.join(' ')).toContain(
      'Row 3 gives a different payment amount from row 2',
    );
    expect(p.rejected[1]!.reasons).toContain('The booking reference is empty.');
  });

  it('writes a result file with the reasons', () => {
    const out = resultCsv([
      {
        ref: 'B1',
        rows: [2, 3],
        status: 'accepted',
        policyNumber: 'ATP-2026-000001',
        premium: '84.00',
        reasons: [],
      },
      {
        ref: 'B, 2',
        rows: [4],
        status: 'rejected',
        reasons: ['Not eligible: too old.', 'The payment of 10.00 does not match the premium'],
      },
    ]);
    expect(out.split('\n')).toEqual([
      'booking_ref,rows,status,policy_number,premium,reasons',
      'B1,2 3,accepted,ATP-2026-000001,84.00,',
      '"B, 2",4,rejected,,,Not eligible: too old. | The payment of 10.00 does not match the premium',
      '',
    ]);
  });
});

describe('branding (WCAG 2.2 AA)', () => {
  it('computes contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });
  it('accepts colours that meet AA and says why when they do not', () => {
    expect(
      BrandingSchema.safeParse({
        displayName: 'Acme Travel',
        primaryColor: '#0b5cad',
        textOnPrimary: '#ffffff',
      }).success,
    ).toBe(true);
    const lowText = BrandingSchema.safeParse({
      displayName: 'Acme Travel',
      primaryColor: '#7fb2e5',
      textOnPrimary: '#ffffff',
    });
    expect(lowText.success).toBe(false);
    expect(JSON.stringify(lowText.error?.issues)).toContain('WCAG 2.2 AA needs 4.5:1');
    const lowEdge = BrandingSchema.safeParse({
      displayName: 'Acme Travel',
      primaryColor: '#f5f5aa',
      textOnPrimary: '#000000',
    });
    expect(lowEdge.success).toBe(false);
    expect(JSON.stringify(lowEdge.error?.issues)).toContain('against a white page');
    expect(
      BrandingSchema.safeParse({ displayName: 'Acme', primaryColor: 'blue', textOnPrimary: '#fff' })
        .success,
    ).toBe(false);
  });
});
