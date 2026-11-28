import Link from 'next/link';
import clsx from 'clsx';
import { Badge, type Tone } from './primitives';

export interface FilterTab {
  href: string;
  label: string;
  current: boolean;
  count?: number | undefined;
  tone?: Tone | undefined;
}

/** Views of one list, as links along the top of its card. */
export function FilterTabs({
  label,
  tabs,
  aside,
}: {
  label: string;
  tabs: FilterTab[];
  aside?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 border-b border-border px-3">
      <nav aria-label={label} className="-mb-px flex max-w-full overflow-x-auto">
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            aria-current={t.current ? 'page' : undefined}
            className={clsx(
              'flex shrink-0 items-center gap-2 border-b-2 px-3 py-3.5 text-sm font-medium focus-visible:outline-offset-[-3px]',
              t.current
                ? 'border-primary text-fg'
                : 'border-transparent text-muted hover:border-border-strong hover:text-fg',
            )}
          >
            {t.label}
            {t.count !== undefined ? (
              <Badge className="tabular-nums" tone={t.count && t.tone ? t.tone : 'neutral'}>
                {t.count}
              </Badge>
            ) : null}
          </Link>
        ))}
      </nav>
      {aside ? <div className="py-2">{aside}</div> : null}
    </div>
  );
}
