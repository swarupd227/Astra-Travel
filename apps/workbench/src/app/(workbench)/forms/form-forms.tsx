'use client';

import { useActionState, useState } from 'react';
import { Upload } from 'lucide-react';
import { FORM_KINDS } from '@astra/contracts';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, FormMessage, Input, Select, SubmitButton } from '@/components/ui/form';
import { Badge } from '@/components/ui/primitives';
import { idle, previous } from '@/lib/actions';
import { sentenceCase } from '@/lib/format';
import { checkUsability, loadEdition, type UsabilityState } from './actions';

export function LoadEditionDialog() {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(loadEdition, idle);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Load a form edition"
      description="The filed document as approved: a PDF with a text layer, or a plain-text export. Editions are never replaced."
      trigger={
        <Button>
          <Upload aria-hidden className="size-4" /> Load edition
        </Button>
      }
    >
      <form action={action} className="space-y-4" noValidate>
        <Field label="Document" required error={errors.file} hint="PDF or .txt, up to 25 MB.">
          {(f) => (
            <Input
              id={f.id}
              type="file"
              name="file"
              accept=".pdf,.txt,application/pdf,text/plain"
              required
              className="py-2"
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Form number"
            required
            error={errors.formNumber}
            hint="For example trvl_indv_pol_cw."
          >
            {(f) => (
              <Input
                id={f.id}
                name="formNumber"
                required
                defaultValue={previous(state, 'formNumber')}
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
          <Field label="Edition" required error={errors.edition} hint="Year and month, YYYY-MM.">
            {(f) => (
              <Input
                id={f.id}
                name="edition"
                required
                pattern="\d{4}-\d{2}"
                placeholder="2026-05"
                defaultValue={previous(state, 'edition')}
                className="font-mono"
                autoComplete="off"
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
        </div>
        <Field label="Title" required error={errors.title}>
          {(f) => (
            <Input
              id={f.id}
              name="title"
              required
              defaultValue={previous(state, 'title')}
              autoComplete="off"
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Kind" required error={errors.kind}>
            {(f) => (
              <Select
                id={f.id}
                name="kind"
                defaultValue={previous(state, 'kind') ?? 'policy'}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              >
                {FORM_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {sentenceCase(k)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Insurer" required error={errors.insurer}>
            {(f) => (
              <Select
                id={f.id}
                name="insurer"
                defaultValue={previous(state, 'insurer') ?? 'VSC'}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              >
                <option value="VSC">Virginia Surety Company (VSC)</option>
                <option value="ABIC">American Bankers Insurance Company (ABIC)</option>
              </Select>
            )}
          </Field>
        </div>
        <FormMessage state={state} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <SubmitButton pendingLabel="Reading the document…">Load edition</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

export function UsabilityCheck({ editionId }: { editionId: string }) {
  const [state, action] = useActionState<UsabilityState, FormData>(checkUsability, idle);
  const kept = state.status === 'success' ? state.data : undefined;
  const errors = state.status === 'error' ? state.fieldErrors : {};
  return (
    <div className="space-y-3 p-5">
      <form
        action={action}
        className="grid gap-3 sm:grid-cols-[6rem_1fr_auto] sm:items-end"
        aria-label="Check usability"
      >
        <input type="hidden" name="editionId" value={editionId} />
        <Field label="State" required error={errors.state}>
          {(f) => (
            <Input
              id={f.id}
              name="state"
              required
              maxLength={2}
              className="uppercase"
              defaultValue={kept?.state ?? previous(state, 'state')}
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <Field label="Date" required error={errors.date}>
          {(f) => (
            <Input
              id={f.id}
              type="date"
              name="date"
              required
              defaultValue={
                kept?.date ?? previous(state, 'date') ?? new Date().toISOString().slice(0, 10)
              }
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <SubmitButton variant="secondary" pendingLabel="Checking…">
          Check
        </SubmitButton>
      </form>
      <div aria-live="polite">
        {state.status === 'success' && state.answer ? (
          <p className="flex items-start gap-2 text-sm">
            <Badge tone={state.answer.usable ? 'success' : 'danger'}>
              {state.answer.usable ? 'Usable' : 'Not usable'}
            </Badge>
            <span className="text-fg">{state.answer.reason}</span>
          </p>
        ) : null}
        {state.status === 'error' ? <FormMessage state={state} /> : null}
      </div>
    </div>
  );
}
