import Link from 'next/link';
import { CreditCard } from 'lucide-react';
import { PROGRAMME_STATUSES, type CardProgramme, type MasterPolicy } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import {
  integer,
  PROGRAMME_STATUS_TONES,
  readParams,
  sentenceCase,
  type SearchParams,
} from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { buttonClass } from '@/components/ui/button';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Pager, Table, TD, TH, THead, TR, withQuery } from '@/components/ui/table';
import { CreateProgrammeDialog } from '../card-forms';

export const metadata = { title: 'Card programmes' };

export default async function ProgrammesPage({ searchParams }: { searchParams: SearchParams }) {
  const me = (await getMe())!;
  if (!me.permissions.includes('card:read')) return <AccessDenied permission="card:read" />;
  const params = await readParams(searchParams);
  const { status, cursor } = params;
  const canManage = me.permissions.includes('card:manage');

  const [result, policies, accounts] = await Promise.all([
    load(() =>
      api<{ items: CardProgramme[]; nextCursor: string | null }>('/v1/card-programmes', {
        query: { status, cursor, limit: 25 },
      }),
    ),
    canManage ? load(() => api<{ items: MasterPolicy[] }>('/v1/master-policies')) : null,
    canManage
      ? load(() =>
          api<{ items: { id: string; name: string }[] }>('/v1/accounts', { query: { limit: 200 } }),
        )
      : null,
  ]);
  const accountName = new Map((accounts?.data?.items ?? []).map((a) => [a.id, a.name]));
  const activePolicies = (policies?.data?.items ?? [])
    .filter((p) => p.status === 'active')
    .map((p) => ({
      id: p.id,
      policyNumber: p.policyNumber,
      states: p.states,
      accountName: accountName.get(p.accountId) ?? 'Unknown account',
    }));

  return (
    <>
      <PageHeader
        eyebrow="Card-linked cover"
        title="Card programmes"
        description="Travel cover that comes with a card. Issuers send eligibility feeds; cover is answered from the eligibility ledger, with the feed version behind every answer."
        actions={canManage ? <CreateProgrammeDialog policies={activePolicies} /> : null}
      />

      <form
        role="search"
        aria-label="Filter programmes"
        className="mb-4 flex flex-wrap items-end gap-3"
        method="get"
      >
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
            {PROGRAMME_STATUSES.map((s) => (
              <option key={s} value={s}>
                {sentenceCase(s)}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className={buttonClass('secondary')}>
          Apply
        </button>
        {status ? (
          <Link
            href="/card/programmes"
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
              icon={<CreditCard className="size-5" />}
              title={status ? 'No programmes match this filter' : 'No card programmes yet'}
              description={
                canManage
                  ? 'Register a master policy for the issuer, then set up a programme under it.'
                  : 'Programmes appear here once they are set up.'
              }
            />
          ) : (
            <>
              <Table caption="Card programmes">
                <THead>
                  <tr>
                    <TH>Programme</TH>
                    <TH>Issuer</TH>
                    <TH>Status</TH>
                    <TH className="text-right">Accounts on file</TH>
                    <TH className="text-right">Certificates</TH>
                    <TH className="text-right">Last feed</TH>
                  </tr>
                </THead>
                <tbody>
                  {result.data.items.map((p) => (
                    <TR key={p.id}>
                      <TD>
                        <Link
                          href={`/card/programmes/${p.id}`}
                          className="font-medium text-fg hover:text-primary hover:underline"
                        >
                          {p.name}
                        </Link>
                        <div className="font-mono text-xs text-muted">{p.code}</div>
                      </TD>
                      <TD className="text-muted">{p.accountName}</TD>
                      <TD>
                        <Badge tone={PROGRAMME_STATUS_TONES[p.status]}>
                          {sentenceCase(p.status)}
                        </Badge>
                      </TD>
                      <TD className="text-right tabular-nums">{integer(p.accountsOnFile)}</TD>
                      <TD className="text-right tabular-nums">{integer(p.certificates)}</TD>
                      <TD className="text-right tabular-nums text-muted">
                        {p.lastAppliedSequence ? `#${p.lastAppliedSequence}` : '—'}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
              <Pager
                count={result.data.items.length}
                nextHref={
                  result.data.nextCursor
                    ? withQuery('/card/programmes', params, { cursor: result.data.nextCursor })
                    : null
                }
                firstHref={cursor ? withQuery('/card/programmes', params, { cursor: null }) : null}
              />
            </>
          )}
        </Card>
      )}
    </>
  );
}
