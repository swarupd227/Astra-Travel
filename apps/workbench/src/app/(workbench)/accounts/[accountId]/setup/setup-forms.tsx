'use client';

import { useActionState } from 'react';
import { Check, KeyRound, Rocket, Upload, X } from 'lucide-react';
import {
  BILLING_BASES,
  INTEGRATION_LABELS,
  INTEGRATION_METHODS,
  LICENCE_KIND_LABELS,
  LICENCE_KINDS,
  RATING_INPUT_LABELS,
  RATING_INPUTS,
  type AccountProfile,
} from '@astra/contracts';
import { Field, FormMessage, Input, Select, SubmitButton, Textarea } from '@/components/ui/form';
import { Notice } from '@/components/ui/primitives';
import { idle } from '@/lib/actions';
import {
  addLicence,
  createSandbox,
  decideSegment,
  goLive,
  issueCredentials,
  requestSegment,
  revokeCredentials,
  revokeLicence,
  saveCollected,
  saveProfile,
  uploadContract,
  type CredentialState,
} from './actions';

const Hidden = ({ accountId }: { accountId: string }) => (
  <input type="hidden" name="accountId" value={accountId} />
);

export function ProfileForm({
  accountId,
  profile,
}: {
  accountId: string;
  profile: AccountProfile;
}) {
  const [state, action] = useActionState(saveProfile, idle);
  return (
    <form action={action} className="space-y-4">
      <Hidden accountId={accountId} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Contract reference">
          {(f) => (
            <Input
              id={f.id}
              name="contractReference"
              defaultValue={profile.contractReference ?? ''}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <Field label="Contract signed on">
          {(f) => (
            <Input
              id={f.id}
              name="contractSignedOn"
              type="date"
              defaultValue={profile.contractSignedOn ?? ''}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <Field label="States the account sells in" hint="Two-letter codes, separated by commas.">
          {(f) => (
            <Input
              id={f.id}
              name="states"
              defaultValue={profile.states.join(', ')}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <Field label="Plans" hint="Plan codes, separated by commas.">
          {(f) => (
            <Input
              id={f.id}
              name="plans"
              defaultValue={profile.plans.join(', ')}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <Field label="Integration method">
          {(f) => (
            <Select
              id={f.id}
              name="integrationMethod"
              defaultValue={profile.integrationMethod ?? ''}
              aria-describedby={f.describedBy}
            >
              <option value="">Not chosen</option>
              {INTEGRATION_METHODS.map((m) => (
                <option key={m} value={m}>
                  {INTEGRATION_LABELS[m]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Billing basis">
          {(f) => (
            <Select
              id={f.id}
              name="basis"
              defaultValue={profile.rateBasis?.basis ?? ''}
              aria-describedby={f.describedBy}
            >
              <option value="">Not agreed</option>
              {BILLING_BASES.map((b) => (
                <option key={b} value={b}>
                  {b.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Limit for a per-$100-of-limit basis">
          {(f) => (
            <Input
              id={f.id}
              name="limit"
              inputMode="decimal"
              defaultValue={profile.rateBasis?.limit ?? ''}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <Field label="Fixed fee per policy">
          {(f) => (
            <Input
              id={f.id}
              name="fixedFeePerPolicy"
              inputMode="decimal"
              defaultValue={profile.rateBasis?.fixedFeePerPolicy ?? ''}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <Field label="Settlement terms" hint="In the contract’s words.">
          {(f) => (
            <Input
              id={f.id}
              name="settlement"
              defaultValue={profile.settlement?.description ?? ''}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <Field label="Days to pay">
          {(f) => (
            <Input
              id={f.id}
              name="paymentDays"
              inputMode="numeric"
              defaultValue={profile.settlement?.paymentDays ?? ''}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
      </div>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Saving…">Save the profile</SubmitButton>
    </form>
  );
}

export function SegmentForm({
  accountId,
  segments,
}: {
  accountId: string;
  segments: { code: string; name: string }[];
}) {
  const [state, action] = useActionState(requestSegment, idle);
  return (
    <form action={action} className="space-y-4">
      <Hidden accountId={accountId} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Business segment" hint="From the filed list.">
          {(f) => (
            <Select id={f.id} name="segment" required aria-describedby={f.describedBy}>
              {segments.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Applies from">
          {(f) => (
            <Input
              id={f.id}
              name="effectiveFrom"
              type="date"
              required
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
      </div>
      <Field label="Reason">
        {(f) => (
          <Textarea
            id={f.id}
            name="reason"
            required
            minLength={3}
            maxLength={500}
            aria-describedby={f.describedBy}
          />
        )}
      </Field>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Requesting…">Request this segment</SubmitButton>
    </form>
  );
}

export function DecideSegmentForm({
  accountId,
  changeId,
}: {
  accountId: string;
  changeId: string;
}) {
  const [state, action] = useActionState(decideSegment, idle);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <Hidden accountId={accountId} />
      <input type="hidden" name="changeId" value={changeId} />
      <input
        name="note"
        aria-label="Note for the decision"
        placeholder="Note"
        className="h-9 rounded-lg border border-border-strong bg-surface px-3 text-sm"
      />
      <button
        name="decision"
        value="approve"
        className="inline-flex h-9 items-center gap-1 rounded-lg bg-primary px-3 text-sm font-medium text-primary-fg"
      >
        <Check aria-hidden className="size-4" /> Approve
      </button>
      <button
        name="decision"
        value="decline"
        className="inline-flex h-9 items-center gap-1 rounded-lg border border-border-strong bg-surface px-3 text-sm font-medium text-fg"
      >
        <X aria-hidden className="size-4" /> Decline
      </button>
      <FormMessage state={state} />
    </form>
  );
}

export function CollectedForm({
  accountId,
  notCollected,
}: {
  accountId: string;
  notCollected: string[];
}) {
  const [state, action] = useActionState(saveCollected, idle);
  return (
    <form action={action} className="space-y-4">
      <Hidden accountId={accountId} />
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-fg">
          Variables the account does NOT collect
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {RATING_INPUTS.map((r) => (
            <label key={r} className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                name="notCollected"
                value={r}
                defaultChecked={notCollected.includes(r)}
                className="size-4"
              />
              {RATING_INPUT_LABELS[r]}
            </label>
          ))}
        </div>
      </fieldset>
      <Field label="Reason">
        {(f) => (
          <Input id={f.id} name="reason" required minLength={3} aria-describedby={f.describedBy} />
        )}
      </Field>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Saving…">Record this</SubmitButton>
    </form>
  );
}

export function LicenceForm({ accountId }: { accountId: string }) {
  const [state, action] = useActionState(addLicence, idle);
  return (
    <form action={action} className="space-y-4">
      <Hidden accountId={accountId} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Kind">
          {(f) => (
            <Select id={f.id} name="kind" aria-describedby={f.describedBy}>
              {LICENCE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {LICENCE_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="State">
          {(f) => (
            <Input id={f.id} name="state" maxLength={2} required aria-describedby={f.describedBy} />
          )}
        </Field>
        <Field label="Number">
          {(f) => <Input id={f.id} name="number" required aria-describedby={f.describedBy} />}
        </Field>
        <Field label="Holder">
          {(f) => <Input id={f.id} name="holder" required aria-describedby={f.describedBy} />}
        </Field>
        <Field label="Valid from">
          {(f) => (
            <Input
              id={f.id}
              name="validFrom"
              type="date"
              required
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <Field label="Expires on">
          {(f) => (
            <Input
              id={f.id}
              name="expiresOn"
              type="date"
              required
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
      </div>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Recording…">Record this licence</SubmitButton>
    </form>
  );
}

export function RevokeLicenceForm({
  licenceId,
  accountId,
}: {
  licenceId: string;
  accountId?: string;
}) {
  const [state, action] = useActionState(revokeLicence, idle);
  return (
    <form action={action} className="flex items-center gap-2">
      {accountId ? <Hidden accountId={accountId} /> : null}
      <input type="hidden" name="licenceId" value={licenceId} />
      <input
        name="reason"
        aria-label="Reason for revoking"
        placeholder="Reason"
        required
        minLength={3}
        className="h-8 rounded-lg border border-border-strong bg-surface px-2 text-sm"
      />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Revoking…">
        Revoke
      </SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}

export function UploadForm({ accountId }: { accountId: string }) {
  const [state, action] = useActionState(uploadContract, idle);
  return (
    <form action={action} className="space-y-3">
      <Hidden accountId={accountId} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Document">
          {(f) => (
            <Select id={f.id} name="kind" aria-describedby={f.describedBy}>
              <option value="contract">Contract</option>
              <option value="term_sheet">Term sheet</option>
            </Select>
          )}
        </Field>
        <Field label="File" hint="PDF with a text layer, or plain text.">
          {(f) => (
            <Input
              id={f.id}
              name="file"
              type="file"
              accept="application/pdf,text/plain"
              required
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
      </div>
      <FormMessage state={state} />
      <SubmitButton variant="secondary" pendingLabel="Uploading…">
        <Upload aria-hidden className="size-4" /> Upload
      </SubmitButton>
    </form>
  );
}

export function SandboxControls({
  accountId,
  hasSandbox,
  credentials,
}: {
  accountId: string;
  hasSandbox: boolean;
  credentials: { clientId: string; revokedAt: string | null }[];
}) {
  const [created, create] = useActionState(createSandbox, idle);
  const [issued, issue] = useActionState<CredentialState, FormData>(issueCredentials, idle);
  const [revoked, revoke] = useActionState(revokeCredentials, idle);
  return (
    <div className="space-y-4">
      {!hasSandbox ? (
        <form action={create} className="space-y-2">
          <Hidden accountId={accountId} />
          <FormMessage state={created} />
          <SubmitButton pendingLabel="Creating…">Create the sandbox</SubmitButton>
        </form>
      ) : (
        <>
          <form action={issue} className="space-y-2">
            <Hidden accountId={accountId} />
            <SubmitButton variant="secondary" pendingLabel="Issuing…">
              <KeyRound aria-hidden className="size-4" /> Issue sandbox credentials
            </SubmitButton>
            {issued.status === 'error' ? <FormMessage state={issued} /> : null}
          </form>
          {issued.status === 'success' && issued.secret ? (
            <Notice tone="warning" title="Copy the secret now">
              <p className="mb-2">{issued.message}</p>
              <dl className="space-y-1 font-mono text-xs">
                <div>Client ID: {issued.secret.clientId}</div>
                <div>Client secret: {issued.secret.clientSecret}</div>
                <div>Token URL: {issued.secret.tokenUrl}</div>
              </dl>
            </Notice>
          ) : null}
          {credentials.length ? (
            <ul className="divide-y divide-border text-sm">
              {credentials.map((c) => (
                <li
                  key={c.clientId}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span className="font-mono text-xs">{c.clientId}</span>
                  {c.revokedAt ? (
                    <span className="text-muted">Revoked</span>
                  ) : (
                    <form action={revoke}>
                      <Hidden accountId={accountId} />
                      <input type="hidden" name="clientId" value={c.clientId} />
                      <SubmitButton variant="secondary" size="sm" pendingLabel="Revoking…">
                        Revoke
                      </SubmitButton>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          <FormMessage state={revoked} />
        </>
      )}
    </div>
  );
}

export function GoLiveForm({ accountId, ready }: { accountId: string; ready: boolean }) {
  const [state, action] = useActionState(goLive, idle);
  return (
    <form action={action} className="space-y-3">
      <Hidden accountId={accountId} />
      <Field label="Note" hint="Kept with the decision to go live.">
        {(f) => (
          <Input id={f.id} name="note" required minLength={3} aria-describedby={f.describedBy} />
        )}
      </Field>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Going live…" disabled={!ready}>
        <Rocket aria-hidden className="size-4" /> Take the account live
      </SubmitButton>
      {!ready ? (
        <p className="text-sm text-muted">Every item of the checklist must be complete first.</p>
      ) : null}
    </form>
  );
}
