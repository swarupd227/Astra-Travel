'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import type { Quote } from '@astra/contracts';
import { api } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

const num = (v: string) => (v === '' ? undefined : Number(v));

/** The travellers on the form: each field repeats once per person, in order. */
function travellersFrom(form: FormData) {
  const column = (name: string) => form.getAll(name).map((v) => String(v).trim());
  const first = column('firstName');
  const last = column('lastName');
  const born = column('dateOfBirth');
  const age = column('age');
  const cost = column('costPerTraveller');
  return first.map((firstName, i) => ({
    firstName,
    lastName: last[i] ?? '',
    ...(born[i] ? { dateOfBirth: born[i] } : {}),
    ...(age[i] ? { age: Number(age[i]) } : {}),
    // A cost left blank for a companion is the same as the first traveller's.
    costPerTraveller: cost[i] || (cost[0] ?? ''),
  }));
}

/** Prices a trip for one or more travellers. */
export async function createQuote(_prev: ActionState, form: FormData): Promise<ActionState> {
  const country = text(form, 'destinationCountry').toUpperCase();
  const region = text(form, 'destinationRegion');
  let quote: Quote;
  try {
    quote = await api<Quote>('/v1/quotes', {
      method: 'POST',
      idempotencyKey: randomUUID(),
      body: {
        accountId: text(form, 'accountId'),
        planCode: text(form, 'planCode'),
        state: text(form, 'state').toUpperCase(),
        travellers: travellersFrom(form),
        trip: {
          ...(text(form, 'purchaseDate') ? { purchaseDate: text(form, 'purchaseDate') } : {}),
          ...(text(form, 'initialDepositDate')
            ? { initialDepositDate: text(form, 'initialDepositDate') }
            : {}),
          departureDate: text(form, 'departureDate'),
          returnDate: text(form, 'returnDate'),
          destinations:
            country || region
              ? [{ ...(country ? { country } : {}), ...(region ? { region } : {}) }]
              : [],
          ...(text(form, 'penaltyDays') ? { penaltyDays: num(text(form, 'penaltyDays')) } : {}),
        },
        insuredPercent: num(text(form, 'insuredPercent')) ?? 100,
        ...(text(form, 'businessSegment')
          ? { businessSegment: text(form, 'businessSegment') }
          : {}),
      },
    });
  } catch (err) {
    return fromError(err, form);
  }
  redirect(`/quotes/${quote.id}?created=1`);
}

/** Re-rates the same quote with the optional benefits ticked. */
export async function changeSelection(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'quoteId');
  const selection = form.getAll('selection').filter((v): v is string => typeof v === 'string');
  try {
    await api<Quote>(`/v1/quotes/${encodeURIComponent(id)}/selection`, {
      method: 'PUT',
      body: { selection },
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/quotes/${id}`);
  return { status: 'success', message: 'Re-rated. The quote keeps its number.' };
}

/**
 * Binds a quote on the traveller's behalf (E04-F03-S03): the payment system's reference and amount, the purchaser,
 * and the traveller's acknowledgement of the disclosure. The API checks all of it as for any caller, and the policy
 * records the staff user who issued it.
 */
export async function issuePolicy(_prev: ActionState, form: FormData): Promise<ActionState> {
  const quoteId = text(form, 'quoteId');
  let policyId: string;
  try {
    const policy = await api<{ id: string }>(`/v1/quotes/${encodeURIComponent(quoteId)}/bind`, {
      method: 'POST',
      idempotencyKey: text(form, 'key') || randomUUID(),
      body: {
        ableToTravel: form.get('able') === 'on',
        acknowledgement: {
          disclosureVersion: text(form, 'disclosureVersion'),
          acknowledgedBy: text(form, 'acknowledgedBy'),
        },
        payment: { reference: text(form, 'paymentReference'), amount: text(form, 'paymentAmount') },
        purchaser: {
          name: text(form, 'purchaserName'),
          ...(text(form, 'purchaserEmail') ? { email: text(form, 'purchaserEmail') } : {}),
        },
      },
    });
    policyId = policy.id;
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath('/policies');
  redirect(`/policies/${policyId}?issued=1`);
}
