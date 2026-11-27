import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Offer } from '@astra/contracts';
import { ApiProblem } from '@/lib/api-problem';
import { journeyApi, journeyConfig } from '@/lib/journey';
import { OptionsForm } from '../../journey-forms';

export const metadata = { title: 'Your price', robots: { index: false, follow: false } };

const money = (v: string) =>
  `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
      <h1 className="mb-1 text-3xl font-bold">Your cover and price</h1>
      <p className="mb-6 text-[#4a4a4a]">{offer.plan.name}</p>
      {updated ? (
        <p
          role="status"
          className="mb-4 rounded-lg border border-[#15803d] bg-[#f0fdf4] p-3 text-[#14532d]"
        >
          Your price is updated.
        </p>
      ) : null}
      {!canBuy ? (
        <div
          role="alert"
          className="mb-6 rounded-lg border border-[#b25e00] bg-[#fff4e5] p-3 text-[#4d2900]"
        >
          {offer.status !== 'open'
            ? 'This offer is no longer open. Please start again.'
            : offer.notBindable.length
              ? offer.notBindable.join(' ')
              : 'We cannot offer cover for this trip.'}
        </div>
      ) : null}
      <section aria-labelledby="included" className="mb-6">
        <h2 id="included" className="mb-2 text-lg font-semibold">
          What is included
        </h2>
        <ul className="divide-y divide-[#e3e6ea] rounded-lg border border-[#c9ced6]">
          {included.map((b) => (
            <li key={b.code} className="flex justify-between gap-3 p-3">
              <span>
                <span className="font-semibold">{b.name}</span>
                {b.limit ? (
                  <span className="block text-sm text-[#4a4a4a]">Up to {b.limit}</span>
                ) : null}
              </span>
              <span className="whitespace-nowrap">{b.premium ? money(b.premium) : 'Included'}</span>
            </li>
          ))}
        </ul>
      </section>
      {offer.status === 'open' ? (
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
      ) : null}
      <p className="mt-6 flex items-baseline justify-between border-t-2 border-[#1a1a1a] pt-3 text-xl font-bold">
        <span>Total price</span>
        <span>{offer.total ? money(offer.total) : 'Not available'}</span>
      </p>
      {offer.wordingUrl ? (
        <p className="mt-3 text-sm">
          <a
            className="underline"
            href={`/j/${slug}/file/wording?quote=${quoteId}`}
            target="_blank"
            rel="noreferrer"
          >
            Read the full policy wording
          </a>{' '}
          (opens in a new tab)
        </p>
      ) : null}
      {canBuy ? (
        <p className="mt-6">
          <Link
            href={`/j/${slug}/q/${quoteId}/pay`}
            className="inline-flex h-11 items-center rounded-lg px-5 text-base font-semibold"
            style={{ background: 'var(--brand)', color: 'var(--on-brand)' }}
          >
            Continue to buy
          </Link>
        </p>
      ) : null}
    </>
  );
}
