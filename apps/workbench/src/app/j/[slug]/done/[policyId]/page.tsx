import { notFound } from 'next/navigation';
import { CircleCheck, Download } from 'lucide-react';
import { DOCUMENT_KIND_LABELS, type IssuedDocument, type Policy } from '@astra/contracts';
import { ApiProblem } from '@/lib/api-problem';
import { formatDayTime } from '@/lib/format';
import { journeyApi, journeyConfig } from '@/lib/journey';
import { Panel } from '../../parts';

export const metadata = { title: 'Your cover is bought', robots: { index: false, follow: false } };

export default async function JourneyDone({
  params,
}: {
  params: Promise<{ slug: string; policyId: string }>;
}) {
  const { slug, policyId } = await params;
  const cfg = await journeyConfig(slug);
  if (!cfg || !/^[0-9a-f-]{36}$/i.test(policyId)) notFound();
  let policy: Policy;
  let docs: IssuedDocument[];
  try {
    policy = await journeyApi<Policy>(cfg, `/v1/policies/${policyId}`);
    docs = (
      await journeyApi<{ items: IssuedDocument[] }>(cfg, `/v1/policies/${policyId}/documents`)
    ).items.filter((d) => d.status === 'issued');
  } catch (err) {
    if (err instanceof ApiProblem && err.problem.code === 'not_found') notFound();
    throw err;
  }
  return (
    <div className="space-y-5">
      <div className="text-center">
        <CircleCheck aria-hidden className="mx-auto mb-3 size-14 text-[#15803d]" />
        <h1 className="mb-2 text-3xl font-bold tracking-tight">Your cover is bought</h1>
        <p>
          Your policy number is <strong className="font-mono text-lg">{policy.number}</strong>
        </p>
        <p className="text-[#4a4a4a]">
          Cover runs from {formatDayTime(policy.record.term.start)} to{' '}
          {formatDayTime(policy.record.term.end)}.
        </p>
      </div>
      {cfg.payment === 'test' ? (
        <p
          role="note"
          className="rounded-xl border border-[#b25e00] bg-[#fff4e5] p-4 text-[#4d2900]"
        >
          This was a test purchase in a sandbox: no money was taken and the policy is not real.
        </p>
      ) : null}
      <Panel aria-labelledby="docs">
        <h2 id="docs" className="mb-3 text-lg font-semibold">
          Your documents
        </h2>
        {docs.length ? (
          <ul className="divide-y divide-[#e3e6ea]">
            {docs.map((d) => (
              <li key={d.id} className="py-3 first:pt-0 last:pb-0">
                <a
                  className="flex items-center gap-3 font-medium underline"
                  href={`/j/${slug}/file/${d.id}?policy=${policyId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Download aria-hidden className="size-5" />
                  {DOCUMENT_KIND_LABELS[d.kind]} (PDF)
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[#4a4a4a]">
            Your documents are being prepared. Refresh this page in a moment.
          </p>
        )}
      </Panel>
    </div>
  );
}
