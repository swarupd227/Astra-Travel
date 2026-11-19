'use client';

import * as RD from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

/** Modal dialog with focus trap, Escape to close and labelled title/description (Radix). */
export function Dialog({
  trigger,
  title,
  description,
  children,
  open,
  onOpenChange,
  wide,
}: {
  trigger?: ReactNode;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  wide?: boolean;
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <RD.Trigger asChild>{trigger}</RD.Trigger> : null}
      <RD.Portal>
        <RD.Overlay className="animate-overlay fixed inset-0 z-40 bg-[rgb(8_14_28/0.55)] backdrop-blur-[2px]" />
        <RD.Content
          className={`animate-dialog fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] ${wide ? 'max-w-2xl' : 'max-w-lg'} -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-overlay`}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <RD.Title className="text-lg font-semibold text-fg">{title}</RD.Title>
              {description ? (
                <RD.Description className="mt-1 text-sm text-muted">{description}</RD.Description>
              ) : null}
            </div>
            <RD.Close
              className="rounded-md p-1 text-muted hover:bg-surface-muted hover:text-fg"
              aria-label="Close"
            >
              <X aria-hidden className="size-5" />
            </RD.Close>
          </div>
          {children}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

export const DialogClose = RD.Close;
