'use client';

import * as RD from '@radix-ui/react-dialog';
import clsx from 'clsx';
import { ArrowRight, CornerDownLeft, Search, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useCopilot } from '@/components/copilot/provider';

export interface CommandEntry {
  href: string;
  label: string;
  /** Where it lives, for example "Underwriting", or "Action". */
  section: string;
  description: string;
}

interface Option extends CommandEntry {
  key: string;
}

const noop = () => () => undefined;
const ASK_KEY = 'ask-copilot';

function rank(entry: CommandEntry, query: string): number {
  const label = entry.label.toLowerCase();
  const text = `${label} ${entry.section} ${entry.description}`.toLowerCase();
  if (!query.split(/\s+/).every((word) => text.includes(word))) return -1;
  if (label.startsWith(query)) return 3;
  if (label.includes(query)) return 2;
  return 1;
}

/** One box to reach any page, start common work or look up a policy (Ctrl K or Cmd K). */
export function CommandMenu({
  entries,
  canSearchPolicies,
}: {
  entries: CommandEntry[];
  canSearchPolicies: boolean;
}) {
  const router = useRouter();
  const copilot = useCopilot();
  const canAsk = copilot.allowed && copilot.unavailableReason === null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const isMac = useSyncExternalStore(
    noop,
    () => /Mac|iPhone|iPad/.test(navigator.userAgent),
    () => false,
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const options = useMemo<Option[]>(() => {
    const q = query.trim().toLowerCase();
    const found = entries
      .map((e, order) => ({ e, order, score: q ? rank(e, q) : 0 }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .map((x) => ({ ...x.e, key: `${x.e.section}:${x.e.href}` }));
    if (canSearchPolicies && q.length >= 2) {
      const search: Option = {
        key: 'policy-search',
        href: `/policies?q=${encodeURIComponent(query.trim())}`,
        label: `Find policies matching “${query.trim()}”`,
        section: 'Policies',
        description: 'Policy number, traveller, account or trip',
      };
      // A page whose name matches comes first; otherwise the person is looking something up.
      if (found.length > 0 && rank(found[0]!, q) >= 2) found.splice(1, 0, search);
      else found.unshift(search);
    }
    if (canAsk && q.length >= 3) {
      const question: Option = {
        key: ASK_KEY,
        href: '',
        label: `Ask the Copilot “${query.trim()}”`,
        section: 'AI agent',
        description: 'Answers from records you may see',
      };
      // Something worded as a question goes to the Copilot first.
      if (q.endsWith('?') || q.split(/s+/).length > 3) found.unshift(question);
      else found.push(question);
    }
    return found;
  }, [entries, query, canSearchPolicies, canAsk]);

  const active = Math.min(index, Math.max(options.length - 1, 0));

  const change = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery('');
      setIndex(0);
    }
  };

  const go = (option: Option | undefined) => {
    if (!option) return;
    change(false);
    if (option.key === ASK_KEY) {
      copilot.ask(query);
      copilot.setPanelOpen(true);
      return;
    }
    router.push(option.href);
  };

  const move = (to: number) => {
    const next = (to + options.length) % options.length;
    setIndex(next);
    document.getElementById(`command-${next}`)?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <RD.Root open={open} onOpenChange={change}>
      <RD.Trigger className="flex size-10 items-center justify-center gap-2.5 rounded-lg text-muted hover:bg-surface-muted hover:text-fg sm:h-10 sm:w-full sm:max-w-md sm:justify-start sm:border sm:border-border-strong sm:bg-surface sm:px-3 sm:shadow-card">
        <Search aria-hidden className="size-4 shrink-0" />
        <span className="sr-only truncate text-sm sm:not-sr-only sm:flex-1 sm:text-left">
          {canSearchPolicies ? 'Search pages and policies' : 'Search pages'}
        </span>
        <kbd
          aria-hidden
          className="hidden rounded-md border border-border bg-surface-muted px-1.5 py-0.5 font-sans text-[11px] text-muted md:block"
        >
          {isMac ? '⌘ K' : 'Ctrl K'}
        </kbd>
      </RD.Trigger>
      <RD.Portal>
        <RD.Overlay className="animate-overlay fixed inset-0 z-40 bg-[rgb(8_14_28/0.55)] backdrop-blur-[2px]" />
        <RD.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-3 z-50 flex max-h-[min(34rem,calc(100dvh-1.5rem))] w-[calc(100vw-1.5rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-overlay sm:top-24"
        >
          <RD.Title className="sr-only">Search the workbench</RD.Title>
          <div className="flex items-center gap-3 border-b border-border px-4">
            <Search aria-hidden className="size-4 shrink-0 text-muted" />
            <input
              role="combobox"
              aria-expanded
              aria-controls="command-list"
              aria-activedescendant={options.length ? `command-${active}` : undefined}
              aria-label="Search pages and policies"
              autoComplete="off"
              spellCheck={false}
              placeholder={
                canSearchPolicies ? 'Type a page, policy number or traveller' : 'Type a page name'
              }
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setIndex(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  move(active + 1);
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  move(active - 1);
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  go(options[active]);
                }
              }}
              className="h-14 w-full bg-transparent text-[15px] text-fg outline-none placeholder:text-subtle"
            />
          </div>
          <ul
            id="command-list"
            role="listbox"
            aria-label="Results"
            className="min-h-0 flex-1 overflow-y-auto p-2"
          >
            {options.map((o, i) => (
              <li
                key={o.key}
                id={`command-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseMove={() => setIndex(i)}
                onClick={() => go(o)}
                className={clsx(
                  'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5',
                  i === active && 'bg-primary-soft',
                )}
              >
                {o.key === ASK_KEY ? (
                  <Sparkles aria-hidden className="size-4 shrink-0 text-primary" />
                ) : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-fg">{o.label}</span>
                  <span className="block truncate text-xs text-muted">
                    {o.section} · {o.description}
                  </span>
                </span>
                {i === active ? (
                  <CornerDownLeft aria-hidden className="size-4 shrink-0 text-muted" />
                ) : (
                  <ArrowRight aria-hidden className="size-4 shrink-0 opacity-0" />
                )}
              </li>
            ))}
          </ul>
          {options.length === 0 ? (
            <p role="status" className="px-5 pb-8 pt-2 text-center text-sm text-muted">
              Nothing matches “{query.trim()}”.
            </p>
          ) : null}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
