'use client';

import Link from 'next/link';
import * as DM from '@radix-ui/react-dropdown-menu';
import { ChevronDown, LogOut, UserRound } from 'lucide-react';

export function UserMenu({
  name,
  email,
  roleLabels,
}: {
  name: string;
  email: string | null;
  roleLabels: string[];
}) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <DM.Root>
      {/* The accessible name contains the visible text (WCAG 2.5.3 Label in Name). */}
      <DM.Trigger className="flex items-center gap-2.5 rounded-lg py-1.5 pl-1.5 pr-2 text-left hover:bg-surface-muted">
        <span className="sr-only">Account menu: </span>
        <span
          aria-hidden
          className="flex size-8 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-primary"
        >
          {initials || '?'}
        </span>
        <span className="sr-only sm:hidden">{name}</span>
        <span className="hidden min-w-0 sm:block">
          <span className="block truncate text-sm font-medium text-fg">{name}</span>
          <span className="block truncate text-xs text-muted">{roleLabels[0] ?? 'No role'}</span>
        </span>
        <ChevronDown aria-hidden className="size-4 text-subtle" />
      </DM.Trigger>
      <DM.Portal>
        <DM.Content
          align="end"
          sideOffset={6}
          className="z-50 w-64 rounded-xl border border-border bg-surface p-1.5 shadow-overlay"
        >
          <div className="px-2.5 py-2">
            <p className="truncate text-sm font-medium text-fg">{name}</p>
            {email ? <p className="truncate text-xs text-muted">{email}</p> : null}
            <p className="mt-1.5 text-xs text-subtle">{roleLabels.join(' · ')}</p>
          </div>
          <DM.Separator className="my-1 h-px bg-border" />
          <DM.Item asChild>
            <Link
              href="/profile"
              className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-fg outline-none data-[highlighted]:bg-surface-muted"
            >
              <UserRound aria-hidden className="size-4 text-muted" /> My access
            </Link>
          </DM.Item>
          <DM.Item
            asChild
            // The menu unmounts on select, so submit the (outside) form explicitly.
            onSelect={() =>
              (document.getElementById('sign-out-form') as HTMLFormElement | null)?.requestSubmit()
            }
          >
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-fg outline-none data-[highlighted]:bg-surface-muted"
            >
              <LogOut aria-hidden className="size-4 text-muted" /> Sign out
            </button>
          </DM.Item>
        </DM.Content>
      </DM.Portal>
      <form id="sign-out-form" action="/api/auth/logout" method="post" hidden />
    </DM.Root>
  );
}
