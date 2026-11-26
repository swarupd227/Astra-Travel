import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ClaimsFeedSchema, DATA_CATALOGUE, DATA_CATALOGUE_VERSION, DataCatalogueSchema, DataLoadSchema, DataLoadStatusSchema, type ClaimsFeed, type DataLoad } from '@astra/contracts';
import { DATA_LOAD_TARGET_SECONDS, notFound, pendingLoad, runDataLoad, withTx, writeAudit } from '@astra/platform';
import type { AppDeps } from '../app';
import { commonErrors } from './shared';

/** The reporting data model, loads to the data platform and the claims feed (E12-F01, E14-F03-S04). Design: docs/adr/0018. */

const DESTINATION = 'Files in the platform’s store (data-platform/<load>/). No data platform connection has been supplied.';

interface LoadRow {
  id: string;
  number: string;
  started_at: Date;
  status: DataLoad['status'];
  trigger: DataLoad['trigger'];
  items: number;
  rejected: number;
  max_lag_seconds: number;
  checks: DataLoad['checks'];
  files: DataLoad['files'];
}

const toLoad = (r: LoadRow): DataLoad => ({
  id: r.id,
  number: Number(r.number),
  startedAt: r.started_at.toISOString(),
  status: r.status,
  trigger: r.trigger,
  items: r.items,
  rejected: r.rejected,
  maxLagSeconds: r.max_lag_seconds,
  checks: r.checks,
  files: r.files,
});

export const dataRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.get(
    '/v1/data-catalogue',
    {
      config: { tenancy: 'platform', permission: 'data:read' },
      schema: { tags: ['Data'], summary: 'The reporting data model: every entity and field, what it means and whether it is personal (E12-F01-S01)', response: { 200: DataCatalogueSchema, ...commonErrors } },
    },
    async () => ({
      version: DATA_CATALOGUE_VERSION,
      ontology: 'The platform’s own definitions. The Artizent P&C ontology has not been supplied; mapping to it is outstanding.',
      entities: DATA_CATALOGUE.map((e) => ({ ...e, fields: [...e.fields] })),
    }),
  );

  app.get(
    '/v1/data-loads',
    {
      config: { tenancy: 'platform', permission: 'data:read' },
      schema: { tags: ['Data'], summary: 'Loads to the data platform, newest first, and what is waiting (E12-F01-S02)', querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }), response: { 200: DataLoadStatusSchema, ...commonErrors } },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const { rows } = await tx.query<LoadRow>(`SELECT * FROM integration.data_loads ORDER BY number DESC LIMIT $1`, [request.query.limit]);
        return { items: rows.map(toLoad), pending: await pendingLoad(tx), targetSeconds: DATA_LOAD_TARGET_SECONDS, destination: DESTINATION };
      }),
  );

  app.post(
    '/v1/data-loads',
    {
      config: { tenancy: 'platform', permission: 'data:manage' },
      schema: {
        tags: ['Data'],
        summary: 'Run a load now. The worker also runs one every few minutes',
        response: { 200: z.object({ load: DataLoadSchema.nullable(), more: z.boolean() }), ...commonErrors },
      },
    },
    async (request) => {
      const r = await runDataLoad(deps.pool, request.ctx, deps.files, { trigger: 'manual' });
      if (r) await withTx(deps.pool, request.ctx, (tx) => writeAudit(tx, request.ctx, { action: 'data_load.run', resourceType: 'data_load', resourceId: r.load.id, data: { number: r.load.number, items: r.load.items, rejected: r.load.rejected } }));
      return { load: r?.load ?? null, more: r?.more ?? false };
    },
  );

  app.get(
    '/v1/data-loads/:loadId/files/:name',
    {
      config: { tenancy: 'platform', permission: 'data:read' },
      schema: { tags: ['Data'], summary: 'A file of a load (newline-delimited JSON)', params: z.object({ loadId: z.uuid(), name: z.string().regex(/^[a-z]+\.ndjson$/) }), produces: ['application/x-ndjson'], response: { ...commonErrors } },
    },
    async (request, reply) => {
      const { loadId, name } = request.params;
      await withTx(deps.pool, request.ctx, async (tx) => {
        const load = (await tx.query<{ files: DataLoad['files'] }>(`SELECT files FROM integration.data_loads WHERE id = $1`, [loadId])).rows[0];
        if (!load?.files.some((f) => f.name === name)) throw notFound('The file');
      });
      return reply.header('content-type', 'application/x-ndjson; charset=utf-8').header('content-disposition', `attachment; filename="${name}"`).send(deps.files.read(`data-platform/${loadId}/${name}`) as never);
    },
  );

  // ---------------- Claims feed ----------------

  app.get(
    '/v1/claims-feed',
    {
      config: { tenancy: 'platform', permission: 'claims:feed' },
      schema: {
        tags: ['Claims'],
        summary: 'Retail policies and card-linked certificates for the claims application, as they stand, changed since a cursor (E12-F01-S03)',
        description:
          'Call with no cursors for everything, then pass back `next` to get what changed. A policy appears again whenever it changes, with a higher `version`; keep the highest. Changes appear after a short settling time, so that none is missed while it is still being saved. Sandbox accounts are excluded. The format (astra.claims.v1) has not yet been agreed with the claims application’s owner.',
        querystring: z.object({
          policyCursor: z.coerce.number().int().min(0).default(0),
          certificateCursor: z.string().max(120).regex(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z\|[A-Za-z0-9_-]+)?$/).default(''),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
        response: { 200: ClaimsFeedSchema, ...commonErrors },
      },
    },
    async (request) => {
      const q = request.query;
      const settle = deps.config.CLAIMS_FEED_SETTLE_SECONDS;
      const [afterTime, afterNumber] = q.certificateCursor ? (q.certificateCursor.split('|') as [string, string]) : ['1970-01-01T00:00:00.000Z', ''];
      return withTx(deps.pool, request.ctx, async (tx): Promise<ClaimsFeed> => {
        const changed = (
          await tx.query<{ policy_id: string; version: string }>(
            `SELECT e.policy_id, max(e.seq) AS version
               FROM policies.policy_events e JOIN platform.accounts a ON a.id = e.account_id
              WHERE e.seq > $1 AND NOT a.sandbox AND e.occurred_at <= now() - make_interval(secs => $2)
              GROUP BY e.policy_id ORDER BY max(e.seq) LIMIT $3`,
            [q.policyCursor, settle, q.limit],
          )
        ).rows;
        const ids = changed.map((c) => c.policy_id);
        const policies = ids.length
          ? (
              await tx.query<{ id: string; number: string; status: ClaimsFeed['policies'][number]['status']; account_id: string; account_name: string; plan_code: string; plan_version: number; state: string; purchased_on: string; term_start: string; term_end: string; trip: { departureDate?: string; returnDate?: string; destinations?: { country?: string; region?: string }[] }; travellers: ClaimsFeed['policies'][number]['travellers']; benefits: ClaimsFeed['policies'][number]['benefits'] }>(
                `SELECT p.id, p.number, p.status, p.account_id, a.name AS account_name, pl.code AS plan_code, v.version AS plan_version, p.state::text AS state, p.purchased_on::text,
                        to_char(p.term_start, 'YYYY-MM-DD"T"HH24:MI') AS term_start, to_char(p.term_end, 'YYYY-MM-DD"T"HH24:MI') AS term_end, ct.trip,
                        (SELECT coalesce(jsonb_agg(jsonb_build_object('travellerId', t.traveller_id, 'firstName', t.first_name, 'lastName', t.last_name, 'dateOfBirth', t.date_of_birth) ORDER BY t.traveller_id), '[]') FROM policies.policy_travellers t WHERE t.policy_id = p.id) AS travellers,
                        (SELECT coalesce(jsonb_agg(jsonb_build_object('code', b.code, 'name', b.name, 'limits', b.limits, 'coverageStart', to_char(b.coverage_start, 'YYYY-MM-DD"T"HH24:MI'), 'coverageEnd', to_char(b.coverage_end, 'YYYY-MM-DD"T"HH24:MI')) ORDER BY b.code), '[]') FROM policies.policy_benefits b WHERE b.policy_id = p.id) AS benefits
                   FROM policies.policies p JOIN platform.accounts a ON a.id = p.account_id JOIN plans.plans pl ON pl.id = p.plan_id JOIN plans.plan_versions v ON v.id = p.plan_version_id
                   JOIN policies.current_trips ct ON ct.policy_id = p.id
                  WHERE p.id = ANY ($1::uuid[])`,
                [ids],
              )
            ).rows
          : [];
        const byId = new Map(policies.map((p) => [p.id, p]));
        const certificates = (
          await tx.query<{ certificate_number: string; code: string; name: string; account_id: string; policy_number: string; underwriter: string; states: string[]; account_ref: string; issued_at: Date; changed_at: Date; eligibility: ClaimsFeed['certificates'][number]['eligibility']; guide: string | null }>(
            `WITH c AS (
               SELECT c.*, greatest(c.issued_at, (SELECT max(f.processed_at) FROM card.eligibility_periods ep JOIN card.feeds f ON f.id IN (ep.established_by, ep.ended_by)
                                                  WHERE ep.programme_id = c.programme_id AND ep.account_ref = c.account_ref)) AS changed_at
                 FROM card.certificates c JOIN platform.accounts a ON a.id = c.account_id WHERE NOT a.sandbox
             )
             SELECT c.certificate_number, pr.code, pr.name, c.account_id, mp.policy_number, mp.underwriter, pr.states::text[] AS states, c.account_ref, c.issued_at,
                    date_trunc('milliseconds', c.changed_at) AS changed_at,
                    (SELECT coalesce(jsonb_agg(jsonb_build_object('productCode', ep.product_code, 'from', ep.valid_from, 'to', ep.valid_to) ORDER BY ep.valid_from, ep.id), '[]')
                       FROM card.eligibility_periods ep WHERE ep.programme_id = c.programme_id AND ep.account_ref = c.account_ref) AS eligibility,
                    (SELECT d.id FROM documents.documents d WHERE d.programme_id = c.programme_id AND d.kind = 'guide_to_benefits' AND d.status = 'issued' ORDER BY d.issued_at DESC LIMIT 1) AS guide
               FROM c JOIN card.programmes pr ON pr.id = c.programme_id JOIN card.master_policies mp ON mp.id = pr.master_policy_id
              WHERE (date_trunc('milliseconds', c.changed_at), c.certificate_number) > ($1::timestamptz, $2) AND c.changed_at <= now() - make_interval(secs => $3)
              ORDER BY date_trunc('milliseconds', c.changed_at), c.certificate_number LIMIT $4`,
            [afterTime, afterNumber, settle, q.limit],
          )
        ).rows;
        const last = certificates.at(-1);
        await writeAudit(tx, request.ctx, { action: 'claims_feed.read', resourceType: 'claims_feed', resourceId: 'astra.claims.v1', data: { policies: ids.length, certificates: certificates.length, policyCursor: q.policyCursor } });
        return {
          format: 'astra.claims.v1',
          generatedAt: new Date().toISOString(),
          policies: changed.flatMap((c) => {
            const p = byId.get(c.policy_id);
            if (!p) return [];
            return [
              {
                policyNumber: p.number,
                version: Number(c.version),
                status: p.status,
                accountId: p.account_id,
                accountName: p.account_name,
                planCode: p.plan_code,
                planVersion: p.plan_version,
                state: p.state,
                purchasedOn: p.purchased_on,
                coverageStart: p.term_start,
                coverageEnd: p.term_end,
                travellers: p.travellers,
                trip: { departureDate: p.trip.departureDate ?? null, returnDate: p.trip.returnDate ?? null, destinations: (p.trip.destinations ?? []).map((d) => ({ country: d.country ?? null, region: d.region ?? null })) },
                benefits: p.benefits,
              },
            ];
          }),
          certificates: certificates.map((c) => ({
            certificateNumber: c.certificate_number,
            programmeCode: c.code,
            programmeName: c.name,
            accountId: c.account_id,
            masterPolicyNumber: c.policy_number,
            underwriter: c.underwriter,
            states: c.states,
            cardholderRef: c.account_ref,
            issuedAt: c.issued_at.toISOString(),
            eligibility: c.eligibility,
            guideDocumentId: c.guide,
          })),
          next: {
            policyCursor: changed.length ? Number(changed.at(-1)!.version) : q.policyCursor,
            certificateCursor: last ? `${last.changed_at.toISOString()}|${last.certificate_number}` : q.certificateCursor,
            more: changed.length === q.limit || certificates.length === q.limit,
          },
        };
      });
    },
  );
};
