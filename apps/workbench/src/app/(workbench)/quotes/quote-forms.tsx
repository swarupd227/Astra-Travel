'use client';

import { useActionState, useState } from 'react';
import { Calculator, FileCheck2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { Quote } from '@astra/contracts';
import { Button } from '@/components/ui/button';
import { Field, FormMessage, Input, Select, SubmitButton } from '@/components/ui/form';
import { idle, previous } from '@/lib/actions';
import { COUNTRIES } from '@/lib/countries';
import { fieldLabel } from '@/lib/field-labels';
import { money } from '@/lib/format';
import { changeSelection, createQuote, issuePolicy } from './actions';

export interface PlanOption {
  code: string;
  label: string;
  state: string | null;
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="min-w-0 rounded-2xl border border-border bg-surface p-5 shadow-card">
      <legend className="sr-only">{title}</legend>
      <div aria-hidden className="mb-4">
        <p className="text-[15px] font-semibold text-fg">{title}</p>
        {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
      </div>
      <div className="space-y-4">{children}</div>
    </fieldset>
  );
}

export function NewQuoteForm({
  accounts,
  plans,
  today,
}: {
  accounts: { id: string; label: string }[];
  plans: PlanOption[];
  today: string;
}) {
  const [state, action] = useActionState(createQuote, idle);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  const values = state.status === 'error' ? state.values : {};
  const keep = (name: string, fallback = '') => previous(state, name) ?? fallback;
  const [people, setPeople] = useState([0]);
  const [saleState, setSaleState] = useState('');

  const text = (
    name: string,
    label: string,
    opts: {
      required?: boolean;
      type?: string;
      hint?: string;
      fallback?: string;
    } = {},
  ) => (
    <Field label={label} required={opts.required} hint={opts.hint} error={errors[name]}>
      {(f) => (
        <Input
          id={f.id}
          name={name}
          type={opts.type ?? 'text'}
          required={opts.required}
          defaultValue={keep(name, opts.fallback)}
          aria-invalid={f.invalid}
          aria-describedby={f.describedBy}
        />
      )}
    </Field>
  );

  const traveller = (
    index: number,
    name: string,
    label: string,
    props: React.ComponentProps<'input'>,
    hint?: string,
  ) => (
    <Field label={label} hint={hint} error={errors[`travellers.${index}.${name}`]}>
      {(f) => (
        <Input
          id={f.id}
          name={name}
          defaultValue={values[name]?.[index] ?? ''}
          aria-invalid={f.invalid}
          aria-describedby={f.describedBy}
          {...props}
        />
      )}
    </Field>
  );

  return (
    <form action={action} className="space-y-5" noValidate>
      <Section title="Sale">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[2fr_2fr_1fr]">
          <Field label="Account" required error={errors.accountId}>
            {(f) => (
              <Select
                id={f.id}
                name="accountId"
                required
                defaultValue={keep('accountId')}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              >
                <option value="">Choose an account</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Plan"
            required
            error={errors.planCode}
            hint={plans.length ? undefined : 'No state plan is published yet.'}
          >
            {(f) => (
              <Select
                id={f.id}
                name="planCode"
                required
                defaultValue={keep('planCode')}
                onChange={(e) =>
                  setSaleState(plans.find((p) => p.code === e.target.value)?.state ?? '')
                }
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              >
                <option value="">Choose a plan</option>
                {plans.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="State of sale" required hint="Filled from the plan." error={errors.state}>
            {(f) => (
              <Input
                id={f.id}
                name="state"
                required
                maxLength={2}
                value={saleState}
                onChange={(e) => setSaleState(e.target.value.toUpperCase())}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
        </div>
      </Section>

      <Section title="Travellers" description="Give each traveller a date of birth or an age.">
        <ol className="space-y-4">
          {people.map((id, index) => (
            <li key={id} className="rounded-xl border border-border p-4">
              <div className="mb-3 flex min-h-8 items-center justify-between gap-3">
                <p className="text-sm font-semibold text-fg">Traveller {index + 1}</p>
                {people.length > 1 ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setPeople((all) => all.filter((x) => x !== id))}
                    aria-label={`Remove traveller ${index + 1}`}
                  >
                    <Trash2 aria-hidden className="size-4" /> Remove
                  </Button>
                ) : null}
              </div>
              <div className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-[2fr_2fr_2fr_1fr_2fr]">
                {traveller(index, 'firstName', 'First name', { required: true })}
                {traveller(index, 'lastName', 'Last name', { required: true })}
                {traveller(index, 'dateOfBirth', 'Date of birth', { type: 'date' })}
                {traveller(index, 'age', 'Age', { type: 'number', min: 0 })}
                {traveller(
                  index,
                  'costPerTraveller',
                  'Trip cost (USD)',
                  { inputMode: 'decimal', required: index === 0 },
                  index ? 'Blank: as traveller 1.' : undefined,
                )}
              </div>
            </li>
          ))}
        </ol>
        <Button
          variant="secondary"
          size="sm"
          disabled={people.length >= 20}
          onClick={() => setPeople((all) => [...all, Math.max(...all) + 1])}
        >
          <Plus aria-hidden className="size-4" /> Add a traveller
        </Button>
      </Section>

      <Section title="Trip">
        <div className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {text('departureDate', 'Departure', { type: 'date', required: true })}
          {text('returnDate', 'Return', { type: 'date', required: true })}
          <Field label="Destination country" error={errors.destinationCountry}>
            {(f) => (
              <Select
                id={f.id}
                name="destinationCountry"
                defaultValue={keep('destinationCountry')}
                aria-describedby={f.describedBy}
              >
                <option value="">Not given</option>
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {text('destinationRegion', 'Destination region', {
            hint: 'As the rates name it, for example Europe.',
          })}
        </div>
        <details className="rounded-xl border border-border">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-fg">
            More options
          </summary>
          <div className="grid items-start gap-4 px-4 pb-4 sm:grid-cols-2 lg:grid-cols-3">
            {text('purchaseDate', 'Purchase date', { type: 'date', fallback: today })}
            {text('initialDepositDate', 'Initial deposit date', {
              type: 'date',
              hint: 'Used by the waiver and cancel-for-any-reason time limits.',
            })}
            {text('insuredPercent', 'Trip costs insured (%)', { type: 'number', fallback: '100' })}
            {text('businessSegment', 'Business segment')}
            {text('penaltyDays', 'Cancellation penalty days', { type: 'number' })}
          </div>
        </details>
      </Section>

      <FormMessage state={state} />
      {state.status === 'error' && Object.keys(errors).length ? (
        <ul className="list-disc space-y-1 pl-5 text-sm text-danger">
          {Object.entries(errors).map(([k, m]) => (
            <li key={k + m}>
              {fieldLabel(k)}: {m}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-4">
        <SubmitButton pendingLabel="Pricing…">
          <Calculator aria-hidden className="size-4" /> Get a quote
        </SubmitButton>
        <p className="text-sm text-muted">Nothing is bought until the traveller pays.</p>
      </div>
    </form>
  );
}

/** Optional benefits as checkboxes; applying re-rates the same quote. */
export function SelectionForm({ quote }: { quote: Quote }) {
  const [state, action] = useActionState(changeSelection, idle);
  const optional = quote.benefits.filter((b) => b.packaging !== 'packaged');
  if (optional.length === 0)
    return <p className="text-sm text-muted">This plan has no optional benefits.</p>;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="quoteId" value={quote.id} />
      <ul className="space-y-2">
        {optional.map((b) => (
          <li key={b.code}>
            <label className="flex items-start gap-3 rounded-xl border border-border p-3 text-sm has-[:checked]:border-primary/50 has-[:checked]:bg-primary-soft">
              <input
                type="checkbox"
                name="selection"
                value={b.code}
                defaultChecked={b.selected}
                disabled={!b.available && !b.selected}
                className="mt-0.5 size-4"
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap justify-between gap-x-3">
                  <span className="font-medium text-fg">{b.name}</span>
                  {b.premium ? (
                    <span className="tabular-nums text-fg">{money(b.premium)}</span>
                  ) : null}
                </span>
                {!b.available ? (
                  <span className="block text-xs text-warning">
                    Not available: {b.reason?.replace(/^Not available:s*/, '')}
                  </span>
                ) : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Re-rating…" variant="secondary">
        <RefreshCw aria-hidden className="size-4" /> Re-rate
      </SubmitButton>
    </form>
  );
}

/** Issue the policy on the traveller's behalf: the payment system's confirmation and the traveller's acknowledgement. */
export function IssueForm({ quote, keyId }: { quote: Quote; keyId: string }) {
  const [state, action] = useActionState(issuePolicy, idle);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="quoteId" value={quote.id} />
      <input type="hidden" name="key" value={keyId} />
      <input type="hidden" name="disclosureVersion" value={quote.disclosure?.version ?? ''} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Purchaser’s name" required error={errors['purchaser.name']}>
          {(f) => (
            <Input id={f.id} name="purchaserName" required aria-describedby={f.describedBy} />
          )}
        </Field>
        <Field
          label="Purchaser’s email"
          hint="Documents are emailed here."
          error={errors['purchaser.email']}
        >
          {(f) => (
            <Input id={f.id} name="purchaserEmail" type="email" aria-describedby={f.describedBy} />
          )}
        </Field>
        <Field
          label="Payment reference"
          hint="From the payment system, once it has confirmed the premium."
          required
          error={errors['payment.reference']}
        >
          {(f) => (
            <Input id={f.id} name="paymentReference" required aria-describedby={f.describedBy} />
          )}
        </Field>
        <Field
          label="Amount paid"
          hint={
            quote.premium ? `Must equal the premium, ${money(quote.premium.total)}.` : undefined
          }
          required
          error={errors['payment.amount']}
        >
          {(f) => (
            <Input
              id={f.id}
              name="paymentAmount"
              inputMode="decimal"
              required
              defaultValue={quote.premium?.total ?? ''}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <Field
          label="Who acknowledged the disclosure"
          hint={`The traveller has been read “${quote.disclosure?.title ?? ''}”.`}
          required
          error={errors['acknowledgement.acknowledgedBy']}
        >
          {(f) => (
            <Input id={f.id} name="acknowledgedBy" required aria-describedby={f.describedBy} />
          )}
        </Field>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="able" className="mt-1" />
        <span>
          The traveller confirms they are medically able to travel and are not under restricting
          treatment.
        </span>
      </label>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Issuing…">
        <FileCheck2 aria-hidden className="size-4" /> Issue the policy
      </SubmitButton>
      <p className="text-xs text-muted">
        The policy records you as the person who issued it. Eligibility, sanctions and payment are
        checked again.
      </p>
    </form>
  );
}
