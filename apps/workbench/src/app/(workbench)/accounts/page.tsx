import Link from 'next/link';
import { Building2, Search } from 'lucide-react';
import { ACCOUNT_KINDS, ACCOUNT_STATUSES, type Account } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import {
  ACCOUNT_KIND_LABELS,
  ACCOUNT_STATUS_TONES,
  readParams,
  sentenceCase,
  type SearchParams,
} from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { buttonClass } from '@/components/ui/button';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Pager, Table, TD, TH, THead, TR, withQuery } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { CreateAccountDialog } from './account-forms';

export const metadata = { title: 'Accounts' };

export default async function AccountsPage({ searchParams }: { searchParams: SearchParams }) {
  const me = (await getMe())!;
  if (!me.permissions.includes('accounts:read')) return <AccessDenied permission="accounts:read" />;
  const params = await readParams(searchParams);
  const { q, status, kind, cursor } = params;

  const result = await load(() =>
    api<{ items: Account[]; nextCursor: string | null }>('/v1/accounts', {
      query: { q, status, kind, cursor, limit: 25 },
    }),
  );
  const filtered = !!(q || status || kind);

  return (
    <>
      <PageHeader
        eyebrow="Partners"
        title="Accounts"
        description="Travel sellers, card issuers and banks. Each account is a separate tenant: its data is isolated from every other account."
        actions={me.permissions.includes('accounts:manage') ? <CreateAccountDialog /> : null}
      />

      <form
        role="search"
        aria-label="Filter accounts"
        className="mb-4 flex flex-wrap items-end gap-3"
        method="get"
      >
        <div className="relative min-w-60 flex-1">
          <label htmlFor="q" className="sr-only">
            Search by name or code
          </label>
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle"
          />
          <input
            id="q"
            name="q"
            defaultValue={q}
            placeholder="Search by name or code"
            className="h-10 w-full rounded-lg border border-border-strong bg-surface pl-9 pr-3 text-sm text-fg shadow-card placeholder:text-subtle"
          />
        </div>
        <div>
          <label htmlFor="status" className="sr-only">
            Status
          </label>
          <select
            id="status"
            name="status"
            defaultValue={status ?? ''}
            className="h-10 rounded-lg border border-border-strong bg-surface px-3 text-sm text-fg shadow-card"
          >
            <option value="">All statuses</option>
            {ACCOUNT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {sentenceCase(s)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="kind" className="sr-only">
            Type
          </label>
          <select
            id="kind"
            name="kind"
            defaultValue={kind ?? ''}
            className="h-10 rounded-lg border border-border-strong bg-surface px-3 text-sm text-fg shadow-card"
          >
            <option value="">All types</option>
            {ACCOUNT_KINDS.map((k) => (
              <option key={k} value={k}>
                {ACCOUNT_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className={buttonClass('secondary')}>
          Apply
        </button>
        {filtered ? (
          <Link href="/accounts" className="text-sm font-medium text-primary hover:underline">
            Clear filters
          </Link>
        ) : null}
      </form>

      {result.error ? (
        <ErrorPanel error={result.error} />
      ) : (
        <Card>
          {result.data.items.length === 0 ? (
            <EmptyState
              icon={<Building2 className="size-5" />}
              title={filtered ? 'No accounts match these filters' : 'No accounts yet'}
              description={
                filtered
                  ? 'Try a different search or clear the filters.'
                  : 'Registered accounts appear here.'
              }
            />
          ) : (
            <>
              <Table caption="Accounts">
                <THead>
                  <tr>
                    <TH>Account</TH>
                    <TH>Code</TH>
                    <TH>Type</TH>
                    <TH>Status</TH>
                    <TH>Registered</TH>
                  </tr>
                </THead>
                <tbody>
                  {result.data.items.map((a) => (
                    <TR key={a.id}>
                      <TD>
                        <Link
                          href={`/accounts/${a.id}`}
                          className="font-medium text-fg hover:text-primary hover:underline"
                        >
                          {a.name}
                        </Link>
                      </TD>
                      <TD className="font-mono text-xs text-muted">{a.code}</TD>
                      <TD className="text-muted">{ACCOUNT_KIND_LABELS[a.kind]}</TD>
                      <TD>
                        <Badge tone={ACCOUNT_STATUS_TONES[a.status]}>
                          {sentenceCase(a.status)}
                        </Badge>
                      </TD>
                      <TD className="text-muted">
                        <LocalTime iso={a.createdAt} />
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
              <Pager
                count={result.data.items.length}
                nextHref={
                  result.data.nextCursor
                    ? withQuery('/accounts', params, { cursor: result.data.nextCursor })
                    : null
                }
                firstHref={cursor ? withQuery('/accounts', params, { cursor: null }) : null}
              />
            </>
          )}
        </Card>
      )}
    </>
  );
}
