'use client';

import clsx from 'clsx';
import { useEffect, useRef, type ReactNode } from 'react';

/** Past this many columns a table is a grid of figures, which reads better scrolled than stacked. */
const MAX_STACKED_COLUMNS = 7;

/**
 * Lets a table stack into labelled records on a phone: each cell is given its column's heading, and
 * the table roles are stated so they survive the change of layout.
 */
export function StackTable({ caption, children }: { caption: string; children: ReactNode }) {
  const ref = useRef<HTMLTableElement>(null);

  useEffect(() => {
    const table = ref.current;
    if (!table) return;
    const label = () => {
      const headings = [...table.querySelectorAll(':scope > thead th')].map((th) => {
        const visible = th.cloneNode(true) as HTMLElement;
        visible.querySelectorAll('.sr-only').forEach((n) => n.remove());
        return visible.textContent?.trim() ?? '';
      });
      const stacks = headings.length > 0 && headings.length <= MAX_STACKED_COLUMNS;
      table.classList.toggle('stack', stacks);
      table.setAttribute('role', 'table');
      table.querySelectorAll(':scope > thead, :scope > tbody').forEach((group) => {
        group.setAttribute('role', 'rowgroup');
      });
      table.querySelectorAll(':scope > * > tr').forEach((row) => {
        row.setAttribute('role', 'row');
        let column = 0;
        for (const cell of row.children as HTMLCollectionOf<HTMLTableCellElement>) {
          const heading = cell.tagName === 'TH' && row.parentElement?.tagName === 'THEAD';
          cell.setAttribute(
            'role',
            heading ? 'columnheader' : cell.tagName === 'TH' ? 'rowheader' : 'cell',
          );
          if (!heading) cell.setAttribute('data-label', headings[column] ?? '');
          column += cell.colSpan;
        }
      });
    };
    label();
    const observer = new MutationObserver(label);
    observer.observe(table, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <table ref={ref} className={clsx('w-full border-collapse text-left text-sm')}>
      <caption className="sr-only">{caption}</caption>
      {children}
    </table>
  );
}
