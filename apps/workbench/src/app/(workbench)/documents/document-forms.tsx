'use client';

import { useActionState } from 'react';
import { FileCheck2, FilePlus2, RotateCw } from 'lucide-react';
import { Field, FormMessage, SubmitButton, Textarea } from '@/components/ui/form';
import { idle } from '@/lib/actions';
import {
  createTemplate,
  issueMissing,
  releaseTemplate,
  retryDelivery,
  reviewFindings,
} from './actions';

export function CreateTemplateForm({
  planVersionId,
  kind,
  label,
}: {
  planVersionId: string;
  kind: 'schedule' | 'policy';
  label: string;
}) {
  const [state, action] = useActionState(createTemplate, idle);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="planVersionId" value={planVersionId} />
      <input type="hidden" name="kind" value={kind} />
      <SubmitButton variant="secondary" pendingLabel="Assembling…">
        <FilePlus2 aria-hidden className="size-4" /> {label}
      </SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}

export function ReleaseTemplateForm({
  templateId,
  disabledReason,
}: {
  templateId: string;
  disabledReason: string | null;
}) {
  const [state, action] = useActionState(releaseTemplate, idle);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="templateId" value={templateId} />
      <Field label="Note (optional)" hint="Kept with the release.">
        {(f) => (
          <Textarea id={f.id} name="note" maxLength={1000} aria-describedby={f.describedBy} />
        )}
      </Field>
      {disabledReason ? <p className="text-sm text-muted">{disabledReason}</p> : null}
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Releasing…" disabled={disabledReason !== null}>
        <FileCheck2 aria-hidden className="size-4" /> Release this template
      </SubmitButton>
    </form>
  );
}

export function RetryDeliveryForm({ deliveryId }: { deliveryId: string }) {
  const [state, action] = useActionState(retryDelivery, idle);
  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="deliveryId" value={deliveryId} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Queuing…">
        <RotateCw aria-hidden className="size-3.5" /> Send again
      </SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}

export function IssueMissingForm({
  policyId,
  label = 'Issue the missing documents',
}: {
  policyId: string;
  label?: string;
}) {
  const [state, action] = useActionState(issueMissing, idle);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="policyId" value={policyId} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Issuing…">
        <FilePlus2 aria-hidden className="size-3.5" /> {label}
      </SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}

export interface FindingItem {
  id: string;
  quote: string;
  issue: string;
  severity: 'hold' | 'note';
}

/** One checkbox per finding: ticked means a real defect (it blocks the template for good); unticked means it is not an issue. */
export function FindingsReview({
  proposalId,
  items,
}: {
  proposalId: string;
  items: FindingItem[];
}) {
  const [state, action] = useActionState(reviewFindings, idle);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="proposalId" value={proposalId} />
      <input type="hidden" name="items" value={JSON.stringify(items.map((i) => i.id))} />
      {items.length ? (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-fg">
            Which findings show a real defect?
          </legend>
          {items.map((i) => (
            <label
              key={i.id}
              className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm"
            >
              <input type="checkbox" name="accept" value={i.id} className="mt-1 size-4" />
              <span className="min-w-0">
                <span className="block font-medium text-fg">{i.issue}</span>
                <span className="mt-1 block text-muted">
                  Quoted: <q className="font-mono text-xs text-fg">{i.quote}</q>
                </span>
                <span className="mt-1 block text-xs text-muted">
                  {i.severity === 'hold' ? 'Holds the release while open.' : 'For information.'}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="text-sm text-muted">
          The agent found nothing wrong. Recording your review closes this check.
        </p>
      )}
      <Field
        label="Note"
        hint="Why you accepted or rejected these findings. Kept with the decision."
      >
        {(f) => (
          <Textarea id={f.id} name="note" maxLength={1000} aria-describedby={f.describedBy} />
        )}
      </Field>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Recording…">Record my review</SubmitButton>
      <p className="text-xs text-muted">
        A ticked finding means the template has a defect: it cannot be released, and the plan or
        form must be corrected and the template assembled again.
      </p>
    </form>
  );
}
