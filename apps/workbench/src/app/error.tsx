'use client';

import { useEffect } from 'react';
import { CloudOff } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Shown when a workbench page fails to render, most often because the platform API is unreachable.
 * The digest lets support find the server-side log entry.
 */
export default function WorkbenchError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div
        role="alert"
        className="max-w-md rounded-2xl border border-border bg-surface p-8 text-center shadow-card"
      >
        <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-full bg-surface-muted text-muted">
          <CloudOff aria-hidden className="size-5" />
        </div>
        <h1 className="text-lg font-semibold text-fg">This page couldn’t load</h1>
        <p className="mt-2 text-sm text-muted">
          The platform didn’t respond. Nothing you entered was lost. Try again in a moment; if it
          keeps happening, contact support with the reference below.
        </p>
        {error.digest ? (
          <p className="mt-3 font-mono text-xs text-subtle">Reference: {error.digest}</p>
        ) : null}
        <Button className="mt-6" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  );
}
