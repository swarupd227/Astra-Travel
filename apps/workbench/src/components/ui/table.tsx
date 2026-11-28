import clsx from 'clsx';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { StackTable } from './stack-table';

/** Accessible data table: captioned, stacked into records on a phone, scrollable when it cannot be. */
export function Table({
  caption,
  children,
  className,
}: {
  caption: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      // Positioned, so hidden text inside wide tables cannot stretch the page on a phone.
      className={clsx('relative overflow-x-auto', className)}
      role="region"
      aria-label={caption}
      tabIndex={0}
    >
      <StackTable caption={caption}>{children}</StackTable>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="border-b border-border bg-surface-muted/60 text-xs text-muted">
      {children}
    </thead>
  );
}

export function TH({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      scope="col"
      className={clsx('whitespace-nowrap px-4 py-2.5 font-medium', className)}
      {...props}
    />
  );
}

export function TR({ className, ...props }: ComponentProps<'tr'>) {
  return (
    <tr
      className={clsx('border-b border-border last:border-0 hover:bg-surface-muted/50', className)}
      {...props}
    />
  );
}

export function TD({ className, ...props }: ComponentProps<'td'>) {
  return <td className={clsx('px-4 py-3 align-top text-fg', className)} {...props} />;
}

export function Pager({
  nextHref,
  firstHref,
  count,
}: {
  nextHref: string | null;
  firstHref: string | null;
  count: number;
}) {
  return (
    <nav
      aria-label="Pagination"
      className="flex items-center justify-between border-t border-border px-4 py-3 text-sm text-muted"
    >
      <span>
        {count} {count === 1 ? 'row' : 'rows'} on this page
      </span>
      <div className="flex items-center gap-4">
        {firstHref ? (
          <Link className="font-medium text-primary hover:underline" href={firstHref}>
            Back to first page
          </Link>
        ) : null}
        {nextHref ? (
          <Link
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            href={nextHref}
          >
            Next page <ChevronRight aria-hidden className="size-4" />
          </Link>
        ) : null}
      </div>
    </nav>
  );
}

/** Builds a URL with updated query parameters, dropping empty values. */
export function withQuery(
  path: string,
  current: Record<string, string | undefined>,
  changes: Record<string, string | null | undefined>,
) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...current, ...changes })) if (v) params.set(k, v);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}
