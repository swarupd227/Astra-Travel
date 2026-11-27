import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import {
  ARRANGEMENT_LABELS,
  SERVICING_LABELS,
  type CatalogueDocument,
  type Policy,
  type PlanVersion,
} from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { nameOf, peopleNames } from '@/lib/people';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import {
  Badge,
  Card,
  CardHeader,
  DescriptionList,
  Notice,
  PageHeader,
} from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { PolicyDocuments } from '../../documents/policy-documents';
import { ServicingPanel } from './servicing-panel';
import { PolicyPremium } from '../../billing/policy-premium';

export const metadata = { title: 'Policy' };

const TONES = { active: 'success', cancelled: 'neutral', expired: 'neutral' } as const;
const when = (s: string) => s.replace('T', ' ');

export default async function PolicyPage({
  params,
  searchParams,
}: {
  params: Promise<{ policyId: string }>;
  searchParams: Promise<{ asOf?: string; serviced?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('policies:read')) return <AccessDenied permission="policies:read" />;
  const { policyId } = await params;
  const { asOf, serviced } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(policyId)) notFound();
  // The date and time field gives a local time; the record is asked for at that instant.
  const asOfIso = asOf && !Number.isNaN(Date.parse(asOf)) ? new Date(asOf).toISOString() : null;
  const res = await load(() =>
    api<Policy>(`/v1/policies/${policyId}${asOfIso ? `?asOf=${encodeURIComponent(asOfIso)}` : ''}`),
  );
  if (res.error instanceof ApiProblem && res.error.problem.code === 'not_found') {
    if (asOfIso) {
      return (
        <>
          <Link
            href={`/policies/${policyId}`}
            className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
          >
            <ChevronLeft aria-hidden className="size-4" /> The policy now
          </Link>
          <Notice tone="warning" title="The policy did not exist then">
            It was bound after {asOf?.replace('T', ' ')}. Choose a later time.
          </Notice>
        </>
      );
    }
    notFound();
  }
  if (res.error) return <ErrorPanel error={res.error} />;
  const p = res.data;
  const r = p.record;
  const names = await peopleNames(p.history.map((h) => h.actor));
  const canService =
    !asOfIso && p.status === 'active' && me.permissions.includes('servicing:execute');
  // The optional benefits the policy does not have yet, for the "add a benefit" choice.
  let optionalBenefits: { code: string; name: string }[] = [];
  if (canService) {
    const pv = await load(() => api<PlanVersion>(`/v1/plan-versions/${r.plan.versionId}`));
    if (pv.data) {
      const cat = await load(() =>
        api<{ document: CatalogueDocument }>(`/v1/benefit-catalogues/${pv.data!.catalogueId}`),
      );
      optionalBenefits = pv.data.document.benefits
        .filter((b) => b.packaging !== 'packaged' && !r.benefits.some((x) => x.code === b.code))
        .map((b) => ({
          code: b.code,
          name: cat.data?.document.benefits.find((c) => c.code === b.code)?.name ?? b.code,
        }));
    }
  }
  return (
    <>
      <Link
        href="/policies"
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> Policies
      </Link>
      <PageHeader
        eyebrow={`${r.plan.code} · ${r.plan.state}`}
        title={p.number}
        description={`${r.travellers.map((t) => `${t.firstName} ${t.lastName}`).join(', ')}. Cover ${when(r.term.start)} to ${when(r.term.end)}.`}
        actions={<Badge tone={TONES[p.status]}>{sentenceCase(p.status)}</Badge>}
      />

      <form
        method="get"
        className="mb-6 flex flex-wrap items-end gap-3"
        aria-label="See the policy as it was"
      >
        <label className="space-y-1.5 text-sm font-medium text-fg">
          See the policy as it was on
          <input
            type="datetime-local"
            name="asOf"
            defaultValue={asOf ?? ''}
            className="block h-10 rounded-lg border border-border-strong bg-surface px-3 text-sm"
          />
        </label>
        <button className="inline-flex h-10 items-center rounded-lg border border-border-strong bg-surface px-4 text-sm font-medium text-fg shadow-card hover:bg-surface-muted">
          Show
        </button>
        {asOfIso ? (
          <Link href={`/policies/${p.id}`} className="text-sm text-primary hover:underline">
            Back to now
          </Link>
        ) : null}
      </form>
      {asOfIso ? (
        <div className="mb-6">
          <Notice tone="primary" title={`As it was on ${asOf?.replace('T', ' ')}`}>
            This is the record after the last event at or before that time. Status then: {p.status}.
          </Notice>
        </div>
      ) : null}

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader title="Policy" />
          <div className="p-5">
            <DescriptionList
              items={[
                { term: 'Status', value: sentenceCase(p.status) },
                { term: 'Purchased', value: r.purchasedOn },
                {
                  term: 'Review period ends',
                  value: r.reviewPeriodEndsAt ? when(r.reviewPeriodEndsAt) : '—',
                },
                { term: 'Term', value: `${when(r.term.start)} to ${when(r.term.end)}` },
                { term: 'Plan', value: `${r.plan.name} (version ${r.plan.version})` },
                { term: 'Rule set', value: `Version ${r.ruleSet.version}` },
                ...Object.entries(r.manuals).map(([b, m]) => ({
                  term: `${b} manual`,
                  value: `${m.code} v${m.version}`,
                })),
              ]}
            />
          </div>
        </Card>
        <Card>
          <CardHeader title="Premium and payment" />
          <div className="p-5">
            <DescriptionList
              items={[
                { term: 'Premium', value: <span className="font-mono">{r.premium.total}</span> },
                {
                  term: 'Payment reference',
                  value: <span className="font-mono">{r.payment.reference}</span>,
                },
                {
                  term: 'Purchaser',
                  value: `${r.purchaser.name}${r.purchaser.email ? ` (${r.purchaser.email})` : ''}`,
                },
                {
                  term: 'Disclosure',
                  value: `${r.disclosure.title}, acknowledged by ${r.disclosure.acknowledgedBy}`,
                },
                { term: 'Waiver', value: r.waiver.applies ? 'Applied' : 'Did not apply' },
                {
                  term: 'CFAR',
                  value: r.cfar.offered
                    ? `Offered${r.cfar.noticePeriod ? `, ${r.cfar.noticePeriod} notice` : ''}`
                    : 'Not offered',
                },
              ]}
            />
          </div>
        </Card>
        <Card>
          <CardHeader title="Travellers" />
          <ul className="divide-y divide-border">
            {r.travellers.map((t) => (
              <li key={t.id} className="px-5 py-3 text-sm">
                <span className="font-medium text-fg">
                  {t.firstName} {t.lastName}
                </span>
                <span className="block text-xs text-muted">
                  {t.dateOfBirth ? `Born ${t.dateOfBirth}` : t.age !== null ? `Age ${t.age}` : ''} ·
                  trip cost {t.costPerTraveller}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {serviced ? (
        <div className="mb-6">
          <Notice tone="success" title="Done">
            {SERVICING_LABELS[serviced as keyof typeof SERVICING_LABELS] ?? 'The change'} was made
            and recorded in the history below. A notice has been issued with the policy’s documents.
          </Notice>
        </div>
      ) : null}
      {canService ? (
        <Card className="mb-6">
          <CardHeader
            title="Service this policy"
            description="Changes are re-rated and re-screened with the versions the policy was bound with. You see the price before you confirm."
          />
          <div className="p-5">
            <ServicingPanel
              policyId={p.id}
              travellers={r.travellers.map((t) => ({
                id: t.id,
                name: `${t.firstName} ${t.lastName}`,
              }))}
              optionalBenefits={optionalBenefits}
            />
          </div>
        </Card>
      ) : null}
      {!asOfIso && me.permissions.includes('billing:read') ? (
        <PolicyPremium policyId={p.id} />
      ) : null}
      {!asOfIso && me.permissions.includes('documents:read') ? (
        <PolicyDocuments policyId={p.id} canManage={me.permissions.includes('documents:manage')} />
      ) : null}

      <Card className="mb-6">
        <CardHeader
          title="Benefits"
          description="Cover dates by benefit, with the underwriting arrangement premium and documents follow."
        />
        <Table caption="Benefits">
          <THead>
            <tr>
              <TH>Benefit</TH>
              <TH>Underwriter</TH>
              <TH>Limit</TH>
              <TH>Cover starts</TH>
              <TH>Cover ends</TH>
              <TH className="text-right">Premium</TH>
            </tr>
          </THead>
          <tbody>
            {r.benefits.map((b) => (
              <TR key={b.code}>
                <TD>
                  {b.name}
                  <span className="block text-xs text-muted">{sentenceCase(b.packaging)}</span>
                </TD>
                <TD>
                  {b.underwriter ? (
                    ARRANGEMENT_LABELS[b.underwriter]
                  ) : (
                    <span className="text-muted">Not set</span>
                  )}
                </TD>
                <TD className="text-xs">
                  {b.limits.maximum !== null
                    ? `$${b.limits.maximum.toLocaleString('en-US')} ${b.limits.basis ?? ''}`
                    : '—'}
                </TD>
                <TD className="whitespace-nowrap text-xs">{when(b.coverageStart)}</TD>
                <TD className="whitespace-nowrap text-xs">{when(b.coverageEnd)}</TD>
                <TD className="text-right font-mono text-xs">{b.premium ?? '—'}</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card>
        <CardHeader
          title="History"
          description="Every change as an event: who or which agent, when and why."
        />
        <ol className="divide-y divide-border">
          {p.history.map((h) => (
            <li
              key={h.seq}
              className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-3 text-sm"
            >
              <span>
                <span className="font-medium text-fg">
                  {h.type === 'bound'
                    ? 'Bound'
                    : h.type === 'status_changed'
                      ? `Status changed to ${String(h.data.to)}`
                      : 'Details changed'}
                </span>
                <span className="text-muted">
                  {' '}
                  by {nameOf(names, h.actor)}
                  {h.reason ? `: ${h.reason}` : ''}
                </span>
              </span>
              <LocalTime iso={h.occurredAt} />
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}
