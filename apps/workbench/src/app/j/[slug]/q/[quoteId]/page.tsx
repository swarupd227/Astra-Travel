import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, Check, FileText } from 'lucide-react';
import type { Offer } from '@astra/contracts';
import { ApiProblem } from '@/lib/api-problem';
import { journeyApi, journeyConfig } from '@/lib/journey';
import { OptionsForm } from '../../journey-forms';
import { money, Panel, Steps } from '../../parts';

export const metadata = { title: 'Your price', robots: { index: false, follow: false } };

export default async function JourneyOffer({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; quoteId: string }>;
  searchParams: Promise<{ updated?: string }>;
}) {
  const { slug, quoteId } = await params;
  const { updated } = await searchParams;
  const cfg = await journeyConfig(slug);
  if (!cfg || !/^[0-9a-f-]{36}$/i.test(quoteId)) notFound();
  let offer: Offer;
  try {
    offer = await journeyApi<Offer>(cfg, `/v1/quotes/${quoteId}/offer`);
  } catch (err) {
    if (err instanceof ApiProblem && err.problem.code === 'not_found') notFound();
    throw err;
  }
  const included = offer.benefits.filter((b) => b.packaging === 'packaged' && b.selected);
  const optional = offer.benefits.filter((b) => b.packaging !== 'packaged');
  const canBuy = offer.status === 'open' && offer.outcome === 'eligible' && offer.total !== null;
  return (
    <>
      <Steps current={2} />
      <h1 className="mb-1 text-3xl font-bold tracking-tight">Your cover and price</h1>
      <p className="mb-6 text-[#4a4a4a]">{offer.plan.name}</p>
      <div className="space-y-5">
        {updated ? (
          <p
            role="status"
            className="rounded-xl border border-[#15803d] bg-[#f0fdf4] p-3 text-[#14532d]"
          >
            Your price is updated.
          </p>
        ) : null}
        {!canBuy ? (
          <div
            role="alert"
            className="rounded-xl border border-[#b25e00] bg-[#fff4e5] p-4 text-[#4d2900]"
          >
            {offer.status !== 'open'
              ? 'This offer is no longer open. Please start again.'
              : offer.notBindable.length
                ? offer.notBindable.join(' ')
                : 'We cannot offer cover for this trip.'}
          </div>
        ) : null}
        <Panel aria-labelledby="included">
          <h2 id="included" className="mb-3 text-lg font-semibold">
            What is included
          </h2>
          <ul className="divide-y divide-[#e3e6ea]">
            {included.map((b) => (
              <li key={b.code} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                <Check aria-hidden className="mt-0.5 size-5 shrink-0 text-[#15803d]" />
                <span className="min-w-0 flex-1">
                  <span className="font-semibold">{b.name}</span>
                  {b.limit ? (
                    <span className="block text-sm text-[#4a4a4a]">Up to {b.limit}</span>
                  ) : null}
                </span>
                <span className="whitespace-nowrap">
                  {b.premium ? money(b.premium) : 'Included'}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
        {offer.status === 'open' && optional.length ? (
          <Panel>
            <OptionsForm
              slug={slug}
              quoteId={quoteId}
              optional={optional.map((b) => ({
                code: b.code,
                name: b.name,
                limit: b.limit,
                premium: b.premium,
                selected: b.selected,
                available: b.available,
                reason: b.reason,
              }))}
            />
          </Panel>
        ) : null}
        <Panel>
          <p className="flex items-baseline justify-between gap-4">
            <span className="text-lg font-semibold">Total price</span>
            <span className="text-3xl font-bold tabular-nums">
              {offer.total ? money(offer.total) : 'Not available'}
            </span>
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
            {offer.wordingUrl ? (
              <p className="flex items-center gap-2 text-sm">
                <FileText aria-hidden className="size-4" />
                <span>
                  <a
                    className="font-medium underline"
                    href={`/j/${slug}/file/wording?quote=${quoteId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Read the full policy wording
                  </a>{' '}
                  (opens in a new tab)
                </span>
              </p>
            ) : null}
            {canBuy ? (
              <Link
                href={`/j/${slug}/q/${quoteId}/pay`}
                className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg px-6 text-base font-semibold sm:ml-auto sm:w-auto"
                style={{ background: 'var(--brand)', color: 'var(--on-brand)' }}
              >
                Continue to buy <ArrowRight aria-hidden className="size-5" />
              </Link>
            ) : (
              <Link href={`/j/${slug}`} className="font-medium underline">
                Start again
              </Link>
            )}
          </div>
        </Panel>
      </div>
    </>
  );
}
