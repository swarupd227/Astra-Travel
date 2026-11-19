'use server';

import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

export async function setFlag(_prev: ActionState, form: FormData): Promise<ActionState> {
  const key = text(form, 'key');
  const accountId = text(form, 'accountId');
  const value = text(form, 'enabled');
  const reason = text(form, 'reason');
  try {
    if (accountId) {
      await api(`/v1/feature-flags/${encodeURIComponent(key)}/overrides`, {
        method: 'POST',
        body: { accountId, enabled: value === 'inherit' ? null : value === 'true', reason },
      });
    } else {
      await api(`/v1/feature-flags/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: { enabled: value === 'true', reason },
      });
    }
    revalidatePath('/admin/flags');
    return {
      status: 'success',
      message: 'Saved. The change applies across the platform within a few seconds.',
    };
  } catch (err) {
    return fromError(err, form);
  }
}
