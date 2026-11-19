'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { Account } from '@astra/contracts';
import { api } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

export async function createAccount(_prev: ActionState, form: FormData): Promise<ActionState> {
  let account: Account;
  try {
    account = await api<Account>('/v1/accounts', {
      method: 'POST',
      idempotencyKey: text(form, 'idempotencyKey'),
      body: {
        code: text(form, 'code').toUpperCase(),
        name: text(form, 'name'),
        kind: text(form, 'kind'),
      },
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath('/accounts');
  redirect(`/accounts/${account.id}?created=1`);
}

export async function changeAccountStatus(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const accountId = text(form, 'accountId');
  try {
    const account = await api<Account>(`/v1/accounts/${encodeURIComponent(accountId)}/status`, {
      method: 'POST',
      body: { status: text(form, 'status'), reason: text(form, 'reason') },
    });
    revalidatePath(`/accounts/${accountId}`);
    revalidatePath('/accounts');
    return { status: 'success', message: `The account is now ${account.status}.` };
  } catch (err) {
    return fromError(err, form);
  }
}
