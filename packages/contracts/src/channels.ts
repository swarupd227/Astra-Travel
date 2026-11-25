import { z } from 'zod';

/** Sales channels: branding, widget, hosted journey and booking files (E04-F03). Design: docs/adr/0015. */

// ---------------- Colour contrast (WCAG 2.2 AA) ----------------

const HEX = /^#[0-9a-fA-F]{6}$/;

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

/** The WCAG contrast ratio between two #rrggbb colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export const BrandingSchema = z
  .object({
    displayName: z.string().trim().min(2).max(80),
    /** An https image URL shown in the widget and journey header; optional. */
    logoUrl: z.url({ protocol: /^https$/ }).max(500).nullable().default(null),
    /** Buttons and selected controls. */
    primaryColor: z.string().regex(HEX, 'A colour such as #0b5cad'),
    /** The text on primary-coloured buttons. */
    textOnPrimary: z.string().regex(HEX, 'A colour such as #ffffff'),
  })
  .superRefine((b, ctx) => {
    if (!HEX.test(b.primaryColor) || !HEX.test(b.textOnPrimary)) return;
    const text = contrastRatio(b.primaryColor, b.textOnPrimary);
    if (text < 4.5) ctx.addIssue({ code: 'custom', path: ['textOnPrimary'], message: `The text on the primary colour has a contrast of ${text.toFixed(2)}:1; WCAG 2.2 AA needs 4.5:1.` });
    const edge = contrastRatio(b.primaryColor, '#ffffff');
    if (edge < 3) ctx.addIssue({ code: 'custom', path: ['primaryColor'], message: `The primary colour has a contrast of ${edge.toFixed(2)}:1 against a white page; WCAG 2.2 AA needs 3:1 for controls and focus.` });
  });
export type Branding = z.infer<typeof BrandingSchema>;

// ---------------- Settings ----------------

const ORIGIN = z.string().regex(/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i, 'An origin such as https://book.example.com');

export const WidgetSettingsSchema = z.object({ enabled: z.boolean().default(false), allowedOrigins: z.array(ORIGIN).max(20).default([]) });
export const JourneySettingsSchema = z.object({
  enabled: z.boolean().default(false),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,39}$/, 'Lower-case letters, digits and hyphens, 3 to 40 characters').nullable().default(null),
  planCodes: z.array(z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,39}$/)).max(20).default([]),
  headline: z.string().trim().max(120).default(''),
});

export const ChannelSettingsInputSchema = z.object({ branding: BrandingSchema.nullable(), widget: WidgetSettingsSchema, journey: JourneySettingsSchema });
export const ChannelSettingsSchema = ChannelSettingsInputSchema.extend({ accountId: z.uuid(), updatedBy: z.string().nullable(), updatedAt: z.iso.datetime({ offset: true }).nullable() });
export type ChannelSettings = z.infer<typeof ChannelSettingsSchema>;

/** What the public may see of a journey. */
export const JourneyConfigSchema = z.object({
  slug: z.string(),
  /** Not a secret: every call is still limited by the channel token's account and permissions. */
  accountId: z.uuid(),
  accountName: z.string(),
  branding: BrandingSchema.nullable(),
  headline: z.string(),
  plans: z.array(z.object({ code: z.string(), name: z.string(), state: z.string() })),
  /** `test` is a labelled test payment (sandbox accounts only); `unavailable` means no payment provider is set up. */
  payment: z.enum(['test', 'unavailable']),
});

// ---------------- Widget ----------------

export const WidgetSessionSchema = z.object({ token: z.string(), expiresAt: z.iso.datetime({ offset: true }), scriptUrl: z.string(), apiUrl: z.string(), snippet: z.string() });

export const OfferSchema = z.object({
  quoteId: z.uuid(),
  accountName: z.string(),
  branding: BrandingSchema.nullable(),
  plan: z.object({ code: z.string(), name: z.string() }),
  status: z.enum(['open', 'bound', 'expired']),
  expiresAt: z.iso.datetime({ offset: true }),
  outcome: z.enum(['eligible', 'ineligible', 'referred', 'held']),
  notBindable: z.array(z.string()),
  benefits: z.array(z.object({ code: z.string(), name: z.string(), packaging: z.string(), selected: z.boolean(), available: z.boolean(), reason: z.string().nullable(), limit: z.string().nullable(), premium: z.string().nullable() })),
  total: z.string().nullable(),
  /** Absolute link to the filed wording; null when the plan has no filed form on record. */
  wordingUrl: z.string().nullable(),
  disclosureTitle: z.string().nullable(),
});
export type Offer = z.infer<typeof OfferSchema>;

// ---------------- Booking files ----------------

export const BOOKING_COLUMNS = [
  'booking_ref',
  'plan_code',
  'state',
  'first_name',
  'last_name',
  'date_of_birth',
  'trip_cost',
  'departure_date',
  'return_date',
  'destination_country',
  'destination_region',
  'optional_benefits',
  'purchaser_name',
  'purchaser_email',
  'payment_reference',
  'payment_amount',
  'disclosure_version',
  'acknowledged_by',
  'able_to_travel',
] as const;
export const MAX_BOOKINGS_PER_FILE = 500;

export const BookingFileSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  fileName: z.string(),
  sha256: z.string(),
  status: z.enum(['processing', 'completed', 'rejected']),
  bookings: z.number().int(),
  accepted: z.number().int(),
  rejected: z.number().int(),
  /** Why the whole file was refused, when it was. */
  reason: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type BookingFile = z.infer<typeof BookingFileSchema>;
