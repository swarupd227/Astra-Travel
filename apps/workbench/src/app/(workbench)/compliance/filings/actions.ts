'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { Filing } from '@astra/contracts';
import { api } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

const states = (value: string) => [
  ...new Set(
    value
      .toUpperCase()
      .split(/[\s,;]+/)
      .filter(Boolean),
  ),
];

export async function recordFiling(_prev: ActionState, form: FormData): Promise<ActionState> {
  const itemType = text(form, 'itemType');
  let created: { items: Filing[] };
  try {
    created = await api<{ items: Filing[] }>('/v1/filings', {
      method: 'POST',
      idempotencyKey: text(form, 'idempotencyKey'),
      body: {
        states: states(text(form, 'states')),
        insurer: text(form, 'insurer'),
        itemType,
        ...(itemType === 'form_edition'
          ? { itemId: text(form, 'itemId') }
          : { itemReference: text(form, 'itemReference') }),
        ...(text(form, 'serffTracking') ? { serffTracking: text(form, 'serffTracking') } : {}),
        ...(text(form, 'notes') ? { notes: text(form, 'notes') } : {}),
      },
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath('/compliance/filings');
  if (created.items.length === 1) redirect(`/compliance/filings/${created.items[0]!.id}?created=1`);
  redirect(
    `/compliance/filings?q=${encodeURIComponent(created.items[0]!.itemReference)}&created=${created.items.length}`,
  );
}

export async function changeFilingStatus(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'filingId');
  const status = text(form, 'status');
  try {
    await api<Filing>(`/v1/filings/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      body: {
        status,
        on: text(form, 'on'),
        reason: text(form, 'reason'),
        ...(status === 'approved'
          ? {
              effectiveFrom: text(form, 'effectiveFrom'),
              effectiveTo: text(form, 'effectiveTo') || null,
            }
          : {}),
        ...(text(form, 'serffTracking') ? { serffTracking: text(form, 'serffTracking') } : {}),
      },
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/compliance/filings/${id}`);
  revalidatePath('/compliance/filings');
  redirect(`/compliance/filings/${id}?changed=${status}`);
}
