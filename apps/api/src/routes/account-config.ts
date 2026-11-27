import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  AccountDocumentSchema,
  AccountProfileInputSchema,
  AccountProfileSchema,
  AccountStatusChanged,
  CollectedVariablesSchema,
  CollectedVariablesViewSchema,
  CreateLicenceSchema,
  DecideSegmentSchema,
  GoLiveSchema,
  LICENCE_ALERT_DAYS,
  LicenceSchema,
  OnboardingSchema,
  SandboxCredentialsSchema,
  SandboxStatusSchema,
  SegmentChangeRequestSchema,
  SegmentChangeSchema,
  type AccountProfile,
  type Licence,
  type SegmentChange,
} from '@astra/contracts';
import {
  AppError,
  conflict,
  forbidden,
  FileTooLargeError,
  notFound,
  publishEvent,
  withTx,
  writeAudit,
  type Tx,
} from '@astra/platform';
import { extractText, UnreadableDocumentError } from '@astra/studio';
import type { AppDeps } from '../app';
import { commonErrors } from './shared';
import { onboardingStatus } from '../accounts/config';

/** Account profile, segment, collected variables, licences, onboarding, contract documents and the sandbox (E07). Design: docs/adr/0014. */

const idParams = z.object({ id: z.uuid() });
const CONTENT_TYPES = ['application/pdf', 'text/plain'] as const;
const MAX_DOC_BYTES = 25 * 1024 * 1024;
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const today = (d: Date) => d.toISOString().slice(0, 10);

interface ProfileRow {
  account_id: string;
  contract_reference: string | null;
  contract_signed_on: string | null;
  states: string[];
  plans: string[];
  integration_method: AccountProfile['integrationMethod'];
  rate_basis: AccountProfile['rateBasis'];
  settlement: AccountProfile['settlement'];
  updated_at: Date;
  updated_by: string;
}
const PROFILE_SELECT = `SELECT account_id, contract_reference, contract_signed_on::text, states, plans, integration_method, rate_basis, settlement, updated_at, updated_by FROM onboarding.profiles`;
const toProfile = (r: ProfileRow): AccountProfile => ({
  accountId: r.account_id,
  contractReference: r.contract_reference,
  contractSignedOn: r.contract_signed_on,
  states: r.states,
  plans: r.plans,
  integrationMethod: r.integration_method,
  rateBasis: r.rate_basis,
  settlement: r.settlement,
  updatedAt: r.updated_at.toISOString(),
  updatedBy: r.updated_by,
});
const emptyProfile = (accountId: string): AccountProfile => ({
  accountId,
  contractReference: null,
  contractSignedOn: null,
  states: [],
  plans: [],
  integrationMethod: null,
  rateBasis: null,
  settlement: null,
  updatedAt: new Date(0).toISOString(),
  updatedBy: '',
});

interface SegRow {
  id: string;
  account_id: string;
  segment: string;
  segment_name: string | null;
  effective_from: string;
  status: SegmentChange['status'];
  reason: string;
  requested_by: string;
  requested_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
}
const SEG_SELECT = `SELECT s.id, s.account_id, s.segment, (SELECT e.data->>'name' FROM refdata.entries e JOIN refdata.versions v ON v.id = e.version_id WHERE v.dataset = 'business_segments' AND v.status = 'approved' AND e.key = s.segment ORDER BY v.effective_from DESC LIMIT 1) AS segment_name,
       s.effective_from::text, s.status, s.reason, s.requested_by, s.requested_at, s.decided_by, s.decided_at, s.decision_note FROM onboarding.segment_changes s`;
const toSeg = (r: SegRow): SegmentChange => ({
  id: r.id,
  accountId: r.account_id,
  segment: r.segment,
  segmentName: r.segment_name,
  effectiveFrom: r.effective_from,
  status: r.status,
  reason: r.reason,
  requestedBy: r.requested_by,
  requestedAt: r.requested_at.toISOString(),
  decidedBy: r.decided_by,
  decidedAt: iso(r.decided_at),
  decisionNote: r.decision_note,
});

interface LicRow {
  id: string;
  account_id: string;
  account_name: string | null;
  kind: Licence['kind'];
  state: string;
  number: string;
  holder: string;
  valid_from: string;
  expires_on: string;
  status: 'active' | 'revoked';
  created_by: string;
  alerts: number[] | null;
}
const LIC_SELECT = `SELECT l.id, l.account_id, a.name AS account_name, l.kind, l.state, l.number, l.holder, l.valid_from::text, l.expires_on::text, l.status, l.created_by,
       (SELECT array_agg(x.days ORDER BY x.days DESC) FROM onboarding.licence_alerts x WHERE x.licence_id = l.id) AS alerts
  FROM onboarding.licences l JOIN platform.accounts a ON a.id = l.account_id`;
const toLicence = (r: LicRow, now: Date): Licence => {
  const t = today(now);
  const days = Math.round(
    (Date.parse(`${r.expires_on}T00:00:00Z`) - Date.parse(`${t}T00:00:00Z`)) / 86_400_000,
  );
  return {
    id: r.id,
    accountId: r.account_id,
    accountName: r.account_name,
    kind: r.kind,
    state: r.state,
    number: r.number,
    holder: r.holder,
    validFrom: r.valid_from,
    expiresOn: r.expires_on,
    status: r.status,
    inForce: r.status === 'active' && r.valid_from <= t && r.expires_on >= t,
    daysLeft: days,
    alertsSent: r.alerts ?? [],
    createdBy: r.created_by,
  };
};

async function mustSee(
  tx: Tx,
  id: string,
): Promise<{ id: string; code: string; name: string; sandbox: boolean; status: string }> {
  const a = (
    await tx.query<{ id: string; code: string; name: string; sandbox: boolean; status: string }>(
      `SELECT id, code, name, sandbox, status FROM platform.accounts WHERE id = $1`,
      [id],
    )
  ).rows[0];
  if (!a) throw notFound('The account');
  return a;
}

export const accountConfigRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  const clock = () => deps.now?.() ?? new Date();
  // Contracts stream to storage unparsed (scoped to this plugin's routes; text/plain replaces the default).
  app.removeContentTypeParser('text/plain');
  for (const type of CONTENT_TYPES)
    app.addContentTypeParser(type, (_request, payload, done) => done(null, payload));

  // ---------------- Profile ----------------

  app.get(
    '/v1/accounts/:id/profile',
    {
      config: { tenancy: 'account', permission: 'accounts:read' },
      schema: {
        tags: ['Account setup'],
        summary:
          'An account’s contract, states, plans, integration method, billing basis and settlement terms (E07-F01-S01)',
        params: idParams,
        response: { 200: AccountProfileSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        await mustSee(tx, request.params.id);
        const r = (
          await tx.query<ProfileRow>(`${PROFILE_SELECT} WHERE account_id = $1`, [request.params.id])
        ).rows[0];
        return r ? toProfile(r) : emptyProfile(request.params.id);
      }),
  );

  app.put(
    '/v1/accounts/:id/profile',
    {
      config: { tenancy: 'platform', permission: 'accounts:manage' },
      schema: {
        tags: ['Account setup'],
        summary: 'Set the fields of an account’s profile',
        description:
          'Only the fields sent change. The profile is what the onboarding checklist and go-live read.',
        params: idParams,
        body: AccountProfileInputSchema,
        response: { 200: AccountProfileSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const id = request.params.id;
        await mustSee(tx, id);
        const b = request.body;
        const cur = (await tx.query<ProfileRow>(`${PROFILE_SELECT} WHERE account_id = $1`, [id]))
          .rows[0];
        const base = cur ? toProfile(cur) : emptyProfile(id);
        const next = {
          contractReference:
            b.contractReference === undefined ? base.contractReference : b.contractReference,
          contractSignedOn:
            b.contractSignedOn === undefined ? base.contractSignedOn : b.contractSignedOn,
          states: b.states ?? base.states,
          plans: b.plans ?? base.plans,
          integrationMethod:
            b.integrationMethod === undefined ? base.integrationMethod : b.integrationMethod,
          rateBasis: b.rateBasis === undefined ? base.rateBasis : b.rateBasis,
          settlement: b.settlement === undefined ? base.settlement : b.settlement,
        };
        const row = (
          await tx.query<ProfileRow>(
            `INSERT INTO onboarding.profiles (account_id, contract_reference, contract_signed_on, states, plans, integration_method, rate_basis, settlement, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (account_id) DO UPDATE SET contract_reference = $2, contract_signed_on = $3, states = $4, plans = $5, integration_method = $6, rate_basis = $7, settlement = $8, updated_by = $9, updated_at = now()
             RETURNING account_id, contract_reference, contract_signed_on::text, states, plans, integration_method, rate_basis, settlement, updated_at, updated_by`,
            [
              id,
              next.contractReference,
              next.contractSignedOn,
              [...new Set(next.states)],
              [...new Set(next.plans)],
              next.integrationMethod,
              next.rateBasis ? JSON.stringify(next.rateBasis) : null,
              next.settlement ? JSON.stringify(next.settlement) : null,
              request.ctx.principal.subject,
            ],
          )
        ).rows[0]!;
        await writeAudit(tx, request.ctx, {
          action: 'account_profile.updated',
          resourceType: 'account',
          resourceId: id,
          accountId: id,
          data: { fields: Object.keys(b) },
        });
        return toProfile(row);
      }),
  );

  // ---------------- Onboarding and go-live ----------------

  app.get(
    '/v1/accounts/:id/onboarding',
    {
      config: { tenancy: 'account', permission: 'accounts:read' },
      schema: {
        tags: ['Account setup'],
        summary: 'The onboarding checklist, judged from what is configured (E07-F01-S01)',
        params: idParams,
        response: { 200: OnboardingSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        await mustSee(tx, request.params.id);
        return onboardingStatus(tx, request.params.id, clock());
      }),
  );

  app.post(
    '/v1/accounts/:id/go-live',
    {
      config: { tenancy: 'platform', permission: 'accounts:manage' },
      schema: {
        tags: ['Account setup'],
        summary: 'Take an account live (E07-F01-S01)',
        description:
          'Refused, with each item that is not complete, until the whole checklist is complete and tested. Going live sets the account active and switches licence enforcement on, so it sells only in states where it holds an unexpired licence.',
        params: idParams,
        body: GoLiveSchema,
        response: { 200: OnboardingSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const id = request.params.id;
        const a = await mustSee(tx, id);
        if (a.sandbox) throw conflict('A sandbox account does not go live.');
        if (a.status !== 'onboarding')
          throw conflict(`This account is ${a.status}; only an account in onboarding goes live.`);
        const o = await onboardingStatus(tx, id, clock());
        if (!o.complete) {
          const open = o.items.filter((i) => !i.complete);
          throw new AppError(
            'precondition_failed',
            `The account cannot go live yet: ${open.map((i) => `${i.label} (${i.detail})`).join(' ')}`,
            open.map((i) => ({ code: 'onboarding_incomplete', field: i.item, message: i.detail })),
          );
        }
        await tx.query(
          `UPDATE platform.accounts SET status = 'active', licences_enforced = true, live_at = now(), updated_at = now() WHERE id = $1`,
          [id],
        );
        await publishEvent(
          tx,
          request.ctx,
          AccountStatusChanged,
          { accountId: id, from: 'onboarding', to: 'active', reason: request.body.note },
          { accountId: id },
        );
        await writeAudit(tx, request.ctx, {
          action: 'account.went_live',
          resourceType: 'account',
          resourceId: id,
          accountId: id,
          reason: request.body.note,
          data: { items: o.items.length },
        });
        return onboardingStatus(tx, id, clock());
      }),
  );

  // ---------------- Segment (E07-F02-S01) ----------------

  app.post(
    '/v1/accounts/:id/segment-changes',
    {
      config: { tenancy: 'platform', permission: 'accounts:manage' },
      schema: {
        tags: ['Account setup'],
        summary: 'Request a business segment for an account from an effective date',
        description:
          'The segment must be in the filed list (reference data). An underwriter other than the requester approves it.',
        params: idParams,
        body: SegmentChangeRequestSchema,
        response: { 201: SegmentChangeSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const out = await withTx(deps.pool, request.ctx, async (tx) => {
        const id = request.params.id;
        await mustSee(tx, id);
        const b = request.body;
        const listed = (
          await tx.query(
            `SELECT 1 FROM refdata.entries e JOIN refdata.versions v ON v.id = e.version_id WHERE v.dataset = 'business_segments' AND v.status = 'approved' AND e.key = $1`,
            [b.segment],
          )
        ).rowCount;
        if (!listed)
          throw new AppError(
            'validation_failed',
            `${b.segment} is not in the filed list of business segments.`,
            [
              {
                code: 'segment',
                field: 'segment',
                message: 'Choose a segment from the filed list',
              },
            ],
          );
        if (
          (
            await tx.query(
              `SELECT 1 FROM onboarding.segment_changes WHERE account_id = $1 AND status = 'pending'`,
              [id],
            )
          ).rowCount
        )
          throw conflict('A segment change for this account is already waiting for approval.');
        const row = (
          await tx.query<{ id: string }>(
            `INSERT INTO onboarding.segment_changes (account_id, segment, effective_from, reason, requested_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [id, b.segment, b.effectiveFrom, b.reason, request.ctx.principal.subject],
          )
        ).rows[0]!;
        await writeAudit(tx, request.ctx, {
          action: 'segment_change.requested',
          resourceType: 'account',
          resourceId: id,
          accountId: id,
          reason: b.reason,
          data: { segment: b.segment, effectiveFrom: b.effectiveFrom },
        });
        return toSeg((await tx.query<SegRow>(`${SEG_SELECT} WHERE s.id = $1`, [row.id])).rows[0]!);
      });
      return reply.code(201).send(out);
    },
  );

  app.get(
    '/v1/accounts/:id/segment-changes',
    {
      config: { tenancy: 'account', permission: 'accounts:read' },
      schema: {
        tags: ['Account setup'],
        summary: 'An account’s segment changes, newest first',
        params: idParams,
        response: { 200: z.object({ items: z.array(SegmentChangeSchema) }), ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        await mustSee(tx, request.params.id);
        const { rows } = await tx.query<SegRow>(
          `${SEG_SELECT} WHERE s.account_id = $1 ORDER BY s.requested_at DESC`,
          [request.params.id],
        );
        return { items: rows.map(toSeg) };
      }),
  );

  app.get(
    '/v1/segment-changes',
    {
      config: { tenancy: 'account', permission: 'accounts:read' },
      schema: {
        tags: ['Account setup'],
        summary: 'Segment changes waiting for an underwriter',
        querystring: z.object({
          status: z.enum(['pending', 'approved', 'declined']).default('pending'),
        }),
        response: { 200: z.object({ items: z.array(SegmentChangeSchema) }), ...commonErrors },
      },
    },
    async (request) => {
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<SegRow>(
          `${SEG_SELECT} WHERE s.status = $1 ORDER BY s.requested_at DESC LIMIT 200`,
          [request.query.status],
        ),
      );
      return { items: rows.map(toSeg) };
    },
  );

  app.post(
    '/v1/segment-changes/:id/decision',
    {
      config: { tenancy: 'platform', permission: 'underwriting:approve' },
      schema: {
        tags: ['Account setup'],
        summary: 'An underwriter approves or declines a segment change',
        params: idParams,
        body: DecideSegmentSchema,
        response: { 200: SegmentChangeSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const cur = (
          await tx.query<{
            status: string;
            requested_by: string;
            account_id: string;
            segment: string;
          }>(
            `SELECT status, requested_by, account_id, segment FROM onboarding.segment_changes WHERE id = $1 FOR UPDATE`,
            [request.params.id],
          )
        ).rows[0];
        if (!cur) throw notFound('The segment change');
        if (cur.status !== 'pending') throw conflict(`This change is already ${cur.status}.`);
        if (cur.requested_by === request.ctx.principal.subject)
          throw forbidden(
            'A segment change is decided by someone other than the person who requested it.',
          );
        const status = request.body.decision === 'approve' ? 'approved' : 'declined';
        await tx.query(
          `UPDATE onboarding.segment_changes SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`,
          [request.params.id, status, request.ctx.principal.subject, request.body.note],
        );
        await writeAudit(tx, request.ctx, {
          action: `segment_change.${status}`,
          resourceType: 'account',
          resourceId: cur.account_id,
          accountId: cur.account_id,
          reason: request.body.note,
          data: { segment: cur.segment },
        });
        return toSeg(
          (await tx.query<SegRow>(`${SEG_SELECT} WHERE s.id = $1`, [request.params.id])).rows[0]!,
        );
      }),
  );

  // ---------------- Collected variables (E07-F02-S02) ----------------

  app.get(
    '/v1/accounts/:id/collected-variables',
    {
      config: { tenancy: 'account', permission: 'accounts:read' },
      schema: {
        tags: ['Account setup'],
        summary: 'The rating variables the account does not collect',
        params: idParams,
        response: { 200: CollectedVariablesViewSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        await mustSee(tx, request.params.id);
        const r = (
          await tx.query<{
            not_collected: never[];
            reason: string;
            decided_by: string;
            decided_at: Date;
          }>(
            `SELECT not_collected, reason, decided_by, decided_at FROM onboarding.collected_variables WHERE account_id = $1`,
            [request.params.id],
          )
        ).rows[0];
        return r
          ? {
              decided: true,
              notCollected: r.not_collected,
              decidedBy: r.decided_by,
              decidedAt: r.decided_at.toISOString(),
              reason: r.reason,
            }
          : { decided: false, notCollected: [], decidedBy: null, decidedAt: null, reason: null };
      }),
  );

  app.put(
    '/v1/accounts/:id/collected-variables',
    {
      config: { tenancy: 'platform', permission: 'rating:manage' },
      schema: {
        tags: ['Account setup'],
        summary: 'Record which rating variables the account collects (E07-F02-S02)',
        description:
          'The listed variables are not collected, so the rating engine applies the filed "not collected" factors for them and prints that on the worksheet. Quotes read this at once.',
        params: idParams,
        body: CollectedVariablesSchema,
        response: { 200: CollectedVariablesViewSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const id = request.params.id;
        await mustSee(tx, id);
        const b = request.body;
        const set = [...new Set(b.notCollected)];
        await tx.query(
          `INSERT INTO onboarding.collected_variables (account_id, not_collected, reason, decided_by) VALUES ($1, $2, $3, $4) ON CONFLICT (account_id) DO UPDATE SET not_collected = $2, reason = $3, decided_by = $4, decided_at = now()`,
          [id, set, b.reason, request.ctx.principal.subject],
        );
        await writeAudit(tx, request.ctx, {
          action: 'collected_variables.set',
          resourceType: 'account',
          resourceId: id,
          accountId: id,
          reason: b.reason,
          data: { notCollected: set },
        });
        return {
          decided: true,
          notCollected: set,
          decidedBy: request.ctx.principal.subject,
          decidedAt: new Date().toISOString(),
          reason: b.reason,
        };
      }),
  );

  // ---------------- Licences (E07-F03-S01) ----------------

  app.post(
    '/v1/accounts/:id/licences',
    {
      config: { tenancy: 'platform', permission: 'licences:manage' },
      schema: {
        tags: ['Account setup'],
        summary: 'Record a travel retailer registration or producer licence for a state',
        description: `Alerts are raised ${LICENCE_ALERT_DAYS.join(' and ')} days before it expires. From go-live the account sells in the state only while it holds one in force.`,
        params: idParams,
        body: CreateLicenceSchema,
        response: { 201: LicenceSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const out = await withTx(deps.pool, request.ctx, async (tx) => {
        const id = request.params.id;
        await mustSee(tx, id);
        const b = request.body;
        const dup = (
          await tx.query(
            `SELECT 1 FROM onboarding.licences WHERE account_id = $1 AND kind = $2 AND state = $3 AND number = $4`,
            [id, b.kind, b.state, b.number],
          )
        ).rowCount;
        if (dup) throw conflict(`${b.number} is already recorded for ${b.state}.`);
        const row = (
          await tx.query<{ id: string }>(
            `INSERT INTO onboarding.licences (account_id, kind, state, number, holder, valid_from, expires_on, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [
              id,
              b.kind,
              b.state,
              b.number,
              b.holder,
              b.validFrom,
              b.expiresOn,
              request.ctx.principal.subject,
            ],
          )
        ).rows[0]!;
        await writeAudit(tx, request.ctx, {
          action: 'licence.recorded',
          resourceType: 'licence',
          resourceId: row.id,
          accountId: id,
          data: { kind: b.kind, state: b.state, number: b.number, expiresOn: b.expiresOn },
        });
        return toLicence(
          (await tx.query<LicRow>(`${LIC_SELECT} WHERE l.id = $1`, [row.id])).rows[0]!,
          clock(),
        );
      });
      return reply.code(201).send(out);
    },
  );

  app.get(
    '/v1/licences',
    {
      config: { tenancy: 'account', permission: 'accounts:read' },
      schema: {
        tags: ['Account setup'],
        summary: 'Licences and registrations, soonest to expire first',
        querystring: z.object({
          accountId: z.uuid().optional(),
          state: z
            .string()
            .regex(/^[A-Z]{2}$/)
            .optional(),
          expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
        }),
        response: { 200: z.object({ items: z.array(LicenceSchema) }), ...commonErrors },
      },
    },
    async (request) => {
      const q = request.query;
      const now = clock();
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<LicRow>(
          `${LIC_SELECT} WHERE ($1::uuid IS NULL OR l.account_id = $1) AND ($2::text IS NULL OR l.state = $2) AND ($3::int IS NULL OR (l.status = 'active' AND l.expires_on <= $4::date + $3::int)) ORDER BY l.expires_on LIMIT 500`,
          [q.accountId ?? null, q.state ?? null, q.expiringWithinDays ?? null, today(now)],
        ),
      );
      return { items: rows.map((r) => toLicence(r, now)) };
    },
  );

  app.post(
    '/v1/licences/:id/revoke',
    {
      config: { tenancy: 'platform', permission: 'licences:manage' },
      schema: {
        tags: ['Account setup'],
        summary: 'Revoke a licence or registration',
        description: 'Sales in that state stop at once for an account that has gone live.',
        params: idParams,
        body: z.object({ reason: z.string().trim().min(3).max(500) }),
        response: { 200: LicenceSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const l = (
          await tx.query<{ account_id: string; status: string }>(
            `SELECT account_id, status FROM onboarding.licences WHERE id = $1 FOR UPDATE`,
            [request.params.id],
          )
        ).rows[0];
        if (!l) throw notFound('The licence');
        if (l.status === 'revoked') throw conflict('This licence is already revoked.');
        await tx.query(`UPDATE onboarding.licences SET status = 'revoked' WHERE id = $1`, [
          request.params.id,
        ]);
        await writeAudit(tx, request.ctx, {
          action: 'licence.revoked',
          resourceType: 'licence',
          resourceId: request.params.id,
          accountId: l.account_id,
          reason: request.body.reason,
          data: {},
        });
        return toLicence(
          (await tx.query<LicRow>(`${LIC_SELECT} WHERE l.id = $1`, [request.params.id])).rows[0]!,
          clock(),
        );
      }),
  );

  // ---------------- Contract documents for AG-05 (E07-F01-S02) ----------------

  app.post(
    '/v1/accounts/:id/documents',
    {
      config: { tenancy: 'platform', permission: 'accounts:manage' },
      bodyLimit: MAX_DOC_BYTES,
      schema: {
        tags: ['Account setup'],
        summary:
          'Upload the account’s contract or term sheet (PDF with a text layer, or plain text)',
        description:
          'The Account Onboarding agent reads these to draft the profile, citing the wording each field comes from.',
        params: idParams,
        querystring: z.object({
          kind: z.enum(['contract', 'term_sheet']),
          fileName: z.string().trim().min(1).max(200),
        }),
        response: { 201: AccountDocumentSchema, ...commonErrors, 413: z.any() },
      },
    },
    async (request, reply) => {
      const contentType = (request.headers['content-type'] ?? '').split(';')[0]!.trim();
      if (!(CONTENT_TYPES as readonly string[]).includes(contentType))
        throw new AppError(
          'validation_failed',
          'Send the document as application/pdf or text/plain.',
        );
      const id = request.params.id;
      await withTx(deps.pool, request.ctx, (tx) => mustSee(tx, id));
      const key = `accounts/${id}/${randomUUID()}`;
      let stored;
      try {
        stored = await deps.files.put(key, request.body as Readable, MAX_DOC_BYTES);
      } catch (err) {
        if (err instanceof FileTooLargeError)
          throw new AppError('payload_too_large', 'Documents are limited to 25 MB.');
        throw err;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of deps.files.read(key)) chunks.push(chunk as Buffer);
      let extracted;
      try {
        extracted = await extractText(new Uint8Array(Buffer.concat(chunks)), contentType);
      } catch (err) {
        await deps.files.remove(key);
        if (err instanceof UnreadableDocumentError || err instanceof TypeError)
          throw new AppError(
            'validation_failed',
            err instanceof UnreadableDocumentError
              ? err.message
              : 'The text file is not valid UTF-8.',
          );
        throw err;
      }
      const doc = await withTx(deps.pool, request.ctx, async (tx) => {
        const dup = (
          await tx.query(
            `SELECT 1 FROM onboarding.documents WHERE account_id = $1 AND sha256 = $2`,
            [id, stored.sha256],
          )
        ).rowCount;
        if (dup) throw conflict('This document has already been uploaded for the account.');
        const row = (
          await tx.query<{ id: string; uploaded_at: Date }>(
            `INSERT INTO onboarding.documents (account_id, kind, file_name, storage_key, sha256, size_bytes, text, page_starts, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, uploaded_at`,
            [
              id,
              request.query.kind,
              request.query.fileName,
              key,
              stored.sha256,
              stored.sizeBytes,
              extracted.text,
              extracted.pageStarts,
              request.ctx.principal.subject,
            ],
          )
        ).rows[0]!;
        await writeAudit(tx, request.ctx, {
          action: 'account_document.uploaded',
          resourceType: 'account',
          resourceId: id,
          accountId: id,
          data: {
            kind: request.query.kind,
            fileName: request.query.fileName,
            sha256: stored.sha256,
          },
        });
        return {
          id: row.id,
          accountId: id,
          kind: request.query.kind,
          fileName: request.query.fileName,
          sizeBytes: stored.sizeBytes,
          pages: extracted.pageStarts.length,
          uploadedBy: request.ctx.principal.subject,
          uploadedAt: row.uploaded_at.toISOString(),
        };
      }).catch(async (err) => {
        await deps.files.remove(key);
        throw err;
      });
      return reply.code(201).send(doc);
    },
  );

  app.get(
    '/v1/accounts/:id/documents',
    {
      config: { tenancy: 'account', permission: 'accounts:read' },
      schema: {
        tags: ['Account setup'],
        summary: 'An account’s contract documents',
        params: idParams,
        response: { 200: z.object({ items: z.array(AccountDocumentSchema) }), ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        await mustSee(tx, request.params.id);
        const { rows } = await tx.query<{
          id: string;
          account_id: string;
          kind: 'contract' | 'term_sheet';
          file_name: string;
          size_bytes: string;
          pages: number;
          uploaded_by: string;
          uploaded_at: Date;
        }>(
          `SELECT id, account_id, kind, file_name, size_bytes::text, cardinality(page_starts) AS pages, uploaded_by, uploaded_at FROM onboarding.documents WHERE account_id = $1 ORDER BY uploaded_at DESC`,
          [request.params.id],
        );
        return {
          items: rows.map((r) => ({
            id: r.id,
            accountId: r.account_id,
            kind: r.kind,
            fileName: r.file_name,
            sizeBytes: Number(r.size_bytes),
            pages: r.pages,
            uploadedBy: r.uploaded_by,
            uploadedAt: r.uploaded_at.toISOString(),
          })),
        };
      }),
  );

  app.get(
    '/v1/account-documents/:id/text',
    {
      config: { tenancy: 'account', permission: 'accounts:read' },
      schema: {
        tags: ['Account setup'],
        summary: 'The text of a contract document, with where each page starts',
        params: idParams,
        response: {
          200: z.object({
            text: z.string(),
            pageStarts: z.array(z.number().int()),
            fileName: z.string(),
            kind: z.enum(['contract', 'term_sheet']),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const r = (
          await tx.query<{
            text: string;
            page_starts: number[];
            file_name: string;
            kind: 'contract' | 'term_sheet';
          }>(`SELECT text, page_starts, file_name, kind FROM onboarding.documents WHERE id = $1`, [
            request.params.id,
          ])
        ).rows[0];
        if (!r) throw notFound('The document');
        return { text: r.text, pageStarts: r.page_starts, fileName: r.file_name, kind: r.kind };
      }),
  );

  // ---------------- Sandbox (E07-F03-S02) ----------------

  app.get(
    '/v1/accounts/:id/sandbox',
    {
      config: { tenancy: 'account', permission: 'accounts:read' },
      schema: {
        tags: ['Account setup'],
        summary: 'The account’s sandbox: its twin account, credentials issued and what it has done',
        params: idParams,
        response: { 200: SandboxStatusSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        await mustSee(tx, request.params.id);
        const twin = (
          await tx.query<{ id: string; code: string }>(
            `SELECT id, code FROM platform.accounts WHERE sandbox_of = $1`,
            [request.params.id],
          )
        ).rows[0];
        if (!twin) return { accountId: null, code: null, credentials: [], quotes: 0, policies: 0 };
        const creds = (
          await tx.query<{
            client_id: string;
            issued_at: Date;
            issued_by: string;
            revoked_at: Date | null;
          }>(
            `SELECT client_id, issued_at, issued_by, revoked_at FROM onboarding.credentials WHERE account_id = $1 ORDER BY issued_at DESC`,
            [twin.id],
          )
        ).rows;
        const t = (
          await tx.query<{ quotes: string; policies: string }>(
            `SELECT (SELECT count(*) FROM policies.quotes WHERE account_id = $1)::text AS quotes, (SELECT count(*) FROM policies.policies WHERE account_id = $1)::text AS policies`,
            [twin.id],
          )
        ).rows[0]!;
        return {
          accountId: twin.id,
          code: twin.code,
          credentials: creds.map((c) => ({
            clientId: c.client_id,
            issuedAt: c.issued_at.toISOString(),
            issuedBy: c.issued_by,
            revokedAt: iso(c.revoked_at),
          })),
          quotes: Number(t.quotes),
          policies: Number(t.policies),
        };
      }),
  );

  app.post(
    '/v1/accounts/:id/sandbox',
    {
      config: { tenancy: 'platform', permission: 'onboarding:sandbox' },
      schema: {
        tags: ['Account setup'],
        summary: 'Create the account’s sandbox twin (on signing)',
        description:
          'A separate account (`<code>-SBX`) that can quote, bind and service against the published plans with synthetic data. Its policies create no premium records and send no email.',
        params: idParams,
        response: { 201: SandboxStatusSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const out = await withTx(deps.pool, request.ctx, async (tx) => {
        const a = await mustSee(tx, request.params.id);
        if (a.sandbox) throw conflict('This is already a sandbox account.');
        if (
          (await tx.query(`SELECT 1 FROM platform.accounts WHERE sandbox_of = $1`, [a.id])).rowCount
        )
          throw conflict('This account already has a sandbox.');
        const kind = (
          await tx.query<{ kind: string }>(`SELECT kind FROM platform.accounts WHERE id = $1`, [
            a.id,
          ])
        ).rows[0]!.kind;
        const code = `${a.code}-SBX`.slice(0, 32);
        const twin = (
          await tx.query<{ id: string }>(
            `INSERT INTO platform.accounts (code, name, kind, status, created_by, sandbox, sandbox_of) VALUES ($1, $2, $3, 'active', $4, true, $5) RETURNING id`,
            [code, `${a.name} (sandbox)`.slice(0, 200), kind, request.ctx.principal.subject, a.id],
          )
        ).rows[0]!;
        await writeAudit(tx, request.ctx, {
          action: 'sandbox.created',
          resourceType: 'account',
          resourceId: a.id,
          accountId: a.id,
          data: { sandboxAccountId: twin.id, code },
        });
        return { accountId: twin.id, code, credentials: [], quotes: 0, policies: 0 };
      });
      return reply.code(201).send(out);
    },
  );

  app.post(
    '/v1/accounts/:id/sandbox/credentials',
    {
      config: { tenancy: 'platform', permission: 'onboarding:sandbox' },
      schema: {
        tags: ['Account setup'],
        summary: 'Issue sandbox credentials for the account’s developer (E07-F03-S02)',
        description:
          'Creates a client in the identity provider that carries the sandbox account’s claim and returns its secret once; the platform keeps only the client ID. Refused when the identity provider’s admin access is not configured.',
        params: idParams,
        response: { 201: SandboxCredentialsSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      if (!deps.credentials)
        throw new AppError(
          'precondition_failed',
          'Sandbox credentials cannot be issued: the identity provider’s admin access is not configured (IDP_ADMIN_URL, IDP_ADMIN_CLIENT_ID, IDP_ADMIN_CLIENT_SECRET).',
        );
      const twin = await withTx(deps.pool, request.ctx, async (tx) => {
        await mustSee(tx, request.params.id);
        const t = (
          await tx.query<{ id: string; code: string }>(
            `SELECT id, code FROM platform.accounts WHERE sandbox_of = $1`,
            [request.params.id],
          )
        ).rows[0];
        if (!t) throw conflict('Create the account’s sandbox first.');
        return t;
      });
      const issued = await deps.credentials.issue(twin);
      await withTx(deps.pool, request.ctx, async (tx) => {
        await tx.query(
          `INSERT INTO onboarding.credentials (account_id, client_id, issued_by) VALUES ($1, $2, $3)`,
          [twin.id, issued.clientId, request.ctx.principal.subject],
        );
        await writeAudit(tx, request.ctx, {
          action: 'sandbox.credentials_issued',
          resourceType: 'account',
          resourceId: request.params.id,
          accountId: request.params.id,
          data: { clientId: issued.clientId, sandboxAccountId: twin.id },
        });
      });
      return reply.code(201).send({
        ...issued,
        accountId: twin.id,
        note: 'Copy the secret now: it is not stored and cannot be shown again.',
      });
    },
  );

  app.post(
    '/v1/accounts/:id/sandbox/credentials/:clientId/revoke',
    {
      config: { tenancy: 'platform', permission: 'onboarding:sandbox' },
      schema: {
        tags: ['Account setup'],
        summary: 'Revoke sandbox credentials',
        params: z.object({ id: z.uuid(), clientId: z.string().min(3).max(200) }),
        response: { 200: SandboxStatusSchema, ...commonErrors },
      },
    },
    async (request) => {
      if (!deps.credentials)
        throw new AppError(
          'precondition_failed',
          'The identity provider’s admin access is not configured.',
        );
      const c = await withTx(deps.pool, request.ctx, async (tx) => {
        const r = (
          await tx.query<{ account_id: string; revoked_at: Date | null }>(
            `SELECT c.account_id, c.revoked_at FROM onboarding.credentials c JOIN platform.accounts a ON a.id = c.account_id WHERE c.client_id = $1 AND a.sandbox_of = $2`,
            [request.params.clientId, request.params.id],
          )
        ).rows[0];
        if (!r) throw notFound('The credentials');
        if (r.revoked_at) throw conflict('These credentials are already revoked.');
        return r;
      });
      await deps.credentials.revoke(request.params.clientId);
      return withTx(deps.pool, request.ctx, async (tx) => {
        await tx.query(
          `UPDATE onboarding.credentials SET revoked_at = now() WHERE client_id = $1`,
          [request.params.clientId],
        );
        await writeAudit(tx, request.ctx, {
          action: 'sandbox.credentials_revoked',
          resourceType: 'account',
          resourceId: request.params.id,
          accountId: request.params.id,
          data: { clientId: request.params.clientId },
        });
        const creds = (
          await tx.query<{
            client_id: string;
            issued_at: Date;
            issued_by: string;
            revoked_at: Date | null;
          }>(
            `SELECT client_id, issued_at, issued_by, revoked_at FROM onboarding.credentials WHERE account_id = $1 ORDER BY issued_at DESC`,
            [c.account_id],
          )
        ).rows;
        const t = (
          await tx.query<{ quotes: string; policies: string; code: string }>(
            `SELECT (SELECT count(*) FROM policies.quotes WHERE account_id = $1)::text AS quotes, (SELECT count(*) FROM policies.policies WHERE account_id = $1)::text AS policies, (SELECT code FROM platform.accounts WHERE id = $1) AS code`,
            [c.account_id],
          )
        ).rows[0]!;
        return {
          accountId: c.account_id,
          code: t.code,
          credentials: creds.map((x) => ({
            clientId: x.client_id,
            issuedAt: x.issued_at.toISOString(),
            issuedBy: x.issued_by,
            revokedAt: iso(x.revoked_at),
          })),
          quotes: Number(t.quotes),
          policies: Number(t.policies),
        };
      });
    },
  );
};
