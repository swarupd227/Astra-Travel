import { CloudOff } from 'lucide-react';
import { ApiProblem } from '@/lib/api';
import { Card, EmptyState } from './ui/primitives';

/** Shown when the API cannot answer a page's query. */
export function ErrorPanel({ error }: { error: unknown }) {
  const problem = error instanceof ApiProblem ? error.problem : null;
  return (
    <Card>
      <EmptyState
        icon={<CloudOff className="size-5" />}
        title={problem?.title ?? 'This information could not be loaded'}
        description={
          <>
            {problem?.detail ?? 'Please try again in a moment.'}
            {problem?.correlationId ? (
              <span className="mt-2 block text-xs text-subtle">
                Reference: {problem.correlationId}
              </span>
            ) : null}
          </>
        }
      />
    </Card>
  );
}

/** Runs a loader, returning its data or the error to render. Next.js control-flow errors propagate. */
export async function load<T>(
  fn: () => Promise<T>,
): Promise<{ data: T; error: null } | { data: null; error: object }> {
  try {
    return { data: await fn(), error: null };
  } catch (error) {
    if (error && typeof error === 'object' && 'digest' in error) throw error;
    return { data: null, error: error instanceof Object ? error : new Error(String(error)) };
  }
}
