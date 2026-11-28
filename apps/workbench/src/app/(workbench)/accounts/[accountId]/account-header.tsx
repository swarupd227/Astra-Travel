import Link from 'next/link';
import clsx from 'clsx';
import type { Account } from '@astra/contracts';
import { ACCOUNT_KIND_LABELS, ACCOUNT_STATUS_TONES, sentenceCase } from '@/lib/format';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/primitives';

const TABS = [
  { key: 'overview', path: '', label: 'Overview' },
  { key: 'setup', path: '/setup', label: 'Onboarding and configuration' },
  { key: 'channels', path: '/channels', label: 'Sales channels' },
] as const;

/** The top of every page about one account: who it is, its status and its sections. */
export function AccountHeader({
  account,
  current,
  title,
  description,
  actions,
}: {
  account: Account;
  current: (typeof TABS)[number]['key'];
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <>
      <BackLink href="/accounts">Accounts</BackLink>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-3xl">
          <p className="mb-1 text-xs font-medium text-muted">
            {current === 'overview' ? ACCOUNT_KIND_LABELS[account.kind] : account.name} ·{' '}
            {account.code}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
            <Badge tone={ACCOUNT_STATUS_TONES[account.status]} className="px-2.5 py-1">
              {sentenceCase(account.status)}
            </Badge>
          </div>
          {description ? (
            <p className="mt-1.5 text-sm leading-6 text-muted">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      <nav
        aria-label="Account sections"
        className="mb-6 flex overflow-x-auto border-b border-border"
      >
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/accounts/${account.id}${t.path}`}
            aria-current={t.key === current ? 'page' : undefined}
            className={clsx(
              '-mb-px shrink-0 border-b-2 px-3 py-3 text-sm font-medium focus-visible:outline-offset-[-3px]',
              t.key === current
                ? 'border-primary text-fg'
                : 'border-transparent text-muted hover:border-border-strong hover:text-fg',
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
