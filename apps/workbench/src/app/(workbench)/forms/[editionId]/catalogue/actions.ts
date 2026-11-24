'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { BenefitCatalogue } from '@astra/contracts';
import { api } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

const SECTIONS = {
  benefits: 'benefits',
  coveredReasons: 'covered-reasons',
  upgrades: 'upgrades',
} as const;

export async function startCatalogue(_prev: ActionState, form: FormData): Promise<ActionState> {
  const editionId = text(form, 'editionId');
  const policy = text(form, 'policyEditionId');
  try {
    await api<BenefitCatalogue>(`/v1/form-editions/${encodeURIComponent(editionId)}/catalogues`, {
      method: 'POST',
      body: { policyEditionId: policy || null },
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/forms/${editionId}/catalogue`);
  return { status: 'success', message: 'Draft started.' };
}

/** The editor sends the item as JSON; the API validates it against the schema and the variable maps. */
export async function saveItem(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'catalogueId');
  const editionId = text(form, 'editionId');
  const section = text(form, 'section') as keyof typeof SECTIONS;
  let item: { code: string };
  try {
    item = JSON.parse(String(form.get('payload') ?? '')) as { code: string };
  } catch {
    return { status: 'error', message: 'The item could not be read.', fieldErrors: {}, values: {} };
  }
  try {
    await api<BenefitCatalogue>(
      `/v1/benefit-catalogues/${encodeURIComponent(id)}/${SECTIONS[section]}/${encodeURIComponent(item.code)}`,
      {
        method: 'PUT',
        body: item,
      },
    );
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/forms/${editionId}/catalogue`);
  return { status: 'success', message: `Saved ${item.code}.` };
}

export async function removeItem(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'catalogueId');
  const editionId = text(form, 'editionId');
  const section = text(form, 'section') as keyof typeof SECTIONS;
  try {
    await api<BenefitCatalogue>(
      `/v1/benefit-catalogues/${encodeURIComponent(id)}/${SECTIONS[section]}/${encodeURIComponent(text(form, 'code'))}`,
      {
        method: 'DELETE',
      },
    );
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/forms/${editionId}/catalogue`);
  return { status: 'success', message: 'Removed.' };
}

export async function approveCatalogue(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'catalogueId');
  const editionId = text(form, 'editionId');
  try {
    await api<BenefitCatalogue>(`/v1/benefit-catalogues/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      body: { note: text(form, 'note') },
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/forms/${editionId}/catalogue`);
  redirect(`/forms/${editionId}/catalogue?approved=1`);
}

export async function discardCatalogue(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'catalogueId');
  const editionId = text(form, 'editionId');
  try {
    await api<null>(`/v1/benefit-catalogues/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/forms/${editionId}/catalogue`);
  return { status: 'success', message: 'Draft discarded.' };
}
