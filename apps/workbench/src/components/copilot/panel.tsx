'use client';

import * as RD from '@radix-ui/react-dialog';
import clsx from 'clsx';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Maximize2, Sparkles, Trash2, X } from 'lucide-react';
import { useEffect } from 'react';
import { AgentMark } from './agent-mark';
import { Conversation } from './conversation';
import { useCopilot } from './provider';

/** The full-page Copilot already shows the conversation, so the panel stays out of its way. */
const FULL_PAGE = '/copilot';

/** Opens the Copilot beside whatever the person is working on (Ctrl J or Cmd J). */
export function CopilotButton() {
  const { allowed, panelOpen, setPanelOpen, busy } = useCopilot();
  const pathname = usePathname();
  const hidden = !allowed || pathname === FULL_PAGE;

  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setPanelOpen(!panelOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hidden, panelOpen, setPanelOpen]);

  if (hidden) return null;
  return (
    <button
      type="button"
      aria-expanded={panelOpen}
      aria-keyshortcuts="Control+J Meta+J"
      onClick={() => setPanelOpen(!panelOpen)}
      className="ai-ring flex h-10 shrink-0 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-fg shadow-card hover:bg-primary-soft sm:px-3.5"
    >
      <Sparkles aria-hidden className={clsx('size-4 text-primary', busy && 'animate-pulse')} />
      <span className="sr-only sm:not-sr-only">Ask Copilot</span>
    </button>
  );
}

export function CopilotPanel() {
  const { allowed, panelOpen, setPanelOpen, turns, clear } = useCopilot();
  const pathname = usePathname();
  if (!allowed || pathname === FULL_PAGE) return null;
  return (
    <RD.Root open={panelOpen} onOpenChange={setPanelOpen} modal={false}>
      <RD.Portal>
        <RD.Content
          aria-describedby={undefined}
          // The page stays usable beside the panel, so it closes only when asked to.
          onInteractOutside={(e) => e.preventDefault()}
          className="animate-panel fixed inset-y-0 right-0 z-30 flex w-full flex-col border-l border-border bg-bg shadow-overlay sm:w-[26rem]"
        >
          <div className="flex h-16 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
            <AgentMark />
            <div className="min-w-0 flex-1">
              <RD.Title className="truncate text-sm font-semibold text-fg">
                Operations Copilot
              </RD.Title>
              <p className="truncate text-xs text-muted">Reads records. Changes nothing.</p>
            </div>
            {turns.length ? (
              <button
                type="button"
                onClick={clear}
                aria-label="Clear the conversation"
                className="rounded-md p-2 text-muted hover:bg-surface-muted hover:text-fg"
              >
                <Trash2 aria-hidden className="size-4" />
              </button>
            ) : null}
            <Link
              href={FULL_PAGE}
              onClick={() => setPanelOpen(false)}
              aria-label="Open the Copilot full screen"
              className="rounded-md p-2 text-muted hover:bg-surface-muted hover:text-fg"
            >
              <Maximize2 aria-hidden className="size-4" />
            </Link>
            <RD.Close
              aria-label="Close the Copilot"
              className="rounded-md p-2 text-muted hover:bg-surface-muted hover:text-fg"
            >
              <X aria-hidden className="size-5" />
            </RD.Close>
          </div>
          <Conversation variant="panel" />
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

/** Makes room for the panel on wide screens, so the work stays visible next to it. */
export function CopilotShift({ children }: { children: React.ReactNode }) {
  const { panelOpen } = useCopilot();
  const pathname = usePathname();
  return (
    <div
      className={clsx(
        'transition-[padding] duration-200 lg:pl-64',
        panelOpen && pathname !== FULL_PAGE && 'xl:pr-[26rem]',
      )}
    >
      {children}
    </div>
  );
}
