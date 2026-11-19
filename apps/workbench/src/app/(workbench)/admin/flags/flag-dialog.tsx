'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, FormMessage, Select, SubmitButton, Textarea } from '@/components/ui/form';
import { idle, previous } from '@/lib/actions';
import { setFlag } from './actions';

export function FlagDialog({
  flagKey,
  enabled,
  accounts,
}: {
  flagKey: string;
  enabled: boolean;
  accounts: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState('');
  const [state, action] = useActionState(setFlag, idle);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Change feature flag"
      description={<span className="font-mono">{flagKey}</span>}
      trigger={
        <Button variant="secondary" size="sm">
          Change
        </Button>
      }
    >
      <form action={action} className="space-y-4">
        <input type="hidden" name="key" value={flagKey} />
        <Field label="Applies to">
          {(f) => (
            <Select
              id={f.id}
              name="accountId"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="">Every account (global value)</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  Only {a.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Value" required>
          {(f) => (
            <Select id={f.id} name="enabled" defaultValue={String(!enabled)} key={scope}>
              <option value="true">On</option>
              <option value="false">Off</option>
              {scope ? <option value="inherit">Follow the global value</option> : null}
            </Select>
          )}
        </Field>
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
          <SubmitButton>Save</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}
