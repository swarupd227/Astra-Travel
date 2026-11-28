import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import {
  ARRANGEMENT_LABELS,
  SERVICING_LABELS,
  type CatalogueDocument,
  type Policy,
  type PlanVersion,
  type PolicyEvent,
} from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { countryName, dayRange, formatDay, formatDayTime, money, sentenceCase } from '@/lib/format';
import { nameOf, peopleNames } from '@/lib/people';
import { AccessDenied } from '@/components/access-denied';
import { AgentMark } from '@/components/copilot/agent-mark';
import { ErrorPanel, load } from '@/components/error-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { Badge, Card, CardHeader, Notice } from '@/components/ui/primitives';
import { LocalTime } from '@/components/ui/time';
import { PolicyDocuments } from '../../documents/policy-documents';
import { PolicyPremium } from '../../billing/policy-premium';
import { ServiceButton } from './service-button';

export const metadata = { title: 'Policy' };

const TONES = { active: 'success', cancelled: 'neutral', expired: 'neutral' } as const;

function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
    >
      <ChevronLeft aria-hidden className="size-4" /> {children}
    </Link>
  );
}

function Fact({ term, value, note }: { term: string; value: string; note?: string }) {
  return (
    <div className="min-w-0 bg-surface px-5 py-4">
      <dt className="text-xs font-medium text-muted">{term}</dt>
      <dd className="mt-1">
        <span className="block text-lg font-semibold tracking-tight text-fg">{value}</span>
        {note ? <span className="block text-xs text-muted">{note}</span> : null}
      </dd>
    </div>
  );
}

function Details({ items }: { items: { term: string; value: React.ReactNode }[] }) {
  return (
    <dl className="space-y-3 px-5 py-4 text-sm">
      {items.map((i) => (
        <div key={i.term} className="flex justify-between gap-4">
          <dt className="shrink-0 text-muted">{i.term}</dt>
          <dd className="min-w-0 break-words text-right text-fg">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const eventTitle = (h: PolicyEvent) =>
  h.type === 'bound'
    ? 'Bound'
    : h.type === 'status_changed'
      ? `Status changed to ${String(h.data.to)}`
      : 'Details changed';

/** The trip as the record holds it: when the traveller goes and where. */
function tripOf(trip: Record<string, unknown>) {
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  const destinations = Array.isArray(trip.destinations)
    ? (trip.destinations as { country?: string; region?: string }[])
    : [];
  return {
    departure: text(trip.departureDate),
    return: text(trip.returnDate),
    places: destinations
      .map((d) => (d.country ? countryName(d.country) : d.region))
      .filter(Boolean)
      .join(', '),
  };
}

export default async function PolicyPage({
  params,
  searchParams,
}: {
  params: Promise<{ policyId: string }>;
  searchParams: Promise<{ asOf?: string; serviced?: string; issued?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('policies:read')) return <AccessDenied permission="policies:read" />;
  const { policyId } = await params;
  const { asOf, serviced, issued } = await searchParams;
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
          <BackLink href={`/policies/${policyId}`}>The policy now</BackLink>
          <Notice tone="warning" title="The policy did not exist then">
            It was bought after {formatDayTime(asOf!)}. Choose a later time.
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
  const travellers = r.travellers.map((t) => ({
    id: t.id,
    name: `${t.firstName} ${t.lastName}`,
  }));
  const trip = tripOf(r.trip);
  // Review period times carry no zone, so they are compared with the clock as written.
  const now = (asOfIso ?? new Date().toISOString()).slice(0, 16);
  const reviewOpen = !!r.reviewPeriodEndsAt && r.reviewPeriodEndsAt > now;

  return (
    <>
      {asOfIso ? (
        <BackLink href={`/policies/${p.id}`}>The policy now</BackLink>
      ) : (
        <BackLink href="/policies">Policies</BackLink>
      )}
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
              {p.number}
            </h1>
            <Badge tone={TONES[p.status]} className="px-2.5 py-1">
              {sentenceCase(p.status)}
            </Badge>
          </div>
          <p className="mt-1.5 text-sm text-muted">
            <span className="font-medium text-fg">{travellers.map((t) => t.name).join(', ')}</span>{' '}
            · {r.plan.name} · {r.plan.state}
          </p>
        </div>
        {canService ? (
          // A new event on the record closes the dialog that made it.
          <ServiceButton
            key={p.history.length}
            policyId={p.id}
            travellers={travellers}
            optionalBenefits={optionalBenefits}
          />
        ) : null}
      </header>

      {asOfIso ? (
        <div className="mb-6">
          <Notice tone="primary" title={`As it was on ${formatDayTime(asOf!)}`}>
            This is the record after the last event at or before that time. Status then: {p.status}.
          </Notice>
        </div>
      ) : null}
      {issued ? (
        <div className="mb-6">
          <Notice tone="success" title="Policy issued">
            Its documents are listed below as they are produced.
          </Notice>
        </div>
      ) : null}
      {serviced ? (
        <div className="mb-6">
          <Notice tone="success" title="Done">
            {SERVICING_LABELS[serviced as keyof typeof SERVICING_LABELS] ?? 'The change'} was made
            and recorded in the history below. A notice has been issued with the policy’s documents.
          </Notice>
        </div>
      ) : null}

      {/* One-pixel gaps over the border colour draw the dividers at every width. */}
      <dl className="mb-6 grid gap-px overflow-hidden rounded-2xl border border-border bg-border shadow-card sm:grid-cols-2 xl:grid-cols-4">
        <Fact
          term="Premium"
          value={money(r.premium.total)}
          note={`Paid · ${r.payment.reference}`}
        />
        <Fact
          term="Cover"
          value={dayRange(r.term.start.slice(0, 10), r.term.end.slice(0, 10))}
          note={`From ${formatDayTime(r.term.start)} to ${formatDayTime(r.term.end)}`}
        />
        <Fact
          term="Trip"
          value={trip.places || 'Not recorded'}
          note={dayRange(trip.departure, trip.return)}
        />
        <Fact
          term="Review period"
          value={!r.reviewPeriodEndsAt ? 'None' : reviewOpen ? 'Open' : 'Over'}
          note={
            r.reviewPeriodEndsAt
              ? `${reviewOpen ? 'Until' : 'Ended'} ${formatDayTime(r.reviewPeriodEndsAt)}`
              : undefined
          }
        />
      </dl>

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-3">
        <div className="min-w-0 space-y-6 xl:col-span-2">
          <Card aria-labelledby="benefits">
            <CardHeader titleId="benefits" title="Benefits" />
            <ul className="divide-y divide-border">
              {r.benefits.map((b) => (
                <li key={b.code} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-fg">
                      {b.name}{' '}
                      <span className="font-normal text-muted">
                        · {sentenceCase(b.packaging).toLowerCase()}
                      </span>
                    </p>
                    <p className="mt-0.5 text-sm text-muted">
                      {b.limits.maximum !== null
                        ? `Up to $${b.limits.maximum.toLocaleString('en-US')} ${b.limits.basis ?? ''} · `
                        : ''}
                      {dayRange(b.coverageStart.slice(0, 10), b.coverageEnd.slice(0, 10))}
                    </p>
                    <p className="mt-0.5 text-xs text-subtle">
                      Underwritten by{' '}
                      {b.underwriter ? ARRANGEMENT_LABELS[b.underwriter] : 'not set'}
                    </p>
                  </div>
                  <p className="text-sm font-medium tabular-nums text-fg">
                    {b.premium ? money(b.premium) : '—'}
                  </p>
                </li>
              ))}
            </ul>
          </Card>

          {!asOfIso && me.permissions.includes('documents:read') ? (
            <PolicyDocuments
              policyId={p.id}
              canManage={me.permissions.includes('documents:manage')}
            />
          ) : null}
          {!asOfIso && me.permissions.includes('billing:read') ? (
            <PolicyPremium policyId={p.id} />
          ) : null}

          <Card aria-labelledby="history">
            <CardHeader
              titleId="history"
              title="History"
              description="Every change: who or which agent, when and why."
            />
            <ol className="px-5 py-4">
              {p.history.map((h, i) => (
                <li key={h.seq} className="relative flex gap-3 pb-5 last:pb-0">
                  {i < p.history.length - 1 ? (
                    <span aria-hidden className="absolute bottom-0 left-3 top-7 w-px bg-border" />
                  ) : null}
                  {h.actor.startsWith('agent:') ? (
                    <AgentMark size="sm" />
                  ) : (
                    <span
                      aria-hidden
                      className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface"
                    >
                      <span className="size-2 rounded-full bg-primary" />
                    </span>
                  )}
                  <div className="min-w-0 text-sm">
                    <p>
                      <span className="font-medium text-fg">{eventTitle(h)}</span>
                      <span className="text-muted"> by {nameOf(names, h.actor)}</span>
                    </p>
                    {h.reason ? <p className="text-fg">{h.reason}</p> : null}
                    <p className="text-xs text-subtle">
                      <LocalTime iso={h.occurredAt} />
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          <Card aria-labelledby="travellers">
            <CardHeader titleId="travellers" title="Travellers" />
            <ul className="divide-y divide-border">
              {r.travellers.map((t) => (
                <li key={t.id} className="flex justify-between gap-4 px-5 py-3.5 text-sm">
                  <span>
                    <span className="block font-medium text-fg">
                      {t.firstName} {t.lastName}
                    </span>
                    <span className="block text-xs text-muted">
                      {t.dateOfBirth
                        ? `Born ${formatDay(t.dateOfBirth)}`
                        : t.age !== null
                          ? `Age ${t.age}`
                          : ''}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block tabular-nums text-fg">{money(t.costPerTraveller)}</span>
                    <span className="block text-xs text-muted">insured trip cost</span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card aria-labelledby="purchase">
            <CardHeader titleId="purchase" title="Purchase" />
            <Details
              items={[
                { term: 'Bought', value: formatDay(r.purchasedOn) },
                { term: 'Purchaser', value: r.purchaser.name },
                { term: 'Email', value: r.purchaser.email ?? '—' },
                { term: 'Disclosure', value: r.disclosure.title },
                { term: 'Acknowledged by', value: r.disclosure.acknowledgedBy },
                {
                  term: 'Pre-existing condition waiver',
                  value: r.waiver.applies ? 'Applied' : 'Did not apply',
                },
                {
                  term: 'Cancel for any reason',
                  value: r.cfar.offered
                    ? `Offered${r.cfar.noticePeriod ? `, ${r.cfar.noticePeriod} notice` : ''}`
                    : 'Not offered',
                },
              ]}
            />
          </Card>

          <Card aria-labelledby="versions">
            <CardHeader
              titleId="versions"
              title="Bought with"
              description="The versions that priced and decided this policy."
            />
            <Details
              items={[
                { term: 'Plan', value: `${r.plan.code}, version ${r.plan.version}` },
                { term: 'Rule set', value: `Version ${r.ruleSet.version}` },
                ...Object.entries(r.manuals).map(([benefit, m]) => ({
                  term: `${benefit} rates`,
                  value: `${m.code}, version ${m.version}`,
                })),
              ]}
            />
          </Card>

          <Card aria-labelledby="look-back">
            <CardHeader titleId="look-back" title="Look back" />
            <form
              method="get"
              className="space-y-2 px-5 py-4"
              aria-label="See the policy as it was"
            >
              <label className="block text-sm text-muted" htmlFor="asOf">
                See the policy as it was on
              </label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="asOf"
                  type="datetime-local"
                  name="asOf"
                  required
                  defaultValue={asOf ?? ''}
                  className="w-auto min-w-0 flex-1"
                />
                <Button type="submit" variant="secondary">
                  Show
                </Button>
              </div>
            </form>
          </Card>
        </div>
      </div>
    </>
  );
}
