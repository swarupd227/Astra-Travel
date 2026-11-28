import type { CSSProperties } from 'react';
import { notFound } from 'next/navigation';
import { Lock } from 'lucide-react';
import { journeyAvailable, journeyConfig } from '@/lib/journey';

export const dynamic = 'force-dynamic';

/** The hosted purchase journey: the partner's branding and the plan's required notices, with no workbench around it. */
export default async function JourneyLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const cfg = await journeyConfig(slug);
  if (!cfg || !journeyAvailable()) notFound();
  const style = {
    '--brand': cfg.branding.primaryColor,
    '--on-brand': cfg.branding.textOnPrimary,
  } as CSSProperties;
  return (
    // The traveller's page is always light: the partner chose its colours against white.
    <div
      style={{ ...style, colorScheme: 'light' }}
      className="flex min-h-dvh flex-col bg-[#f6f7f9] text-[#1a1a1a]"
    >
      <a
        href="#journey-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-white focus:px-3 focus:py-2"
      >
        Skip to the form
      </a>
      <header className="bg-white">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-4">
          {cfg.branding.logoUrl ? (
            // The partner's own logo address, which the image optimiser is not set up for.
            <img src={cfg.branding.logoUrl} alt="" className="max-h-9 max-w-32" />
          ) : (
            <span
              aria-hidden
              className="flex size-9 items-center justify-center rounded-lg text-lg font-bold"
              style={{ background: 'var(--brand)', color: 'var(--on-brand)' }}
            >
              {cfg.branding.displayName.charAt(0).toUpperCase()}
            </span>
          )}
          <p className="text-lg font-semibold">{cfg.branding.displayName}</p>
          <p className="ml-auto hidden items-center gap-1.5 text-sm text-[#4a4a4a] sm:flex">
            <Lock aria-hidden className="size-4" /> Travel insurance
          </p>
        </div>
        <div style={{ background: 'var(--brand)', height: 4 }} aria-hidden />
      </header>
      <main id="journey-main" className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
        {children}
      </main>
      <footer className="border-t border-[#d8dce3] bg-white">
        <p className="mx-auto max-w-3xl px-4 py-6 text-sm text-[#4a4a4a]">
          Travel insurance offered by {cfg.accountName}. Cover is subject to the policy wording,
          which you can read before you buy. This page is run for {cfg.accountName} on the Astra
          Travel platform.
        </p>
      </footer>
    </div>
  );
}
