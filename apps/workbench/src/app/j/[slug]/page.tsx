import { notFound } from 'next/navigation';
import { journeyConfig } from '@/lib/journey';
import { TripForm } from './journey-forms';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const cfg = await journeyConfig((await params).slug);
  return {
    title: cfg ? `Travel insurance, ${cfg.branding.displayName}` : 'Travel insurance',
    robots: { index: false, follow: false },
  };
}

export default async function JourneyStart({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const cfg = await journeyConfig(slug);
  if (!cfg) notFound();
  return (
    <>
      <h1 className="mb-2 text-3xl font-bold">{cfg.headline || 'Cover for your trip'}</h1>
      <p className="mb-8 text-[#4a4a4a]">
        Tell us about your trip and we will show you the price and what is covered. You can read the
        full policy wording before you buy.
      </p>
      <TripForm slug={slug} plans={cfg.plans} />
    </>
  );
}
