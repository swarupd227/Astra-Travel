'use client';

import { useActionState, useState } from 'react';
import { Plus } from 'lucide-react';
import { ACCOUNT_KINDS, ACCOUNT_STATUS_TRANSITIONS, type AccountStatus } from '@astra/contracts';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, FormMessage, Input, Select, SubmitButton, Textarea } from '@/components/ui/form';
import { idle, previous } from '@/lib/actions';
import { ACCOUNT_KIND_LABELS, sentenceCase } from '@/lib/format';
import { changeAccountStatus, createAccount } from './actions';

export function CreateAccountDialog() {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(createAccount, idle);
  // A fresh idempotency key each time the dialog opens; resubmitting the same form reuses it.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const errors = state.status === 'error' ? state.fieldErrors : {};

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setKey(crypto.randomUUID());
      }}
      title="Register an account"
      description="Add a travel seller, card issuer or bank. It starts in onboarding and cannot sell until onboarding is complete."
      trigger={
        <Button>
          <Plus aria-hidden className="size-4" /> Register account
        </Button>
      }
    >
      <form action={action} className="space-y-4" noValidate>
        <input type="hidden" name="idempotencyKey" value={key} />
        <Field label="Account name" required error={errors.name}>
          {(f) => (
            <Input
              id={f.id}
              name="name"
              defaultValue={previous(state, 'name')}
              required
              minLength={2}
              maxLength={200}
              aria-describedby={f.describedBy}
              aria-invalid={f.invalid}
              autoComplete="off"
            />
          )}
        </Field>
        <Field
          label="Account code"
          required
          hint="2 to 32 characters: capital letters, digits, - or _. Used in reports and files; it cannot be changed."
          error={errors.code}
        >
          {(f) => (
            <Input
              id={f.id}
              name="code"
              defaultValue={previous(state, 'code')}
              required
              pattern="[A-Za-z0-9][A-Za-z0-9_\-]{1,31}"
              className="font-mono uppercase"
              aria-describedby={f.describedBy}
              aria-invalid={f.invalid}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </Field>
        <Field label="Type" required error={errors.kind}>
          {(f) => (
            <Select
              id={f.id}
              name="kind"
              required
              defaultValue={previous(state, 'kind') ?? 'travel_account'}
              aria-describedby={f.describedBy}
              aria-invalid={f.invalid}
            >
              {ACCOUNT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {ACCOUNT_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <FormMessage state={state} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <SubmitButton pendingLabel="Registering…">Register account</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

export function ChangeStatusDialog({
  accountId,
  current,
}: {
  accountId: string;
  current: AccountStatus;
}) {
  const options = ACCOUNT_STATUS_TRANSITIONS[current];
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(changeAccountStatus, idle);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  if (options.length === 0) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Change account status"
      description="The change and your reason are recorded in the audit trail."
      trigger={<Button variant="secondary">Change status</Button>}
    >
      <form action={action} className="space-y-4">
        <input type="hidden" name="accountId" value={accountId} />
        <Field label="New status" required error={errors.status}>
          {(f) => (
            <Select
              id={f.id}
              name="status"
              defaultValue={previous(state, 'status')}
              required
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            >
              {options.map((s) => (
                <option key={s} value={s}>
                  {sentenceCase(s)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Reason" required hint="At least 3 characters." error={errors.reason}>
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
          <SubmitButton>Change status</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}
