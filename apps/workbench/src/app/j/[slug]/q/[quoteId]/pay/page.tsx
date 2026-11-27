import { notFound } from 'next/navigation';
import type { Quote } from '@astra/contracts';
import { ApiProblem } from '@/lib/api-problem';
import { journeyApi, journeyConfig } from '@/lib/journey';
import { PayForm } from '../../../journey-forms';

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
        <h1 className="mb-3 text-3xl font-bold">This quote can no longer be bought</h1>
        <p>
          <a className="underline" href={`/j/${slug}`}>
            Start again
          </a>
        </p>
      </>
    );
  }
  return (
    <>
      <h1 className="mb-1 text-3xl font-bold">Buy your cover</h1>
      <p className="mb-6 text-[#4a4a4a]">
        {q.plan.name}: total{' '}
        {`$${Number(q.premium.total).toLocaleString('en-US', { minimumFractionDigits: 2 })}`}
      </p>
      <section aria-labelledby="notice" className="mb-6 rounded-lg border border-[#6b7280] p-4">
        <h2 id="notice" className="mb-2 text-lg font-semibold">
          {q.disclosure.title}
        </h2>
        <p className="whitespace-pre-line">{q.disclosure.text}</p>
      </section>
      <PayForm slug={slug} quoteId={quoteId} total={q.premium.total} payment={cfg.payment} />
    </>
  );
}
