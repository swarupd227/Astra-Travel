'use client';

import { useActionState } from 'react';
import { Calculator, RefreshCw } from 'lucide-react';
import type { Quote } from '@astra/contracts';
import { Field, FormMessage, Input, Select, SubmitButton, Textarea } from '@/components/ui/form';
import { idle, previous } from '@/lib/actions';
import { changeSelection, createQuote } from './actions';

export interface PlanOption {
  code: string;
  label: string;
  state: string | null;
}

export function NewQuoteForm({ accounts, plans, today }: { accounts: { id: string; label: string }[]; plans: PlanOption[]; today: string }) {
  const [state, action] = useActionState(createQuote, idle);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  const keep = (name: string, fallback = '') => previous(state, name) ?? fallback;
  const text = (name: string, label: string, opts: { required?: boolean; type?: string; hint?: string; className?: string; fallback?: string } = {}) => (
    <Field label={label} required={opts.required} hint={opts.hint} error={errors[name]}>
      {(f) => (
        <Input id={f.id} name={name} type={opts.type ?? 'text'} required={opts.required} defaultValue={keep(name, opts.fallback)} className={opts.className} aria-invalid={f.invalid} aria-describedby={f.describedBy} />
      )}
    </Field>
  );
  return (
    <form action={action} className="space-y-6" noValidate>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Account" required error={errors.accountId}>
          {(f) => (
            <Select id={f.id} name="accountId" required defaultValue={keep('accountId')} aria-invalid={f.invalid} aria-describedby={f.describedBy}>
              <option value="">Choose…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Plan" required error={errors.planCode} hint={plans.length ? undefined : 'No state plan is published yet.'}>
          {(f) => (
            <Select id={f.id} name="planCode" required defaultValue={keep('planCode')} aria-invalid={f.invalid} aria-describedby={f.describedBy}>
              <option value="">Choose…</option>
              {plans.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {text('state', 'State of sale', { required: true, className: 'uppercase', hint: 'Two letters, for example DE.' })}
      </div>
      <fieldset className="space-y-4 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-medium text-fg">First traveller</legend>
        <div className="grid gap-4 sm:grid-cols-4">
          {text('firstName', 'First name', { required: true })}
          {text('lastName', 'Last name', { required: true })}
          {text('dateOfBirth', 'Date of birth', { type: 'date', hint: 'Or give an age.' })}
          {text('age', 'Age', { type: 'number' })}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {text('costPerTraveller', 'Trip cost per traveller', { required: true, hint: 'For example 4200.00' })}
          {text('insuredPercent', 'Trip costs insured (%)', { type: 'number', fallback: '100' })}
          {text('businessSegment', 'Business segment')}
        </div>
        <Field label="More travellers" hint="One per line: first name, last name, date of birth, trip cost (the cost is optional).">
          {(f) => <Textarea id={f.id} name="moreTravellers" rows={2} defaultValue={keep('moreTravellers')} aria-describedby={f.describedBy} />}
        </Field>
      </fieldset>
      <fieldset className="space-y-4 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-medium text-fg">Trip</legend>
        <div className="grid gap-4 sm:grid-cols-4">
          {text('purchaseDate', 'Purchase date', { type: 'date', fallback: today })}
          {text('initialDepositDate', 'Initial deposit date', { type: 'date', hint: 'Needed for the waiver and CFAR time conditions.' })}
          {text('departureDate', 'Departure', { type: 'date', required: true })}
          {text('returnDate', 'Return', { type: 'date', required: true })}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {text('destinationCountry', 'Destination country', { className: 'uppercase', hint: 'Two letters, for example FR.' })}
          {text('destinationRegion', 'Destination region', { hint: 'As the rate manual names it.' })}
          {text('penaltyDays', 'Cancellation penalty days', { type: 'number' })}
        </div>
      </fieldset>
      <FormMessage state={state} />
      {state.status === 'error' && Object.keys(errors).length ? (
        <ul className="list-disc space-y-1 pl-5 text-sm text-danger">
          {Object.entries(errors).map(([k, m]) => (
            <li key={k + m}>
              {k}: {m}
            </li>
          ))}
        </ul>
      ) : null}
      <SubmitButton pendingLabel="Pricing…">
        <Calculator aria-hidden className="size-4" /> Get a quote
      </SubmitButton>
    </form>
  );
}

/** Optional benefits as checkboxes; applying re-rates the same quote. */
export function SelectionForm({ quote }: { quote: Quote }) {
  const [state, action] = useActionState(changeSelection, idle);
  const optional = quote.benefits.filter((b) => b.packaging !== 'packaged');
  if (optional.length === 0) return <p className="text-sm text-muted">This plan has no optional benefits.</p>;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="quoteId" value={quote.id} />
      <ul className="space-y-2">
        {optional.map((b) => (
          <li key={b.code}>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="selection" value={b.code} defaultChecked={b.selected} disabled={!b.available && !b.selected} className="mt-1" />
              <span>
                <span className="font-medium text-fg">{b.name}</span>
                {b.premium ? <span className="ml-2 font-mono text-xs text-muted">{b.premium}</span> : null}
                {!b.available ? <span className="block text-xs text-warning">Not available: {b.reason}</span> : null}
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
