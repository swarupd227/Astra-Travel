'use client';

import { useActionState } from 'react';
import { ShieldCheck, ShieldX } from 'lucide-react';
import { SubmitButton } from '@/components/ui/form';
import { verifyAuditTrail, type VerifyState } from './actions';

export function VerifyAudit() {
  const [state, action] = useActionState(verifyAuditTrail, { status: 'idle' } as VerifyState);
  return (
    <div className="flex flex-col items-end gap-2">
      <form action={action}>
        <SubmitButton variant="secondary" pendingLabel="Verifying…">
          <ShieldCheck aria-hidden className="size-4" /> Verify integrity
        </SubmitButton>
      </form>
      {state.status === 'done' ? (
        <p
          role="status"
          className={`flex items-center gap-1.5 text-sm ${state.ok ? 'text-success' : 'text-danger'}`}
        >
          {state.ok ? (
            <ShieldCheck aria-hidden className="size-4" />
          ) : (
            <ShieldX aria-hidden className="size-4" />
          )}
          {state.message}
        </p>
      ) : null}
      {state.status === 'error' ? (
        <p role="alert" className="text-sm text-danger">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
