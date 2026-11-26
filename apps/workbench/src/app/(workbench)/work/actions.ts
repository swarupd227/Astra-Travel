'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { TASK_SOURCES, type TaskSource } from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';

/** Taking, handing back and assigning work, and the timers. Each one goes back to the queue with what happened. */

const source = (form: FormData): TaskSource => {
  const v = String(form.get('sourceType') ?? '');
  if (!(TASK_SOURCES as readonly string[]).includes(v)) redirect('/work');
  return v as TaskSource;
};
const id = (form: FormData): string => {
  const v = String(form.get('sourceId') ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(v)) redirect('/work');
  return v;
};
const back = (qs: Record<string, string>) => redirect(`/work?${new URLSearchParams(qs).toString()}`);

async function assign(form: FormData, owner: string | null, ownerName?: string | null) {
  const sourceType = source(form);
  const sourceId = id(form);
  try {
    await api(`/v1/tasks/${sourceType}/${sourceId}/assignment`, { method: 'PUT', body: { owner, ...(ownerName ? { ownerName } : {}) } });
  } catch (err) {
    if (err instanceof ApiProblem) return back({ error: err.problem.detail ?? err.problem.title });
    throw err;
  }
  revalidatePath('/work');
  return back({ done: owner === null ? 'handed back' : 'assigned' });
}

export async function takeTask(form: FormData) {
  const me = await getMe();
  if (!me) redirect('/api/auth/login');
  return assign(form, me.subject, me.name);
}

export async function handBack(form: FormData) {
  return assign(form, null);
}

export async function assignTask(form: FormData) {
  const owner = String(form.get('owner') ?? '').trim();
  if (!owner) return back({ error: 'Choose who should take it.' });
  return assign(form, owner);
}

export async function saveSla(form: FormData) {
  const sourceType = source(form);
  try {
    await api(`/v1/task-sla/${sourceType}`, { method: 'PUT', body: { priority: String(form.get('priority') ?? ''), targetHours: Number(form.get('targetHours')) } });
  } catch (err) {
    if (err instanceof ApiProblem) return back({ error: err.problem.detail ?? err.problem.title });
    throw err;
  }
  revalidatePath('/work');
  return back({ done: 'timer saved' });
}
