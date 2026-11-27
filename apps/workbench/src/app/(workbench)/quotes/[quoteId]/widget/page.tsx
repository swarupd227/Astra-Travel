import { createElement } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import type { z } from 'zod';
import type { Quote, WidgetSessionSchema } from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Card, CardHeader, Notice, PageHeader } from '@/components/ui/primitives';

export const metadata = { title: 'Widget preview' };

type Session = z.infer<typeof WidgetSessionSchema>;

/** The cover widget as a traveller would see it in the account's booking page, loaded from the API like any host page would. */
export default async function WidgetPreview({ params }: { params: Promise<{ quoteId: string }> }) {
  const me = (await getMe())!;
  if (!me.permissions.includes('quotes:create')) return <AccessDenied permission="quotes:create" />;
  const { quoteId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(quoteId)) notFound();
  const q = await load(() => api<Quote>(`/v1/quotes/${quoteId}`));
  if (q.error instanceof ApiProblem && q.error.problem.code === 'not_found') notFound();
  if (q.error) return <ErrorPanel error={q.error} />;
  const s = await load(() =>
    api<Session>(`/v1/quotes/${quoteId}/widget-sessions`, { method: 'POST', body: {} }),
  );
  return (
    <>
      <Link
        href={`/quotes/${quoteId}`}
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> Quote
      </Link>
      <PageHeader
        eyebrow={`${q.data.plan.code} · ${q.data.state}`}
        title="Widget preview"
        description="What the account’s booking page shows. The widget loads from the API with a short token for this one quote; it can add and remove optional benefits, and it cannot bind."
      />
      {s.error ? (
        <Notice tone="warning" title="The widget cannot be shown">
          {s.error instanceof ApiProblem
            ? (s.error.problem.detail ?? s.error.problem.title)
            : 'The widget session could not be started.'}{' '}
          Switch the widget on, and list this site’s address as an allowed origin, in the account’s
          channel settings.
        </Notice>
      ) : (
        <>
          <Card className="mb-6">
            <CardHeader title="As the traveller sees it" />
            <div className="p-5">
              <script src={s.data.scriptUrl} async />
              {createElement('astra-cover-offer', {
                api: s.data.apiUrl,
                quote: quoteId,
                token: s.data.token,
              })}
            </div>
          </Card>
          <Card>
            <CardHeader
              title="Add it to a booking page"
              description="The account’s server starts a session for each quote and puts this in the page. The token lasts 30 minutes."
            />
            <pre
              className="overflow-auto p-5 font-mono text-xs leading-relaxed"
              tabIndex={0}
              aria-label="Widget snippet"
            >
              {s.data.snippet}
            </pre>
          </Card>
        </>
      )}
    </>
  );
}
