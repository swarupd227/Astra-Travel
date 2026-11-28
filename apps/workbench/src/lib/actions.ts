import type { FieldError } from '@astra/contracts';
import { ApiProblem } from './api-problem';
import { plainMessage } from './plain-errors';

/** Result of a server action, rendered by forms with useActionState. */
export type ActionState =
  | { status: 'idle' }
  | { status: 'success'; message: string; data?: Record<string, string> }
  | {
      status: 'error';
      message: string;
      fieldErrors: Record<string, string>;
      correlationId?: string;
      /** What the user submitted, so the form can be re-filled (React resets forms after an action). */
      values: Record<string, string[]>;
    };

export const idle: ActionState = { status: 'idle' };

function submittedValues(form?: FormData): Record<string, string[]> {
  const values: Record<string, string[]> = {};
  if (!form) return values;
  for (const [key, value] of form.entries()) {
    if (typeof value !== 'string' || key.startsWith('$ACTION')) continue;
    (values[key] ??= []).push(value);
  }
  return values;
}

export function fromError(err: unknown, form?: FormData): ActionState {
  const values = submittedValues(form);
  if (err instanceof ApiProblem) {
    const fieldErrors: Record<string, string> = {};
    for (const e of err.problem.errors ?? ([] as FieldError[]))
      fieldErrors[e.field] = plainMessage(e.message);
    return {
      status: 'error',
      message: plainMessage(err.problem.detail ?? err.problem.title),
      fieldErrors,
      correlationId: err.problem.correlationId,
      values,
    };
  }
  // Re-throw Next.js control-flow errors (redirect, notFound).
  if (err && typeof err === 'object' && 'digest' in err) throw err;
  return {
    status: 'error',
    message: 'Something went wrong. Please try again.',
    fieldErrors: {},
    values,
  };
}

/** The value a field had when the last submission failed, for `defaultValue`. */
export function previous(state: ActionState, name: string): string | undefined {
  return state.status === 'error' ? state.values[name]?.[0] : undefined;
}

/** All values of a multi-value field (checkboxes) from the last failed submission. */
export function previousAll(state: ActionState, name: string): string[] {
  return state.status === 'error' ? (state.values[name] ?? []) : [];
}

export function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
}
