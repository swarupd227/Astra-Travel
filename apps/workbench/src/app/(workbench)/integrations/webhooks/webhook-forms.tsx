'use client';

import { useActionState, useState } from 'react';
import { Check, Copy, KeyRound, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, FormMessage, Input, Select, SubmitButton } from '@/components/ui/form';
import { Notice } from '@/components/ui/primitives';
import { idle, previous, previousAll } from '@/lib/actions';
import { createWebhook, setWebhookStatus } from './actions';

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code
        aria-label={label}
        className="min-w-0 flex-1 break-all rounded-lg border border-border bg-surface-muted px-3 py-2 font-mono text-xs text-fg"
      >
        {value}
      </code>
      <Button
        variant="secondary"
        size="sm"
        aria-label={copied ? 'Copied' : `Copy ${label}`}
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? (
          <Check aria-hidden className="size-4" />
        ) : (
          <Copy aria-hidden className="size-4" />
        )}
      </Button>
    </div>
  );
}

export function CreateWebhookDialog({
  accounts,
  eventTypes,
  defaultAccountId,
}: {
  accounts: { id: string; name: string }[];
  eventTypes: string[];
  defaultAccountId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [state, action] = useActionState(createWebhook, idle);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  const secret = state.status === 'success' ? state.data?.signingSecret : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setKey(crypto.randomUUID());
      }}
      wide
      title={secret ? 'Save the signing secret' : 'Add a webhook subscription'}
      description={
        secret
          ? 'This is the only time the secret is shown. Store it in the partner system’s secret store.'
          : 'Signed event notifications are POSTed to this HTTPS endpoint and retried with back-off if it fails.'
      }
      trigger={
        <Button>
          <Plus aria-hidden className="size-4" /> Add subscription
        </Button>
      }
    >
      {secret ? (
        <div className="space-y-4">
          <Notice tone="warning" title="Shown once">
            Verify each delivery by computing HMAC-SHA256 of <code>&lt;t&gt;.&lt;body&gt;</code>{' '}
            with this secret and comparing it to the <code>v1</code> value of the{' '}
            <code>Astra-Signature</code> header.
          </Notice>
          <div className="flex items-center gap-2 text-sm font-medium text-fg">
            <KeyRound aria-hidden className="size-4 text-muted" /> Signing secret
          </div>
          <CopyField value={secret} label="signing secret" />
          <div className="flex justify-end pt-2">
            <Button onClick={() => window.location.reload()}>Done</Button>
          </div>
        </div>
      ) : (
        <form action={action} className="space-y-4">
          <input type="hidden" name="idempotencyKey" value={key} />
          <Field label="Account" required error={errors.accountId}>
            {(f) => (
              <Select
                id={f.id}
                name="accountId"
                required
                defaultValue={previous(state, 'accountId') ?? defaultAccountId}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Endpoint URL"
            required
            hint="Must use https and be reachable from the internet."
            error={errors.url}
          >
            {(f) => (
              <Input
                id={f.id}
                name="url"
                defaultValue={previous(state, 'url')}
                type="url"
                required
                placeholder="https://partner.example/astra/webhooks"
                className="font-mono"
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-fg">
              Events{' '}
              <span className="text-danger" aria-hidden>
                *
              </span>
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {eventTypes.map((t) => (
                <label
                  key={t}
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-fg has-[:checked]:border-primary has-[:checked]:bg-primary-soft"
                >
                  <input
                    type="checkbox"
                    name="eventTypes"
                    defaultChecked={previousAll(state, 'eventTypes').includes(t)}
                    value={t}
                    className="size-4 accent-[var(--primary)]"
                  />
                  <span className="font-mono text-xs">{t}</span>
                </label>
              ))}
            </div>
            {errors.eventTypes ? (
              <p className="text-xs font-medium text-danger">{errors.eventTypes}</p>
            ) : null}
          </fieldset>
          <Field label="Description" error={errors.description}>
            {(f) => (
              <Input
                id={f.id}
                name="description"
                defaultValue={previous(state, 'description')}
                maxLength={200}
                aria-invalid={f.invalid}
              />
            )}
          </Field>
          <FormMessage state={state} />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton pendingLabel="Creating…">Create subscription</SubmitButton>
          </div>
        </form>
      )}
    </Dialog>
  );
}

export function WebhookStatusButton({
  subscriptionId,
  status,
  label,
  variant = 'secondary',
}: {
  subscriptionId: string;
  status: 'active' | 'paused' | 'disabled';
  label: string;
  variant?: 'secondary' | 'danger';
}) {
  const [state, action] = useActionState(setWebhookStatus, idle);
  return (
    <form action={action} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="subscriptionId" value={subscriptionId} />
      <input type="hidden" name="status" value={status} />
      <SubmitButton variant={variant} pendingLabel="…" className="h-8 px-3 text-[13px]">
        {label}
      </SubmitButton>
      {state.status === 'error' ? (
        <span role="alert" className="text-xs text-danger">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
