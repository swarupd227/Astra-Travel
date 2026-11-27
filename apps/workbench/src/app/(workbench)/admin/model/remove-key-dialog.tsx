'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, FormMessage, SubmitButton, Textarea } from '@/components/ui/form';
import { idle, previous } from '@/lib/actions';
import { removeModelKey } from './actions';

export function RemoveKeyDialog({ endsWith }: { endsWith: string }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(removeModelKey, idle);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Remove the saved key"
      description={`The key ending ${endsWith} is erased. Agents stop working unless the worker has a key of its own.`}
      trigger={
        <Button variant="secondary" size="sm">
          Remove
        </Button>
      }
    >
      <form action={action} className="space-y-4">
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
          <SubmitButton variant="danger" pendingLabel="Removing…">
            Remove key
          </SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}
