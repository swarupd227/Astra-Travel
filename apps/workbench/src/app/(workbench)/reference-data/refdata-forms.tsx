'use client';

import { useActionState, useState } from 'react';
import { Check, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, FormMessage, Input, SubmitButton, Textarea } from '@/components/ui/form';
import { idle, previous } from '@/lib/actions';
import { decideVersion, loadVersion } from './actions';

export function LoadVersionDialog({
  dataset,
  name,
  fields,
  expectedSource,
}: {
  dataset: string;
  name: string;
  fields: string[];
  expectedSource: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(loadVersion, idle);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  const entryErrors =
    state.status === 'error'
      ? Object.entries(state.fieldErrors).filter(([k]) => k.startsWith('entries'))
      : [];
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      wide
      title={`Load a new version of ${name.toLowerCase()}`}
      description="Load the complete list. It takes effect on its date once someone else approves it."
      trigger={
        <Button>
          <Upload aria-hidden className="size-4" /> Load new version
        </Button>
      }
    >
      <form action={action} className="space-y-4" noValidate>
        <input type="hidden" name="dataset" value={dataset} />
        <Field
          label="CSV file"
          required
          error={errors.file}
          hint={
            <>
              First row: <code className="font-mono">{fields.join(',')}</code>. Separate list values
              with ;.
            </>
          }
        >
          {(f) => (
            <Input
              id={f.id}
              type="file"
              name="file"
              accept=".csv,text/csv"
              required
              className="py-2"
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Effective from" required error={errors.effectiveFrom}>
            {(f) => (
              <Input
                id={f.id}
                type="date"
                name="effectiveFrom"
                required
                defaultValue={previous(state, 'effectiveFrom')}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
          <Field label="Source" required error={errors.source} hint={`Expected: ${expectedSource}`}>
            {(f) => (
              <Input
                id={f.id}
                name="source"
                required
                minLength={3}
                defaultValue={previous(state, 'source')}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
        </div>
        <Field label="Notes" error={errors.notes}>
          {(f) => (
            <Textarea
              id={f.id}
              name="notes"
              maxLength={1000}
              defaultValue={previous(state, 'notes')}
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <FormMessage state={state} />
        {entryErrors.length ? (
          <ul
            className="max-h-48 list-disc space-y-1 overflow-y-auto rounded-lg border border-danger/25 px-6 py-3 text-sm text-danger"
            aria-label="Problems in the file"
          >
            {entryErrors.map(([k, m]) => (
              <li key={k}>{m}</li>
            ))}
          </ul>
        ) : null}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <SubmitButton pendingLabel="Checking and loading…">Load version</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

export function DecideVersionForm({ dataset, versionId }: { dataset: string; versionId: string }) {
  const [state, action] = useActionState(decideVersion, idle);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  return (
    <form action={action} className="space-y-4 p-5" aria-label="Approve or reject this version">
      <input type="hidden" name="dataset" value={dataset} />
      <input type="hidden" name="versionId" value={versionId} />
      <Field
        label="Reason"
        required
        hint="For example, what you checked it against. Recorded in the audit trail."
        error={errors.reason}
      >
        {(f) => (
          <Textarea
            id={f.id}
            name="reason"
            required
            minLength={5}
            maxLength={500}
            defaultValue={previous(state, 'reason')}
            aria-invalid={f.invalid}
            aria-describedby={f.describedBy}
          />
        )}
      </Field>
      <FormMessage state={state} />
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="submit"
          name="decision"
          value="reject"
          className="inline-flex h-10 items-center gap-2 rounded-lg border border-border-strong bg-surface px-4 text-sm font-medium text-fg shadow-card hover:bg-surface-muted"
        >
          <X aria-hidden className="size-4" /> Reject
        </button>
        <button
          type="submit"
          name="decision"
          value="approve"
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-contrast shadow-card hover:bg-primary-hover"
        >
          <Check aria-hidden className="size-4" /> Approve
        </button>
      </div>
    </form>
  );
}
