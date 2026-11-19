import clsx from 'clsx';
import type { ComponentProps, ReactNode } from 'react';

export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

const toneClass: Record<Tone, string> = {
  neutral: 'bg-surface-muted text-muted ring-border',
  primary: 'bg-primary-soft text-primary ring-primary/20',
  success: 'bg-success-soft text-success ring-success/20',
  warning: 'bg-warning-soft text-warning ring-warning/25',
  danger: 'bg-danger-soft text-danger ring-danger/20',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        toneClass[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusDot({ tone }: { tone: Tone }) {
  const color: Record<Tone, string> = {
    neutral: 'bg-subtle',
    primary: 'bg-primary',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
  };
  return <span aria-hidden className={clsx('size-1.5 rounded-full', color[tone])} />;
}

export function Card({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      className={clsx('rounded-xl border border-border bg-surface shadow-card', className)}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  actions,
  titleId,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  titleId?: string;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
      <div className="min-w-0">
        <h2 id={titleId} className="text-[15px] font-semibold text-fg">
          {title}
        </h2>
        {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 max-w-3xl">
        {eyebrow ? (
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-accent">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
        {description ? <p className="mt-1.5 text-sm leading-6 text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon ? (
        <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-surface-muted text-muted">
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-semibold text-fg">{title}</p>
      {description ? <p className="mt-1 max-w-md text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Notice({
  tone = 'primary',
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  const styles: Record<Tone, string> = {
    neutral: 'border-border bg-surface-muted text-fg',
    primary: 'border-primary/25 bg-primary-soft text-fg',
    success: 'border-success/25 bg-success-soft text-fg',
    warning: 'border-warning/30 bg-warning-soft text-fg',
    danger: 'border-danger/25 bg-danger-soft text-fg',
  };
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={clsx('rounded-lg border px-4 py-3 text-sm', styles[tone])}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      <div className={clsx(title && 'mt-0.5', 'text-muted [&_strong]:text-fg')}>{children}</div>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-md border border-border bg-surface-muted px-1.5 py-0.5 font-mono text-[12px] text-fg">
      {children}
    </code>
  );
}

export function DescriptionList({ items }: { items: { term: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
      {items.map((i) => (
        <div key={i.term} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-subtle">{i.term}</dt>
          <dd className="mt-1 break-words text-sm text-fg">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}
