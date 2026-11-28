import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2, CircleAlert, CircleX } from 'lucide-react';
import {
  PERMISSIONS,
  ROLE_LABELS,
  type AgentDetail,
  type AgentRun,
  type EvalRun,
  type Permission,
  type Role,
} from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { nameOf, peopleNames } from '@/lib/people';
import { RUN_STATUS_TONES, TOOL_ACTIVITY, usd } from '@/lib/agents';
import { sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import {
  Badge,
  Card,
  CardHeader,
  DescriptionList,
  EmptyState,
  Notice,
  PageHeader,
} from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { BudgetBar } from '@/components/budget-bar';
import { BackLink } from '@/components/ui/back-link';
import {
  AutoRefresh,
  BudgetForm,
  KillSwitch,
  RunEvaluation,
  VersionDecision,
  WarrantEditor,
} from '../agent-forms';

export const metadata = { title: 'Agent' };

const APPROVAL_TONE = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  retired: 'neutral',
} as const;

export default async function AgentPage({ params }: { params: Promise<{ agentId: string }> }) {
  const me = (await getMe())!;
  if (!me.permissions.includes('agents:read')) return <AccessDenied permission="agents:read" />;
  const { agentId } = await params;
  if (!/^AG-\d{2}$/.test(agentId)) notFound();
  const can = (p: Permission) => me.permissions.includes(p);

  const [agent, evals, runs] = await Promise.all([
    load(() => api<AgentDetail>(`/v1/agents/${agentId}`)),
    load(() => api<{ items: EvalRun[] }>(`/v1/agents/${agentId}/evaluations`)),
    load(() => api<{ items: AgentRun[] }>('/v1/agent-runs', { query: { agentId, limit: 10 } })),
  ]);
  if (agent.error instanceof ApiProblem && agent.error.problem.code === 'not_found') notFound();
  if (agent.error) return <ErrorPanel error={agent.error} />;
  const a = agent.data;
  const names = await peopleNames([...a.versions.map((v) => v.approvedBy), a.warrant?.createdBy]);
  const evalRuns = evals.data?.items ?? [];
  const evaluating = evalRuns.some((e) => e.status === 'queued' || e.status === 'running');

  const blockers = [
    a.status !== 'active' ? `The agent is ${a.status}.` : null,
    !a.warrant ? 'No warrant is set.' : null,
    !a.budget ? 'No budget is set.' : null,
    !a.liveVersion ? 'No version is approved.' : null,
  ].filter(Boolean) as string[];

  return (
    <>
      <AutoRefresh active={evaluating} />
      <BackLink href="/agents">Agent registry</BackLink>
      <PageHeader
        eyebrow={`${a.id} · Autonomy ${a.autonomy}`}
        title={a.name}
        description={a.purpose}
        actions={
          can('agents:pause') ? <KillSwitch agentId={a.id} name={a.name} status={a.status} /> : null
        }
      />

      <div className="mb-6">
        {blockers.length ? (
          <Card className="ai-surface overflow-hidden" aria-labelledby="release">
            <CardHeader
              titleId="release"
              title="Not serving requests"
              description={
                a.status === 'paused'
                  ? `Paused. ${a.statusReason ? `Reason: ${a.statusReason}` : ''}`
                  : 'A person takes it through these steps. Nothing happens on its own.'
              }
            />
            <ol className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-4">
              {[
                { title: 'Set what it may do', done: !!a.warrant, note: 'The warrant' },
                { title: 'Set what it may spend', done: !!a.budget, note: 'A monthly budget' },
                {
                  title: 'Test it',
                  done: !!a.liveVersion || a.versions.some((v) => v.latestEvaluation?.passed),
                  note: 'A version passes its evaluation',
                },
                {
                  title: 'Approve a version',
                  done: !!a.liveVersion,
                  note: 'It then serves requests',
                },
              ].map((step, i) => (
                <li key={step.title} className="flex gap-3 bg-surface px-5 py-4">
                  {step.done ? (
                    <CheckCircle2 aria-label="Done" className="size-6 shrink-0 text-success" />
                  ) : (
                    <span
                      aria-hidden
                      className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border-strong text-xs font-semibold text-muted"
                    >
                      {i + 1}
                    </span>
                  )}
                  <span className="min-w-0 text-sm">
                    <span className="block font-medium text-fg">{step.title}</span>
                    <span className="block text-xs text-muted">{step.note}</span>
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        ) : (
          <Notice tone="success" title={`Version ${a.liveVersion} is live`}>
            Serving requests under warrant version {a.warrantVersion}. {a.autonomyLabel}.
          </Notice>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader
              title="Versions"
              description="Each change to the agent’s prompt, model, tools or access is a new version. A person approves it after a passed evaluation."
            />
            <Table caption="Agent versions">
              <THead>
                <tr>
                  <TH>Version</TH>
                  <TH>Model and prompt</TH>
                  <TH>Status</TH>
                  <TH>Latest evaluation</TH>
                  {can('agents:manage') ? <TH className="text-right">Actions</TH> : null}
                </tr>
              </THead>
              <tbody>
                {a.versions.map((v) => (
                  <TR key={v.version}>
                    <TD className="font-semibold">v{v.version}</TD>
                    <TD>
                      <span className="block font-mono text-xs">
                        {v.model} · effort {v.effort}
                      </span>
                      <span
                        className="block font-mono text-[11px] text-subtle"
                        title={v.configHash}
                      >
                        {v.promptVersion} · {v.configHash.slice(0, 12)}
                      </span>
                    </TD>
                    <TD>
                      <Badge tone={APPROVAL_TONE[v.approvalStatus]}>
                        {sentenceCase(v.approvalStatus)}
                      </Badge>
                      {v.approvedBy ? (
                        <span className="mt-1 block text-[11px] text-subtle">
                          by {nameOf(names, v.approvedBy)}
                        </span>
                      ) : null}
                    </TD>
                    <TD>
                      {v.latestEvaluation ? (
                        <span className="inline-flex items-center gap-1.5 text-sm">
                          {v.latestEvaluation.passed === true ? (
                            <CheckCircle2 aria-hidden className="size-4 text-success" />
                          ) : v.latestEvaluation.passed === false ? (
                            <CircleX aria-hidden className="size-4 text-danger" />
                          ) : (
                            <CircleAlert aria-hidden className="size-4 text-subtle" />
                          )}
                          {v.latestEvaluation.score !== null
                            ? `${Math.round(v.latestEvaluation.score * 100)}%`
                            : sentenceCase(v.latestEvaluation.status)}
                        </span>
                      ) : (
                        <span className="text-sm text-subtle">Not evaluated</span>
                      )}
                    </TD>
                    {can('agents:manage') ? (
                      <TD>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          {v.approvalStatus === 'pending' && a.evalSets.length ? (
                            <RunEvaluation
                              agentId={a.id}
                              version={v.version}
                              evalSets={a.evalSets}
                            />
                          ) : null}
                          {v.approvalStatus === 'pending' ? (
                            <VersionDecision agentId={a.id} version={v.version} />
                          ) : null}
                        </div>
                      </TD>
                    ) : null}
                  </TR>
                ))}
              </tbody>
            </Table>
          </Card>

          <Card>
            <CardHeader
              title="Evaluations"
              description="Each case runs through the real model under the warrant. Critical cases must all pass."
            />
            {evalRuns.length === 0 ? (
              <EmptyState
                title="No evaluations yet"
                description="Set the warrant and budget, then evaluate a version."
              />
            ) : (
              <ul className="divide-y divide-border">
                {evalRuns.slice(0, 8).map((e) => (
                  <li key={e.id} className="px-5 py-3">
                    <details>
                      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 text-sm">
                        <Badge
                          tone={
                            e.status === 'completed'
                              ? e.passed
                                ? 'success'
                                : 'danger'
                              : e.status === 'failed'
                                ? 'danger'
                                : 'primary'
                          }
                        >
                          {e.status === 'completed'
                            ? e.passed
                              ? 'Passed'
                              : 'Failed'
                            : sentenceCase(e.status)}
                        </Badge>
                        <span className="font-medium text-fg">
                          v{e.agentVersion} · {e.evalSet} v{e.evalSetVersion}
                        </span>
                        {e.score !== null ? (
                          <span className="text-muted">{Math.round(e.score * 100)}%</span>
                        ) : null}
                        <span className="text-muted">{usd(e.costUsd)}</span>
                        <span className="ml-auto text-xs text-subtle">
                          <LocalTime iso={e.createdAt} relative />
                        </span>
                      </summary>
                      {e.error ? <p className="mt-2 text-sm text-danger">{e.error}</p> : null}
                      {e.results?.length ? (
                        <ul className="mt-3 space-y-2">
                          {e.results.map((r) => {
                            const res = r as {
                              caseId: string;
                              description: string;
                              passed: boolean;
                              critical: boolean;
                              failures: string[];
                              runId: string;
                              toolsCalled: string[];
                            };
                            return (
                              <li
                                key={res.caseId}
                                className="rounded-lg border border-border px-3 py-2 text-sm"
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  {res.passed ? (
                                    <CheckCircle2
                                      aria-label="Passed"
                                      className="size-4 text-success"
                                    />
                                  ) : (
                                    <CircleX aria-label="Failed" className="size-4 text-danger" />
                                  )}
                                  <span className="font-medium text-fg">{res.description}</span>
                                  {res.critical ? <Badge tone="warning">Critical</Badge> : null}
                                  <Link
                                    href={`/agents/runs/${res.runId}`}
                                    className="ml-auto text-xs font-medium text-primary hover:underline"
                                  >
                                    Run record
                                  </Link>
                                </div>
                                {res.failures.length ? (
                                  <p className="mt-1 text-xs text-danger">
                                    {res.failures.join('; ')}
                                  </p>
                                ) : null}
                                {res.toolsCalled.length ? (
                                  <p className="mt-1 font-mono text-[11px] text-subtle">
                                    {res.toolsCalled.join(', ')}
                                  </p>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Recent runs" />
            {runs.data?.items.length ? (
              <Table caption="Recent agent runs">
                <THead>
                  <tr>
                    <TH>When</TH>
                    <TH>Requested by</TH>
                    <TH>Status</TH>
                    <TH>Tools</TH>
                    <TH>Cost</TH>
                  </tr>
                </THead>
                <tbody>
                  {runs.data.items.map((r) => (
                    <TR key={r.id}>
                      <TD>
                        <Link
                          href={`/agents/runs/${r.id}`}
                          className="text-primary hover:underline"
                        >
                          <LocalTime iso={r.createdAt} />
                        </Link>
                      </TD>
                      <TD className="text-muted">
                        {r.purpose === 'evaluation'
                          ? 'Evaluation'
                          : (r.requestedByName ?? r.requestedBy)}
                      </TD>
                      <TD>
                        <Badge tone={RUN_STATUS_TONES[r.status]}>{sentenceCase(r.status)}</Badge>
                      </TD>
                      <TD className="tabular-nums text-muted">{r.toolCalls}</TD>
                      <TD className="tabular-nums text-muted">{usd(r.costUsd)}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="No runs yet" />
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Warrant"
              description={a.warrant ? `Version ${a.warrant.version}` : 'Not set'}
              actions={
                can('agents:manage') ? (
                  <WarrantEditor
                    agentId={a.id}
                    current={a.warrant?.document ?? null}
                    proposed={a.proposedWarrant}
                  />
                ) : null
              }
            />
            <div className="space-y-4 p-5 text-sm">
              {a.warrant ? (
                <>
                  <div>
                    <p className="mb-1.5 text-xs font-semibold text-muted">
                      Permitted tools (calls per run)
                    </p>
                    <ul className="space-y-1">
                      {a.warrant.document.tools.map((t) => (
                        <li key={t.name} className="flex justify-between gap-3">
                          <span className="min-w-0">
                            {TOOL_ACTIVITY[t.name] ?? sentenceCase(t.name)}
                            <span className="block break-all font-mono text-[11px] text-subtle">
                              {t.name}
                            </span>
                          </span>
                          <span className="tabular-nums text-muted">{t.maxCallsPerRun}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="mb-1.5 text-xs font-semibold text-muted">Access it may use</p>
                    <ul className="space-y-0.5 text-muted">
                      {a.warrant.document.dataAccess.map((p) => (
                        <li key={p}>{PERMISSIONS[p]}</li>
                      ))}
                    </ul>
                    <p className="mt-1 text-xs text-subtle">
                      Never more than the person it acts for.
                    </p>
                  </div>
                  <DescriptionList
                    items={[
                      { term: 'Model turns', value: a.warrant.document.maxModelTurns },
                      { term: 'Cost per run', value: usd(a.warrant.document.maxCostPerRunUsd, 2) },
                      {
                        term: 'Escalates to',
                        value:
                          ROLE_LABELS[a.warrant.document.escalationRole as Role] ??
                          a.warrant.document.escalationRole,
                      },
                      { term: 'Set by', value: nameOf(names, a.warrant.createdBy) },
                    ]}
                  />
                  <p className="text-xs text-subtle">Reason: {a.warrant.reason}</p>
                </>
              ) : (
                <p className="text-muted">
                  Without a warrant the agent cannot run. Only an AI governance lead can set one.
                </p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Budget"
              actions={
                can('agents:manage') ? (
                  <BudgetForm
                    agentId={a.id}
                    limit={a.budget ? Number(a.budget.monthlyLimitUsd) : null}
                    threshold={
                      a.budget?.alertThresholdPct ?? a.proposedBudget?.alertThresholdPct ?? null
                    }
                  />
                ) : null
              }
            />
            <div className="p-5">
              {a.budget ? (
                <>
                  <BudgetBar
                    spent={Number(a.budget.spentThisMonthUsd)}
                    limit={Number(a.budget.monthlyLimitUsd)}
                  />
                  <p className="mt-2 text-xs text-subtle">
                    Alert at {a.budget.alertThresholdPct}% of the limit.
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted">
                  No budget, so the agent cannot spend. Proposed in code:{' '}
                  {a.proposedBudget ? usd(a.proposedBudget.monthlyLimitUsd, 2) : 'none'} a month.
                </p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Registration" />
            <div className="p-5">
              <DescriptionList
                items={[
                  { term: 'Owner', value: ROLE_LABELS[a.ownerRole as Role] ?? a.ownerRole },
                  { term: 'Autonomy', value: a.autonomyLabel },
                  { term: 'Status changed', value: <LocalTime iso={a.statusChangedAt} /> },
                  {
                    term: 'Open reviews',
                    value: a.openReviews ? (
                      <Link className="text-primary hover:underline" href="/agents/reviews">
                        {a.openReviews}
                      </Link>
                    ) : (
                      0
                    ),
                  },
                ]}
              />
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
