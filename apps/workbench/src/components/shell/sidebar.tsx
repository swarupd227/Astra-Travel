'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import * as RD from '@radix-ui/react-dialog';
import { ChevronRight, Menu, X } from 'lucide-react';
import { useMemo, useState, useSyncExternalStore } from 'react';
import type { VisibleNavigation } from '@/lib/navigation';
import { NavIcon } from './nav-icon';
import { Logo } from './logo';

/** Roles with few pages see them all; everyone else starts with their own groups open. */
const SHOW_ALL_UP_TO = 12;

// Which groups this viewer has opened or closed. A per-browser convenience only.
const STORE_KEY = 'astra.nav.groups';
const STORE_EVENT = 'astra:nav-groups';

function subscribe(onChange: () => void) {
  window.addEventListener(STORE_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(STORE_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

function readStore(): string {
  try {
    return window.localStorage.getItem(STORE_KEY) ?? '';
  } catch {
    return '';
  }
}

function useGroupChoices() {
  const raw = useSyncExternalStore(subscribe, readStore, () => '');
  const choices = useMemo<Record<string, boolean>>(() => {
    try {
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  }, [raw]);
  const choose = (id: string, open: boolean) => {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({ ...choices, [id]: open }));
    } catch {
      // Private windows may refuse storage; the groups then keep their defaults.
    }
    window.dispatchEvent(new Event(STORE_EVENT));
  };
  return { choices, choose };
}

function matches(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

const linkClass = (active: boolean) =>
  clsx(
    'flex items-center gap-3 rounded-lg text-sm transition-colors',
    'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#8fb0ff]',
    active
      ? 'bg-sidebar-active font-medium text-sidebar-fg-strong'
      : 'text-sidebar-fg hover:bg-white/5 hover:text-sidebar-fg-strong',
  );

function NavList({
  navigation,
  defaultOpen,
  idPrefix,
  onNavigate,
}: {
  navigation: VisibleNavigation;
  defaultOpen: string[];
  idPrefix: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const { choices, choose } = useGroupChoices();
  // A group the viewer closed while on one of its pages stays closed until they move on.
  const [closedOn, setClosedOn] = useState<Record<string, string>>({});

  const all = [...navigation.primary, ...navigation.groups.flatMap((g) => g.items)];
  // The most specific matching item is current (for example /agents/reviews, not /agents).
  const current = all
    .map((i) => i.href)
    .filter((href) => matches(pathname, href))
    .sort((a, b) => b.length - a.length)[0];
  const showAll = all.length <= SHOW_ALL_UP_TO;

  return (
    <nav aria-label="Workbench" className="flex-1 overflow-y-auto px-3 pb-6 pt-2">
      <ul className="space-y-0.5">
        {navigation.primary.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={item.href === current ? 'page' : undefined}
              className={clsx(linkClass(item.href === current), 'h-9 px-3')}
            >
              <NavIcon
                name={item.icon}
                className={clsx('size-4 shrink-0', item.href === current && 'text-[#8fb0ff]')}
              />
              {item.label}
            </Link>
          </li>
        ))}
      </ul>

      <ul className="mt-3 space-y-0.5 border-t border-sidebar-border pt-3">
        {navigation.groups.map((group) => {
          const holdsCurrent = group.items.some((i) => i.href === current);
          const open = holdsCurrent
            ? closedOn[group.id] !== pathname
            : (choices[group.id] ?? (showAll || defaultOpen.includes(group.id)));
          const listId = `${idPrefix}-${group.id}`;
          return (
            <li key={group.id}>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => {
                  if (holdsCurrent) {
                    setClosedOn((c) => ({ ...c, [group.id]: open ? pathname : '' }));
                  }
                  choose(group.id, !open);
                }}
                className={clsx(linkClass(false), 'h-9 w-full px-3 font-medium')}
              >
                <NavIcon
                  name={group.icon}
                  className={clsx('size-4 shrink-0', holdsCurrent && 'text-[#8fb0ff]')}
                />
                <span
                  className={clsx(
                    'min-w-0 flex-1 truncate text-left',
                    holdsCurrent && 'text-sidebar-fg-strong',
                  )}
                >
                  {group.label}
                </span>
                <ChevronRight
                  aria-hidden
                  className={clsx(
                    'size-4 shrink-0 opacity-60 transition-transform',
                    open && 'rotate-90',
                  )}
                />
              </button>
              <ul
                id={listId}
                hidden={!open}
                className="mb-2 ml-5 mt-0.5 space-y-0.5 border-l border-sidebar-border pl-2"
              >
                {group.items.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={item.href === current ? 'page' : undefined}
                      className={clsx(linkClass(item.href === current), 'min-h-8 px-3 py-1.5')}
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function EnvironmentTag({ environment }: { environment: string }) {
  return (
    <div className="border-t border-sidebar-border px-6 py-3 text-xs text-sidebar-fg">
      <span className="inline-flex items-center gap-2">
        <span aria-hidden className="size-1.5 rounded-full bg-[#4fd1bd]" />
        {environment} environment
      </span>
    </div>
  );
}

export function Sidebar({
  navigation,
  defaultOpen,
  environment,
}: {
  navigation: VisibleNavigation;
  defaultOpen: string[];
  environment: string;
}) {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
      <div className="flex h-16 shrink-0 items-center px-6">
        <Logo endorsement />
      </div>
      <NavList navigation={navigation} defaultOpen={defaultOpen} idPrefix="nav" />
      <EnvironmentTag environment={environment} />
    </aside>
  );
}

export function MobileNav({
  navigation,
  defaultOpen,
  environment,
}: {
  navigation: VisibleNavigation;
  defaultOpen: string[];
  environment: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <RD.Root open={open} onOpenChange={setOpen}>
      <RD.Trigger
        className="inline-flex size-10 items-center justify-center rounded-lg text-muted hover:bg-surface-muted hover:text-fg lg:hidden"
        aria-label="Open navigation"
      >
        <Menu aria-hidden className="size-5" />
      </RD.Trigger>
      <RD.Portal>
        <RD.Overlay className="animate-overlay fixed inset-0 z-40 bg-[rgb(8_14_28/0.55)] lg:hidden" />
        <RD.Content className="animate-drawer fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col bg-sidebar shadow-overlay lg:hidden">
          <RD.Title className="sr-only">Navigation</RD.Title>
          <RD.Description className="sr-only">
            Workbench sections you have access to.
          </RD.Description>
          <div className="flex h-16 shrink-0 items-center justify-between px-6">
            <Logo endorsement />
            <RD.Close
              className="rounded-md p-2 text-sidebar-fg hover:text-sidebar-fg-strong"
              aria-label="Close navigation"
            >
              <X aria-hidden className="size-5" />
            </RD.Close>
          </div>
          <NavList
            navigation={navigation}
            defaultOpen={defaultOpen}
            idPrefix="drawer"
            onNavigate={() => setOpen(false)}
          />
          <EnvironmentTag environment={environment} />
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
