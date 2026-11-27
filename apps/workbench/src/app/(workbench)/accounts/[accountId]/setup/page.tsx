import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2, ChevronLeft, CircleDashed } from 'lucide-react';
import type { z } from 'zod';
import {
  LICENCE_KIND_LABELS,
  type Account,
  type AccountDocument,
  type AccountProfile,
  type Licence,
  type Onboarding,
  type SandboxStatusSchema,
  type SegmentChange,
} from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, CardHeader, Notice, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { AgentProposals } from '../../../proposals/agent-proposals';
import {
  CollectedForm,
  DecideSegmentForm,
  GoLiveForm,
  LicenceForm,
  ProfileForm,
  RevokeLicenceForm,
  SandboxControls,
  SegmentForm,
  UploadForm,
} from './setup-forms';

export const metadata = { title: 'Account onboarding' };

type Sandbox = z.infer<typeof SandboxStatusSchema>;

export default async function SetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<{ live?: string; asked?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('accounts:read')) return <AccessDenied permission="accounts:read" />;
  const { accountId } = await params;
  const { live, asked } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) notFound();
  const acc = await load(() => api<Account>(`/v1/accounts/${accountId}`));
  if (acc.error instanceof ApiProblem && acc.error.problem.code === 'not_found') notFound();
  if (acc.error) return <ErrorPanel error={acc.error} />;
  const [onb, profile, segs, collected, lics, docs, sandbox, segList] = await Promise.all([
    load(() => api<Onboarding>(`/v1/accounts/${accountId}/onboarding`)),
    load(() => api<AccountProfile>(`/v1/accounts/${accountId}/profile`)),
    load(() => api<{ items: SegmentChange[] }>(`/v1/accounts/${accountId}/segment-changes`)),
    load(() =>
      api<{ decided: boolean; notCollected: string[]; reason: string | null }>(
        `/v1/accounts/${accountId}/collected-variables`,
      ),
    ),
    load(() => api<{ items: Licence[] }>(`/v1/licences?accountId=${accountId}`)),
    load(() => api<{ items: AccountDocument[] }>(`/v1/accounts/${accountId}/documents`)),
    load(() => api<Sandbox>(`/v1/accounts/${accountId}/sandbox`)),
    load(() =>
      api<{ items: { key: string; data: { name: string } }[] }>(
        '/v1/reference-data/business_segments/entries',
      ),
    ),
  ]);
  if (onb.error) return <ErrorPanel error={onb.error} />;
  if (profile.error) return <ErrorPanel error={profile.error} />;
  const a = acc.data;
  const o = onb.data;
  const can = (p: string) => me.permissions.includes(p as never);
  const isSandbox = o.sandbox;
  const segments = (segList.data?.items ?? []).map((s) => ({ code: s.key, name: s.data.name }));
  const sb = sandbox.data;
  return (
    <>
      <Link
        href={`/accounts/${accountId}`}
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> {a.name}
      </Link>
      <PageHeader
        eyebrow="Account setup"
        title={isSandbox ? `${a.name}: sandbox` : 'Onboarding and configuration'}
        description={
          isSandbox
            ? 'A sandbox account for integration testing with synthetic data. Its transactions are not billed and send no email.'
            : 'Everything an account needs before it can sell: contract, licences, segment, plans, integration, billing basis, settlement, the variables it collects, and a tested sandbox.'
        }
        actions={
          <Badge tone={a.status === 'active' ? 'success' : 'warning'}>
            {sentenceCase(a.status)}
          </Badge>
        }
      />
      {live ? (
        <div className="mb-6">
          <Notice tone="success" title="The account is live">
            It is active and licence checks now apply: it can sell only in states where it holds an
            unexpired licence.
          </Notice>
        </div>
      ) : null}

      {!isSandbox ? (
        <Card className="mb-6">
          <CardHeader
            title="Checklist"
            description="Judged from what is configured, not ticked by hand. The account goes live only when every item is complete."
          />
          <ul className="divide-y divide-border">
            {o.items.map((i) => (
              <li key={i.item} className="flex items-start gap-3 px-5 py-3 text-sm">
                {i.complete ? (
                  <CheckCircle2
                    aria-label="Complete"
                    className="mt-0.5 size-4 shrink-0 text-success"
                  />
                ) : (
                  <CircleDashed aria-label="Open" className="mt-0.5 size-4 shrink-0 text-muted" />
                )}
                <div>
                  <p className="font-medium text-fg">{i.label}</p>
                  <p className="text-muted">{i.detail}</p>
                </div>
              </li>
            ))}
          </ul>
          {can('accounts:manage') && a.status === 'onboarding' ? (
            <div className="border-t border-border p-5">
              <GoLiveForm accountId={accountId} ready={o.complete} />
            </div>
          ) : null}
        </Card>
      ) : null}

      {!isSandbox ? (
        <>
          <Card className="mb-6">
            <CardHeader
              title="Profile"
              description="The contract, where the account sells, how it integrates, how it is billed and how it settles."
            />
            <div className="p-5">
              {can('accounts:manage') ? (
                <ProfileForm accountId={accountId} profile={profile.data} />
              ) : (
                <p className="text-sm text-muted">
                  You can view the profile; changing it needs the accounts:manage permission.
                </p>
              )}
            </div>
          </Card>

          <Card className="mb-6">
            <CardHeader
              title="Business segment"
              description="From the filed list. An underwriter other than the requester approves a change, and it applies from its date."
            />
            {segs.data?.items.length ? (
              <Table caption="Segment changes">
                <THead>
                  <tr>
                    <TH>Segment</TH>
                    <TH>From</TH>
                    <TH>Status</TH>
                    <TH>Reason</TH>
                    <TH>
                      <span className="sr-only">Decision</span>
                    </TH>
                  </tr>
                </THead>
                <tbody>
                  {segs.data.items.map((s) => (
                    <TR key={s.id}>
                      <TD>{s.segmentName ?? s.segment}</TD>
                      <TD>{s.effectiveFrom}</TD>
                      <TD>
                        <Badge
                          tone={
                            s.status === 'approved'
                              ? 'success'
                              : s.status === 'pending'
                                ? 'warning'
                                : 'neutral'
                          }
                        >
                          {sentenceCase(s.status)}
                        </Badge>
                      </TD>
                      <TD className="max-w-xs text-sm">{s.reason}</TD>
                      <TD>
                        {s.status === 'pending' && can('underwriting:approve') ? (
                          <DecideSegmentForm accountId={accountId} changeId={s.id} />
                        ) : null}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            ) : null}
            {can('accounts:manage') && segments.length ? (
              <div className="border-t border-border p-5">
                <SegmentForm accountId={accountId} segments={segments} />
              </div>
            ) : null}
          </Card>

          <Card className="mb-6">
            <CardHeader
              title="Rating variables the account collects"
              description={
                collected.data?.decided
                  ? `Recorded: ${collected.data.reason ?? ''}`
                  : 'Not decided yet: the engine treats every variable as collected.'
              }
            />
            <div className="p-5">
              {can('rating:manage') ? (
                <CollectedForm
                  accountId={accountId}
                  notCollected={collected.data?.notCollected ?? []}
                />
              ) : (
                <p className="text-sm text-muted">
                  {collected.data?.notCollected.length
                    ? `Does not collect: ${collected.data.notCollected.join(', ')}.`
                    : 'Collects every variable.'}{' '}
                  A rating analyst changes this.
                </p>
              )}
            </div>
          </Card>

          <Card className="mb-6">
            <CardHeader
              title="Licences and registrations"
              description="From go-live, the account sells in a state only while it holds an unexpired one there. Alerts go out 60 and 30 days before expiry."
            />
            {lics.data?.items.length ? (
              <Table caption="Licences and registrations">
                <THead>
                  <tr>
                    <TH>State</TH>
                    <TH>Kind</TH>
                    <TH>Number</TH>
                    <TH>Expires</TH>
                    <TH>Status</TH>
                    <TH>
                      <span className="sr-only">Revoke</span>
                    </TH>
                  </tr>
                </THead>
                <tbody>
                  {lics.data.items.map((l) => (
                    <TR key={l.id}>
                      <TD>{l.state}</TD>
                      <TD>{LICENCE_KIND_LABELS[l.kind]}</TD>
                      <TD className="font-mono text-xs">{l.number}</TD>
                      <TD>
                        {l.expiresOn}
                        <span className="block text-xs text-muted">
                          {l.daysLeft >= 0
                            ? `${l.daysLeft} days left`
                            : `expired ${-l.daysLeft} days ago`}
                        </span>
                      </TD>
                      <TD>
                        <Badge tone={l.inForce ? 'success' : 'danger'}>
                          {l.status === 'revoked'
                            ? 'Revoked'
                            : l.inForce
                              ? 'In force'
                              : 'Not in force'}
                        </Badge>
                      </TD>
                      <TD>
                        {can('licences:manage') && l.status === 'active' ? (
                          <RevokeLicenceForm licenceId={l.id} accountId={accountId} />
                        ) : null}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="p-5 text-sm text-muted">No licence or registration is recorded.</p>
            )}
            {can('licences:manage') ? (
              <div className="border-t border-border p-5">
                <LicenceForm accountId={accountId} />
              </div>
            ) : null}
          </Card>

          <Card className="mb-6">
            <CardHeader
              title="Contract documents"
              description="The Account Onboarding agent reads these to draft the profile, citing the wording each field comes from."
            />
            {docs.data?.items.length ? (
              <ul className="divide-y divide-border px-5 text-sm">
                {docs.data.items.map((d) => (
                  <li key={d.id} className="flex flex-wrap justify-between gap-2 py-2">
                    <span>
                      {sentenceCase(d.kind.replace('_', ' '))}: {d.fileName}
                    </span>
                    <span className="text-muted">
                      {d.pages} page{d.pages === 1 ? '' : 's'}, <LocalTime iso={d.uploadedAt} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {can('accounts:manage') ? (
              <div className="border-t border-border p-5">
                <UploadForm accountId={accountId} />
              </div>
            ) : null}
          </Card>

          {docs.data?.items.length ? (
            <AgentProposals
              subjectId={accountId}
              kind="account_onboarding"
              agentId="AG-05"
              agentName="Account Onboarding"
              question={`Draft the onboarding for account ${accountId} (${a.name}) from its contract and term sheet.`}
              askLabel="Ask for a draft"
              description="Reads the contract and term sheet and drafts the profile, each field with the wording it comes from. You approve, correct or reject every field; nothing is saved until you do."
              canAsk={can('agents:use') && can('proposals:create')}
              asked={asked}
            />
          ) : null}
        </>
      ) : null}

      {!isSandbox ? (
        <Card className="mb-6">
          <CardHeader
            title="Sandbox"
            description="A separate account for integration testing with synthetic data. The platform issues credentials through the identity provider and shows the secret once."
          />
          <div className="space-y-4 p-5">
            {sb?.accountId ? (
              <p className="text-sm text-fg">
                Sandbox account <span className="font-mono">{sb.code}</span>: {sb.quotes} quote
                {sb.quotes === 1 ? '' : 's'}, {sb.policies} polic{sb.policies === 1 ? 'y' : 'ies'}{' '}
                bound.
              </p>
            ) : null}
            {can('onboarding:sandbox') ? (
              <SandboxControls
                accountId={accountId}
                hasSandbox={!!sb?.accountId}
                credentials={sb?.credentials ?? []}
              />
            ) : (
              <p className="text-sm text-muted">
                Creating the sandbox needs the onboarding:sandbox permission.
              </p>
            )}
            {sb?.accountId ? <SandboxGuide accountId={sb.accountId} /> : null}
          </div>
        </Card>
      ) : null}
    </>
  );
}

/** Examples for quote, bind, change and cancel, with the sandbox account’s own values and synthetic travellers. */
function SandboxGuide({ accountId }: { accountId: string }) {
  const block = (title: string, body: string) => (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-fg">{title}</h3>
      <pre
        className="overflow-auto rounded-lg bg-surface-muted p-3 font-mono text-xs leading-relaxed text-fg"
        tabIndex={0}
      >
        {body}
      </pre>
    </div>
  );
  return (
    <div className="space-y-4 border-t border-border pt-4">
      <h3 className="text-base font-semibold text-fg">Using the sandbox</h3>
      <p className="text-sm text-muted">
        Get a token with your sandbox client (client credentials), then call the API with it. Use
        only the synthetic travellers below; nothing here is billed or emailed.
      </p>
      {block(
        '1. Quote',
        `POST /v1/quotes\n{ "accountId": "${accountId}", "planCode": "<plan code>", "state": "<state>",\n  "travellers": [{ "firstName": "Sam", "lastName": "Sandbox", "dateOfBirth": "1980-05-05", "costPerTraveller": "4200" }],\n  "trip": { "departureDate": "<date>", "returnDate": "<date>", "destinations": [{ "country": "FR", "region": "Europe" }] } }`,
      )}
      {block(
        '2. Bind (with an Idempotency-Key header)',
        `POST /v1/quotes/{quoteId}/bind\n{ "ableToTravel": true,\n  "acknowledgement": { "disclosureVersion": "<from the quote>", "acknowledgedBy": "Sam Sandbox" },\n  "payment": { "reference": "SANDBOX-0001", "amount": "<the quote's premium>" },\n  "purchaser": { "name": "Sam Sandbox" } }`,
      )}
      {block(
        '3. Change (preview, then confirm the price)',
        `POST /v1/policies/{policyId}/servicing/preview\n{ "type": "change_dates", "reason": "Flight moved", "departureDate": "<date>", "returnDate": "<date>" }\nPOST /v1/policies/{policyId}/servicing   (Idempotency-Key)\n{ "request": { ...the same request }, "confirmAmount": "<confirmAmount from the preview>" }`,
      )}
      {block(
        '4. Cancel',
        `POST /v1/policies/{policyId}/servicing/preview\n{ "type": "cancel", "reason": "Changed my mind", "noLoss": true }\nPOST /v1/policies/{policyId}/servicing   (Idempotency-Key)\n{ "request": { ...the same request }, "confirmAmount": "<the refund shown>" }`,
      )}
    </div>
  );
}
