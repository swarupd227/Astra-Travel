'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

export async function saveChannels(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'accountId');
  const name = text(form, 'displayName');
  const body = {
    branding: name ? { displayName: name, logoUrl: text(form, 'logoUrl') || null, primaryColor: text(form, 'primaryColor'), textOnPrimary: text(form, 'textOnPrimary') } : null,
    widget: { enabled: form.get('widgetEnabled') === 'on', allowedOrigins: text(form, 'origins').split(/[\s,]+/).filter(Boolean) },
    journey: { enabled: form.get('journeyEnabled') === 'on', slug: text(form, 'slug') || null, planCodes: text(form, 'planCodes').split(/[\s,]+/).map((c) => c.toUpperCase()).filter(Boolean), headline: text(form, 'headline') },
  };
  try {
    await api(`/v1/accounts/${id}/channels`, { method: 'PUT', body, idempotencyKey: randomUUID() });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/accounts/${id}/channels`);
  return { status: 'success', message: 'Saved.' };
}
