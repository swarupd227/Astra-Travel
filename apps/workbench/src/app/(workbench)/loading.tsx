/** Shown while a page gathers its records: the shape of a page, so nothing jumps when it arrives. */
export default function Loading() {
  const block = 'animate-pulse rounded-lg bg-border/70';
  return (
    <div role="status">
      <span className="sr-only">Loading the page</span>
      <div aria-hidden className="space-y-6">
        <div className="space-y-3">
          <div className={`${block} h-7 w-56`} />
          <div className={`${block} h-4 w-96 max-w-full`} />
        </div>
        <div className="rounded-2xl border border-border bg-surface p-5 shadow-card">
          <div className="space-y-4">
            {['w-3/4', 'w-1/2', 'w-2/3', 'w-5/6', 'w-1/2'].map((width, i) => (
              <div key={i} className="flex items-center gap-4">
                <div className={`${block} size-9 shrink-0`} />
                <div className="flex-1 space-y-2">
                  <div className={`${block} h-3.5 ${width}`} />
                  <div className={`${block} h-3 w-1/3`} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
