import { z } from 'zod';

/**
 * Standard event envelope (specification section 11, E13-F02-S01).
 * Every business event carries: id, type, version, time, source, correlation ID, account ID and state.
 * `state` is the US jurisdiction (two-letter code) the event relates to, when there is one.
 */
export const EventEnvelopeSchema = z.object({
  id: z.uuid(),
  type: z.string().regex(/^[A-Z][A-Za-z0-9]{2,63}$/, 'PascalCase event type, e.g. PolicyBound'),
  version: z.number().int().min(1),
  time: z.iso.datetime({ offset: true }),
  source: z.string().regex(/^astra\.[a-z0-9-]+(\.[a-z0-9-]+)*$/, 'e.g. astra.platform.accounts'),
  correlationId: z.string().min(1).max(128),
  accountId: z.uuid().nullable(),
  state: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable(),
  data: z.record(z.string(), z.unknown()),
});

export type EventEnvelope<TData extends Record<string, unknown> = Record<string, unknown>> = Omit<
  z.infer<typeof EventEnvelopeSchema>,
  'data'
> & { data: TData };
