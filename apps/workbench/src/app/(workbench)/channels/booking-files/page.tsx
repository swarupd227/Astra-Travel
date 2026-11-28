import { Download, FileSpreadsheet } from 'lucide-react';
import {
  BOOKING_COLUMNS,
  MAX_BOOKINGS_PER_FILE,
  type Account,
  type BookingFile,
} from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { buttonClass } from '@/components/ui/button';
import { Badge, Card, CardHeader, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { BookingFileForm } from './file-form';

export const metadata = { title: 'Booking files' };

export default async function BookingFilesPage({
  searchParams,
}: {
  searchParams: Promise<{ accountId?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('quotes:read')) return <AccessDenied permission="quotes:read" />;
  const { accountId } = await searchParams;
  const q = accountId && /^[0-9a-f-]{36}$/i.test(accountId) ? `&accountId=${accountId}` : '';
  const [files, accounts] = await Promise.all([
    load(() => api<{ items: BookingFile[] }>(`/v1/booking-files?limit=50${q}`)),
    load(() => api<{ items: Account[] }>('/v1/accounts?limit=100')),
  ]);
  if (files.error) return <ErrorPanel error={files.error} />;
  const list = accounts.data?.items ?? [];
  const names = new Map(list.map((a) => [a.id, a.name]));
  const canSend = me.permissions.includes('quotes:create');
  return (
    <>
      <PageHeader
        title="Booking files"
        description={`For accounts that send bookings as a CSV file. Each booking is priced and bought like any other, and the result file says which were accepted and why not. Up to ${MAX_BOOKINGS_PER_FILE} bookings a file.`}
      />
      {canSend ? (
        <Card className="mb-6">
          <CardHeader
            title="Send a file"
            actions={
              <a
                className={buttonClass('secondary', 'sm')}
                download="bookings-template.csv"
                href={`data:text/csv;charset=utf-8,${encodeURIComponent(`${BOOKING_COLUMNS.join(',')}\n`)}`}
              >
                <FileSpreadsheet aria-hidden className="size-4" /> Download a template
              </a>
            }
          />
          <div className="p-5">
            <BookingFileForm
              accounts={list.map((a) => ({ id: a.id, name: a.name }))}
              fixedAccountId={q ? accountId! : null}
            />
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer font-medium text-primary">
                The columns a file needs
              </summary>
              <p className="mt-2 break-words font-mono text-xs leading-6 text-muted">
                {BOOKING_COLUMNS.join(', ')}
              </p>
            </details>
          </div>
        </Card>
      ) : null}
      <Card>
        {files.data.items.length === 0 ? (
          <EmptyState
            icon={<FileSpreadsheet className="size-5" />}
            title="No files yet"
            description="Files sent by accounts, or on their behalf, are listed here."
          />
        ) : (
          <Table caption="Booking files">
            <THead>
              <tr>
                <TH>File</TH>
                <TH>Account</TH>
                <TH>Status</TH>
                <TH className="text-right">Bookings</TH>
                <TH className="text-right">Accepted</TH>
                <TH className="text-right">Rejected</TH>
                <TH>Sent</TH>
                <TH>
                  <span className="sr-only">Result</span>
                </TH>
              </tr>
            </THead>
            <tbody>
              {files.data.items.map((f) => (
                <TR key={f.id}>
                  <TD>{f.fileName}</TD>
                  <TD>{names.get(f.accountId) ?? f.accountId.slice(0, 8)}</TD>
                  <TD>
                    <Badge
                      tone={
                        f.status === 'completed'
                          ? 'success'
                          : f.status === 'rejected'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {sentenceCase(f.status)}
                    </Badge>
                    {f.reason ? (
                      <span className="mt-1 block max-w-xs text-xs text-danger">{f.reason}</span>
                    ) : null}
                  </TD>
                  <TD className="text-right">{f.bookings}</TD>
                  <TD className="text-right">{f.accepted}</TD>
                  <TD className="text-right">{f.rejected}</TD>
                  <TD className="whitespace-nowrap text-muted">
                    <LocalTime iso={f.createdAt} />
                  </TD>
                  <TD>
                    {f.status === 'completed' ? (
                      <a
                        href={`/api/booking-files/${f.id}/result`}
                        className={buttonClass('ghost', 'sm')}
                        aria-label={`Download the result of ${f.fileName}`}
                      >
                        <Download aria-hidden className="size-3.5" /> Result
                      </a>
                    ) : null}
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
