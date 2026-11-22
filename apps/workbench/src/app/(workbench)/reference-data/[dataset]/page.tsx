import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, Database } from 'lucide-react';
import {
  REFDATA_DATASET_CODES,
  type RefdataDatasetSummary,
  type RefdataVersion,
} from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { integer, sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Notice,
  PageHeader,
} from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { LoadVersionDialog } from '../refdata-forms';

export const metadata = { title: 'Reference dataset' };

const TONES = { draft: 'primary', approved: 'success', rejected: 'neutral' } as const;

function versionState(v: RefdataVersion, today: string): string {
  if (v.status !== 'approved') return sentenceCase(v.status);
  if (v.effectiveFrom > today) return 'Approved, from ' + v.effectiveFrom;
  if (v.effectiveTo && v.effectiveTo <= today) return 'Replaced';
  return 'In force';
}

export default async function DatasetPage({ params }: { params: Promise<{ dataset: string }> }) {
  const me = (await getMe())!;
  if (!me.permissions.includes('refdata:read')) return <AccessDenied permission="refdata:read" />;
  const { dataset } = await params;
  if (!(REFDATA_DATASET_CODES as string[]).includes(dataset)) notFound();

  const [summary, versions] = await Promise.all([
    load(() => api<{ items: RefdataDatasetSummary[] }>('/v1/reference-data')),
    load(() => api<{ items: RefdataVersion[] }>(`/v1/reference-data/${dataset}/versions`)),
  ]);
  if (summary.error) return <ErrorPanel error={summary.error} />;
  if (versions.error) return <ErrorPanel error={versions.error} />;
  const d = summary.data.items.find((x) => x.code === dataset)!;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <Link
        href="/reference-data"
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> Reference data
      </Link>
      <PageHeader
        eyebrow="Reference data"
        title={d.name}
        description={d.description}
        actions={
          me.permissions.includes('refdata:manage') ? (
            <LoadVersionDialog
              dataset={d.code}
              name={d.name}
              fields={d.fields}
              expectedSource={d.expectedSource}
            />
          ) : null
        }
      />
      {!d.inForce ? (
        <div className="mb-6">
          <Notice tone="warning" title="No version in force">
            This dataset is defined but has no approved content yet. Expected source:{' '}
            {d.expectedSource}.
          </Notice>
        </div>
      ) : null}
      <Card>
        <CardHeader
          title="Versions"
          description={`Key field: ${d.keyField}. Fields: ${d.fields.join(', ')}.`}
        />
        {versions.data.items.length === 0 ? (
          <EmptyState
            icon={<Database className="size-5" />}
            title="No versions yet"
            description="Load the first version from a CSV file."
          />
        ) : (
          <Table caption={`Versions of ${d.name}`}>
            <THead>
              <tr>
                <TH>Version</TH>
                <TH>State</TH>
                <TH>Effective</TH>
                <TH className="text-right">Entries</TH>
                <TH>Source</TH>
                <TH>Loaded</TH>
              </tr>
            </THead>
            <tbody>
              {versions.data.items.map((v) => (
                <TR key={v.id}>
                  <TD>
                    <Link
                      href={`/reference-data/${dataset}/versions/${v.id}`}
                      className="font-medium text-fg hover:text-primary hover:underline"
                    >
                      Version {v.version}
                    </Link>
                  </TD>
                  <TD>
                    <Badge
                      tone={versionState(v, today) === 'In force' ? 'success' : TONES[v.status]}
                    >
                      {versionState(v, today)}
                    </Badge>
                  </TD>
                  <TD className="whitespace-nowrap text-muted">
                    {v.effectiveFrom}
                    {v.effectiveTo ? ` to ${v.effectiveTo}` : ''}
                  </TD>
                  <TD className="text-right tabular-nums">{integer(v.entryCount)}</TD>
                  <TD className="max-w-xs text-muted">{v.source}</TD>
                  <TD className="text-muted">
                    <LocalTime iso={v.loadedAt} /> · {v.loadedBy}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
