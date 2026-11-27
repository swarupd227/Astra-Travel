'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { ServicingPreview, ServicingRequest, ServicingResult } from '@astra/contracts';
import { api } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

export type PreviewState = ActionState & { preview?: ServicingPreview; request?: ServicingRequest };

/** Builds the request the API expects from the servicing form; the API validates everything again. */
function requestFrom(form: FormData): ServicingRequest {
  const type = text(form, 'type');
  const reason = text(form, 'reason');
  const noLoss = form.get('noLoss') === 'on';
  switch (type) {
    case 'cancel':
      return { type, reason, noLoss };
    case 'change_dates':
      return {
        type,
        reason,
        departureDate: text(form, 'departureDate'),
        returnDate: text(form, 'returnDate'),
      };
    case 'change_cost':
      return {
        type,
        reason,
        costs: [
          {
            travellerId: text(form, 'travellerId'),
            costPerTraveller: text(form, 'costPerTraveller'),
          },
        ],
      };
    case 'add_traveller':
      return {
        type,
        reason,
        traveller: {
          firstName: text(form, 'firstName'),
          lastName: text(form, 'lastName'),
          ...(text(form, 'dateOfBirth') ? { dateOfBirth: text(form, 'dateOfBirth') } : {}),
          costPerTraveller: text(form, 'costPerTraveller'),
        },
      };
    case 'remove_traveller':
      return { type, reason, travellerId: text(form, 'travellerId'), noLoss };
    case 'change_destinations':
      return {
        type,
        reason,
        destinations: [
          {
            ...(text(form, 'country') ? { country: text(form, 'country').toUpperCase() } : {}),
            ...(text(form, 'region') ? { region: text(form, 'region') } : {}),
          },
        ],
      };
    case 'add_benefits':
      return { type, reason, benefits: [text(form, 'benefit')] };
    default: {
      const first = text(form, 'firstName');
      const last = text(form, 'lastName');
      const dob = text(form, 'dateOfBirth');
      const email = text(form, 'email');
      const name = text(form, 'purchaserName');
      return {
        type: 'correct',
        reason,
        travellers:
          first || last || dob
            ? [
                {
                  travellerId: text(form, 'travellerId'),
                  ...(first ? { firstName: first } : {}),
                  ...(last ? { lastName: last } : {}),
                  ...(dob ? { dateOfBirth: dob } : {}),
                },
              ]
            : [],
        ...(email || name
          ? { purchaser: { ...(name ? { name } : {}), ...(email ? { email } : {}) } }
          : {}),
        ...(text(form, 'supplier') ? { supplier: text(form, 'supplier') } : {}),
      };
    }
  }
}

/** Shows what the change would do and cost, without making it. */
export async function previewServicing(_prev: PreviewState, form: FormData): Promise<PreviewState> {
  const request = requestFrom(form);
  try {
    const preview = await api<ServicingPreview>(
      `/v1/policies/${encodeURIComponent(text(form, 'policyId'))}/servicing/preview`,
      { method: 'POST', body: request },
    );
    return {
      status: 'success',
      message: preview.allowed
        ? 'Check the change and the price, then confirm.'
        : 'This cannot be done.',
      preview,
      request,
    };
  } catch (err) {
    return fromError(err, form);
  }
}

/** Makes the change that was previewed, against the price that was shown. */
export async function applyServicing(_prev: ActionState, form: FormData): Promise<ActionState> {
  const policyId = text(form, 'policyId');
  let result: ServicingResult;
  try {
    result = await api<ServicingResult>(`/v1/policies/${encodeURIComponent(policyId)}/servicing`, {
      method: 'POST',
      body: {
        request: JSON.parse(text(form, 'request')),
        confirmAmount: text(form, 'confirmAmount'),
      },
      idempotencyKey: text(form, 'idempotencyKey') || randomUUID(),
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/policies/${policyId}`);
  redirect(`/policies/${policyId}?serviced=${result.type}`);
}
