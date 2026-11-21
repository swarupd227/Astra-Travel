import type { CardProgramme } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { CoverCheckForm } from '../card-forms';

export const metadata = { title: 'Cover check' };

export default async function CoverCheckPage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('cover:verify')) return <AccessDenied permission="cover:verify" />;
  const programmes = me.permissions.includes('card:read')
    ? await load(() =>
        api<{ items: CardProgramme[] }>('/v1/card-programmes', { query: { limit: 200 } }),
      )
    : null;
  if (programmes?.error) return <ErrorPanel error={programmes.error} />;
  const options = (programmes?.data.items ?? [])
    .filter((p) => p.status !== 'draft')
    .map((p) => ({ code: p.code, name: p.name }));

  return (
    <>
      <PageHeader
        eyebrow="Card-linked cover"
        title="Cover check"
        description="The same answer the claims system gets: whether the cardholder account was covered for a trip, the feed versions behind it, and the payment condition result."
      />
      <Card className="p-5">
        {options.length === 0 ? (
          <EmptyState
            title="No live programmes"
            description="Cover can be checked once a card programme has gone live."
          />
        ) : (
          <CoverCheckForm programmes={options} />
        )}
      </Card>
    </>
  );
}
