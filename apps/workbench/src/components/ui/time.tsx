'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => undefined;

/**
 * Shows a timestamp in the viewer's own time zone. The server render uses UTC; the browser
 * replaces it after hydration. The full ISO value is always available in the title and datetime.
 */
export function LocalTime({ iso, relative = false }: { iso: string; relative?: boolean }) {
  const isClient = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const date = new Date(iso);
  const absolute = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(isClient ? {} : { timeZone: 'UTC' }),
  }).format(date);
  let label = isClient ? absolute : `${absolute} UTC`;
  if (relative && isClient) {
    const seconds = Math.round((date.getTime() - Date.now()) / 1000);
    const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
    const abs = Math.abs(seconds);
    if (abs < 60) label = rtf.format(seconds, 'second');
    else if (abs < 3600) label = rtf.format(Math.round(seconds / 60), 'minute');
    else if (abs < 86400) label = rtf.format(Math.round(seconds / 3600), 'hour');
    else if (abs < 86400 * 7) label = rtf.format(Math.round(seconds / 86400), 'day');
  }
  return (
    <time dateTime={iso} title={date.toISOString()} className="whitespace-nowrap tabular-nums">
      {label}
    </time>
  );
}
