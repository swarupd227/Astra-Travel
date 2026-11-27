'use server';

import { revalidatePath } from 'next/cache';
import type { Readiness } from '@astra/contracts';
import { api } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

export async function signLaunch(_prev: ActionState, form: FormData): Promise<ActionState> {
  const decision = text(form, 'decision');
  try {
    const r = await api<Readiness>('/v1/launch-readiness/signoffs', {
      method: 'POST',
      body: { states: text(form, 'states').split(',').filter(Boolean), area: text(form, 'area'), decision, reportHash: text(form, 'reportHash'), note: text(form, 'note') },
    });
    revalidatePath('/compliance/launch');
    return { status: 'success', message: decision === 'signed' ? (r.goLiveApproved ? 'Signed. All four areas have now signed.' : 'Signed.') : 'Your signature is withdrawn.' };
  } catch (err) {
    return fromError(err, form);
  }
}
