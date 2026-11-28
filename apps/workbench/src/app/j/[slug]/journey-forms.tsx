'use client';

import { useActionState, useState } from 'react';
import { ArrowRight, Plus, Trash2 } from 'lucide-react';
import { idle, previous, type ActionState } from '@/lib/actions';
import { COUNTRIES } from '@/lib/countries';
import { purchase, selectBenefits, startQuote } from './actions';
import { money, Panel } from './parts';

const field =
  'mt-1 block h-12 w-full rounded-lg border border-[#6b7280] bg-white px-3 text-base text-[#1a1a1a]';
const label = 'block min-w-0 text-sm font-medium';
const button =
  'inline-flex h-12 items-center justify-center gap-2 rounded-lg px-6 text-base font-semibold disabled:opacity-60';
const brandButton = { background: 'var(--brand)', color: 'var(--on-brand)' } as const;
/** The most travellers the purchase accepts on this page. */
const MOST_TRAVELLERS = 4;

function Problem({ state }: { state: ActionState }) {
  if (state.status !== 'error') return null;
  return (
    <div
      role="alert"
      className="rounded-lg border border-[#b91c1c] bg-[#fef2f2] p-3 text-[#7f1d1d]"
    >
      <p className="font-semibold">{state.message}</p>
      {Object.values(state.fieldErrors).length ? (
        <ul className="mt-1 list-disc pl-5 text-sm">
          {[...new Set(Object.values(state.fieldErrors))].map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function TripForm({
  slug,
  plans,
}: {
  slug: string;
  plans: { code: string; name: string; state: string }[];
}) {
  const [state, action, pending] = useActionState(startQuote, idle);
  const [people, setPeople] = useState([1]);
  const only = plans.length === 1 ? plans[0] : undefined;
  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="slug" value={slug} />
      <Problem state={state} />
      <Panel>
        <fieldset className="space-y-4">
          <legend className="mb-3 text-lg font-semibold">Your trip</legend>
          {only ? (
            <>
              <input type="hidden" name="planCode" value={only.code} />
              <p className="text-sm text-[#4a4a4a]">
                Plan: <span className="font-semibold text-[#1a1a1a]">{only.name}</span> (
                {only.state})
              </p>
            </>
          ) : (
            <label className={label}>
              Plan
              <select
                name="planCode"
                required
                className={field}
                defaultValue={previous(state, 'planCode') ?? plans[0]?.code}
              >
                {plans.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name} ({p.state})
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <label className={label}>
              Departure date
              <input
                name="departureDate"
                type="date"
                required
                className={field}
                defaultValue={previous(state, 'departureDate')}
              />
            </label>
            <label className={label}>
              Return date
              <input
                name="returnDate"
                type="date"
                required
                className={field}
                defaultValue={previous(state, 'returnDate')}
              />
            </label>
            <label className={label}>
              Destination country
              <select
                name="country"
                className={field}
                key={previous(state, 'country') ?? ''}
                defaultValue={previous(state, 'country') ?? ''}
              >
                <option value="">Choose a country</option>
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={label}>
              Destination region
              <input
                name="region"
                placeholder="For example Europe"
                className={field}
                defaultValue={previous(state, 'region')}
              />
            </label>
          </div>
        </fieldset>
      </Panel>

      {people.map((n, index) => (
        <Panel key={n}>
          <fieldset>
            <legend className="mb-3 text-lg font-semibold">
              {people.length === 1 ? 'Traveller' : `Traveller ${index + 1}`}
            </legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className={label}>
                First name
                <input
                  name={`first${n}`}
                  required={index === 0}
                  autoComplete={index === 0 ? 'given-name' : 'off'}
                  className={field}
                  defaultValue={previous(state, `first${n}`)}
                />
              </label>
              <label className={label}>
                Last name
                <input
                  name={`last${n}`}
                  required={index === 0}
                  autoComplete={index === 0 ? 'family-name' : 'off'}
                  className={field}
                  defaultValue={previous(state, `last${n}`)}
                />
              </label>
              <label className={label}>
                Date of birth
                <input
                  name={`dob${n}`}
                  type="date"
                  required={index === 0}
                  className={field}
                  defaultValue={previous(state, `dob${n}`)}
                />
              </label>
              <label className={label}>
                Trip cost to insure (US$)
                <input
                  name={`cost${n}`}
                  inputMode="decimal"
                  required={index === 0}
                  placeholder="For example 4200"
                  className={field}
                  defaultValue={previous(state, `cost${n}`)}
                />
              </label>
            </div>
          </fieldset>
          {index > 0 ? (
            <button
              type="button"
              onClick={() => setPeople((all) => all.filter((x) => x !== n))}
              className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium underline"
              aria-label={`Remove traveller ${index + 1}`}
            >
              <Trash2 aria-hidden className="size-4" /> Remove
            </button>
          ) : null}
        </Panel>
      ))}
      {people.length < MOST_TRAVELLERS ? (
        <button
          type="button"
          onClick={() => setPeople((all) => [...all, Math.max(...all) + 1])}
          className="inline-flex h-11 items-center gap-2 rounded-lg border border-dashed border-[#6b7280] bg-white px-4 text-sm font-semibold"
        >
          <Plus aria-hidden className="size-4" /> Add another traveller
        </button>
      ) : null}
      <div>
        <button
          type="submit"
          disabled={pending}
          className={`${button} w-full sm:w-auto`}
          style={brandButton}
        >
          {pending ? 'Getting your price…' : 'See my price'}
          <ArrowRight aria-hidden className="size-5" />
        </button>
      </div>
    </form>
  );
}

export function OptionsForm({
  slug,
  quoteId,
  optional,
}: {
  slug: string;
  quoteId: string;
  optional: {
    code: string;
    name: string;
    limit: string | null;
    premium: string | null;
    selected: boolean;
    available: boolean;
    reason: string | null;
  }[];
}) {
  const [state, action, pending] = useActionState(selectBenefits, idle);
  if (optional.length === 0) return null;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="quoteId" value={quoteId} />
      <Problem state={state} />
      <fieldset className="space-y-3">
        <legend className="mb-3 text-lg font-semibold">Add to your cover</legend>
        {optional.map((b) => (
          <label
            key={b.code}
            className="flex items-start gap-3 rounded-xl border-2 border-[#d8dce3] p-4 has-[:checked]:border-[var(--brand)]"
          >
            <input
              type="checkbox"
              name="benefit"
              value={b.code}
              defaultChecked={b.selected}
              disabled={!b.available && !b.selected}
              className="mt-1 size-5"
              style={{ accentColor: 'var(--brand)' }}
            />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap justify-between gap-x-3">
                <span className="font-semibold">{b.name}</span>
                {b.premium ? <span>{money(b.premium)}</span> : null}
              </span>
              {b.limit ? (
                <span className="block text-sm text-[#4a4a4a]">Up to {b.limit}</span>
              ) : null}
              {!b.available && b.reason ? (
                <span className="block text-sm text-[#4a4a4a]">{b.reason}</span>
              ) : null}
            </span>
          </label>
        ))}
      </fieldset>
      <button
        type="submit"
        disabled={pending}
        className={button}
        style={{ border: '2px solid var(--brand)', color: '#1a1a1a', background: '#fff' }}
      >
        {pending ? 'Updating…' : 'Update my price'}
      </button>
    </form>
  );
}

export function PayForm({
  slug,
  quoteId,
  total,
  payment,
}: {
  slug: string;
  quoteId: string;
  total: string;
  payment: 'test' | 'unavailable';
}) {
  const [state, action, pending] = useActionState(purchase, idle);
  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="quoteId" value={quoteId} />
      <Problem state={state} />
      <Panel>
        <fieldset>
          <legend className="mb-3 text-lg font-semibold">Who is buying</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className={label}>
              Your name
              <input
                name="purchaserName"
                required
                autoComplete="name"
                className={field}
                defaultValue={previous(state, 'purchaserName')}
              />
            </label>
            <label className={label}>
              Email for your documents
              <input
                name="purchaserEmail"
                type="email"
                autoComplete="email"
                className={field}
                defaultValue={previous(state, 'purchaserEmail')}
              />
            </label>
          </div>
        </fieldset>
      </Panel>
      <Panel className="space-y-3">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            name="acknowledge"
            className="mt-1 size-5"
            style={{ accentColor: 'var(--brand)' }}
            aria-describedby="ack-help"
          />
          <span>I have read the notice above.</span>
        </label>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            name="able"
            className="mt-1 size-5"
            style={{ accentColor: 'var(--brand)' }}
          />
          <span>I am medically able to travel and am not under restricting treatment.</span>
        </label>
      </Panel>
      {payment === 'test' ? (
        <div className="rounded-xl border border-[#b25e00] bg-[#fff4e5] p-4 text-[#4d2900]">
          <p className="font-semibold">Test payment</p>
          <p className="text-sm">
            This is a sandbox. No money is taken and no real policy is made.
          </p>
        </div>
      ) : (
        <div role="status" className="rounded-xl border border-[#6b7280] bg-white p-4">
          <p className="font-semibold">Online payment is not set up yet</p>
          <p className="text-sm">
            You can see your price and read the wording, but this page cannot take payment. Please
            contact the seller to buy.
          </p>
        </div>
      )}
      <p id="ack-help" className="sr-only">
        The notice is shown above the form.
      </p>
      {payment === 'test' ? (
        <button
          type="submit"
          disabled={pending}
          className={`${button} w-full sm:w-auto`}
          style={brandButton}
        >
          {pending ? 'Buying…' : `Pay ${money(total)} (test)`}
        </button>
      ) : null}
    </form>
  );
}
