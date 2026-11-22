'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { FormEdition, VariableMap } from '@astra/contracts';
import { api, apiUpload } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

const MAX_BYTES = 25 * 1024 * 1024;

export async function loadEdition(_prev: ActionState, form: FormData): Promise<ActionState> {
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return {
      status: 'error',
      message: 'Choose the filed document.',
      fieldErrors: { file: 'Choose a file' },
      values: {},
    };
  }
  if (file.size > MAX_BYTES) {
    return {
      status: 'error',
      message: 'Form documents are limited to 25 MB.',
      fieldErrors: { file: 'Too large' },
      values: {},
    };
  }
  const contentType =
    file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
      ? 'application/pdf'
      : 'text/plain';
  let edition: FormEdition;
  try {
    const res = await apiUpload<FormEdition>(
      '/v1/form-editions',
      file,
      {
        formNumber: text(form, 'formNumber'),
        edition: text(form, 'edition'),
        title: text(form, 'title'),
        kind: text(form, 'kind'),
        insurer: text(form, 'insurer'),
        fileName: file.name.replace(/[^A-Za-z0-9 ._()-]/g, '_').slice(0, 200) || 'form',
      },
      contentType,
    );
    edition = res.body;
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath('/forms');
  redirect(`/forms/${edition.id}?loaded=1`);
}

export async function startMap(_prev: ActionState, form: FormData): Promise<ActionState> {
  const editionId = text(form, 'editionId');
  try {
    await api<VariableMap>(`/v1/form-editions/${encodeURIComponent(editionId)}/maps`, {
      method: 'POST',
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/forms/${editionId}`);
  return { status: 'success', message: 'Draft started.' };
}

function constraintsFrom(form: FormData, type: string): Record<string, unknown> {
  const num = (name: string) => Number(text(form, name));
  const list = (name: string) =>
    text(form, name)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  switch (type) {
    case 'numeric_range':
      return { min: num('min'), max: num('max'), unit: text(form, 'unit') || 'usd' };
    case 'percentage_range':
      return { min: num('min'), max: num('max'), bases: list('bases') };
    case 'time_period':
      return { min: num('min'), max: num('max'), unit: text(form, 'periodUnit') || 'days' };
    case 'wording_choice':
      return { options: list('options'), multiple: form.get('multiple') === 'on' };
    case 'limit_basis':
      return { options: list('options') };
    case 'insert_placeholder':
      return text(form, 'source') === 'dataset'
        ? { source: 'dataset', dataset: text(form, 'dataset') }
        : { source: text(form, 'source') };
    default:
      return {};
  }
}

export async function saveVariable(_prev: ActionState, form: FormData): Promise<ActionState> {
  const mapId = text(form, 'mapId');
  const editionId = text(form, 'editionId');
  const key = text(form, 'key');
  const type = text(form, 'type');
  try {
    await api<VariableMap>(
      `/v1/variable-maps/${encodeURIComponent(mapId)}/variables/${encodeURIComponent(key)}`,
      {
        method: 'PUT',
        body: {
          key,
          label: text(form, 'label'),
          type,
          constraints: constraintsFrom(form, type),
          textStart: Number(text(form, 'textStart')),
          textEnd: Number(text(form, 'textEnd')),
          excerpt: String(form.get('excerpt') ?? ''),
          ...(text(form, 'notes') ? { notes: text(form, 'notes') } : {}),
        },
      },
    );
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/forms/${editionId}`);
  return { status: 'success', message: `Saved ${key}.` };
}

export async function removeVariable(_prev: ActionState, form: FormData): Promise<ActionState> {
  const mapId = text(form, 'mapId');
  const editionId = text(form, 'editionId');
  try {
    await api<VariableMap>(
      `/v1/variable-maps/${encodeURIComponent(mapId)}/variables/${encodeURIComponent(text(form, 'key'))}`,
      { method: 'DELETE' },
    );
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/forms/${editionId}`);
  return { status: 'success', message: 'Removed.' };
}

export async function approveMap(_prev: ActionState, form: FormData): Promise<ActionState> {
  const mapId = text(form, 'mapId');
  const editionId = text(form, 'editionId');
  try {
    await api<VariableMap>(`/v1/variable-maps/${encodeURIComponent(mapId)}/approve`, {
      method: 'POST',
      body: { note: text(form, 'note') },
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/forms/${editionId}`);
  redirect(`/forms/${editionId}?approved=1`);
}

export async function discardMap(_prev: ActionState, form: FormData): Promise<ActionState> {
  const mapId = text(form, 'mapId');
  const editionId = text(form, 'editionId');
  try {
    await api<null>(`/v1/variable-maps/${encodeURIComponent(mapId)}`, { method: 'DELETE' });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/forms/${editionId}`);
  return { status: 'success', message: 'Draft discarded.' };
}

export type UsabilityState = ActionState & { answer?: { usable: boolean; reason: string } };

export async function checkUsability(
  _prev: UsabilityState,
  form: FormData,
): Promise<UsabilityState> {
  const editionId = text(form, 'editionId');
  try {
    const answer = await api<{ usable: boolean; reason: string }>(
      `/v1/form-editions/${encodeURIComponent(editionId)}/usability`,
      {
        query: { state: text(form, 'state').toUpperCase(), date: text(form, 'date') },
      },
    );
    const values: Record<string, string[]> = {
      state: [text(form, 'state').toUpperCase()],
      date: [text(form, 'date')],
    };
    return {
      status: 'success',
      message: answer.usable ? 'Usable' : 'Not usable',
      answer,
      data: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v[0]!])),
    };
  } catch (err) {
    return fromError(err, form);
  }
}
