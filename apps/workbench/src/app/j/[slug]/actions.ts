'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { fromError, text, type ActionState } from '@/lib/actions';
import { journeyApi, journeyConfig } from '@/lib/journey';

/** The traveller's trip becomes a quote through the same API as every other channel. */
export async function startQuote(_prev: ActionState, form: FormData): Promise<ActionState> {
  const slug = text(form, 'slug');
  const cfg = await journeyConfig(slug);
  if (!cfg)
    return { status: 'error', message: 'This page is not available.', fieldErrors: {}, values: {} };
  const plan = cfg.plans.find((p) => p.code === text(form, 'planCode'));
  if (!plan)
    return {
      status: 'error',
      message: 'Choose one of the plans.',
      fieldErrors: { planCode: 'Choose a plan' },
      values: {},
    };
  const travellers = [1, 2, 3, 4]
    .map((n) => ({
      firstName: text(form, `first${n}`),
      lastName: text(form, `last${n}`),
      dateOfBirth: text(form, `dob${n}`),
      costPerTraveller: text(form, `cost${n}`),
    }))
    .filter((t) => t.firstName || t.lastName || t.dateOfBirth || t.costPerTraveller);
  const country = text(form, 'country').toUpperCase();
  let quoteId: string;
  try {
    const q = await journeyApi<{ id: string }>(cfg, '/v1/quotes', {
      method: 'POST',
      body: {
        accountId: cfg.accountId,
        planCode: plan.code,
        state: plan.state,
        travellers: travellers.map((t) => ({ ...t, dateOfBirth: t.dateOfBirth || undefined })),
        trip: {
          departureDate: text(form, 'departureDate'),
          returnDate: text(form, 'returnDate'),
          destinations:
            country || text(form, 'region')
              ? [
                  {
                    ...(country ? { country } : {}),
                    ...(text(form, 'region') ? { region: text(form, 'region') } : {}),
                  },
                ]
              : [],
        },
      },
      idempotencyKey: randomUUID(),
    });
    quoteId = q.id;
  } catch (err) {
    return fromError(err, form);
  }
  redirect(`/j/${slug}/q/${quoteId}`);
}

/** Adds or removes optional benefits on the same quote; the price follows. */
export async function selectBenefits(_prev: ActionState, form: FormData): Promise<ActionState> {
  const slug = text(form, 'slug');
  const quoteId = text(form, 'quoteId');
  const cfg = await journeyConfig(slug);
  if (!cfg)
    return { status: 'error', message: 'This page is not available.', fieldErrors: {}, values: {} };
  try {
    await journeyApi(cfg, `/v1/quotes/${encodeURIComponent(quoteId)}/selection`, {
      method: 'PUT',
      body: { selection: form.getAll('benefit').filter((v): v is string => typeof v === 'string') },
    });
  } catch (err) {
    return fromError(err, form);
  }
  redirect(`/j/${slug}/q/${quoteId}?updated=1`);
}

/** Buys the cover. Only a sandbox journey can complete: its payment is a labelled test payment. */
export async function purchase(_prev: ActionState, form: FormData): Promise<ActionState> {
  const slug = text(form, 'slug');
  const quoteId = text(form, 'quoteId');
  const cfg = await journeyConfig(slug);
  if (!cfg)
    return { status: 'error', message: 'This page is not available.', fieldErrors: {}, values: {} };
  if (cfg.payment !== 'test')
    return {
      status: 'error',
      message:
        'Online payment is not set up for this page yet, so the purchase cannot be completed here.',
      fieldErrors: {},
      values: {},
    };
  let policyId: string;
  try {
    const q = await journeyApi<{
      premium: { total: string } | null;
      disclosure: { version: string } | null;
    }>(cfg, `/v1/quotes/${encodeURIComponent(quoteId)}`);
    if (!q.premium || !q.disclosure)
      return {
        status: 'error',
        message: 'This quote cannot be bought as it stands.',
        fieldErrors: {},
        values: {},
      };
    if (form.get('acknowledge') !== 'on')
      return {
        status: 'error',
        message: 'Please confirm you have read the notice.',
        fieldErrors: { acknowledge: 'Confirm that you have read the notice' },
        values: {},
      };
    if (form.get('able') !== 'on')
      return {
        status: 'error',
        message: 'Please confirm you are able to travel.',
        fieldErrors: { able: 'Confirm that you are able to travel' },
        values: {},
      };
    const policy = await journeyApi<{ id: string }>(
      cfg,
      `/v1/quotes/${encodeURIComponent(quoteId)}/bind`,
      {
        method: 'POST',
        idempotencyKey: `journey-${quoteId}`,
        body: {
          ableToTravel: true,
          acknowledgement: {
            disclosureVersion: q.disclosure.version,
            acknowledgedBy: text(form, 'purchaserName'),
          },
          // A labelled test payment: it is accepted only for a sandbox account, whose policies are never billed.
          payment: { reference: `TEST-${quoteId.slice(0, 8)}`, amount: q.premium.total },
          purchaser: {
            name: text(form, 'purchaserName'),
            ...(text(form, 'purchaserEmail') ? { email: text(form, 'purchaserEmail') } : {}),
          },
        },
      },
    );
    policyId = policy.id;
  } catch (err) {
    return fromError(err, form);
  }
  redirect(`/j/${slug}/done/${policyId}`);
}
