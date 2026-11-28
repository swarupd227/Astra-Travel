'use client';

import { useSyncExternalStore } from 'react';

const noop = () => () => undefined;

function words(date: Date) {
  const hour = date.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const day = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(date);
  return `${greeting}|${day}`;
}

/** The greeting and date by the viewer's own clock; the server's first guess uses US Eastern time. */
export function Greeting({ name, serverNow }: { name: string; serverNow: string }) {
  const value = useSyncExternalStore(
    noop,
    () => words(new Date()),
    () =>
      words(
        new Date(new Date(serverNow).toLocaleString('en-US', { timeZone: 'America/New_York' })),
      ),
  );
  const [greeting, day] = value.split('|');
  return (
    <>
      <p className="text-sm text-muted">{day}</p>
      <h1 id="welcome" className="mt-1 text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
        {greeting}, {name}
      </h1>
    </>
  );
}
