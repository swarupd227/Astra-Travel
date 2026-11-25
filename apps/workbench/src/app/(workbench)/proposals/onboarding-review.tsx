'use client';

import { useActionState } from 'react';
import { Field, FormMessage, Input, SubmitButton, Textarea } from '@/components/ui/form';
import { idle } from '@/lib/actions';
import { applyOnboardingDraft } from './actions';

export interface OnboardingItem {
  field: string;
  label: string;
  /** The value as text: lists comma-separated, objects as JSON. */
  value: string;
  documentName: string;
  excerpt: string;
  note: string | null;
}

/** One row per drafted field: the value to correct, the wording it comes from, and whether to apply it. */
export function OnboardingReview({ proposalId, accountId, items, open }: { proposalId: string; accountId: string; items: OnboardingItem[]; open: boolean }) {
  const [state, action] = useActionState(applyOnboardingDraft, idle);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="proposalId" value={proposalId} />
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="items" value={JSON.stringify(items.map((i) => ({ field: i.field, original: i.value })))} />
      <ul className="space-y-3">
        {items.map((i) => (
          <li key={i.field} className="rounded-lg border border-border p-4">
            <div className="flex items-start gap-3">
              {open ? <input type="checkbox" name={`pick:${i.field}`} defaultChecked aria-label={`Apply ${i.label}`} className="mt-2 size-4" /> : null}
              <div className="min-w-0 flex-1 space-y-2">
                <Field label={i.label}>
                  {(f) => (open ? <Input id={f.id} name={`value:${i.field}`} defaultValue={i.value} aria-describedby={f.describedBy} className="font-mono text-xs" /> : <p className="break-words font-mono text-xs text-fg">{i.value}</p>)}
                </Field>
                <p className="text-xs text-muted">
                  From {i.documentName}: <q className="text-fg">{i.excerpt}</q>
                </p>
                {i.note ? <p className="text-xs text-muted">Agent’s note: {i.note}</p> : null}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {open ? (
        <>
          <Field label="Note" hint="Kept with your decision.">
            {(f) => <Textarea id={f.id} name="note" maxLength={1000} aria-describedby={f.describedBy} />}
          </Field>
          <FormMessage state={state} />
          <SubmitButton pendingLabel="Applying…">Apply the fields I ticked</SubmitButton>
          <p className="text-xs text-muted">Ticked fields are saved through the ordinary screens’ checks: the profile directly, a segment as a request an underwriter approves, and collected variables if you may set them.</p>
        </>
      ) : null}
    </form>
  );
}
