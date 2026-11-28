import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  Ban,
  Bot,
  ChevronLeft,
  CircleAlert,
  Cpu,
  EyeOff,
  FileCheck2,
  KeyRound,
  MessageSquareText,
  OctagonPause,
  Wallet,
  Wrench,
} from 'lucide-react';
import type { AgentRunDetail } from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { RUN_STATUS_TONES, STOP_EXPLANATIONS, TOOL_ACTIVITY, usd } from '@/lib/agents';
import { sentenceCase } from '@/lib/format';
import { AnswerText } from '@/components/answer-text';
import { ErrorPanel, load } from '@/components/error-panel';
import {
  Badge,
  Card,
  CardHeader,
  DescriptionList,
  PageHeader,
  type Tone,
} from '@/components/ui/primitives';
import { LocalTime } from '@/components/ui/time';

export const metadata = { title: 'Agent run' };

const KIND_ICON = {
  input: MessageSquareText,
  guardrail: EyeOff,
  warrant: KeyRound,
  model_call: Cpu,
  tool_call: Wrench,
  tool_result: FileCheck2,
  kill_switch: OctagonPause,
  budget: Wallet,
  escalation: CircleAlert,
  output: Bot,
} as const;

const DECISION_TONE: Record<string, Tone> = {
  allowed: 'success',
  refused: 'danger',
  redacted: 'warning',
  stopped: 'danger',
  error: 'danger',
};

function stepTitle(kind: string, name: string | null): string {
  switch (kind) {
    case 'input':
      return 'Question received';
    case 'warrant':
      return name === 'scope' ? 'Warrant applied' : `Warrant check: ${name}`;
    case 'model_call':
      return `Model call (${name})`;
    case 'tool_call':
      return TOOL_ACTIVITY[name ?? ''] ?? `Tool call: ${name}`;
    case 'tool_result':
      return `Result from ${name}`;
    case 'kill_switch':
      return 'Kill switch';
    case 'budget':
      return 'Budget check';
    case 'guardrail':
      return 'Guardrail';
    case 'escalation':
      return 'Escalated';
    case 'output':
      return 'Answer delivered';
    default:
      return sentenceCase(kind);
  }
}

function StepDetail({ kind, detail }: { kind: string; detail: Record<string, unknown> }) {
  if (
    kind === 'input' ||
    (kind === 'model_call' && typeof detail.text === 'string' && detail.text)
  ) {
    return <p className="mt-1 whitespace-pre-wrap text-sm text-fg">{String(detail.text ?? '')}</p>;
  }
  if (kind === 'warrant' && Array.isArray(detail.toolsOffered)) {
    return (
      <p className="mt-1 text-xs text-muted">
        Tools offered:{' '}
        <span className="font-mono">{(detail.toolsOffered as string[]).join(', ') || 'none'}</span>
        {Array.isArray(detail.toolsWithheld) && detail.toolsWithheld.length ? (
          <>
            {' '}
            · withheld:{' '}
            <span className="font-mono">{(detail.toolsWithheld as string[]).join(', ')}</span>
          </>
        ) : null}
      </p>
    );
  }
  if (typeof detail.reason === 'string')
    return <p className="mt-1 text-sm text-danger">{detail.reason}</p>;
  return null;
}

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  await getMe();
  const { runId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(runId)) notFound();
  const result = await load(() => api<AgentRunDetail>(`/v1/agent-runs/${runId}`));
  if (result.error instanceof ApiProblem && result.error.problem.code === 'not_found') notFound();
  if (result.error) return <ErrorPanel error={result.error} />;
  const r = result.data;
  const answer = typeof r.output?.answer === 'string' ? r.output.answer : null;
  const question = typeof r.input.question === 'string' ? r.input.question : '';

  return (
    <>
      <Link
        href={`/agents/${r.agentId}`}
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> {r.agentId}
      </Link>
      <PageHeader
        eyebrow={`${r.agentId} v${r.agentVersion} · ${r.purpose === 'evaluation' ? 'Evaluation run' : 'Request'}`}
        title="Run record"
        description="Everything this run did, in order. The record cannot be changed."
        actions={<Badge tone={RUN_STATUS_TONES[r.status]}>{sentenceCase(r.status)}</Badge>}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Question and answer" />
            <div className="space-y-4 p-5">
              <p className="rounded-lg bg-surface-muted px-4 py-3 text-[15px] text-fg">
                {question}
              </p>
              {answer ? (
                <AnswerText text={answer} />
              ) : (
                <p className="text-sm text-warning">
                  {STOP_EXPLANATIONS[r.stopReason ?? ''] ??
                    (r.status === 'queued' || r.status === 'running'
                      ? 'Still working…'
                      : 'No answer was given.')}
                </p>
              )}
            </div>
          </Card>
          <Card>
            <CardHeader title="Steps" description={`${r.steps.length} recorded`} />
            <ol className="relative space-y-0 px-5 py-4">
              {r.steps.map((s) => {
                const Icon = KIND_ICON[s.kind as keyof typeof KIND_ICON] ?? CircleAlert;
                const refused = s.decision === 'refused' || s.decision === 'stopped';
                return (
                  <li key={s.seq} className="relative flex gap-3 pb-4 last:pb-0">
                    <span
                      aria-hidden
                      className="absolute left-[15px] top-8 h-[calc(100%-2rem)] w-px bg-border last:hidden"
                    />
                    <span
                      aria-hidden
                      className={`z-10 flex size-8 shrink-0 items-center justify-center rounded-full ${refused ? 'bg-danger-soft text-danger' : 'bg-surface-muted text-muted'}`}
                    >
                      {refused ? <Ban className="size-4" /> : <Icon className="size-4" />}
                    </span>
                    <div className="min-w-0 flex-1 pt-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-fg">
                          {stepTitle(s.kind, s.name)}
                        </span>
                        {s.decision ? (
                          <Badge tone={DECISION_TONE[s.decision] ?? 'neutral'}>{s.decision}</Badge>
                        ) : null}
                        <span className="ml-auto text-xs text-subtle">
                          <LocalTime iso={s.at} />
                        </span>
                      </div>
                      <StepDetail kind={s.kind} detail={s.detail} />
                      <details className="mt-1 text-xs">
                        <summary className="cursor-pointer text-subtle">Details</summary>
                        <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-surface-muted p-2 font-mono text-[11px] text-fg">
                          {JSON.stringify(s.detail, null, 2)}
                        </pre>
                      </details>
                    </div>
                  </li>
                );
              })}
            </ol>
          </Card>
        </div>
        <Card>
          <CardHeader title="Run" />
          <div className="p-5">
            <DescriptionList
              items={[
                { term: 'Requested by', value: r.requestedByName ?? r.requestedBy },
                {
                  term: 'Started',
                  value: r.startedAt ? <LocalTime iso={r.startedAt} /> : 'Not started',
                },
                {
                  term: 'Model',
                  value: (
                    <span className="font-mono text-xs">
                      {r.modelsServed.join(', ') || r.modelRequested || '—'}
                    </span>
                  ),
                },
                {
                  term: 'Prompt version',
                  value: <span className="font-mono text-xs">{r.promptVersion ?? '—'}</span>,
                },
                { term: 'Warrant', value: r.warrantVersion ? `Version ${r.warrantVersion}` : '—' },
                { term: 'Model turns', value: r.turns },
                { term: 'Tool calls', value: r.toolCalls },
                {
                  term: 'Tokens',
                  value: `${r.inputTokens.toLocaleString('en-US')} in · ${r.outputTokens.toLocaleString('en-US')} out`,
                },
                { term: 'Cost', value: usd(r.costUsd) },
                { term: 'Stop reason', value: r.stopReason ? sentenceCase(r.stopReason) : '—' },
                {
                  term: 'Reference',
                  value: (
                    <Link
                      className="break-all font-mono text-xs text-primary hover:underline"
                      href={`/governance/audit?correlationId=${encodeURIComponent(r.correlationId)}`}
                    >
                      {r.correlationId}
                    </Link>
                  ),
                },
              ]}
            />
          </div>
        </Card>
      </div>
    </>
  );
}
