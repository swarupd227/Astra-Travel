'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import { ArrowUp, Check, CircleAlert, Loader2, ShieldCheck, Sparkles } from 'lucide-react';
import { AnswerText } from '@/components/answer-text';
import { STOP_EXPLANATIONS, TOOL_ACTIVITY, usd } from '@/lib/agents';
import { askCopilot, runProgress, type RunProgress } from './actions';

const SUGGESTIONS = [
  'Which accounts are still in onboarding?',
  'Have any event deliveries failed for good?',
  'What changed on the platform today, and who changed it?',
  'Which feature flags are switched on?',
];

interface Turn {
  id: string;
  question: string;
  runId: string | null;
  progress: RunProgress | null;
  error: string | null;
}

const POLL_MS = 1_500;
const MAX_WAIT_MS = 4 * 60_000;

export function CopilotConsole({
  available,
  unavailableReason,
}: {
  available: boolean;
  unavailableReason: string | null;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [pending, startTransition] = useTransition();
  const endRef = useRef<HTMLDivElement>(null);
  const busy =
    pending ||
    turns.some(
      (t) => t.runId && (!t.progress || ['queued', 'running'].includes(t.progress.status)),
    );

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  function update(id: string, patch: Partial<Turn>) {
    setTurns((all) => all.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  async function follow(turnId: string, runId: string) {
    const started = Date.now();
    while (Date.now() - started < MAX_WAIT_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      try {
        const progress = await runProgress(runId);
        update(turnId, { progress });
        if (!['queued', 'running'].includes(progress.status)) return;
      } catch {
        // A transient failure; keep polling until the time limit.
      }
    }
    update(turnId, {
      error: 'The answer is taking longer than expected. Check back on this run later.',
    });
  }

  function submit(text: string) {
    const q = text.trim();
    if (q.length < 3 || busy) return;
    const turn: Turn = {
      id: crypto.randomUUID(),
      question: q,
      runId: null,
      progress: null,
      error: null,
    };
    setTurns((all) => [...all, turn]);
    setQuestion('');
    startTransition(async () => {
      const res = await askCopilot(q, turn.id);
      if (!res.ok) {
        update(turn.id, { error: res.message });
        return;
      }
      update(turn.id, { runId: res.runId });
      void follow(turn.id, res.runId);
    });
  }

  return (
    <div className="flex min-h-[calc(100dvh-14rem)] flex-col">
      <div className="flex-1 space-y-6" aria-live="polite">
        {turns.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border-strong bg-surface px-6 py-10 text-center">
            <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-full bg-primary-soft text-primary">
              <Sparkles aria-hidden className="size-5" />
            </div>
            <p className="font-semibold text-fg">
              Ask about accounts, events, deliveries, the audit trail or feature flags
            </p>
            <p className="mx-auto mt-1 max-w-lg text-sm text-muted">
              The Copilot looks the answer up in records you’re allowed to see. It can’t change
              anything, and every step it takes is recorded.
            </p>
            {available ? (
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => submit(s)}
                    className="rounded-full border border-border-strong bg-surface px-3.5 py-1.5 text-sm text-fg hover:border-primary hover:bg-primary-soft"
                  >
                    {s}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {turns.map((t) => (
          <article key={t.id} className="space-y-3">
            <div className="flex justify-end">
              <p className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-[15px] text-primary-contrast">
                {t.question}
              </p>
            </div>
            <div className="flex gap-3">
              <span
                aria-hidden
                className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary"
              >
                <Sparkles className="size-4" />
              </span>
              <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-border bg-surface px-4 py-3 shadow-card">
                <TurnBody turn={t} />
              </div>
            </div>
          </article>
        ))}
        <div ref={endRef} />
      </div>

      <form
        className="sticky bottom-0 mt-6 bg-bg/90 pb-2 pt-3 backdrop-blur"
        onSubmit={(e) => {
          e.preventDefault();
          submit(question);
        }}
      >
        {!available ? (
          <p
            role="status"
            className="mb-2 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning"
          >
            {unavailableReason}
          </p>
        ) : null}
        <label htmlFor="copilot-question" className="sr-only">
          Your question
        </label>
        <div className="flex items-end gap-2 rounded-2xl border border-border-strong bg-surface p-2 shadow-card focus-within:border-primary">
          <textarea
            id="copilot-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit(question);
              }
            }}
            rows={1}
            maxLength={4000}
            disabled={!available}
            placeholder={available ? 'Ask the Operations Copilot…' : 'The Copilot is not available'}
            className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] text-fg outline-none placeholder:text-subtle"
          />
          <button
            type="submit"
            disabled={!available || busy || question.trim().length < 3}
            className="inline-flex size-10 items-center justify-center rounded-xl bg-primary text-primary-contrast disabled:opacity-40"
            aria-label="Send question"
          >
            {busy ? (
              <Loader2 aria-hidden className="size-4 animate-spin" />
            ) : (
              <ArrowUp aria-hidden className="size-4" />
            )}
          </button>
        </div>
        <p className="mt-2 flex items-center gap-1.5 px-1 text-xs text-muted">
          <ShieldCheck aria-hidden className="size-3.5" />
          Answers come from an AI agent acting with your access. Card and social security numbers
          are removed before the model sees them.
        </p>
      </form>
    </div>
  );
}

function TurnBody({ turn }: { turn: Turn }) {
  if (turn.error) {
    return (
      <p role="alert" className="flex items-start gap-2 text-sm text-danger">
        <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" /> {turn.error}
      </p>
    );
  }
  const p = turn.progress;
  const working = !p || p.status === 'queued' || p.status === 'running';
  const activity = (p?.activity ?? []).map((a) => TOOL_ACTIVITY[a] ?? a);
  return (
    <div className="space-y-3">
      {activity.length || working ? (
        <ul className="space-y-1 text-sm text-muted">
          {activity.map((a, i) => (
            <li key={i} className="flex items-center gap-2">
              <Check aria-hidden className="size-3.5 text-success" /> {a}
            </li>
          ))}
          {working ? (
            <li className="flex items-center gap-2">
              <Loader2 aria-hidden className="size-3.5 animate-spin text-primary" />
              {p?.status === 'running' ? 'Thinking…' : 'Starting…'}
            </li>
          ) : null}
        </ul>
      ) : null}
      {p && !working ? (
        p.answer ? (
          <AnswerText text={p.answer} />
        ) : (
          <p className="flex items-start gap-2 text-sm text-warning">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            {STOP_EXPLANATIONS[p.stopReason ?? ''] ?? 'The agent could not answer this question.'}
          </p>
        )
      ) : null}
      {p && !working && turn.runId ? (
        <p className="border-t border-border pt-2 text-xs text-subtle">
          Operations Copilot v{p.agentVersion} · {p.modelsServed.join(', ') || 'no model call'} ·{' '}
          {usd(p.costUsd)} ·{' '}
          <Link
            href={`/agents/runs/${turn.runId}`}
            className="font-medium text-primary hover:underline"
          >
            View run record
          </Link>
        </p>
      ) : null}
    </div>
  );
}
