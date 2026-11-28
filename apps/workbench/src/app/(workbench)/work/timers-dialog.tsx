'use client';

import { Timer } from 'lucide-react';
import { TASK_PRIORITIES, TASK_SOURCE_LABELS, type SlaPolicy } from '@astra/contracts';
import { sentenceCase } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Select, SubmitButton } from '@/components/ui/form';
import { saveSla } from './actions';

/** How long each kind of work may wait. Everyone can read it; a supervisor changes it. */
export function TimersDialog({ policies, editable }: { policies: SlaPolicy[]; editable: boolean }) {
  return (
    <Dialog
      wide
      title="How long work may wait"
      description={
        editable
          ? 'Each timer starts when the work is raised. These are starting values until Assurant agrees response times.'
          : 'Each timer starts when the work is raised. A supervisor sets them.'
      }
      trigger={
        <Button variant="secondary">
          <Timer aria-hidden className="size-4" /> Timers
        </Button>
      }
    >
      <ul className="divide-y divide-border">
        {policies.map((s) => (
          <li key={s.sourceType} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <span className="text-sm font-medium text-fg">{TASK_SOURCE_LABELS[s.sourceType]}</span>
            {editable ? (
              <form action={saveSla} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="sourceType" value={s.sourceType} />
                <label className="text-xs">
                  <span className="mb-1 block text-muted">Priority</span>
                  <Select name="priority" defaultValue={s.priority} className="h-8 w-28 text-xs">
                    {TASK_PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {sentenceCase(p)}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="text-xs">
                  <span className="mb-1 block text-muted">Hours to act</span>
                  <Input
                    name="targetHours"
                    type="number"
                    required
                    min={1}
                    max={720}
                    defaultValue={s.targetHours}
                    className="h-8 w-24 text-xs"
                  />
                </label>
                <SubmitButton
                  size="sm"
                  variant="secondary"
                  aria-label={`Save the timer for ${TASK_SOURCE_LABELS[s.sourceType]}`}
                >
                  Save
                </SubmitButton>
              </form>
            ) : (
              <span className="text-sm text-muted">
                {sentenceCase(s.priority)} priority, {s.targetHours} hours
              </span>
            )}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
