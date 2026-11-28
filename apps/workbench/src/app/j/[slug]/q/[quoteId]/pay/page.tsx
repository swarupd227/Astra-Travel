import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import type { Quote } from '@astra/contracts';
import { ApiProblem } from '@/lib/api-problem';
import { journeyApi, journeyConfig } from '@/lib/journey';
import { PayForm } from '../../../journey-forms';
import { money, Panel, Steps } from '../../../parts';

export const metadata = { title: 'Buy your cover', robots: { index: false, follow: false } };

export default async function JourneyPay({
  params,
}: {
  params: Promise<{ slug: string; quoteId: string }>;
}) {
  const { slug, quoteId } = await params;
  const cfg = await journeyConfig(slug);
  if (!cfg || !/^[0-9a-f-]{36}$/i.test(quoteId)) notFound();
  let q: Quote;
  try {
    q = await journeyApi<Quote>(cfg, `/v1/quotes/${quoteId}`);
  } catch (err) {
    if (err instanceof ApiProblem && err.problem.code === 'not_found') notFound();
    throw err;
  }
  if (q.status !== 'open' || !q.premium || !q.disclosure) {
    return (
      <>
        <h1 className="mb-3 text-3xl font-bold tracking-tight">
          This quote can no longer be bought
        </h1>
        <p>
          <Link className="font-medium underline" href={`/j/${slug}`}>
            Start again
          </Link>
        </p>
      </>
    );
  }
  return (
    <>
      <Steps current={3} />
      <Link
        href={`/j/${slug}/q/${quoteId}`}
        className="mb-3 inline-flex items-center gap-1 text-sm font-medium underline"
      >
        <ChevronLeft aria-hidden className="size-4" /> Back to your price
      </Link>
      <h1 className="mb-6 text-3xl font-bold tracking-tight">Buy your cover</h1>
      <div className="space-y-5">
        <Panel className="flex flex-wrap items-baseline justify-between gap-3">
          <p>
            <span className="block font-semibold">{q.plan.name}</span>
            <span className="text-sm text-[#4a4a4a]">
              {q.travellers.map((t) => `${t.firstName} ${t.lastName}`).join(', ')}
            </span>
          </p>
          <p className="text-2xl font-bold tabular-nums">{money(q.premium.total)}</p>
        </Panel>
        <Panel aria-labelledby="notice">
          <h2 id="notice" className="mb-2 text-lg font-semibold">
            {q.disclosure.title}
          </h2>
          <p className="whitespace-pre-line">{q.disclosure.text}</p>
        </Panel>
        <PayForm slug={slug} quoteId={quoteId} total={q.premium.total} payment={cfg.payment} />
      </div>
    </>
  );
}
