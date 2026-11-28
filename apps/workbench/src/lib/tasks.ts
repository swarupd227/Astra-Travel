import type { Task } from '@astra/contracts';
import { plainReason } from './plain-errors';

/** Event names, such as "account.registered". */
const EVENT_NAME = /\b([a-z]+(?:_[a-z]+)*)\.([a-z]+(?:_[a-z]+)*)(?:\.v\d+)?$/;

/** A task's title and summary in words for the person doing the work. */
export function taskWords(task: Pick<Task, 'sourceType' | 'title' | 'summary'>) {
  let title = task.title;
  if (task.sourceType === 'event_delivery') {
    title = title.replace(EVENT_NAME, (_, subject: string, verb: string) =>
      `${subject} ${verb}`.replace(/_/g, ' '),
    );
  }
  return { title, summary: plainReason(task.summary) };
}

export const TIMER_TONES = {
  overdue: 'danger',
  at_risk: 'warning',
  on_track: 'neutral',
} as const;
