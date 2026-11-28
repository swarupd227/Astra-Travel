'use client';

import * as DM from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { buttonClass } from '@/components/ui/button';

export interface KindOption {
  href: string;
  label: string;
  selected: boolean;
}

/** Narrows the queue to one kind of work. Each choice is a link, so it applies at once. */
export function KindFilter({ options }: { options: KindOption[] }) {
  const current = options.find((o) => o.selected) ?? options[0]!;
  return (
    <DM.Root modal={false}>
      <DM.Trigger className={buttonClass('secondary', 'sm')}>
        <span className="sr-only">Kind of work: </span>
        {current.label}
        <ChevronDown aria-hidden className="size-4 text-subtle" />
      </DM.Trigger>
      <DM.Portal>
        <DM.Content
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 w-56 rounded-xl border border-border bg-surface p-1.5 shadow-overlay"
        >
          {options.map((o) => (
            <DM.Item key={o.href} asChild>
              <Link
                href={o.href}
                aria-current={o.selected ? 'true' : undefined}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-2 text-sm text-fg outline-none data-[highlighted]:bg-surface-muted"
              >
                {o.label}
                {o.selected ? <Check aria-hidden className="size-4 text-primary" /> : null}
              </Link>
            </DM.Item>
          ))}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
