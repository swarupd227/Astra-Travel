'use server';

import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

export async function replayDeliveries(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const result = await api<{ replayed: number }>('/v1/event-deliveries/replay', {
      method: 'POST',
      body: {
        eventId: text(form, 'eventId') || undefined,
        subscriber: text(form, 'subscriber') || undefined,
        reason: text(form, 'reason'),
      },
    });
    revalidatePath('/operations/events');
    return {
      status: 'success',
      message:
        result.replayed === 1
          ? '1 delivery was queued again.'
          : `${result.replayed} deliveries were queued again.`,
    };
  } catch (err) {
    return fromError(err, form);
  }
}
