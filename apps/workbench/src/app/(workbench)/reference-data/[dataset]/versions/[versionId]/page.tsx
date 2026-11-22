import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, Search } from 'lucide-react';
import {
  REFDATA_DATASETS,
  REFDATA_DATASET_CODES,
  type RefdataDataset,
  type RefdataDiff,
  type RefdataVersion,
} from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { integer, readParams, sentenceCase, type SearchParams } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { buttonClass } from '@/components/ui/button';
import {
  Badge,
  Card,
  CardHeader,
  DescriptionList,
  Notice,
  PageHeader,
} from '@/components/ui/primitives';
import { Pager, Table, TD, TH, THead, TR, withQuery } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { DecideVersionForm } from '../../../refdata-forms';

export const metadata = { title: 'Reference data version' };

function show(value: unknown): string {
  if (Array.isArray(value)) return value.join('; ');
  if (value === undefined || value === null) return '';
  return String(value);
}

function KeyList({
  label,
  keys,
  tone,
}: {
  label: string;
  keys: string[];
  tone: 'success' | 'danger' | 'warning';
}) {
  return (
    <div>
      <p className="text-sm font-medium text-fg">
        {label} <Badge tone={tone}>{integer(keys.length)}</Badge>
      </p>
      {keys.length ? (
        <p className="mt-1 max-h-24 overflow-y-auto break-words font-mono text-xs text-muted">
          {keys.slice(0, 300).join(', ')}
          {keys.length > 300 ? ` and ${integer(keys.length - 300)} more` : ''}
        </p>
      ) : null}
    </div>
  );
}

export default async function VersionPage({
  params,
  searchParams,
}: {
  params: Promise<{ dataset: string; versionId: string }>;
  searchParams: SearchParams;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('refdata:read')) return <AccessDenied permission="refdata:read" />;
  const { dataset, versionId } = await params;
  if (!(REFDATA_DATASET_CODES as string[]).includes(dataset) || !/^[0-9a-f-]{36}$/i.test(versionId))
    notFound();
  const query = await readParams(searchParams);
  const base = `/reference-data/${dataset}/versions/${versionId}`;

  const [version, entries] = await Promise.all([
    load(() =>
      api<RefdataVersion & { diff: RefdataDiff }>(
        `/v1/reference-data/${dataset}/versions/${versionId}`,
      ),
    ),
    load(() =>
      api<{ items: { key: string; data: Record<string, unknown> }[]; nextCursor: string | null }>(
        `/v1/reference-data/${dataset}/versions/${versionId}/entries`,
        { query: { q: query.q, cursor: query.cursor, limit: 50 } },
      ),
    ),
  ]);
  if (version.error instanceof ApiProblem && version.error.problem.code === 'not_found') notFound();
  if (version.error) return <ErrorPanel error={version.error} />;
  const v = version.data;
  const def = REFDATA_DATASETS[dataset as RefdataDataset];
  const fields = entries.data?.items[0] ? Object.keys(entries.data.items[0].data) : [];
  const canDecide =
    v.status === 'draft' && me.permissions.includes('refdata:manage') && v.loadedBy !== me.subject;

  return (
    <>
      <Link
        href={`/reference-data/${dataset}`}
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> {def.name}
      </Link>
      <PageHeader
        eyebrow={def.name}
        title={`Version ${v.version}`}
        description={`Effective from ${v.effectiveFrom}${v.effectiveTo ? ` to ${v.effectiveTo}` : ''}`}
        actions={
          <Badge
            tone={
              v.status === 'approved' ? 'success' : v.status === 'draft' ? 'primary' : 'neutral'
            }
          >
            {sentenceCase(v.status)}
          </Badge>
        }
      />
      <div className="mb-6 space-y-3">
        {query.loaded ? (
          <Notice tone="success" title="Version loaded">
            Every entry passed its checks. It takes effect on {v.effectiveFrom} once someone else
            approves it.
          </Notice>
        ) : null}
        {query.decided ? (
          <Notice
            tone={query.decided === 'approved' ? 'success' : 'neutral'}
            title={`Version ${query.decided}`}
          >
            {query.decided === 'approved'
              ? `It is in force from ${v.effectiveFrom}.`
              : 'It will never take effect.'}
          </Notice>
        ) : null}
        {v.status === 'draft' && v.loadedBy === me.subject ? (
          <Notice tone="primary" title="Waiting for approval">
            You loaded this version, so someone else must approve it.
          </Notice>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-1">
          <Card>
            <CardHeader title="Details" />
            <div className="p-5">
              <DescriptionList
                items={[
                  { term: 'Source', value: v.source },
                  { term: 'Entries', value: integer(v.entryCount) },
                  { term: 'Loaded by', value: v.loadedBy },
                  { term: 'Loaded', value: <LocalTime iso={v.loadedAt} /> },
                  { term: 'Decided by', value: v.decidedBy ?? '—' },
                  { term: 'Decision', value: v.decisionReason ?? '—' },
                  {
                    term: 'Content SHA-256',
                    value: <span className="break-all font-mono text-xs">{v.sha256}</span>,
                  },
                  ...(v.notes ? [{ term: 'Notes', value: v.notes }] : []),
                ]}
              />
            </div>
          </Card>
          {canDecide ? (
            <Card>
              <CardHeader title="Approve or reject" description={`Loaded by ${v.loadedBy}.`} />
              <DecideVersionForm dataset={dataset} versionId={v.id} />
            </Card>
          ) : null}
        </div>

        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader
              title="Changes"
              description={
                v.diff.against
                  ? `Compared with version ${v.diff.against.version}, the version it follows.`
                  : 'The first approved version of this dataset: every entry is new.'
              }
            />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <KeyList label="Added" keys={v.diff.added} tone="success" />
              <KeyList label="Removed" keys={v.diff.removed} tone="danger" />
              <KeyList label="Changed" keys={v.diff.changed} tone="warning" />
              <div>
                <p className="text-sm font-medium text-fg">
                  Unchanged <Badge tone="neutral">{integer(v.diff.unchanged)}</Badge>
                </p>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Entries" />
            <form
              role="search"
              aria-label="Search entries"
              method="get"
              className="flex flex-wrap items-end gap-3 border-b border-border p-4"
            >
              <div className="relative min-w-60 flex-1">
                <label htmlFor="q" className="sr-only">
                  Search entries
                </label>
                <Search
                  aria-hidden
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle"
                />
                <input
                  id="q"
                  name="q"
                  defaultValue={query.q}
                  placeholder="Search entries"
                  className="h-10 w-full rounded-lg border border-border-strong bg-surface pl-9 pr-3 text-sm text-fg shadow-card placeholder:text-subtle"
                />
              </div>
              <button type="submit" className={buttonClass('secondary')}>
                Search
              </button>
            </form>
            {entries.error ? (
              <p className="px-5 py-4 text-sm text-danger">Entries could not be loaded.</p>
            ) : entries.data.items.length === 0 ? (
              <p className="px-5 py-6 text-sm text-muted">No entries match.</p>
            ) : (
              <>
                <Table caption={`Entries of version ${v.version}`}>
                  <THead>
                    <tr>
                      {fields.map((f) => (
                        <TH key={f}>{f}</TH>
                      ))}
                    </tr>
                  </THead>
                  <tbody>
                    {entries.data.items.map((e) => (
                      <TR key={e.key}>
                        {fields.map((f) => (
                          <TD
                            key={f}
                            className={f === def.keyField ? 'font-mono text-xs' : 'text-muted'}
                          >
                            {show(e.data[f])}
                          </TD>
                        ))}
                      </TR>
                    ))}
                  </tbody>
                </Table>
                <Pager
                  count={entries.data.items.length}
                  nextHref={
                    entries.data.nextCursor
                      ? withQuery(base, query, {
                          cursor: entries.data.nextCursor,
                          loaded: null,
                          decided: null,
                        })
                      : null
                  }
                  firstHref={query.cursor ? withQuery(base, query, { cursor: null }) : null}
                />
              </>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
