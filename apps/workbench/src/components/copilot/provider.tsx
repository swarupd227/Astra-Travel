'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { askCopilot, runProgress, type RunProgress } from '@/app/(workbench)/copilot/actions';

export interface Turn {
  id: string;
  question: string;
  runId: string | null;
  progress: RunProgress | null;
  error: string | null;
}

export interface CopilotAvailability {
  /** The person may ask agents questions. */
  allowed: boolean;
  /** Why the Copilot cannot answer right now, or null when it can. */
  unavailableReason: string | null;
  suggestions: string[];
}

interface CopilotState extends CopilotAvailability {
  turns: Turn[];
  busy: boolean;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  ask: (question: string) => boolean;
  clear: () => void;
}

const POLL_MS = 1_500;
const MAX_WAIT_MS = 4 * 60_000;

const Context = createContext<CopilotState | null>(null);

export function useCopilot(): CopilotState {
  const value = useContext(Context);
  if (!value) throw new Error('useCopilot needs a CopilotProvider');
  return value;
}

const running = (t: Turn) =>
  !t.error && (!t.progress || ['queued', 'running'].includes(t.progress.status));

/** One conversation with the Operations Copilot, kept while the person moves around the workbench. */
export function CopilotProvider({
  availability,
  children,
}: {
  availability: CopilotAvailability;
  children: React.ReactNode;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const inFlight = useRef(false);
  const busy = turns.some(running);

  const update = useCallback((id: string, patch: Partial<Turn>) => {
    setTurns((all) => all.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const answer = useCallback(
    async (id: string, question: string) => {
      try {
        const sent = await askCopilot(question, id);
        if (!sent.ok) {
          update(id, { error: sent.message });
          return;
        }
        update(id, { runId: sent.runId });
        const started = Date.now();
        while (Date.now() - started < MAX_WAIT_MS) {
          await new Promise((r) => setTimeout(r, POLL_MS));
          try {
            const progress = await runProgress(sent.runId);
            update(id, { progress });
            if (!['queued', 'running'].includes(progress.status)) return;
          } catch {
            // A transient failure; keep polling until the time limit.
          }
        }
        update(id, {
          error: 'The answer is taking longer than expected. Check back on this run later.',
        });
      } catch {
        update(id, {
          error: 'The question could not be sent. Check your connection and try again.',
        });
      } finally {
        inFlight.current = false;
      }
    },
    [update],
  );

  const ask = useCallback(
    (text: string) => {
      const question = text.trim();
      if (question.length < 3 || inFlight.current || availability.unavailableReason) return false;
      inFlight.current = true;
      const id = crypto.randomUUID();
      setTurns((all) => [...all, { id, question, runId: null, progress: null, error: null }]);
      void answer(id, question);
      return true;
    },
    [answer, availability.unavailableReason],
  );

  const clear = useCallback(() => {
    setTurns((all) => all.filter(running));
  }, []);

  return (
    <Context.Provider value={{ ...availability, turns, busy, panelOpen, setPanelOpen, ask, clear }}>
      {children}
    </Context.Provider>
  );
}
