'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import * as RD from '@radix-ui/react-dialog';
import { Menu, X } from 'lucide-react';
import { useState } from 'react';
import type { NavSection } from '@/lib/navigation';
import { NavIcon } from './nav-icon';
import { Logo } from './logo';

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

function NavList({ sections, onNavigate }: { sections: NavSection[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Workbench" className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
      {sections.map((section) => (
        <div key={section.label}>
          <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-sidebar-fg/60">
            {section.label}
          </p>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={clsx(
                      'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                      'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#8fb0ff]',
                      active
                        ? 'bg-sidebar-active text-sidebar-fg-strong'
                        : 'text-sidebar-fg hover:bg-white/5 hover:text-sidebar-fg-strong',
                    )}
                  >
                    <NavIcon
                      name={item.icon}
                      className={clsx(
                        'size-4 shrink-0',
                        active
                          ? 'text-[#8fb0ff]'
                          : 'text-sidebar-fg/70 group-hover:text-sidebar-fg-strong',
                      )}
                    />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function EnvironmentTag({ environment }: { environment: string }) {
  return (
    <div className="border-t border-sidebar-border px-6 py-4 text-xs text-sidebar-fg/70">
      <span className="inline-flex items-center gap-2">
        <span aria-hidden className="size-1.5 rounded-full bg-[#4fd1bd]" />
        {environment} environment
      </span>
    </div>
  );
}

export function Sidebar({
  sections,
  environment,
}: {
  sections: NavSection[];
  environment: string;
}) {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
      <div className="flex h-16 items-center px-6">
        <Logo />
      </div>
      <NavList sections={sections} />
      <EnvironmentTag environment={environment} />
    </aside>
  );
}

export function MobileNav({
  sections,
  environment,
}: {
  sections: NavSection[];
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
        <RD.Content className="animate-drawer fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-sidebar shadow-overlay lg:hidden">
          <RD.Title className="sr-only">Navigation</RD.Title>
          <RD.Description className="sr-only">
            Workbench sections you have access to.
          </RD.Description>
          <div className="flex h-16 items-center justify-between px-6">
            <Logo />
            <RD.Close
              className="rounded-md p-1 text-sidebar-fg hover:text-sidebar-fg-strong"
              aria-label="Close navigation"
            >
              <X aria-hidden className="size-5" />
            </RD.Close>
          </div>
          <NavList sections={sections} onNavigate={() => setOpen(false)} />
          <EnvironmentTag environment={environment} />
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
