import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { DocumentIssued, type DocumentKind, type PolicyEvent, type PolicySnapshot } from '@astra/contracts';
import { BUILDER_VERSION, cancellationNotice, changeNotice, filedFormDocument, purchaseConfirmation, renderPdf, toText, type DocModel } from '@astra/documents';
import { AppError, conflict, notFound, publishEvent, writeAudit, type FileStore, type RequestContext, type Tx } from '@astra/platform';
import { project } from '@astra/policies';

/**
 * Issuing documents: the one place a document is rendered, stored and given its deliveries (E09-F01, E09-F03).
 * Bind calls it inside its transaction; staff and servicing call it for notices and for documents that
 * could not be produced at bind. Design: docs/adr/0011.
 */

const MAX_PDF_BYTES = 25 * 1024 * 1024;

export interface StoreInput {
  accountId: string;
  kind: DocumentKind;
  title: string;
  policyId: string | null;
  programmeId: string | null;
  templateId: string | null;
  eventSeq: number | null;
  source: string;
  version: number | null;
  model: DocModel;
  /** Where the email copy goes, when there is one. */
  email: string | null;
  actor: string;
  /** A failed record this issue settles. */
  replaces?: string | undefined;
}

/** Renders the document, keeps its PDF, records it and queues its deliveries. */
export async function storeDocument(tx: Tx, files: FileStore, input: StoreInput): Promise<string> {
  const text = toText(input.model);
  const pdf = Buffer.from(await renderPdf(input.model));
  const id = input.replaces ?? randomUUID();
  const stored = await files.put(`documents/${id}.pdf`, Readable.from(pdf), MAX_PDF_BYTES);
  if (input.replaces) {
    await tx.query(
      `UPDATE documents.documents SET status = 'issued', failure = NULL, title = $2, template_id = $3, source = $4, text = $5, file_key = $6, sha256 = $7, size_bytes = $8, issued_at = now() WHERE id = $1`,
      [id, input.title, input.templateId, input.source, text, stored.key, stored.sha256, stored.sizeBytes],
    );
  } else {
    await tx.query(
      `INSERT INTO documents.documents (id, account_id, kind, title, policy_id, programme_id, template_id, event_seq, source, version, status, text, file_key, sha256, size_bytes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'issued', $11, $12, $13, $14, $15)`,
      [id, input.accountId, input.kind, input.title, input.policyId, input.programmeId, input.templateId, input.eventSeq, input.source, input.version, text, stored.key, stored.sha256, stored.sizeBytes, input.actor],
    );
  }
  await tx.query(`INSERT INTO documents.deliveries (document_id, account_id, channel, status, delivered_at) VALUES ($1, $2, 'account', 'available', now())`, [id, input.accountId]);
  if (input.email) {
    await tx.query(`INSERT INTO documents.deliveries (document_id, account_id, channel, recipient, status, next_attempt_at) VALUES ($1, $2, 'email', $3, 'queued', now())`, [id, input.accountId, input.email]);
  }
  return id;
}

async function recordFailure(tx: Tx, input: Pick<StoreInput, 'accountId' | 'kind' | 'title' | 'policyId' | 'programmeId' | 'eventSeq' | 'actor'>, reason: string): Promise<string> {
  return (
    await tx.query<{ id: string }>(
      `INSERT INTO documents.documents (account_id, kind, title, policy_id, programme_id, event_seq, status, failure, created_by) VALUES ($1, $2, $3, $4, $5, $6, 'failed', $7, $8) RETURNING id`,
      [input.accountId, input.kind, input.title, input.policyId, input.programmeId, input.eventSeq, reason, input.actor],
    )
  ).rows[0]!.id;
}

export interface IssuedRef {
  id: string;
  kind: DocumentKind;
  status: 'issued' | 'failed';
  failure: string | null;
}

const TITLES: Record<string, string> = { schedule: 'Schedule', policy: 'Policy', purchase_confirmation: 'Purchase Confirmation' };

/**
 * The documents a policy has from bind: the purchase confirmation always, and the schedule and the policy form
 * from the plan's released templates. A document that cannot be produced is recorded as failed with its reason
 * (and settled later by issuing again); it never stops the policy being bound.
 */
export async function issuePolicyDocuments(
  tx: Tx,
  files: FileStore,
  ctx: RequestContext,
  p: { policyId: string; accountId: string; snapshot: PolicySnapshot; planVersionId: string },
): Promise<IssuedRef[]> {
  const plan = (await tx.query<{ policy_edition_id: string | null }>(`SELECT p.policy_edition_id FROM plans.plans p JOIN plans.plan_versions v ON v.plan_id = p.id WHERE v.id = $1`, [p.planVersionId])).rows[0]!;
  const have = (await tx.query<{ id: string; kind: DocumentKind; status: 'issued' | 'failed' }>(`SELECT id, kind, status FROM documents.documents WHERE policy_id = $1 AND kind IN ('purchase_confirmation', 'schedule', 'policy')`, [p.policyId])).rows;
  const wanted: DocumentKind[] = ['purchase_confirmation', 'schedule', ...(plan.policy_edition_id ? (['policy'] as const) : [])];
  const out: IssuedRef[] = [];
  const actor = ctx.principal.subject;
  // A sandbox account's documents are made but never emailed.
  const sandbox = (await tx.query<{ sandbox: boolean }>(`SELECT sandbox FROM platform.accounts WHERE id = $1`, [p.accountId])).rows[0]?.sandbox ?? false;
  const email = sandbox ? null : p.snapshot.purchaser.email;

  for (const kind of wanted) {
    const existing = have.find((h) => h.kind === kind);
    if (existing?.status === 'issued') continue;
    const base = { accountId: p.accountId, kind, title: TITLES[kind]!, policyId: p.policyId, programmeId: null, eventSeq: null, actor };
    let model: DocModel | null = null;
    let templateId: string | null = null;
    let source = `builder ${BUILDER_VERSION}`;
    let reason: string | null = null;
    try {
      if (kind === 'purchase_confirmation') {
        model = purchaseConfirmation(p.snapshot);
      } else {
        const t = (
          await tx.query<{ id: string; version: number; text: string; form_number: string; edition: string }>(
            `SELECT t.id, t.version, t.text, e.form_number, e.edition FROM documents.templates t JOIN studio.form_editions e ON e.id = t.edition_id
              WHERE t.plan_version_id = $1 AND t.kind = $2 AND t.status = 'released'`,
            [p.planVersionId, kind],
          )
        ).rows[0];
        if (!t) reason = `The plan version has no released ${kind} template. Release one, then issue the documents again.`;
        else {
          templateId = t.id;
          source = `template v${t.version} · builder ${BUILDER_VERSION}`;
          model = filedFormDocument(`${p.snapshot.plan.name} ${TITLES[kind]}`, p.snapshot, `${t.form_number} ed. ${t.edition}`, t.text);
        }
      }
    } catch (err) {
      reason = `The document could not be built: ${err instanceof Error ? err.message : String(err)}`;
    }
    let ref: IssuedRef;
    if (model) {
      try {
        const id = await storeDocument(tx, files, { ...base, title: model.title, templateId, source, version: null, model, email, replaces: existing?.id });
        ref = { id, kind, status: 'issued', failure: null };
      } catch (err) {
        if (err instanceof AppError) throw err;
        // Rendering or storing failed; SQL errors have thrown already because they abort the transaction.
        const msg = `The document could not be produced: ${err instanceof Error ? err.message : String(err)}`;
        ref = { id: existing?.id ?? (await recordFailure(tx, base, msg)), kind, status: 'failed', failure: msg };
      }
    } else if (existing) {
      ref = { id: existing.id, kind, status: 'failed', failure: reason };
    } else {
      ref = { id: await recordFailure(tx, base, reason!), kind, status: 'failed', failure: reason };
    }
    out.push(ref);
    await publishEvent(tx, ctx, DocumentIssued, { documentId: ref.id, kind, policyId: p.policyId, policyNumber: p.snapshot.number, status: ref.status }, { accountId: p.accountId });
  }
  if (out.length) {
    await writeAudit(tx, ctx, {
      action: 'documents.issued',
      resourceType: 'policy',
      resourceId: p.policyId,
      accountId: p.accountId,
      data: { number: p.snapshot.number, documents: out.map((o) => ({ id: o.id, kind: o.kind, status: o.status })) },
    });
  }
  return out;
}

const toEvent = (e: { seq: string | number; type: PolicyEvent['type']; occurred_at: Date; actor: string; actor_name: string | null; reason: string | null; data: Record<string, unknown> }): PolicyEvent => ({
  seq: Number(e.seq),
  type: e.type,
  occurredAt: e.occurred_at.toISOString(),
  actor: e.actor,
  actorName: e.actor_name,
  reason: e.reason,
  data: e.data,
});

export async function loadEvents(tx: Tx, policyId: string): Promise<PolicyEvent[]> {
  return (await tx.query<Parameters<typeof toEvent>[0]>(`SELECT seq, type, occurred_at, actor, actor_name, reason, data FROM policies.policy_events WHERE policy_id = $1 ORDER BY seq`, [policyId])).rows.map(toEvent);
}

/**
 * The notice for one change to a policy: what changed for a change of details, or the end of cover for a
 * cancellation or expiry (E09-F01-S03). One notice per event.
 */
export async function issueNotice(tx: Tx, files: FileStore, ctx: RequestContext, policyId: string, eventSeq: number): Promise<IssuedRef> {
  const pol = (await tx.query<{ id: string; account_id: string }>(`SELECT id, account_id FROM policies.policies WHERE id = $1`, [policyId])).rows[0];
  if (!pol) throw notFound('The policy');
  const events = await loadEvents(tx, policyId);
  const ev = events.find((e) => e.seq === eventSeq);
  if (!ev) throw notFound('That event of the policy');
  if (ev.type === 'bound') throw new AppError('validation_failed', 'The purchase confirmation covers the bind; a notice is for a change or a cancellation.');
  const dup = (await tx.query<{ id: string }>(`SELECT id FROM documents.documents WHERE policy_id = $1 AND event_seq = $2 AND status = 'issued'`, [policyId, eventSeq])).rows[0];
  if (dup) throw conflict('A notice has already been issued for this event.');
  const before = project(events.filter((e) => e.seq < eventSeq))!;
  const after = project(events.filter((e) => e.seq <= eventSeq))!;
  let kind: DocumentKind;
  let model: DocModel;
  if (ev.type === 'status_changed') {
    const to = ev.data.to as 'cancelled' | 'expired';
    if (to !== 'cancelled' && to !== 'expired') throw new AppError('validation_failed', 'Only a cancellation or expiry has a notice of its own.');
    kind = 'cancellation_notice';
    model = cancellationNotice(after.record, ev, to);
  } else {
    kind = 'change_notice';
    model = changeNotice(before.record, after.record, ev);
  }
  const id = await storeDocument(tx, files, {
    accountId: pol.account_id,
    kind,
    title: model.title,
    policyId,
    programmeId: null,
    templateId: null,
    eventSeq,
    source: `builder ${BUILDER_VERSION}`,
    version: null,
    model,
    email: (await tx.query<{ sandbox: boolean }>(`SELECT sandbox FROM platform.accounts WHERE id = $1`, [pol.account_id])).rows[0]?.sandbox ? null : after.record.purchaser.email,
    actor: ctx.principal.subject,
  });
  await publishEvent(tx, ctx, DocumentIssued, { documentId: id, kind, policyId, policyNumber: after.record.number, status: 'issued' }, { accountId: pol.account_id });
  await writeAudit(tx, ctx, { action: 'documents.notice_issued', resourceType: 'policy', resourceId: policyId, accountId: pol.account_id, data: { documentId: id, kind, eventSeq } });
  return { id, kind, status: 'issued', failure: null };
}
