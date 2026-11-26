import { Button, buttonClass } from '@/components/ui/button';
import { Input } from '@/components/ui/form';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The period asked for, or the last 30 days. */
export function periodFrom(sp: { from?: string; to?: string }): { from: string; to: string } {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const to = DAY.test(sp.to ?? '') ? sp.to! : today;
  const from = DAY.test(sp.from ?? '') && sp.from! <= to ? sp.from! : monthAgo < to ? monthAgo : to;
  return { from, to };
}

export function PeriodForm({ from, to, csvHref }: { from: string; to: string; csvHref: string }) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-3 p-4" aria-label="Choose the period">
      <label className="text-sm">
        <span className="mb-1 block font-medium text-fg">From</span>
        <Input type="date" name="from" defaultValue={from} required />
      </label>
      <label className="text-sm">
        <span className="mb-1 block font-medium text-fg">To</span>
        <Input type="date" name="to" defaultValue={to} required />
      </label>
      <Button type="submit" variant="secondary">
        Show
      </Button>
      <a href={csvHref} className={buttonClass('ghost', 'md')}>
        Download as CSV
      </a>
    </form>
  );
}
