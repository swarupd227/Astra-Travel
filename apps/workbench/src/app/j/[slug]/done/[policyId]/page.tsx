import { notFound } from 'next/navigation';
import { DOCUMENT_KIND_LABELS, type IssuedDocument, type Policy } from '@astra/contracts';
import { ApiProblem } from '@/lib/api-problem';
import { journeyApi, journeyConfig } from '@/lib/journey';

export const metadata = { title: 'Your cover is bought', robots: { index: false, follow: false } };

export default async function JourneyDone({ params }: { params: Promise<{ slug: string; policyId: string }> }) {
  const { slug, policyId } = await params;
  const cfg = await journeyConfig(slug);
  if (!cfg || !/^[0-9a-f-]{36}$/i.test(policyId)) notFound();
  let policy: Policy;
  let docs: IssuedDocument[];
  try {
    policy = await journeyApi<Policy>(cfg, `/v1/policies/${policyId}`);
    docs = (await journeyApi<{ items: IssuedDocument[] }>(cfg, `/v1/policies/${policyId}/documents`)).items.filter((d) => d.status === 'issued');
  } catch (err) {
    if (err instanceof ApiProblem && err.problem.code === 'not_found') notFound();
    throw err;
  }
  return (
    <>
      <h1 className="mb-2 text-3xl font-bold">Your cover is bought</h1>
      <p className="mb-6">
        Your policy number is <strong className="font-mono">{policy.number}</strong>. Cover runs from {policy.record.term.start.replace('T', ' ')} to {policy.record.term.end.replace('T', ' ')}.
      </p>
      {cfg.payment === 'test' ? (
        <p role="note" className="mb-6 rounded-lg border border-[#b25e00] bg-[#fff4e5] p-3 text-[#4d2900]">
          This was a test purchase in a sandbox: no money was taken and the policy is not real.
        </p>
      ) : null}
      <section aria-labelledby="docs">
        <h2 id="docs" className="mb-2 text-lg font-semibold">
          Your documents
        </h2>
        <ul className="list-disc space-y-1 pl-5">
          {docs.map((d) => (
            <li key={d.id}>
              <a className="underline" href={`/j/${slug}/file/${d.id}?policy=${policyId}`} target="_blank" rel="noreferrer">
                {DOCUMENT_KIND_LABELS[d.kind]} (PDF)
              </a>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
