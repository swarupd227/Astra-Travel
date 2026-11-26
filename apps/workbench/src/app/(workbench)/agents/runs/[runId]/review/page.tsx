import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import type { AgentRunReview } from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { RUN_STATUS_TONES, usd } from '@/lib/agents';
import { sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { AnswerText } from '@/components/answer-text';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, CardHeader, DescriptionList, PageHeader } from '@/components/ui/primitives';
import { LocalTime } from '@/components/ui/time';

export const metadata = { title: 'Review agent output' };

const KIND_LABELS: Record<string, string> = {
  input: 'Given',
  guardrail: 'Safety check',
  warrant: 'Warrant check',
  model_call: 'Model call',
  tool_call: 'Asked for',
  tool_result: 'Received',
  kill_switch: 'Kill switch',
  budget: 'Budget check',
  escalation: 'Escalated',
  output: 'Answered',
};

const pretty = (v: unknown): string => {
  const text = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return text.length > 6000 ? `${text.slice(0, 6000)}\n… (shortened; the full record is in the run's step log)` : text;
};

/** What a person needs to judge an agent's output: what it was given, what it read, what it concluded, and its limits (E11-F02-S02). */
export default async function RunReviewPage({ params }: { params: Promise<{ runId: string }> }) {
  const me = (await getMe())!;
  if (!me.permissions.includes('underwriting:read') && !me.permissions.includes('agents:read')) return <AccessDenied permission="underwriting:read" />;
  const { runId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(runId)) notFound();
  const res = await load(() => api<AgentRunReview>(`/v1/agent-runs/${runId}/review`));
  if (res.error instanceof ApiProblem && ['not_found', 'forbidden'].includes(res.error.problem.code)) notFound();
  if (res.error) return <ErrorPanel error={res.error} />;
  const r = res.data;
  const question = typeof r.input === 'object' && r.input !== null && 'question' in r.input ? String((r.input as { question: unknown }).question) : pretty(r.input);
  return (
    <>
      <Link href="/work" className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg">
        <ChevronLeft aria-hidden className="size-4" /> Work queue
      </Link>
      <PageHeader
        eyebrow="Agent output"
        title={`${r.agentName} (${r.agentId}) · run`}
        description="What the agent was given, what it read and did, what it concluded, and the limits it works within. Judge its output here, then record your decision where it was produced."
        actions={<Badge tone={RUN_STATUS_TONES[r.status as keyof typeof RUN_STATUS_TONES] ?? 'neutral'}>{sentenceCase(r.status)}</Badge>}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="What it was given" />
            <p className="whitespace-pre-line p-5 text-sm text-fg">{question}</p>
          </Card>
          <Card>
            <CardHeader title="What it concluded" description="Its final answer to the person who asked." />
            <div className="p-5 text-sm">{r.reasoning ? <AnswerText text={r.reasoning} /> : <p className="text-muted">The run gave no final answer.</p>}</div>
          </Card>
          <Card>
            <CardHeader title="What it read and did" description="In order: every tool it called, with the platform's answer, and every check the platform made on it." />
            <ol className="divide-y divide-border">
              {r.evidence.map((e) => (
                <li key={e.seq} className="px-5 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-mono text-xs text-muted">{e.seq}</span>
                    <span className="font-medium text-fg">{KIND_LABELS[e.kind] ?? sentenceCase(e.kind)}</span>
                    {e.name ? <code className="rounded bg-surface-muted px-1.5 py-0.5 text-xs">{e.name}</code> : null}
                    {e.decision ? <Badge tone={e.decision === 'allowed' ? 'success' : 'danger'}>{sentenceCase(e.decision)}</Badge> : null}
                    <span className="ml-auto text-xs text-muted">
                      <LocalTime iso={e.at} />
                    </span>
                  </div>
                  {e.kind === 'tool_call' || e.kind === 'tool_result' || e.kind === 'input' || e.kind === 'escalation' ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs font-medium text-primary">Show the detail</summary>
                      <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-surface-muted p-3 text-xs">{pretty(e.detail)}</pre>
                    </details>
                  ) : null}
                </li>
              ))}
            </ol>
          </Card>
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Its limits" description="The warrant this run was allowed to work within." />
            <div className="space-y-3 p-5 text-sm">
              {r.warrant ? (
                <>
                  <DescriptionList
                    items={[
                      { term: 'Warrant version', value: String(r.warrant.version) },
                      { term: 'Model turns', value: r.warrant.maxModelTurns === null ? '—' : `at most ${r.warrant.maxModelTurns}` },
                      { term: 'Cost per run', value: r.warrant.maxCostPerRunUsd === null ? '—' : `at most ${usd(r.warrant.maxCostPerRunUsd)}` },
                      { term: 'Hands over to', value: r.warrant.escalationRole ? sentenceCase(r.warrant.escalationRole) : '—' },
                    ]}
                  />
                  <div>
                    <p className="font-medium text-fg">Tools it may use</p>
                    <ul className="mt-1 list-disc pl-5 text-muted">
                      {r.warrant.tools.map((t) => (
                        <li key={t.name}>
                          <code className="text-xs">{t.name}</code>
                          {t.maxCallsPerRun !== null ? `, up to ${t.maxCallsPerRun} calls` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="font-medium text-fg">Data it may read</p>
                    <p className="mt-1 text-muted">{r.warrant.dataAccess.join(', ') || '—'}</p>
                  </div>
                </>
              ) : (
                <p className="text-muted">No warrant is recorded for this run.</p>
              )}
            </div>
          </Card>
          <Card>
            <CardHeader title="This run" />
            <div className="p-5">
              <DescriptionList
                items={[
                  { term: 'Version', value: String(r.agentVersion) },
                  { term: 'Turns', value: String(r.usage.turns) },
                  { term: 'Tool calls', value: String(r.usage.toolCalls) },
                  { term: 'Cost', value: usd(r.usage.costUsd) },
                ]}
              />
              <p className="mt-3 text-xs">
                <Link href={`/agents/runs/${r.runId}`} className="font-medium text-primary hover:underline">
                  Open the full run record
                </Link>
              </p>
            </div>
          </Card>
          <Card>
            <CardHeader title="Decisions about this output" />
            <div className="p-5 text-sm">
              {r.decisions.length === 0 ? (
                <p className="text-muted">Nobody has judged this output yet.</p>
              ) : (
                <ul className="space-y-2">
                  {r.decisions.map((d) => (
                    <li key={`${d.subjectId}:${d.decidedAt}`}>
                      <Badge tone={d.decision === 'rejected' ? 'danger' : 'primary'}>{sentenceCase(d.decision)}</Badge> <LocalTime iso={d.decidedAt} />
                      {d.reason ? <p className="mt-1 text-xs text-muted">{d.reason}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
