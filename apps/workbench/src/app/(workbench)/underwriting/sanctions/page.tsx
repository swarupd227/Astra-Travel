import { ShieldAlert } from 'lucide-react';
import type { SanctionsList } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { nameOf, peopleNames } from '@/lib/people';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, EmptyState, Notice, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { LoadSanctionsDialog, SanctionsDecisionForm } from '../uw-forms';

export const metadata = { title: 'Sanctions lists' };
const TONES = {
  draft: 'primary',
  approved: 'success',
  rejected: 'danger',
  superseded: 'neutral',
} as const;

export default async function SanctionsPage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('underwriting:read'))
    return <AccessDenied permission="underwriting:read" />;
  const res = await load(() => api<{ items: SanctionsList[] }>('/v1/sanctions-lists'));
  if (res.error) return <ErrorPanel error={res.error} />;
  const items = res.data.items;
  const names = await peopleNames(items.flatMap((l) => [l.loadedBy, l.decidedBy]));
  const inUse = items.find((l) => l.status === 'approved');
  return (
    <>
      <PageHeader
        title="Sanctions lists"
        description="The US Treasury list travellers are screened against when they get a quote and buy."
        actions={me.permissions.includes('underwriting:manage') ? <LoadSanctionsDialog /> : null}
      />
      <div className="mb-6">
        {inUse ? (
          <Notice tone="success" title="Screening is using an approved list">
            {inUse.source}: {inUse.entries.toLocaleString()} individuals and{' '}
            {inUse.aliases.toLocaleString()} aliases.
          </Notice>
        ) : (
          <Notice tone="warning" title="No approved list">
            Until a list is approved, nobody can be cleared at bind: every bind is held for a person
            to review.
          </Notice>
        )}
      </div>
      <Card>
        {items.length === 0 ? (
          <EmptyState
            icon={<ShieldAlert className="size-5" />}
            title="No list loaded"
            description="Download SDN.CSV and ALT.CSV from the Treasury's sanctions list service and load them here."
          />
        ) : (
          <Table caption="Sanctions lists">
            <THead>
              <tr>
                <TH>Source</TH>
                <TH>Status</TH>
                <TH className="text-right">Individuals</TH>
                <TH className="text-right">Aliases</TH>
                <TH>Loaded by</TH>
                <TH>Decision</TH>
              </tr>
            </THead>
            <tbody>
              {items.map((l) => (
                <TR key={l.id}>
                  <TD>
                    {l.source}
                    <span className="block font-mono text-xs text-muted">
                      {l.publishedOn ? `published ${l.publishedOn} · ` : ''}
                      {l.sha256.slice(0, 12)}
                    </span>
                  </TD>
                  <TD>
                    <Badge tone={TONES[l.status]}>{sentenceCase(l.status)}</Badge>
                  </TD>
                  <TD className="text-right tabular-nums">{l.entries.toLocaleString()}</TD>
                  <TD className="text-right tabular-nums">{l.aliases.toLocaleString()}</TD>
                  <TD>
                    {nameOf(names, l.loadedBy)}
                    <span className="block text-xs text-muted">
                      <LocalTime iso={l.loadedAt} />
                    </span>
                  </TD>
                  <TD>
                    {l.status === 'draft' && me.permissions.includes('underwriting:approve') ? (
                      l.loadedBy === me.subject ? (
                        <span className="text-xs text-muted">
                          You loaded this list, so someone else approves it.
                        </span>
                      ) : (
                        <SanctionsDecisionForm listId={l.id} />
                      )
                    ) : l.decidedBy ? (
                      <span className="text-xs">{nameOf(names, l.decidedBy)}</span>
                    ) : (
                      '—'
                    )}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
