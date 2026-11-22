import Link from 'next/link';
import { Search, Stamp } from 'lucide-react';
import {
  FILING_ITEM_TYPES,
  FILING_STATUSES,
  type Filing,
  type FormEdition,
} from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import {
  FILING_ITEM_LABELS,
  FILING_STATUS_TONES,
  filingInForce,
  readParams,
  sentenceCase,
  type SearchParams,
} from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { buttonClass } from '@/components/ui/button';
import { Badge, Card, EmptyState, Notice, PageHeader } from '@/components/ui/primitives';
import { Pager, Table, TD, TH, THead, TR, withQuery } from '@/components/ui/table';
import { RecordFilingDialog } from './filing-forms';

export const metadata = { title: 'Filing register' };

const select =
  'h-10 rounded-lg border border-border-strong bg-surface px-3 text-sm text-fg shadow-card';

export default async function FilingsPage({ searchParams }: { searchParams: SearchParams }) {
  const me = (await getMe())!;
  if (!me.permissions.includes('filings:read')) return <AccessDenied permission="filings:read" />;
  const params = await readParams(searchParams);
  const { q, state, status, itemType, cursor, created } = params;
  const canManage = me.permissions.includes('filings:manage');

  const [result, editions] = await Promise.all([
    load(() =>
      api<{ items: Filing[]; nextCursor: string | null }>('/v1/filings', {
        query: { q, state, status, itemType, cursor, limit: 50 },
      }),
    ),
    canManage && me.permissions.includes('forms:read')
      ? load(() => api<{ items: FormEdition[] }>('/v1/form-editions'))
      : null,
  ]);
  const editionOptions = (editions?.data?.items ?? []).map((e) => ({
    id: e.id,
    insurer: e.insurer,
    label: `${e.formNumber} ed. ${e.edition} · ${e.title}`,
  }));
  const today = new Date().toISOString().slice(0, 10);
  const filtered = !!(q || state || status || itemType);

  return (
    <>
      <PageHeader
        eyebrow="Product & compliance"
        title="Filing register"
        description="Every form, rate manual and rule set by state, with its filing status and effective dates. Plans and quotes can only use what is approved and in effect."
        actions={canManage ? <RecordFilingDialog editions={editionOptions} /> : null}
      />
      {created ? (
        <div className="mb-4">
          <Notice tone="success" title={`${created} filings recorded`}>
            One per state, in draft.
          </Notice>
        </div>
      ) : null}

      <form
        role="search"
        aria-label="Filter filings"
        method="get"
        className="mb-4 flex flex-wrap items-end gap-3"
      >
        <div className="relative min-w-60 flex-1">
          <label htmlFor="q" className="sr-only">
            Search by item or SERFF number
          </label>
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle"
          />
          <input
            id="q"
            name="q"
            defaultValue={q}
            placeholder="Search by item or SERFF number"
            className="h-10 w-full rounded-lg border border-border-strong bg-surface pl-9 pr-3 text-sm text-fg shadow-card placeholder:text-subtle"
          />
        </div>
        <div>
          <label htmlFor="state" className="sr-only">
            State
          </label>
          <input
            id="state"
            name="state"
            defaultValue={state}
            placeholder="State"
            maxLength={2}
            className={`${select} w-24 uppercase`}
          />
        </div>
        <div>
          <label htmlFor="status" className="sr-only">
            Status
          </label>
          <select id="status" name="status" defaultValue={status ?? ''} className={select}>
            <option value="">All statuses</option>
            {FILING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {sentenceCase(s)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="itemType" className="sr-only">
            Item type
          </label>
          <select id="itemType" name="itemType" defaultValue={itemType ?? ''} className={select}>
            <option value="">All items</option>
            {FILING_ITEM_TYPES.map((s) => (
              <option key={s} value={s}>
                {FILING_ITEM_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className={buttonClass('secondary')}>
          Apply
        </button>
        {filtered ? (
          <Link
            href="/compliance/filings"
            className="text-sm font-medium text-primary hover:underline"
          >
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
              icon={<Stamp className="size-5" />}
              title={filtered ? 'No filings match these filters' : 'No filings recorded yet'}
              description={
                filtered
                  ? 'Try different filters.'
                  : 'Record filings as forms, manuals and rule sets are filed with each state.'
              }
            />
          ) : (
            <>
              <Table caption="Filings">
                <THead>
                  <tr>
                    <TH>Item</TH>
                    <TH>State</TH>
                    <TH>Status</TH>
                    <TH>Effective</TH>
                    <TH>SERFF</TH>
                    <TH>In effect today</TH>
                  </tr>
                </THead>
                <tbody>
                  {result.data.items.map((f) => (
                    <TR key={f.id}>
                      <TD>
                        <Link
                          href={`/compliance/filings/${f.id}`}
                          className="font-medium text-fg hover:text-primary hover:underline"
                        >
                          {f.itemReference}
                        </Link>
                        <div className="text-xs text-muted">
                          {FILING_ITEM_LABELS[f.itemType]} · {f.insurer}
                        </div>
                      </TD>
                      <TD className="font-mono text-xs">{f.state}</TD>
                      <TD>
                        <Badge tone={FILING_STATUS_TONES[f.status]}>{sentenceCase(f.status)}</Badge>
                      </TD>
                      <TD className="whitespace-nowrap text-muted">
                        {f.effectiveFrom
                          ? `${f.effectiveFrom}${f.effectiveTo ? ` to ${f.effectiveTo}` : ''}`
                          : '—'}
                      </TD>
                      <TD className="font-mono text-xs text-muted">{f.serffTracking ?? '—'}</TD>
                      <TD>
                        {filingInForce(f, today) ? (
                          <Badge tone="success">Yes</Badge>
                        ) : (
                          <span className="text-muted">No</span>
                        )}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
              <Pager
                count={result.data.items.length}
                nextHref={
                  result.data.nextCursor
                    ? withQuery('/compliance/filings', params, {
                        cursor: result.data.nextCursor,
                        created: null,
                      })
                    : null
                }
                firstHref={
                  cursor ? withQuery('/compliance/filings', params, { cursor: null }) : null
                }
              />
            </>
          )}
        </Card>
      )}
    </>
  );
}
