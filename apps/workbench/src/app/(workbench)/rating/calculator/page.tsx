import type { RateManual } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { AccessDenied } from '@/components/access-denied';
import { load } from '@/components/error-panel';
import { Card, PageHeader } from '@/components/ui/primitives';
import { RatingCalculator } from '../rating-forms';

export const metadata = { title: 'Rating calculator' };

export default async function CalculatorPage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('rating:read')) return <AccessDenied permission="rating:read" />;
  const manuals = await load(() =>
    api<{ items: Omit<RateManual, 'document'>[] }>('/v1/rate-manuals'),
  );
  const options = (manuals.data?.items ?? [])
    .filter((m) => m.status !== 'withdrawn')
    .map((m) => ({
      id: m.id,
      label: `${m.code} v${m.version} (${m.state} ${m.benefit}, ${m.status})`,
    }));
  return (
    <>
      <PageHeader
        title="Rating calculator"
        description="Price one traveller for one benefit and see how the figure is built."
      />
      <Card className="p-5">
        <RatingCalculator manuals={options} />
      </Card>
    </>
  );
}
