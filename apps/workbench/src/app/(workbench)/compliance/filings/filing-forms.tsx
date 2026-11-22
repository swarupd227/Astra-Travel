'use client';

import { useActionState, useState } from 'react';
import { Plus } from 'lucide-react';
import { FILING_TRANSITIONS, type FilingStatus } from '@astra/contracts';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, FormMessage, Input, Select, SubmitButton, Textarea } from '@/components/ui/form';
import { idle, previous } from '@/lib/actions';
import { sentenceCase } from '@/lib/format';
import { changeFilingStatus, recordFiling } from './actions';

const ITEM_LABELS = {
  form_edition: 'Form or schedule edition',
  rate_manual: 'Rate manual',
  rule_set: 'Underwriting rule set',
};

export function RecordFilingDialog({
  editions,
  presetEditionId,
}: {
  editions: { id: string; label: string; insurer: string }[];
  presetEditionId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(recordFiling, idle);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [itemType, setItemType] = useState(
    presetEditionId ? 'form_edition' : (previous(state, 'itemType') ?? 'form_edition'),
  );
  const [editionId, setEditionId] = useState(presetEditionId ?? editions[0]?.id ?? '');
  const edition = editions.find((e) => e.id === editionId);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setKey(crypto.randomUUID());
      }}
      title="Record a filing"
      description="One filing is recorded per state, in draft. Record the submission and the regulator's decision as they happen."
      trigger={
        <Button>
          <Plus aria-hidden className="size-4" /> Record filing
        </Button>
      }
    >
      <form action={action} className="space-y-4" noValidate>
        <input type="hidden" name="idempotencyKey" value={key} />
        <Field label="What is filed" required error={errors.itemType}>
          {(f) => (
            <Select
              id={f.id}
              name="itemType"
              value={itemType}
              onChange={(e) => setItemType(e.target.value)}
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            >
              {Object.entries(ITEM_LABELS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {itemType === 'form_edition' ? (
          <Field
            label="Form edition"
            required
            error={errors.itemId}
            hint={editions.length ? undefined : 'Load the form edition in Forms & schedules first.'}
          >
            {(f) => (
              <Select
                id={f.id}
                name="itemId"
                value={editionId}
                onChange={(e) => setEditionId(e.target.value)}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              >
                {editions.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : (
          <Field
            label="Filed reference"
            required
            error={errors.itemReference}
            hint="As filed, for example RETR-SP-VU-DE-0426."
          >
            {(f) => (
              <Input
                id={f.id}
                name="itemReference"
                required
                defaultValue={previous(state, 'itemReference')}
                autoComplete="off"
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="States"
            required
            error={errors.states}
            hint="Two-letter codes, comma-separated."
          >
            {(f) => (
              <Input
                id={f.id}
                name="states"
                required
                className="uppercase"
                defaultValue={previous(state, 'states')}
                autoComplete="off"
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
          <Field label="Insurer" required error={errors.insurer}>
            {(f) => (
              <Select
                id={f.id}
                name="insurer"
                key={edition?.insurer}
                defaultValue={
                  itemType === 'form_edition'
                    ? edition?.insurer
                    : (previous(state, 'insurer') ?? 'VSC')
                }
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              >
                <option value="VSC">Virginia Surety Company (VSC)</option>
                <option value="ABIC">American Bankers Insurance Company (ABIC)</option>
              </Select>
            )}
          </Field>
        </div>
        <Field label="SERFF tracking number" error={errors.serffTracking} hint="If already known.">
          {(f) => (
            <Input
              id={f.id}
              name="serffTracking"
              className="font-mono uppercase"
              defaultValue={previous(state, 'serffTracking')}
              autoComplete="off"
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
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
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <SubmitButton pendingLabel="Recording…">Record filing</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

const ACTION_LABELS: Record<string, string> = {
  submitted: 'Record submission',
  approved: 'Record approval',
  disapproved: 'Record disapproval',
  withdrawn: 'Withdraw',
};

export function FilingStatusDialog({
  filingId,
  current,
  serff,
}: {
  filingId: string;
  current: FilingStatus;
  serff: string | null;
}) {
  const options = FILING_TRANSITIONS[current];
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(changeFilingStatus, idle);
  const [status, setStatus] = useState<string>(options[0] ?? '');
  const errors = state.status === 'error' ? state.fieldErrors : {};
  if (!options.length) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Update the filing"
      description="Each change and its reason go into the filing history and the audit trail."
      trigger={<Button>Update status</Button>}
    >
      <form action={action} className="space-y-4" noValidate>
        <input type="hidden" name="filingId" value={filingId} />
        <Field label="Change" required error={errors.status}>
          {(f) => (
            <Select
              id={f.id}
              name="status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            >
              {options.map((s) => (
                <option key={s} value={s}>
                  {ACTION_LABELS[s] ?? sentenceCase(s)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label={
            status === 'submitted'
              ? 'Submitted on'
              : status === 'withdrawn'
                ? 'Withdrawn on'
                : 'Decision date'
          }
          required
          error={errors.on}
          hint={
            status === 'withdrawn'
              ? 'An approval stops on this date; earlier dates stay covered.'
              : undefined
          }
        >
          {(f) => (
            <Input
              id={f.id}
              type="date"
              name="on"
              required
              defaultValue={previous(state, 'on')}
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        {status === 'approved' ? (
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
            <Field
              label="Effective to"
              error={errors.effectiveTo}
              hint="Leave empty if open-ended."
            >
              {(f) => (
                <Input
                  id={f.id}
                  type="date"
                  name="effectiveTo"
                  defaultValue={previous(state, 'effectiveTo')}
                  aria-invalid={f.invalid}
                  aria-describedby={f.describedBy}
                />
              )}
            </Field>
          </div>
        ) : null}
        {status === 'submitted' || status === 'approved' ? (
          <Field label="SERFF tracking number" error={errors.serffTracking}>
            {(f) => (
              <Input
                id={f.id}
                name="serffTracking"
                className="font-mono uppercase"
                defaultValue={previous(state, 'serffTracking') ?? serff ?? ''}
                autoComplete="off"
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
        ) : null}
        <Field
          label="Reason or reference"
          required
          error={errors.reason}
          hint="For example, the approval letter."
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
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <SubmitButton pendingLabel="Saving…">{ACTION_LABELS[status] ?? 'Save'}</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}
