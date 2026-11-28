import { notFound } from 'next/navigation';
import type { z } from 'zod';
import type { Quote, WidgetSessionSchema } from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { BackLink } from '@/components/ui/back-link';
import { Card, CardHeader, Notice, PageHeader } from '@/components/ui/primitives';
import { CopyButton, WidgetFrame } from './widget-frame';

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
      <BackLink href={`/quotes/${quoteId}`}>Quote</BackLink>
      <PageHeader
        eyebrow={`${q.data.plan.code} · ${q.data.state}`}
        title="Widget preview"
        description="What the account’s booking page shows. Travellers can add and remove optional benefits here; they cannot buy."
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
        <div className="space-y-6">
          <Card className="overflow-hidden">
            <CardHeader title="As the traveller sees it" />
            <WidgetFrame
              scriptUrl={s.data.scriptUrl}
              api={s.data.apiUrl}
              quoteId={quoteId}
              token={s.data.token}
            />
          </Card>
          <Card>
            <CardHeader
              title="Add it to a booking page"
              description="The account’s server starts a session for each quote and puts this in the page. The token lasts 30 minutes."
              actions={<CopyButton text={s.data.snippet} />}
            />
            <pre
              className="overflow-auto p-5 font-mono text-xs leading-relaxed"
              tabIndex={0}
              aria-label="Widget snippet"
            >
              {s.data.snippet}
            </pre>
          </Card>
        </div>
      )}
    </>
  );
}
