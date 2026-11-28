import Link from 'next/link';
import { Lock, ScrollText } from 'lucide-react';
import { AUDIT_ACTOR_TYPES, type AuditEntry } from '@astra/contracts';
import { activityPhrase } from '@/lib/activity';
import { api, getMe } from '@/lib/api';
import { readParams, sentenceCase, type SearchParams } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { buttonClass } from '@/components/ui/button';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Pager, Table, TD, TH, THead, TR, withQuery } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { VerifyAudit } from './verify-button';

export const metadata = { title: 'Audit trail' };

const ACTOR_TONE = {
  user: 'neutral',
  partner: 'primary',
  agent: 'warning',
  system: 'neutral',
} as const;
const inputClass =
  'h-10 rounded-lg border border-border-strong bg-surface px-3 text-sm text-fg shadow-card placeholder:text-subtle';

export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  const me = (await getMe())!;
  if (!me.permissions.includes('audit:read')) return <AccessDenied permission="audit:read" />;
  const params = await readParams(searchParams);
  const result = await load(() =>
    api<{ items: AuditEntry[]; nextCursor: string | null }>('/v1/audit', {
      query: {
        action: params.action,
        actorType: params.actorType,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        correlationId: params.correlationId,
        cursor: params.cursor,
        limit: 50,
      },
    }),
  );
  const filtered = !!(
    params.action ||
    params.actorType ||
    params.resourceType ||
    params.resourceId ||
    params.correlationId
  );

  return (
    <>
      <PageHeader
        title="Audit trail"
        description="Who changed what, when and why. Entries cannot be edited or deleted."
        actions={me.permissions.includes('audit:verify') ? <VerifyAudit /> : null}
      />
      <form
        role="search"
        aria-label="Filter audit records"
        method="get"
        className="mb-4 flex flex-wrap items-end gap-3"
      >
        <div>
          <label htmlFor="action" className="mb-1 block text-xs font-medium text-muted">
            Action
          </label>
          <input
            id="action"
            name="action"
            defaultValue={params.action}
            placeholder="e.g. account.registered"
            className={`${inputClass} w-56 font-mono`}
          />
        </div>
        <div>
          <label htmlFor="actorType" className="mb-1 block text-xs font-medium text-muted">
            Actor
          </label>
          <select
            id="actorType"
            name="actorType"
            defaultValue={params.actorType ?? ''}
            className={inputClass}
          >
            <option value="">Anyone</option>
            {AUDIT_ACTOR_TYPES.map((a) => (
              <option key={a} value={a}>
                {sentenceCase(a)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="resourceType" className="mb-1 block text-xs font-medium text-muted">
            Resource type
          </label>
          <input
            id="resourceType"
            name="resourceType"
            defaultValue={params.resourceType}
            placeholder="e.g. account"
            className={`${inputClass} w-40 font-mono`}
          />
        </div>
        <div>
          <label htmlFor="correlationId" className="mb-1 block text-xs font-medium text-muted">
            Reference
          </label>
          <input
            id="correlationId"
            name="correlationId"
            defaultValue={params.correlationId}
            className={`${inputClass} w-72 font-mono`}
          />
        </div>
        <button type="submit" className={buttonClass('secondary')}>
          Apply
        </button>
        {filtered ? (
          <Link
            href="/governance/audit"
            className="pb-2.5 text-sm font-medium text-primary hover:underline"
          >
            Clear
          </Link>
        ) : null}
      </form>

      {result.error ? (
        <ErrorPanel error={result.error} />
      ) : (
        <Card>
          {result.data.items.length === 0 ? (
            <EmptyState
              icon={<ScrollText className="size-5" />}
              title={filtered ? 'No records match' : 'No audit records yet'}
            />
          ) : (
            <>
              <Table caption="Audit records">
                <THead>
                  <tr>
                    <TH>Time</TH>
                    <TH>Who</TH>
                    <TH>What happened</TH>
                    <TH>Record</TH>
                    <TH>Reason</TH>
                    <TH>Details</TH>
                  </tr>
                </THead>
                <tbody>
                  {result.data.items.map((a) => (
                    <TR key={a.id}>
                      <TD className="text-muted">
                        <span className="inline-flex items-center gap-1.5">
                          {a.sealed ? (
                            <Lock aria-label="Sealed" className="size-3 text-success" />
                          ) : null}
                          <LocalTime iso={a.occurredAt} />
                        </span>
                      </TD>
                      <TD>
                        <div className="flex items-center gap-2">
                          <Badge tone={ACTOR_TONE[a.actorType]}>{a.actorType}</Badge>
                          <span className="max-w-40 truncate text-sm" title={a.actorId}>
                            {a.actorName ?? a.actorId}
                          </span>
                        </div>
                      </TD>
                      <TD>
                        <span className="block text-sm first-letter:uppercase">
                          {activityPhrase(a.action)}
                        </span>
                        <span className="block font-mono text-[11px] text-subtle">{a.action}</span>
                      </TD>
                      <TD className="text-xs text-muted">
                        {a.resourceType.replace(/_/g, ' ')}
                        {a.resourceId ? (
                          <span className="block max-w-40 truncate font-mono" title={a.resourceId}>
                            {a.resourceId}
                          </span>
                        ) : null}
                      </TD>
                      <TD className="max-w-48 text-xs text-muted">{a.reason ?? '—'}</TD>
                      <TD>
                        <details className="text-xs">
                          <summary className="cursor-pointer text-primary">View</summary>
                          <pre className="mt-2 max-w-sm overflow-x-auto rounded-md bg-surface-muted p-2 font-mono text-[11px] text-fg">
                            {JSON.stringify({ ...a.data, correlationId: a.correlationId }, null, 2)}
                          </pre>
                        </details>
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
              <Pager
                count={result.data.items.length}
                nextHref={
                  result.data.nextCursor
                    ? withQuery('/governance/audit', params, { cursor: result.data.nextCursor })
                    : null
                }
                firstHref={
                  params.cursor ? withQuery('/governance/audit', params, { cursor: null }) : null
                }
              />
            </>
          )}
        </Card>
      )}
    </>
  );
}
