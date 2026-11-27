'use client';

import { useActionState, useState } from 'react';
import { Bot } from 'lucide-react';
import { Field, FormMessage, SubmitButton, Textarea } from '@/components/ui/form';
import { idle, previous } from '@/lib/actions';
import { decideSummary, summariseReferral } from './summary-actions';

export function AskSummaryForm({ referralId, label }: { referralId: string; label: string }) {
  return (
    <form action={summariseReferral}>
      <input type="hidden" name="referralId" value={referralId} />
      <SubmitButton variant="secondary" pendingLabel="Asking…">
        <Bot aria-hidden className="size-4" /> {label}
      </SubmitButton>
    </form>
  );
}

/** Accept, edit or reject: a decision about the agent's summary, not about the referral. */
export function SummaryDecisionForm({
  summaryId,
  summary,
}: {
  summaryId: string;
  summary: string;
}) {
  const [state, action] = useActionState(decideSummary, idle);
  const [mode, setMode] = useState<'accepted' | 'edited' | 'rejected'>('accepted');
  return (
    <form
      action={action}
      className="mt-4 space-y-3 border-t border-border pt-4"
      aria-label="Your decision about this summary"
    >
      <input type="hidden" name="summaryId" value={summaryId} />
      <fieldset className="flex flex-wrap gap-4 text-sm">
        <legend className="mb-1 font-medium text-fg">Is the summary right?</legend>
        {(
          [
            ['accepted', 'Accept it as written'],
            ['edited', 'Correct it'],
            ['rejected', 'Reject it'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-2">
            <input
              type="radio"
              name="decision"
              value={value}
              checked={mode === value}
              onChange={() => setMode(value)}
              className="size-4"
            />
            {label}
          </label>
        ))}
      </fieldset>
      {mode === 'edited' ? (
        <Field
          label="Your corrected summary"
          required
          error={state.status === 'error' ? state.fieldErrors.editedSummary : undefined}
        >
          {(f) => (
            <Textarea
              id={f.id}
              name="editedSummary"
              required
              minLength={20}
              maxLength={4000}
              defaultValue={previous(state, 'editedSummary') ?? summary}
              aria-describedby={f.describedBy}
              className="min-h-32"
            />
          )}
        </Field>
      ) : null}
      {mode !== 'accepted' ? (
        <Field
          label="Why"
          required
          hint="Kept with the decision so the agent's evaluation can learn from it."
          error={state.status === 'error' ? state.fieldErrors.reason : undefined}
        >
          {(f) => (
            <Textarea
              id={f.id}
              name="reason"
              required
              minLength={3}
              maxLength={1000}
              defaultValue={previous(state, 'reason')}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
      ) : null}
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Recording…">Record my decision</SubmitButton>
    </form>
  );
}
