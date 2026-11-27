import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { Readable } from 'node:stream';
import {
  BookingFileSchema,
  ChannelSettingsInputSchema,
  ChannelSettingsSchema,
  JourneyConfigSchema,
  MAX_BOOKINGS_PER_FILE,
  OfferSchema,
  WidgetSessionSchema,
  type Branding,
  type CatalogueDocument,
  type PlanDocument,
} from '@astra/contracts';
import { signChannelToken } from '@astra/contracts/channel-token';
import {
  AppError,
  canSeeAccount,
  conflict,
  forbidden,
  isUniqueViolation,
  notFound,
  withTx,
  writeAudit,
} from '@astra/platform';
import { benefitLimits } from '@astra/policies';
import type { AppDeps } from '../app';
import { commonErrors } from './shared';
import { INTERNAL_HEADER, INTERNAL_KEY } from '../http/internal';
import { parseBookingFile, resultCsv, type BookingResult } from '../channels/bookings';
import { WIDGET_SCRIPT } from '../channels/widget-script';

/** Channel settings, the widget, the hosted journey's public configuration and booking files (E04-F03). Design: docs/adr/0015. */

const idParams = z.object({ id: z.uuid() });
const quoteParams = z.object({ quoteId: z.uuid() });
const WIDGET_LIFETIME_SECONDS = 30 * 60;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

interface SettingsRow {
  account_id: string;
  branding: Branding | null;
  widget: { enabled: boolean; allowedOrigins: string[] };
  journey: { enabled: boolean; slug: string | null; planCodes: string[]; headline: string };
  updated_by: string | null;
  updated_at: Date | null;
}
const emptySettings = (accountId: string): SettingsRow => ({
  account_id: accountId,
  branding: null,
  widget: { enabled: false, allowedOrigins: [] },
  journey: { enabled: false, slug: null, planCodes: [], headline: '' },
  updated_by: null,
  updated_at: null,
});
const toSettings = (r: SettingsRow) => ({
  accountId: r.account_id,
  branding: r.branding,
  widget: r.widget,
  journey: r.journey,
  updatedBy: r.updated_by,
  updatedAt: iso(r.updated_at),
});

interface FileRow {
  id: string;
  account_id: string;
  file_name: string;
  sha256: string;
  status: 'processing' | 'completed' | 'rejected';
  bookings: number;
  accepted: number;
  rejected: number;
  reason: string | null;
  created_by: string;
  created_at: Date;
}
const FILE_COLS =
  'id, account_id, file_name, sha256, status, bookings, accepted, rejected, reason, created_by, created_at';
const toFile = (r: FileRow) => ({
  id: r.id,
  accountId: r.account_id,
  fileName: r.file_name,
  sha256: r.sha256,
  status: r.status,
  bookings: r.bookings,
  accepted: r.accepted,
  rejected: r.rejected,
  reason: r.reason,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
});

/** What an error answer says, in words: its detail and each field message. */
function reasonsOf(body: unknown): string[] {
  const p = body as { detail?: string; title?: string; errors?: { message?: string }[] } | null;
  const lines = (p?.errors ?? []).map((e) => e.message).filter((m): m is string => !!m);
  return lines.length ? [...new Set(lines)] : [p?.detail ?? p?.title ?? 'The booking was refused.'];
}

export const channelRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.addContentTypeParser(
    'text/csv',
    { parseAs: 'string', bodyLimit: 5 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  // ---------------- Settings ----------------

  app.get(
    '/v1/accounts/:id/channels',
    {
      config: { tenancy: 'account', permission: 'accounts:read' },
      schema: {
        tags: ['Channels'],
        summary: 'An account’s branding, widget and hosted journey settings',
        params: idParams,
        response: { 200: ChannelSettingsSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        if (
          !(await tx.query(`SELECT 1 FROM platform.accounts WHERE id = $1`, [request.params.id]))
            .rowCount
        )
          throw notFound('The account');
        const r = (
          await tx.query<SettingsRow>(
            `SELECT account_id, branding, widget, journey, updated_by, updated_at FROM channels.settings WHERE account_id = $1`,
            [request.params.id],
          )
        ).rows[0];
        return toSettings(r ?? emptySettings(request.params.id));
      }),
  );

  app.put(
    '/v1/accounts/:id/channels',
    {
      config: { tenancy: 'platform', permission: 'accounts:manage' },
      schema: {
        tags: ['Channels'],
        summary: 'Set an account’s branding, widget origins and hosted journey (E04-F03)',
        description:
          'Branding colours are checked against WCAG 2.2 AA contrast when saved. A journey needs a slug and at least one state or account plan; the slug is its public address.',
        params: idParams,
        body: ChannelSettingsInputSchema,
        response: { 200: ChannelSettingsSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const id = request.params.id;
        if (!(await tx.query(`SELECT 1 FROM platform.accounts WHERE id = $1`, [id])).rowCount)
          throw notFound('The account');
        const b = request.body;
        if (b.journey.enabled) {
          if (!b.journey.slug)
            throw new AppError('validation_failed', 'A journey needs a slug.', [
              { code: 'slug', field: 'journey.slug', message: 'Choose the journey’s address' },
            ]);
          if (!b.branding)
            throw new AppError('validation_failed', 'A journey needs the account’s branding.', [
              { code: 'branding', field: 'branding', message: 'Set the branding first' },
            ]);
          if (b.journey.planCodes.length === 0)
            throw new AppError('validation_failed', 'A journey needs at least one plan.', [
              { code: 'plans', field: 'journey.planCodes', message: 'Choose the plans it sells' },
            ]);
          const found = (
            await tx.query<{ code: string }>(
              `SELECT code FROM plans.plans WHERE code = ANY ($1::text[]) AND kind <> 'base'`,
              [b.journey.planCodes],
            )
          ).rows.map((r) => r.code);
          const missing = b.journey.planCodes.filter((c) => !found.includes(c));
          if (missing.length)
            throw new AppError(
              'validation_failed',
              `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not a state or account plan.`,
              [
                {
                  code: 'plans',
                  field: 'journey.planCodes',
                  message: `Unknown: ${missing.join(', ')}`,
                },
              ],
            );
        }
        try {
          const row = (
            await tx.query<SettingsRow>(
              `INSERT INTO channels.settings (account_id, branding, widget, journey, journey_slug, updated_by) VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (account_id) DO UPDATE SET branding = $2, widget = $3, journey = $4, journey_slug = $5, updated_by = $6, updated_at = now()
               RETURNING account_id, branding, widget, journey, updated_by, updated_at`,
              [
                id,
                b.branding ? JSON.stringify(b.branding) : null,
                JSON.stringify(b.widget),
                JSON.stringify(b.journey),
                b.journey.enabled ? b.journey.slug : null,
                request.ctx.principal.subject,
              ],
            )
          ).rows[0]!;
          await writeAudit(tx, request.ctx, {
            action: 'channel_settings.updated',
            resourceType: 'account',
            resourceId: id,
            accountId: id,
            data: { widget: b.widget.enabled, journey: b.journey.enabled, slug: b.journey.slug },
          });
          return toSettings(row);
        } catch (err) {
          if (isUniqueViolation(err))
            throw conflict(
              `The journey address “${b.journey.slug}” is already used by another account.`,
            );
          throw err;
        }
      }),
  );

  // ---------------- Public journey configuration (E04-F03-S04) ----------------

  app.get(
    '/v1/journeys/:slug',
    {
      config: { tenancy: 'public' },
      schema: {
        tags: ['Channels'],
        summary:
          'What the hosted journey at an address looks like: branding, plans and how payment works',
        params: z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,39}$/) }),
        response: { 200: JourneyConfigSchema, ...commonErrors },
      },
    },
    async (request) => {
      const j = (
        await deps.pool.query<{
          account_id: string;
          account_name: string;
          sandbox: boolean;
          status: string;
          branding: Branding | null;
          journey: { headline: string; planCodes: string[] };
        }>(`SELECT * FROM channels.journey_by_slug($1)`, [request.params.slug])
      ).rows[0];
      if (!j || (j.status !== 'active' && !j.sandbox) || !j.branding)
        throw notFound('This journey');
      const plans = (
        await deps.pool.query<{ code: string; name: string; state: string }>(
          `SELECT code, name, state FROM plans.plans WHERE code = ANY ($1::text[]) AND kind <> 'base' AND (account_id IS NULL OR account_id = $2) ORDER BY code`,
          [j.journey.planCodes, j.account_id],
        )
      ).rows;
      return {
        slug: request.params.slug,
        accountId: j.account_id,
        accountName: j.account_name,
        branding: j.branding,
        headline: j.journey.headline,
        plans,
        payment: j.sandbox ? ('test' as const) : ('unavailable' as const),
      };
    },
  );

  // ---------------- Widget (E04-F03-S01) ----------------

  app.get(
    '/widget/v1/astra-widget.js',
    { config: { tenancy: 'public' }, schema: { hide: true } },
    async (_request, reply) =>
      reply
        .header('content-type', 'text/javascript; charset=utf-8')
        .header('cache-control', 'public, max-age=300')
        .header('cross-origin-resource-policy', 'cross-origin')
        .send(WIDGET_SCRIPT),
  );

  app.post(
    '/v1/quotes/:quoteId/widget-sessions',
    {
      config: { tenancy: 'account', permission: 'quotes:create' },
      schema: {
        tags: ['Channels'],
        summary: 'Start a widget session for a quote (E04-F03-S01)',
        description:
          'Returns a short-lived token a traveller’s browser can hold: it can read this one quote and change its optional benefits, and nothing else. Put the snippet in the account’s booking page. The widget never binds; the account’s server binds with its own credentials once the traveller has paid.',
        params: quoteParams,
        response: { 201: WidgetSessionSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      if (!deps.config.CHANNEL_SIGNING_SECRET)
        throw new AppError(
          'precondition_failed',
          'Widget sessions are not available: CHANNEL_SIGNING_SECRET is not configured.',
        );
      const quote = await withTx(deps.pool, request.ctx, async (tx) => {
        const q = (
          await tx.query<{ id: string; account_id: string; status: string; expires_at: Date }>(
            `SELECT id, account_id, status, expires_at FROM policies.quotes WHERE id = $1`,
            [request.params.quoteId],
          )
        ).rows[0];
        if (!q) throw notFound('The quote');
        if (!canSeeAccount(request.ctx.principal, q.account_id)) throw notFound('The quote');
        if (q.status !== 'open') throw conflict(`This quote is ${q.status}.`);
        const s = (
          await tx.query<{ widget: { enabled: boolean } }>(
            `SELECT widget FROM channels.settings WHERE account_id = $1`,
            [q.account_id],
          )
        ).rows[0];
        if (!s?.widget.enabled) throw conflict('The widget is not switched on for this account.');
        await writeAudit(tx, request.ctx, {
          action: 'widget_session.started',
          resourceType: 'quote',
          resourceId: q.id,
          accountId: q.account_id,
          data: {},
        });
        return q;
      });
      const { token, expiresAt } = signChannelToken(
        deps.config.CHANNEL_SIGNING_SECRET,
        {
          scope: 'widget',
          accountId: quote.account_id,
          sub: quote.id,
          permissions: ['quotes:read', 'quotes:reselect'],
          quoteId: quote.id,
        },
        WIDGET_LIFETIME_SECONDS,
      );
      const api = deps.config.PUBLIC_API_URL.replace(/\/$/, '');
      const scriptUrl = `${api}/widget/v1/astra-widget.js`;
      return reply.code(201).send({
        token,
        expiresAt: expiresAt.toISOString(),
        scriptUrl,
        apiUrl: api,
        snippet: `<script src="${scriptUrl}" async></script>\n<astra-cover-offer api="${api}" quote="${quote.id}" token="${token}"></astra-cover-offer>`,
      });
    },
  );

  app.get(
    '/v1/quotes/:quoteId/offer',
    {
      config: { tenancy: 'account', permission: 'quotes:read' },
      schema: {
        tags: ['Channels'],
        summary:
          'A quote as an offer for a traveller: benefits with limits, premium, branding and the link to the wording',
        params: quoteParams,
        response: { 200: OfferSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const q = (
          await tx.query<{
            id: string;
            account_id: string;
            plan_version_id: string;
            status: 'open' | 'bound' | 'expired';
            expires_at: Date;
            result: {
              plan: { code: string; name: string };
              outcome: 'eligible' | 'ineligible' | 'referred' | 'held';
              notBindable: string[];
              benefits: {
                code: string;
                name: string;
                packaging: string;
                selected: boolean;
                available: boolean;
                reason: string | null;
                premium: string | null;
              }[];
              premium: { total: string } | null;
              disclosure: { title: string } | null;
            };
          }>(
            `SELECT id, account_id, plan_version_id, status, expires_at, result FROM policies.quotes WHERE id = $1`,
            [request.params.quoteId],
          )
        ).rows[0];
        if (!q) throw notFound('The quote');
        const pv = (
          await tx.query<{
            catalogue_id: string;
            document: PlanDocument;
            schedule_edition_id: string;
            policy_edition_id: string | null;
          }>(
            `SELECT v.catalogue_id, v.document, p.schedule_edition_id, p.policy_edition_id FROM plans.plan_versions v JOIN plans.plans p ON p.id = v.plan_id WHERE v.id = $1`,
            [q.plan_version_id],
          )
        ).rows[0]!;
        const cat = (
          await tx.query<{ document: CatalogueDocument }>(
            `SELECT document FROM studio.benefit_catalogues WHERE id = $1`,
            [pv.catalogue_id],
          )
        ).rows[0]!.document;
        const acc = (
          await tx.query<{ name: string }>(`SELECT name FROM platform.accounts WHERE id = $1`, [
            q.account_id,
          ])
        ).rows[0]!;
        const branding =
          (
            await tx.query<{ branding: Branding | null }>(
              `SELECT branding FROM channels.settings WHERE account_id = $1`,
              [q.account_id],
            )
          ).rows[0]?.branding ?? null;
        const expired = q.status === 'open' && q.expires_at.getTime() < Date.now();
        const limitText = (code: string): string | null => {
          const l = benefitLimits(pv.document, cat, code);
          return l.maximum === null
            ? null
            : `$${l.maximum.toLocaleString('en-US')}${l.basis ? ` ${l.basis}` : ''}`;
        };
        const hasForm = !!(pv.policy_edition_id ?? pv.schedule_edition_id);
        return {
          quoteId: q.id,
          accountName: acc.name,
          branding,
          plan: q.result.plan,
          status: expired ? ('expired' as const) : q.status,
          expiresAt: q.expires_at.toISOString(),
          outcome: q.result.outcome,
          notBindable: q.result.notBindable,
          benefits: q.result.benefits.map((b) => ({
            code: b.code,
            name: b.name,
            packaging: b.packaging,
            selected: b.selected,
            available: b.available,
            reason: b.reason,
            limit: limitText(b.code),
            premium: b.premium,
          })),
          total: q.result.premium?.total ?? null,
          wordingUrl: hasForm
            ? `${deps.config.PUBLIC_API_URL.replace(/\/$/, '')}/v1/quotes/${q.id}/wording`
            : null,
          disclosureTitle: q.result.disclosure?.title ?? null,
        };
      }),
  );

  app.get(
    '/v1/quotes/:quoteId/wording',
    {
      config: { tenancy: 'account', permission: 'quotes:read' },
      schema: {
        tags: ['Channels'],
        summary:
          'The filed policy form (or schedule) of the quote’s plan, as the traveller reads it',
        params: quoteParams,
        produces: ['application/pdf', 'text/plain'],
        response: { ...commonErrors },
      },
    },
    async (request, reply) => {
      const f = await withTx(deps.pool, request.ctx, async (tx) => {
        const r = (
          await tx.query<{ storage_key: string; content_type: string; file_name: string }>(
            `SELECT e.storage_key, e.content_type, e.file_name FROM policies.quotes q JOIN plans.plan_versions v ON v.id = q.plan_version_id JOIN plans.plans p ON p.id = v.plan_id
               JOIN studio.form_editions e ON e.id = coalesce(p.policy_edition_id, p.schedule_edition_id) WHERE q.id = $1`,
            [request.params.quoteId],
          )
        ).rows[0];
        if (!r) throw notFound('The quote');
        return r;
      });
      return reply
        .header('content-type', f.content_type)
        .header(
          'content-disposition',
          `inline; filename="${f.file_name.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
        )
        .header('cache-control', 'private, no-store')
        .send(deps.files.read(f.storage_key) as never);
    },
  );

  // ---------------- Booking files (E04-F03-S02) ----------------

  app.post(
    '/v1/booking-files',
    {
      config: { tenancy: 'account', permission: 'quotes:create' },
      bodyLimit: 5 * 1024 * 1024,
      schema: {
        tags: ['Channels'],
        summary: 'Send bookings in a CSV file for cover (E04-F03-S02)',
        description: `One row per traveller; rows with the same booking_ref are one booking. Every booking is quoted and bound through the same rules as the API, and the answer lists each booking as accepted (with its policy number) or rejected (with every reason). A file holds at most ${MAX_BOOKINGS_PER_FILE} bookings and cannot be loaded twice.`,
        querystring: z.object({
          fileName: z.string().trim().min(1).max(200),
          accountId: z.uuid().optional(),
        }),
        response: { 201: BookingFileSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const contentType = (request.headers['content-type'] ?? '').split(';')[0]!.trim();
      if (contentType !== 'text/csv' && contentType !== 'text/plain')
        throw new AppError('validation_failed', 'Send the file as text/csv.');
      const text = request.body as string;
      const principal = request.ctx.principal;
      if (request.query.accountId && !canSeeAccount(principal, request.query.accountId))
        throw forbidden('You cannot send bookings for this account.');
      const accountId =
        request.query.accountId ??
        (principal.accountScope.type === 'accounts'
          ? principal.accountScope.accountIds[0]
          : undefined);
      if (!accountId)
        throw new AppError(
          'validation_failed',
          'Say which account the bookings are for (accountId).',
        );
      const sha = createHash('sha256').update(text).digest('hex');
      const id = randomUUID();
      const key = `bookings/${id}.csv`;
      await deps.files.put(key, Readable.from(Buffer.from(text, 'utf8')), 6 * 1024 * 1024);
      const file = await withTx(deps.pool, request.ctx, async (tx) => {
        if (
          !(await tx.query(`SELECT 1 FROM platform.accounts WHERE id = $1`, [accountId])).rowCount
        )
          throw notFound('The account');
        try {
          return (
            await tx.query<FileRow>(
              `INSERT INTO channels.booking_files (id, account_id, file_name, sha256, storage_key, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${FILE_COLS}`,
              [id, accountId, request.query.fileName, sha, key, principal.subject],
            )
          ).rows[0]!;
        } catch (err) {
          if (isUniqueViolation(err))
            throw conflict('This file has already been loaded for the account.');
          throw err;
        }
      }).catch(async (err) => {
        await deps.files.remove(key);
        throw err;
      });

      const parsed = parseBookingFile(text);
      const finish = (
        status: 'completed' | 'rejected',
        c: { bookings: number; accepted: number; rejected: number },
        reason: string | null,
        resultKey: string | null,
      ) =>
        withTx(deps.pool, request.ctx, async (tx) => {
          const r = (
            await tx.query<FileRow>(
              `UPDATE channels.booking_files SET status = $2, bookings = $3, accepted = $4, rejected = $5, reason = $6, result_key = $7 WHERE id = $1 RETURNING ${FILE_COLS}`,
              [id, status, c.bookings, c.accepted, c.rejected, reason, resultKey],
            )
          ).rows[0]!;
          await writeAudit(tx, request.ctx, {
            action: 'booking_file.processed',
            resourceType: 'booking_file',
            resourceId: id,
            accountId,
            data: { fileName: file.file_name, sha256: sha, status, ...c, reason },
          });
          return r;
        });
      if (parsed.fileProblem)
        return reply
          .code(201)
          .send(
            toFile(
              await finish(
                'rejected',
                { bookings: 0, accepted: 0, rejected: 0 },
                parsed.fileProblem,
                null,
              ),
            ),
          );

      const results: BookingResult[] = parsed.rejected.map((r) => ({
        ref: r.ref,
        rows: r.rows,
        status: 'rejected',
        reasons: r.reasons,
      }));
      const headers = {
        authorization: request.headers.authorization ?? '',
        'content-type': 'application/json',
        [INTERNAL_HEADER]: INTERNAL_KEY,
        'x-correlation-id': request.ctx.correlationId,
      };
      for (const b of parsed.bookings) {
        const q = await app.inject({
          method: 'POST',
          url: '/v1/quotes',
          headers,
          payload: {
            accountId,
            planCode: b.planCode,
            state: b.state,
            travellers: b.travellers,
            trip: { ...b.trip, destinations: b.trip.destinations },
            selection: b.selection,
          },
        });
        if (q.statusCode !== 201) {
          results.push({
            ref: b.ref,
            rows: b.rows,
            status: 'rejected',
            reasons: reasonsOf(q.json()),
          });
          continue;
        }
        const quote = q.json() as { id: string };
        const bound = await app.inject({
          method: 'POST',
          url: `/v1/quotes/${quote.id}/bind`,
          headers: {
            ...headers,
            'idempotency-key': `bf-${sha.slice(0, 16)}-${b.ref}`.slice(0, 200),
          },
          payload: {
            ableToTravel: true,
            acknowledgement: b.acknowledgement,
            payment: b.payment,
            purchaser: b.purchaser,
          },
        });
        if (bound.statusCode === 201) {
          const policy = bound.json() as { number: string; record: { premium: { total: string } } };
          results.push({
            ref: b.ref,
            rows: b.rows,
            status: 'accepted',
            policyNumber: policy.number,
            premium: policy.record.premium.total,
            reasons: [],
          });
        } else
          results.push({
            ref: b.ref,
            rows: b.rows,
            status: 'rejected',
            reasons: reasonsOf(bound.json()),
          });
      }
      const ordered = results.sort((a, b) => a.rows[0]! - b.rows[0]!);
      const resultKey = `bookings/${id}.result.csv`;
      await deps.files.put(
        resultKey,
        Readable.from(Buffer.from(resultCsv(ordered), 'utf8')),
        6 * 1024 * 1024,
      );
      const accepted = ordered.filter((r) => r.status === 'accepted').length;
      return reply
        .code(201)
        .send(
          toFile(
            await finish(
              'completed',
              { bookings: ordered.length, accepted, rejected: ordered.length - accepted },
              null,
              resultKey,
            ),
          ),
        );
    },
  );

  app.get(
    '/v1/booking-files',
    {
      config: { tenancy: 'account', permission: 'quotes:read' },
      schema: {
        tags: ['Channels'],
        summary: 'Booking files sent, newest first',
        querystring: z.object({
          accountId: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        }),
        response: { 200: z.object({ items: z.array(BookingFileSchema) }), ...commonErrors },
      },
    },
    async (request) => {
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<FileRow>(
          `SELECT ${FILE_COLS} FROM channels.booking_files WHERE ($1::uuid IS NULL OR account_id = $1) ORDER BY created_at DESC LIMIT $2`,
          [request.query.accountId ?? null, request.query.limit],
        ),
      );
      return { items: rows.map(toFile) };
    },
  );

  app.get(
    '/v1/booking-files/:id/result',
    {
      config: { tenancy: 'account', permission: 'quotes:read' },
      schema: {
        tags: ['Channels'],
        summary:
          'The result file: each booking accepted (with its policy number) or rejected (with every reason)',
        params: idParams,
        produces: ['text/csv'],
        response: { ...commonErrors },
      },
    },
    async (request, reply) => {
      const f = await withTx(deps.pool, request.ctx, async (tx) => {
        const r = (
          await tx.query<{ result_key: string | null; file_name: string }>(
            `SELECT result_key, file_name FROM channels.booking_files WHERE id = $1`,
            [request.params.id],
          )
        ).rows[0];
        if (!r) throw notFound('The booking file');
        if (!r.result_key)
          throw conflict(
            'This file has no result file: it was refused as a whole (see its reason).',
          );
        return r;
      });
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="${f.file_name.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._-]/g, '_')}-result.csv"`,
        )
        .send(deps.files.read(f.result_key!) as never);
    },
  );
};
