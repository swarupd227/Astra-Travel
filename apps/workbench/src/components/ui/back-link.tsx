import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';

/** The way back to the list a record belongs to. */
export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
    >
      <ChevronLeft aria-hidden className="size-4" /> {children}
    </Link>
  );
}
