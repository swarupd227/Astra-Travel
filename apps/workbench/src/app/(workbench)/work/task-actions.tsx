'use client';

import * as DM from '@radix-ui/react-dropdown-menu';
import { Loader2, UserRoundPlus } from 'lucide-react';
import { useTransition } from 'react';
import type { TaskSource } from '@astra/contracts';
import { useCopilot } from '@/components/copilot/provider';
import { Button, buttonClass } from '@/components/ui/button';
import { assignTask, handBack, takeTask } from './actions';

export interface Person {
  subject: string;
  name: string | null;
  open: number;
}

const itemClass =
  'flex cursor-pointer items-center justify-between gap-4 rounded-md px-2.5 py-2 text-sm text-fg outline-none data-[highlighted]:bg-surface-muted';

/** Take, hand back or give one task, according to what the person may do. */
export function TaskActions({
  sourceType,
  sourceId,
  title,
  ownerSubject,
  mine,
  canWork,
  supervisor,
  people,
  question,
}: {
  sourceType: TaskSource;
  sourceId: string;
  title: string;
  ownerSubject: string | null;
  mine: boolean;
  canWork: boolean;
  supervisor: boolean;
  people: Person[];
  /** Something the Copilot can look into about this task, when it can read the records involved. */
  question: string | null;
}) {
  const [pending, start] = useTransition();
  const copilot = useCopilot();

  const run = (action: (form: FormData) => Promise<unknown>, owner?: string) => {
    const form = new FormData();
    form.set('sourceType', sourceType);
    form.set('sourceId', sourceId);
    if (owner) form.set('owner', owner);
    start(async () => {
      await action(form);
    });
  };

  const others = people.filter((p) => p.subject !== ownerSubject);
  const spinner = <Loader2 aria-hidden className="size-4 animate-spin" />;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {question && copilot.allowed && !copilot.unavailableReason ? (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Ask Copilot about ${title}`}
          onClick={() => {
            copilot.ask(question);
            copilot.setPanelOpen(true);
          }}
        >
          Ask Copilot
        </Button>
      ) : null}
      {canWork && !ownerSubject ? (
        <Button size="sm" disabled={pending} onClick={() => run(takeTask)}>
          {pending ? spinner : null}
          Take it<span className="sr-only">: {title}</span>
        </Button>
      ) : null}
      {ownerSubject && (mine || supervisor) ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          aria-label={`Hand back ${title}`}
          onClick={() => run(handBack)}
        >
          Hand back
        </Button>
      ) : null}
      {supervisor && others.length > 0 ? (
        <DM.Root modal={false}>
          <DM.Trigger
            disabled={pending}
            aria-label={`Assign ${title}`}
            className={buttonClass('secondary', 'sm')}
          >
            <UserRoundPlus aria-hidden className="size-4" /> Assign
          </DM.Trigger>
          <DM.Portal>
            <DM.Content
              align="end"
              sideOffset={6}
              collisionPadding={12}
              className="z-50 max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] w-64 overflow-y-auto rounded-xl border border-border bg-surface p-1.5 shadow-overlay"
            >
              <DM.Label className="px-2.5 py-1.5 text-xs text-muted">
                Give to (work they hold now)
              </DM.Label>
              {others.map((p) => (
                <DM.Item
                  key={p.subject}
                  className={itemClass}
                  onSelect={() => run(assignTask, p.subject)}
                >
                  <span className="truncate">{p.name ?? p.subject}</span>
                  <span className="tabular-nums text-muted">{p.open}</span>
                </DM.Item>
              ))}
            </DM.Content>
          </DM.Portal>
        </DM.Root>
      ) : null}
    </div>
  );
}
