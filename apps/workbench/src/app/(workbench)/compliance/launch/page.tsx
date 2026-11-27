import { CheckCircle2, XCircle } from 'lucide-react';
import { SIGNOFF_ROLES, type Readiness } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { Badge, Card, CardHeader, Notice, PageHeader } from '@/components/ui/primitives';
import { LocalTime } from '@/components/ui/time';
import { SignForm } from './sign-form';

export const metadata = { title: 'Launch readiness' };

function Checks({ checks }: { checks: { code: string; passed: boolean; detail: string }[] }) {
  return (
    <ul className="space-y-1">
      {checks.map((c) => (
        <li key={c.code} className="flex items-start gap-2 text-sm">
          {c.passed ? (
            <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
          ) : (
            <XCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
          )}
          <span>
            <span className="sr-only">{c.passed ? 'Met: ' : 'Missing: '}</span>
            {c.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default async function LaunchPage({
  searchParams,
}: {
  searchParams: Promise<{ states?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('launch:read')) return <AccessDenied permission="launch:read" />;
  const asked = ((await searchParams).states ?? '').toUpperCase().replace(/\s+/g, '');
  const states = /^[A-Z]{2}(,[A-Z]{2}){0,59}$/.test(asked) ? asked : undefined;
  const res = await load(() => api<Readiness>('/v1/launch-readiness', { query: { states } }));
  if (res.error) return <ErrorPanel error={res.error} />;
  const r = res.data;
  const canSign = me.permissions.includes('launch:signoff');
  return (
    <>
      <PageHeader
        eyebrow="Compliance"
        title="Launch readiness"
        description="What each state still needs before it can be sold, from the plans, rules, manuals, parity runs, templates and filings in the platform. Going live needs every state ready and a signature from product, actuarial, compliance and finance."
        actions={
          <Badge tone={r.goLiveApproved ? 'success' : 'warning'}>
            {r.goLiveApproved ? 'Go-live approved' : 'Not approved'}
          </Badge>
        }
      />
      <Card className="mb-6">
        <form
          method="get"
          className="flex flex-wrap items-end gap-3 p-4"
          aria-label="Choose the launch states"
        >
          <label className="min-w-64 text-sm">
            <span className="mb-1 block font-medium text-fg">
              Launch states (for example DE, NY)
            </span>
            <Input
              name="states"
              defaultValue={states?.replace(/,/g, ', ') ?? ''}
              placeholder="Every state with a plan"
            />
          </label>
          <Button type="submit" variant="secondary">
            Show
          </Button>
        </form>
      </Card>
      {r.states.length === 0 ? (
        <Notice tone="neutral" title="No state has a plan yet">
          Build and publish a state plan, or name the launch states above.
        </Notice>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            {r.byState.map((s) => (
              <Card key={s.state}>
                <CardHeader
                  title={`State ${s.state}`}
                  actions={
                    <Badge tone={s.ready ? 'success' : 'danger'}>
                      {s.ready ? 'Ready' : 'Not ready'}
                    </Badge>
                  }
                />
                <div className="space-y-4 p-5">
                  <Checks checks={s.checks} />
                  {s.plans.map((p) => (
                    <section
                      key={p.code}
                      aria-label={`${s.state}: ${p.name}`}
                      className="rounded-lg border border-border p-4"
                    >
                      <h3 className="mb-2 text-sm font-semibold text-fg">
                        {p.name}{' '}
                        <span className="font-mono text-xs text-muted">
                          {p.code} v{p.version}
                        </span>
                      </h3>
                      <Checks checks={p.checks} />
                    </section>
                  ))}
                </div>
              </Card>
            ))}
          </div>
          <Card className="h-fit">
            <CardHeader
              title="Sign-offs"
              description="For the report as it stands. If anything in it changes, it must be signed again."
            />
            <ul className="divide-y divide-border">
              {r.signoffs.map((s) => (
                <li key={s.area} className="space-y-2 p-5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-fg">{sentenceCase(s.area)}</span>
                    <Badge tone={s.signed ? 'success' : 'neutral'}>
                      {s.signed ? 'Signed' : 'Not signed'}
                    </Badge>
                  </div>
                  {s.signed && s.at ? (
                    <p className="text-xs text-muted">
                      {s.name ?? s.by}, <LocalTime iso={s.at} />: {s.note}
                    </p>
                  ) : null}
                  {canSign && me.roles.includes(SIGNOFF_ROLES[s.area]) && (r.ready || s.signed) ? (
                    <SignForm
                      states={r.states}
                      area={s.area}
                      reportHash={r.reportHash}
                      signed={s.signed}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}
