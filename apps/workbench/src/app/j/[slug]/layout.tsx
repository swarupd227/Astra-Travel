import type { CSSProperties } from 'react';
import { notFound } from 'next/navigation';
import { journeyAvailable, journeyConfig } from '@/lib/journey';

export const dynamic = 'force-dynamic';

/** The hosted purchase journey: the partner's branding and the plan's required notices, with no workbench around it. */
export default async function JourneyLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const cfg = await journeyConfig(slug);
  if (!cfg || !journeyAvailable()) notFound();
  const style = { '--brand': cfg.branding.primaryColor, '--on-brand': cfg.branding.textOnPrimary } as CSSProperties;
  return (
    <div style={style} className="min-h-dvh bg-white text-[#1a1a1a]">
      <a href="#journey-main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-white focus:px-3 focus:py-2">
        Skip to the form
      </a>
      <header className="border-b border-[#c9ced6]">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-4">
          {cfg.branding.logoUrl ? (
            <img src={cfg.branding.logoUrl} alt="" className="max-h-9 max-w-32" />
          ) : null}
          <p className="text-lg font-semibold">{cfg.branding.displayName}</p>
        </div>
        <div style={{ background: 'var(--brand)', height: 4 }} aria-hidden />
      </header>
      <main id="journey-main" className="mx-auto max-w-3xl px-4 py-8">
        {children}
      </main>
      <footer className="mx-auto max-w-3xl px-4 pb-10 text-sm text-[#4a4a4a]">
        <p>
          Travel insurance offered by {cfg.accountName}. Cover is subject to the policy wording, which you can read before you buy. This page is run for {cfg.accountName} on the Astra Travel platform.
        </p>
      </footer>
    </div>
  );
}
