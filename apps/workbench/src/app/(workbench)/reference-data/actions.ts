'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { RefdataVersion } from '@astra/contracts';
import { api, apiUpload } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

const MAX_CSV_BYTES = 30 * 1024 * 1024;

export async function loadVersion(_prev: ActionState, form: FormData): Promise<ActionState> {
  const dataset = text(form, 'dataset');
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return {
      status: 'error',
      message: 'Choose a CSV file.',
      fieldErrors: { file: 'Choose a file' },
      values: {},
    };
  }
  if (file.size > MAX_CSV_BYTES) {
    return {
      status: 'error',
      message: 'The file is larger than 30 MB.',
      fieldErrors: { file: 'Too large' },
      values: {},
    };
  }
  let version: RefdataVersion;
  try {
    const res = await apiUpload<RefdataVersion>(
      `/v1/reference-data/${encodeURIComponent(dataset)}/versions/csv`,
      file,
      {
        effectiveFrom: text(form, 'effectiveFrom'),
        source: text(form, 'source'),
        ...(text(form, 'notes') ? { notes: text(form, 'notes') } : {}),
      },
      'text/csv',
    );
    version = res.body;
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/reference-data/${dataset}`);
  redirect(`/reference-data/${dataset}/versions/${version.id}?loaded=1`);
}

export async function decideVersion(_prev: ActionState, form: FormData): Promise<ActionState> {
  const dataset = text(form, 'dataset');
  const versionId = text(form, 'versionId');
  const decision = text(form, 'decision');
  try {
    await api<RefdataVersion>(
      `/v1/reference-data/${encodeURIComponent(dataset)}/versions/${encodeURIComponent(versionId)}/decision`,
      {
        method: 'POST',
        body: { decision, reason: text(form, 'reason') },
      },
    );
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath('/reference-data');
  revalidatePath(`/reference-data/${dataset}`);
  redirect(
    `/reference-data/${dataset}/versions/${versionId}?decided=${decision === 'approve' ? 'approved' : 'rejected'}`,
  );
}
