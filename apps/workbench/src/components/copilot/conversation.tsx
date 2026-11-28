'use client';

import Link from 'next/link';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, CircleAlert, Loader2, ShieldCheck } from 'lucide-react';
import { AnswerText } from '@/components/answer-text';
import { STOP_EXPLANATIONS, TOOL_ACTIVITY, usd } from '@/lib/agents';
import { AgentMark } from './agent-mark';
import { useCopilot, type Turn } from './provider';

export function Conversation({ variant }: { variant: 'page' | 'panel' }) {
  const { turns, busy, ask, unavailableReason, suggestions } = useCopilot();
  const [question, setQuestion] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const available = unavailableReason === null;
  const panel = variant === 'panel';

  useEffect(() => {
    if (turns.length) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  useEffect(() => {
    if (panel) inputRef.current?.focus();
  }, [panel]);

  const submit = (text: string) => {
    if (ask(text)) setQuestion('');
  };

  return (
    <div className={clsx('flex flex-col', panel ? 'min-h-0 flex-1' : 'min-h-[calc(100dvh-14rem)]')}>
      <div
        className={clsx('flex-1 space-y-6', panel && 'min-h-0 overflow-y-auto px-4 py-4')}
        aria-live="polite"
      >
        {turns.length === 0 ? (
          <div className="px-2 py-8 text-center">
            <AgentMark size="lg" className="mx-auto mb-4" />
            <p className="font-semibold text-fg">
              Ask about accounts, events, deliveries, the audit trail or feature flags
            </p>
            <p className="mx-auto mt-1.5 max-w-lg text-sm text-muted">
              The Copilot looks the answer up in records you’re allowed to see. It can’t change
              anything, and every step it takes is recorded.
            </p>
            {available ? (
              <div className="mt-5 flex flex-col items-stretch gap-2 sm:items-center">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => submit(s)}
                    className="rounded-xl border border-border bg-surface px-3.5 py-2 text-left text-sm text-fg shadow-card transition-colors hover:border-primary/50 hover:bg-primary-soft sm:text-center"
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
              <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-[15px] text-primary-contrast">
                {t.question}
              </p>
            </div>
            <div className="flex gap-3">
              <AgentMark className="mt-1" />
              <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-border bg-surface px-4 py-3 shadow-card">
                <TurnBody turn={t} />
              </div>
            </div>
          </article>
        ))}
        <div ref={endRef} />
      </div>

      <form
        className={clsx(
          panel
            ? 'border-t border-border bg-surface px-4 pb-3 pt-3'
            : 'sticky bottom-0 mt-6 bg-bg/90 pb-2 pt-3 backdrop-blur',
        )}
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
        <div className="ai-ring flex items-end gap-2 rounded-2xl p-2 shadow-card">
          <textarea
            id="copilot-question"
            ref={inputRef}
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
            className="field-sizing-content max-h-40 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] text-fg outline-none placeholder:text-subtle"
          />
          <button
            type="submit"
            disabled={!available || busy || question.trim().length < 3}
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-contrast disabled:opacity-40"
            aria-label="Send question"
          >
            {busy ? (
              <Loader2 aria-hidden className="size-4 animate-spin" />
            ) : (
              <ArrowUp aria-hidden className="size-4" />
            )}
          </button>
        </div>
        <p className="mt-2 flex items-start gap-1.5 px-1 text-xs text-muted">
          <ShieldCheck aria-hidden className="mt-0.5 size-3.5 shrink-0" />
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
        <ul className="space-y-1.5 text-sm text-muted">
          {activity.map((a, i) => (
            <li key={i} className="flex items-center gap-2">
              <Check aria-hidden className="size-3.5 text-success" /> {a}
            </li>
          ))}
          {working ? (
            <li className="flex items-center gap-2">
              <Loader2 aria-hidden className="size-3.5 animate-spin text-primary" />
              {p?.status === 'running' ? 'Working…' : 'Starting…'}
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
