'use server';

import { revalidatePath } from 'next/cache';
import type { ModelConnectionTest } from '@astra/contracts';
import { api } from '@/lib/api';
import { fromError, type ActionState } from '@/lib/actions';

/*
 * The key is passed to the API and nowhere else: it is never put in the result (so a failed save does not send it
 * back to the browser), and server function logging is off (next.config.ts).
 */

const PAGE = '/admin/model';

export async function saveModelKey(apiKey: string, reason: string): Promise<ActionState> {
  try {
    await api('/v1/settings/model-connection/key', { method: 'PUT', body: { apiKey, reason } });
    revalidatePath(PAGE);
    return {
      status: 'success',
      message: 'Saved. Agents use this key from their next request.',
    };
  } catch (err) {
    return fromError(err);
  }
}

export async function testModelKey(
  apiKey: string,
): Promise<{ test: ModelConnectionTest } | { error: ActionState }> {
  try {
    const test = await api<ModelConnectionTest>('/v1/settings/model-connection/test', {
      method: 'POST',
      body: apiKey ? { apiKey } : {},
    });
    revalidatePath(PAGE);
    return { test };
  } catch (err) {
    return { error: fromError(err) };
  }
}

export async function removeModelKey(_prev: ActionState, form: FormData): Promise<ActionState> {
  const reason = form.get('reason');
  try {
    await api('/v1/settings/model-connection/key/removal', {
      method: 'POST',
      body: { reason: typeof reason === 'string' ? reason.trim() : '' },
    });
    revalidatePath(PAGE);
    return { status: 'success', message: 'Removed. The saved key has been erased.' };
  } catch (err) {
    return fromError(err, form);
  }
}
