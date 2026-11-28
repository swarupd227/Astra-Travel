'use client';

import clsx from 'clsx';
import { useId, type ComponentProps, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { buttonClass } from './button';
import type { ActionState } from '@/lib/actions';

const control =
  'block w-full rounded-lg border border-border-strong bg-surface px-3 text-sm text-fg shadow-card ' +
  'placeholder:text-subtle focus:border-primary focus:outline-2 focus:outline-offset-0 focus:outline-primary/30 ' +
  'aria-[invalid=true]:border-danger disabled:opacity-60';

interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

export function Field({ label, hint, error, required, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-fg">
        {label}
        {required ? (
          <span className="ml-0.5 text-danger" aria-hidden>
            {' '}
            *
          </span>
        ) : null}
      </label>
      {children({ id, describedBy, invalid: !!error })}
      {hint ? (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={clsx(control, 'h-10', className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={clsx(control, 'h-10 pr-8', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={clsx(control, 'min-h-20 py-2', className)} {...props} />;
}

export function SubmitButton({
  children,
  variant = 'primary',
  pendingLabel,
  className,
  disabled = false,
  size = 'md',
  'aria-label': ariaLabel,
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  pendingLabel?: string;
  className?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  'aria-label'?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      aria-disabled={pending || disabled}
      aria-label={ariaLabel}
      className={buttonClass(variant, size, className)}
    >
      {pending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
      {pending ? (pendingLabel ?? 'Saving…') : children}
    </button>
  );
}

export function FormMessage({ state }: { state: ActionState }) {
  if (state.status === 'idle') return null;
  if (state.status === 'success') {
    return (
      <p role="status" className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">
        {state.message}
      </p>
    );
  }
  return (
    <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
      <p className="font-medium">{state.message}</p>
      {state.correlationId ? (
        <p className="mt-0.5 text-xs">Reference: {state.correlationId}</p>
      ) : null}
    </div>
  );
}
