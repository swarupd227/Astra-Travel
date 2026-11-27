'use client';

import { useActionState } from 'react';
import { Field, FormMessage, SubmitButton, Textarea } from '@/components/ui/form';
import { idle, previous } from '@/lib/actions';
import { signLaunch } from './actions';

export function SignForm({ states, area, reportHash, signed }: { states: string[]; area: string; reportHash: string; signed: boolean }) {
  const [state, action] = useActionState(signLaunch, idle);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="states" value={states.join(',')} />
      <input type="hidden" name="area" value={area} />
      <input type="hidden" name="reportHash" value={reportHash} />
      <input type="hidden" name="decision" value={signed ? 'withdrawn' : 'signed'} />
      <Field label={signed ? `Why you withdraw the ${area} signature` : `What you checked for ${area}`} required error={state.status === 'error' ? state.fieldErrors.note : undefined}>
        {(f) => <Textarea id={f.id} name="note" required minLength={3} maxLength={2000} defaultValue={previous(state, 'note')} aria-describedby={f.describedBy} />}
      </Field>
      <FormMessage state={state} />
      <SubmitButton variant={signed ? 'secondary' : 'primary'} pendingLabel="Recording…">
        {signed ? `Withdraw the ${area} signature` : `Sign for ${area}`}
      </SubmitButton>
    </form>
  );
}
