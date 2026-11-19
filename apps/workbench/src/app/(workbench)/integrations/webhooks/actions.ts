'use server';

import { revalidatePath } from 'next/cache';
import type { WebhookSubscription } from '@astra/contracts';
import { api } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

export async function createWebhook(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const created = await api<WebhookSubscription & { signingSecret: string }>(
      '/v1/webhook-subscriptions',
      {
        method: 'POST',
        idempotencyKey: text(form, 'idempotencyKey'),
        body: {
          accountId: text(form, 'accountId'),
          url: text(form, 'url'),
          eventTypes: form.getAll('eventTypes').map(String),
          description: text(form, 'description') || undefined,
        },
      },
    );
    revalidatePath('/integrations/webhooks');
    return {
      status: 'success',
      message: 'Subscription created.',
      data: { id: created.id, signingSecret: created.signingSecret },
    };
  } catch (err) {
    return fromError(err, form);
  }
}

export async function setWebhookStatus(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'subscriptionId');
  const status = text(form, 'status');
  try {
    if (status === 'disabled') {
      await api(`/v1/webhook-subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } else {
      await api(`/v1/webhook-subscriptions/${encodeURIComponent(id)}/status`, {
        method: 'POST',
        body: { status },
      });
    }
    revalidatePath('/integrations/webhooks');
    return { status: 'success', message: 'Updated.' };
  } catch (err) {
    return fromError(err, form);
  }
}
