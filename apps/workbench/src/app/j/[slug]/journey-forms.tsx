'use client';

import { useActionState } from 'react';
import { idle, previous, type ActionState } from '@/lib/actions';
import { purchase, selectBenefits, startQuote } from './actions';

const field = 'mt-1 block h-11 w-full rounded-lg border border-[#6b7280] bg-white px-3 text-base text-[#1a1a1a]';
const button = 'inline-flex h-11 items-center justify-center rounded-lg px-5 text-base font-semibold disabled:opacity-60';
const brandButton = { background: 'var(--brand)', color: 'var(--on-brand)' } as const;

function Problem({ state }: { state: ActionState }) {
  if (state.status !== 'error') return null;
  return (
    <div role="alert" className="mb-4 rounded-lg border border-[#b91c1c] bg-[#fef2f2] p-3 text-[#7f1d1d]">
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

export function TripForm({ slug, plans }: { slug: string; plans: { code: string; name: string; state: string }[] }) {
  const [state, action, pending] = useActionState(startQuote, idle);
  return (
    <form action={action} className="space-y-6" noValidate>
      <input type="hidden" name="slug" value={slug} />
      <Problem state={state} />
      <fieldset className="space-y-3">
        <legend className="text-lg font-semibold">Your trip</legend>
        <label className="block">
          Plan
          <select name="planCode" required className={field} defaultValue={previous(state, 'planCode') ?? plans[0]?.code}>
            {plans.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name} ({p.state})
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            Departure date
            <input name="departureDate" type="date" required className={field} defaultValue={previous(state, 'departureDate')} />
          </label>
          <label className="block">
            Return date
            <input name="returnDate" type="date" required className={field} defaultValue={previous(state, 'returnDate')} />
          </label>
          <label className="block">
            Destination country
            <input name="country" maxLength={2} placeholder="Two-letter code, for example FR" className={field} defaultValue={previous(state, 'country')} />
          </label>
          <label className="block">
            Destination region
            <input name="region" className={field} defaultValue={previous(state, 'region')} />
          </label>
        </div>
      </fieldset>
      {[1, 2].map((n) => (
        <fieldset key={n} className="space-y-3">
          <legend className="text-lg font-semibold">{n === 1 ? 'Traveller' : 'Another traveller (optional)'}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              First name
              <input name={`first${n}`} required={n === 1} autoComplete={n === 1 ? 'given-name' : 'off'} className={field} defaultValue={previous(state, `first${n}`)} />
            </label>
            <label className="block">
              Last name
              <input name={`last${n}`} required={n === 1} autoComplete={n === 1 ? 'family-name' : 'off'} className={field} defaultValue={previous(state, `last${n}`)} />
            </label>
            <label className="block">
              Date of birth
              <input name={`dob${n}`} type="date" required={n === 1} className={field} defaultValue={previous(state, `dob${n}`)} />
            </label>
            <label className="block">
              Trip cost to insure
              <input name={`cost${n}`} inputMode="decimal" required={n === 1} placeholder="For example 4200" className={field} defaultValue={previous(state, `cost${n}`)} />
            </label>
          </div>
        </fieldset>
      ))}
      <button type="submit" disabled={pending} className={button} style={brandButton}>
        {pending ? 'Getting your price…' : 'See my price'}
      </button>
    </form>
  );
}

export function OptionsForm({ slug, quoteId, optional }: { slug: string; quoteId: string; optional: { code: string; name: string; limit: string | null; premium: string | null; selected: boolean; available: boolean; reason: string | null }[] }) {
  const [state, action, pending] = useActionState(selectBenefits, idle);
  if (optional.length === 0) return null;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="quoteId" value={quoteId} />
      <Problem state={state} />
      <fieldset className="space-y-2">
        <legend className="text-lg font-semibold">Add to your cover</legend>
        {optional.map((b) => (
          <label key={b.code} className="flex items-start gap-3 rounded-lg border border-[#c9ced6] p-3">
            <input type="checkbox" name="benefit" value={b.code} defaultChecked={b.selected} disabled={!b.available && !b.selected} className="mt-1 size-5" style={{ accentColor: 'var(--brand)' }} />
            <span>
              <span className="font-semibold">{b.name}</span>
              {b.limit ? <span className="block text-sm text-[#4a4a4a]">Up to {b.limit}</span> : null}
              {!b.available && b.reason ? <span className="block text-sm text-[#4a4a4a]">{b.reason}</span> : null}
            </span>
          </label>
        ))}
      </fieldset>
      <button type="submit" disabled={pending} className={button} style={{ border: '2px solid var(--brand)', color: '#1a1a1a', background: '#fff' }}>
        {pending ? 'Updating…' : 'Update my price'}
      </button>
    </form>
  );
}

export function PayForm({ slug, quoteId, total, payment }: { slug: string; quoteId: string; total: string; payment: 'test' | 'unavailable' }) {
  const [state, action, pending] = useActionState(purchase, idle);
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="quoteId" value={quoteId} />
      <Problem state={state} />
      <fieldset className="space-y-3">
        <legend className="text-lg font-semibold">Who is buying</legend>
        <label className="block">
          Your name
          <input name="purchaserName" required autoComplete="name" className={field} defaultValue={previous(state, 'purchaserName')} />
        </label>
        <label className="block">
          Email for your documents
          <input name="purchaserEmail" type="email" autoComplete="email" className={field} defaultValue={previous(state, 'purchaserEmail')} />
        </label>
      </fieldset>
      <label className="flex items-start gap-3">
        <input type="checkbox" name="acknowledge" className="mt-1 size-5" style={{ accentColor: 'var(--brand)' }} aria-describedby="ack-help" />
        <span>I have read the notice above.</span>
      </label>
      <label className="flex items-start gap-3">
        <input type="checkbox" name="able" className="mt-1 size-5" style={{ accentColor: 'var(--brand)' }} />
        <span>I am medically able to travel and am not under restricting treatment.</span>
      </label>
      {payment === 'test' ? (
        <div className="rounded-lg border border-[#b25e00] bg-[#fff4e5] p-3 text-[#4d2900]">
          <p className="font-semibold">Test payment</p>
          <p className="text-sm">This is a sandbox. No money is taken and no real policy is made.</p>
        </div>
      ) : (
        <div role="status" className="rounded-lg border border-[#6b7280] bg-[#f3f4f6] p-3">
          <p className="font-semibold">Online payment is not set up yet</p>
          <p className="text-sm">You can see your price and read the wording, but this page cannot take payment. Please contact the seller to buy.</p>
        </div>
      )}
      <p id="ack-help" className="sr-only">
        The notice is shown above the form.
      </p>
      {payment === 'test' ? (
        <button type="submit" disabled={pending} className={button} style={brandButton}>
          {pending ? 'Buying…' : `Pay $${Number(total).toLocaleString('en-US', { minimumFractionDigits: 2 })} (test)`}
        </button>
      ) : null}
    </form>
  );
}
