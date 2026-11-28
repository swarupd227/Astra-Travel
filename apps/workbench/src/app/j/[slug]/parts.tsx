import { Check } from 'lucide-react';

const STEPS = ['Your trip', 'Your price', 'Buy'] as const;

export const money = (value: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value));

/** Where the traveller is in buying cover. */
export function Steps({ current }: { current: 1 | 2 | 3 }) {
  return (
    <ol aria-label="Progress" className="mb-8 flex items-center gap-2 text-sm">
      {STEPS.map((label, i) => {
        const step = i + 1;
        const done = step < current;
        const here = step === current;
        return (
          <li
            key={label}
            aria-current={here ? 'step' : undefined}
            className="flex flex-1 items-center gap-2 last:flex-none"
          >
            <span
              className="flex size-7 shrink-0 items-center justify-center rounded-full border-2 text-sm font-semibold"
              style={
                done || here
                  ? {
                      background: 'var(--brand)',
                      borderColor: 'var(--brand)',
                      color: 'var(--on-brand)',
                    }
                  : { borderColor: '#c9ced6', color: '#4a4a4a' }
              }
            >
              {done ? <Check aria-hidden className="size-4" /> : step}
            </span>
            <span className={here ? 'font-semibold' : 'text-[#4a4a4a] max-[399px]:sr-only'}>
              {label}
              {done ? <span className="sr-only"> (done)</span> : null}
            </span>
            {step < STEPS.length ? (
              <span aria-hidden className="h-px min-w-3 flex-1 bg-[#c9ced6]" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export function Panel({ children, className = '', ...props }: React.ComponentProps<'section'>) {
  return (
    <section
      className={`rounded-2xl border border-[#d8dce3] bg-white p-5 shadow-sm ${className}`}
      {...props}
    >
      {children}
    </section>
  );
}
