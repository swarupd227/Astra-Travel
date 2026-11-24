import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import type { BenefitCatalogue, FormEdition, FormVariable, VariableMap } from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Notice, PageHeader } from '@/components/ui/primitives';
import { CatalogueEditor, type CatalogueVariable } from './catalogue-editor';

export const metadata = { title: 'Benefit catalogue' };

function describe(v: FormVariable): string {
  const c = v.constraints as Record<string, unknown>;
  switch (v.type) {
    case 'numeric_range':
      return c.unit === 'usd'
        ? `$${Number(c.min).toLocaleString('en-US')}–$${Number(c.max).toLocaleString('en-US')}`
        : `${c.min}–${c.max}`;
    case 'limit_basis':
      return (c.options as string[]).join(' / ');
    case 'optional_benefit':
      return 'optional';
    default:
      return v.type.replace(/_/g, ' ');
  }
}

const variablesOf = (map: VariableMap | null, source: 'schedule' | 'policy'): CatalogueVariable[] =>
  (map?.variables ?? []).map((v) => ({
    source,
    key: v.key,
    label: v.label,
    type: v.type,
    describe: describe(v),
  }));

export default async function CataloguePage({
  params,
  searchParams,
}: {
  params: Promise<{ editionId: string }>;
  searchParams: Promise<{ approved?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('forms:read')) return <AccessDenied permission="forms:read" />;
  const { editionId } = await params;
  const { approved } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(editionId)) notFound();

  const edition = await load(() => api<FormEdition>(`/v1/form-editions/${editionId}`));
  if (edition.error instanceof ApiProblem && edition.error.problem.code === 'not_found') notFound();
  if (edition.error) return <ErrorPanel error={edition.error} />;
  const e = edition.data;
  if (e.kind !== 'schedule') {
    return (
      <Notice tone="neutral" title="Not a schedule">
        Benefit catalogues are built from schedule editions.{' '}
        <Link className="font-medium text-primary underline" href={`/forms/${e.id}`}>
          Back to the edition
        </Link>
      </Notice>
    );
  }

  const versions = await load(() =>
    api<{
      items: { id: string; status: string; version: number; policyEditionId: string | null }[];
    }>(`/v1/form-editions/${editionId}/catalogues`),
  );
  if (versions.error) return <ErrorPanel error={versions.error} />;
  const draftId = versions.data.items.find((v) => v.status === 'draft')?.id;
  const currentId = versions.data.items.find((v) => v.status === 'approved')?.id;
  const [draft, current, editions] = await Promise.all([
    draftId ? load(() => api<BenefitCatalogue>(`/v1/benefit-catalogues/${draftId}`)) : null,
    currentId ? load(() => api<BenefitCatalogue>(`/v1/benefit-catalogues/${currentId}`)) : null,
    load(() => api<{ items: FormEdition[] }>('/v1/form-editions', { query: { kind: 'policy' } })),
  ]);
  const cat = draft?.data ?? current?.data ?? null;
  const policyId = cat?.policyEditionId ?? null;
  const policyEdition = policyId ? editions.data?.items.find((p) => p.id === policyId) : undefined;
  const [scheduleMap, policyMap] = await Promise.all([
    e.currentMap ? load(() => api<VariableMap>(`/v1/variable-maps/${e.currentMap!.id}`)) : null,
    policyEdition?.currentMap
      ? load(() => api<VariableMap>(`/v1/variable-maps/${policyEdition.currentMap!.id}`))
      : null,
  ]);
  const vars = [
    ...variablesOf(scheduleMap?.data ?? null, 'schedule'),
    ...variablesOf(policyMap?.data ?? null, 'policy'),
  ];

  return (
    <>
      <Link
        href={`/forms/${e.id}`}
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> {e.title}
      </Link>
      <PageHeader
        eyebrow={`Benefit catalogue · ${e.formNumber} ed. ${e.edition}`}
        title="Benefit catalogue"
        description={
          policyEdition
            ? `Built on the approved variable maps of this schedule and of ${policyEdition.formNumber} ed. ${policyEdition.edition}.`
            : 'Built on the approved variable map of this schedule.'
        }
        actions={
          cat ? (
            <Badge tone={cat.status === 'approved' ? 'success' : 'primary'}>
              {cat.status === 'approved'
                ? `Version ${cat.version}, approved`
                : `Draft version ${cat.version}`}
            </Badge>
          ) : null
        }
      />
      <div className="mb-6 space-y-3">
        {approved ? (
          <Notice tone="success" title="Catalogue approved">
            Plans are built from it. It never changes; start a new version for any correction.
          </Notice>
        ) : null}
        {!e.currentMap ? (
          <Notice tone="warning" title="No approved variable map">
            The catalogue refers to the schedule&rsquo;s variables.{' '}
            <Link className="font-medium text-primary underline" href={`/forms/${e.id}`}>
              Build and approve the variable map first.
            </Link>
          </Notice>
        ) : null}
        {current?.data && draft?.data ? (
          <Notice tone="primary">
            Editing draft version {draft.data.version}. Version {current.data.version} stays in
            force until the draft is approved.
          </Notice>
        ) : null}
      </div>
      <CatalogueEditor
        editionId={e.id}
        draft={draft?.data ?? null}
        current={current?.data ?? null}
        vars={vars}
        canEdit={me.permissions.includes('forms:manage') && !!e.currentMap}
        me={me.subject}
        policyEditions={(editions.data?.items ?? [])
          .filter((p) => p.insurer === e.insurer)
          .map((p) => ({ id: p.id, label: `${p.formNumber} ed. ${p.edition} · ${p.title}` }))}
      />
    </>
  );
}
