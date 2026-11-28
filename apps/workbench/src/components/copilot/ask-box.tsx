'use client';

import Link from 'next/link';
import { ArrowUp } from 'lucide-react';
import { useState } from 'react';
import { AgentMark } from './agent-mark';
import { useCopilot } from './provider';

/** The home page's front door to the Copilot: ask here, read the answer in the panel beside you. */
export function AskBox({ setUpHref }: { setUpHref: string | null }) {
  const { unavailableReason, suggestions, ask, setPanelOpen, busy } = useCopilot();
  const [question, setQuestion] = useState('');
  const available = unavailableReason === null;

  const submit = (text: string) => {
    if (ask(text)) setQuestion('');
    setPanelOpen(true);
  };

  return (
    <section aria-labelledby="ask-title" className="ai-surface rounded-2xl p-4 sm:p-5">
      <div className="flex items-center gap-3">
        <AgentMark />
        <div className="min-w-0">
          <h2 id="ask-title" className="text-[15px] font-semibold text-fg">
            Ask the Operations Copilot
          </h2>
          <p className="text-xs text-muted">
            Looks up records you may see. Changes nothing. Every step is recorded.
          </p>
        </div>
      </div>
      {available ? (
        <>
          <form
            className="ai-ring mt-3 flex items-center gap-2 rounded-xl p-1.5 shadow-card"
            onSubmit={(e) => {
              e.preventDefault();
              submit(question);
            }}
          >
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              aria-label="Ask the Operations Copilot a question"
              maxLength={4000}
              placeholder="What do you want to know?"
              className="h-10 min-w-0 flex-1 bg-transparent px-2.5 text-[15px] text-fg outline-none placeholder:text-subtle"
            />
            <button
              type="submit"
              disabled={busy || question.trim().length < 3}
              aria-label="Ask"
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-contrast disabled:opacity-40"
            >
              <ArrowUp aria-hidden className="size-4" />
            </button>
          </form>
          <ul className="mt-3 flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => submit(s)}
                  className="rounded-full border border-border bg-surface/70 px-3 py-1.5 text-left text-[13px] text-fg transition-colors hover:border-primary/50 hover:bg-surface disabled:opacity-60"
                >
                  {s}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p role="status" className="mt-3 text-sm text-muted">
          {unavailableReason}{' '}
          {setUpHref ? (
            <Link href={setUpHref} className="font-medium text-primary hover:underline">
              Set it up
            </Link>
          ) : null}
        </p>
      )}
    </section>
  );
}
