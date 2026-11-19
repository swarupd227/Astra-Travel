'use client';

import { useActionState, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, FormMessage, SubmitButton, Textarea } from '@/components/ui/form';
import { idle, previous } from '@/lib/actions';
import { replayDeliveries } from './actions';

export function ReplayDialog({
  eventId,
  subscriber,
  all,
}: {
  eventId?: string;
  subscriber?: string;
  all?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(replayDeliveries, idle);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title={all ? 'Replay every dead-lettered delivery' : 'Replay this delivery'}
      description="The delivery goes back into the queue with a fresh set of retries. Fix the cause first, for example a partner endpoint that was down."
      trigger={
        <Button variant={all ? 'primary' : 'secondary'} size="sm">
          <RotateCcw aria-hidden className="size-3.5" /> {all ? 'Replay all' : 'Replay'}
        </Button>
      }
    >
      <form action={action} className="space-y-4">
        {eventId ? <input type="hidden" name="eventId" value={eventId} /> : null}
        {subscriber ? <input type="hidden" name="subscriber" value={subscriber} /> : null}
        <Field label="Reason" required hint="Recorded in the audit trail." error={errors.reason}>
          {(f) => (
            <Textarea
              id={f.id}
              name="reason"
              defaultValue={previous(state, 'reason')}
              required
              minLength={3}
              maxLength={500}
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <FormMessage state={state} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
          <SubmitButton pendingLabel="Replaying…">Replay</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}
