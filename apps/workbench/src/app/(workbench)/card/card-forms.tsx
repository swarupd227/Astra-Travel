'use client';

import { useActionState, useState } from 'react';
import { CheckCircle2, Plus, Rocket, Search, Upload, XCircle } from 'lucide-react';
import {
  PROGRAMME_STATUS_TRANSITIONS,
  type CardProgramme,
  type EligibilityAnswer,
} from '@astra/contracts';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, FormMessage, Input, Select, SubmitButton, Textarea } from '@/components/ui/form';
import { Badge, DescriptionList } from '@/components/ui/primitives';
import { idle, previous } from '@/lib/actions';
import { paymentConditionLabel, sentenceCase } from '@/lib/format';
import {
  changeProgrammeStatus,
  checkEligibility,
  createMasterPolicy,
  createProgramme,
  goLive,
  rejectFeed,
  uploadFeed,
  verifyCover,
  type CoverState,
  type EligibilityState,
} from './actions';

const today = () => new Date().toISOString().slice(0, 10);

function ReasonField({ state, hint }: { state: Parameters<typeof previous>[0]; hint?: string }) {
  const errors = state.status === 'error' ? state.fieldErrors : {};
  return (
    <Field
      label="Reason"
      required
      hint={hint ?? 'At least 5 characters. Recorded in the audit trail.'}
      error={errors.reason}
    >
      {(f) => (
        <Textarea
          id={f.id}
          name="reason"
          defaultValue={previous(state, 'reason')}
          required
          minLength={5}
          maxLength={500}
          aria-invalid={f.invalid}
          aria-describedby={f.describedBy}
        />
      )}
    </Field>
  );
}

// ---------------------------------------------------------------- Master policies

export function CreateMasterPolicyDialog({
  accounts,
}: {
  accounts: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(createMasterPolicy, idle);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const errors = state.status === 'error' ? state.fieldErrors : {};
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setKey(crypto.randomUUID());
      }}
      title="Register a master policy"
      description="The group policy Assurant issued to a card issuer or bank. Card programmes run under it."
      trigger={
        <Button>
          <Plus aria-hidden className="size-4" /> Register master policy
        </Button>
      }
    >
      <form action={action} className="space-y-4" noValidate>
        <input type="hidden" name="idempotencyKey" value={key} />
        <Field
          label="Policyholder"
          required
          error={errors.accountId}
          hint={accounts.length ? undefined : 'Register the issuer or bank as an account first.'}
        >
          {(f) => (
            <Select
              id={f.id}
              name="accountId"
              required
              defaultValue={previous(state, 'accountId')}
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Policy number"
            required
            error={errors.policyNumber}
            hint="3 to 40 capital letters, digits or -."
          >
            {(f) => (
              <Input
                id={f.id}
                name="policyNumber"
                required
                defaultValue={previous(state, 'policyNumber')}
                className="font-mono uppercase"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
          <Field label="Underwriter" required error={errors.underwriter}>
            {(f) => (
              <Select
                id={f.id}
                name="underwriter"
                required
                defaultValue={previous(state, 'underwriter') ?? 'VSC'}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              >
                <option value="VSC">Virginia Surety Company (VSC)</option>
                <option value="ABIC">American Bankers Insurance Company (ABIC)</option>
              </Select>
            )}
          </Field>
        </div>
        <Field
          label="States"
          required
          error={errors.states}
          hint="Two-letter codes separated by commas, for example NY, CA, TX."
        >
          {(f) => (
            <Input
              id={f.id}
              name="states"
              required
              defaultValue={previous(state, 'states')}
              className="uppercase"
              autoComplete="off"
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Effective from" required error={errors.effectiveFrom}>
            {(f) => (
              <Input
                id={f.id}
                type="date"
                name="effectiveFrom"
                required
                defaultValue={previous(state, 'effectiveFrom')}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
          <Field label="Effective to" error={errors.effectiveTo} hint="Leave empty if open-ended.">
            {(f) => (
              <Input
                id={f.id}
                type="date"
                name="effectiveTo"
                defaultValue={previous(state, 'effectiveTo')}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
        </div>
        <FormMessage state={state} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
          <SubmitButton pendingLabel="Registering…">Register master policy</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Programmes

export function CreateProgrammeDialog({
  policies,
}: {
  policies: { id: string; policyNumber: string; accountName: string; states: string[] }[];
}) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(createProgramme, idle);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [rule, setRule] = useState(previous(state, 'paymentRule') ?? 'full');
  const [policyId, setPolicyId] = useState(policies[0]?.id ?? '');
  const policy = policies.find((p) => p.id === policyId);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setKey(crypto.randomUUID());
      }}
      title="Set up a card programme"
      description="The programme starts in draft. It goes live once a test feed from the issuer has passed."
      trigger={
        <Button>
          <Plus aria-hidden className="size-4" /> Set up programme
        </Button>
      }
    >
      <form action={action} className="space-y-4" noValidate>
        <input type="hidden" name="idempotencyKey" value={key} />
        <Field
          label="Master policy"
          required
          error={errors.masterPolicyId}
          hint={policies.length ? undefined : 'Register a master policy first.'}
        >
          {(f) => (
            <Select
              id={f.id}
              name="masterPolicyId"
              required
              value={policyId}
              onChange={(e) => setPolicyId(e.target.value)}
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            >
              {policies.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.policyNumber} · {p.accountName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Programme name" required error={errors.name}>
            {(f) => (
              <Input
                id={f.id}
                name="name"
                required
                minLength={2}
                maxLength={200}
                defaultValue={previous(state, 'name')}
                autoComplete="off"
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
          <Field
            label="Programme code"
            required
            error={errors.code}
            hint="Appears in feed headers and certificate numbers."
          >
            {(f) => (
              <Input
                id={f.id}
                name="code"
                required
                defaultValue={previous(state, 'code')}
                className="font-mono uppercase"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Card product" required error={errors.cardProduct}>
            {(f) => (
              <Input
                id={f.id}
                name="cardProduct"
                required
                defaultValue={previous(state, 'cardProduct')}
                autoComplete="off"
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
          <Field
            label="States"
            required
            error={errors.states}
            hint={
              policy
                ? `On the master policy: ${policy.states.join(', ')}`
                : 'Two-letter codes, comma-separated.'
            }
          >
            {(f) => (
              <Input
                id={f.id}
                name="states"
                required
                defaultValue={previous(state, 'states') ?? policy?.states.join(', ')}
                className="uppercase"
                autoComplete="off"
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Effective from" required error={errors.effectiveFrom}>
            {(f) => (
              <Input
                id={f.id}
                type="date"
                name="effectiveFrom"
                required
                defaultValue={previous(state, 'effectiveFrom')}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
          <Field label="Effective to" error={errors.effectiveTo} hint="Leave empty if open-ended.">
            {(f) => (
              <Input
                id={f.id}
                type="date"
                name="effectiveTo"
                defaultValue={previous(state, 'effectiveTo')}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
        </div>
        <fieldset className="space-y-3 rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-medium text-fg">Cover conditions</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Payment condition" required error={errors['paymentCondition.rule']}>
              {(f) => (
                <Select
                  id={f.id}
                  name="paymentRule"
                  value={rule}
                  onChange={(e) => setRule(e.target.value)}
                  aria-invalid={f.invalid}
                  aria-describedby={f.describedBy}
                >
                  <option value="full">Full trip cost paid with the card</option>
                  <option value="partial">Part of the trip cost paid with the card</option>
                  <option value="none">No payment condition</option>
                </Select>
              )}
            </Field>
            {rule === 'partial' ? (
              <Field
                label="Minimum share paid with the card (%)"
                required
                error={errors['paymentCondition.minimumPercent']}
              >
                {(f) => (
                  <Input
                    id={f.id}
                    type="number"
                    name="minimumPercent"
                    min={1}
                    max={100}
                    required
                    defaultValue={previous(state, 'minimumPercent') ?? '50'}
                    aria-invalid={f.invalid}
                    aria-describedby={f.describedBy}
                  />
                )}
              </Field>
            ) : null}
          </div>
          <Field label="Eligibility rule" required error={errors.eligibilityRule}>
            {(f) => (
              <Select
                id={f.id}
                name="eligibilityRule"
                defaultValue={previous(state, 'eligibilityRule') ?? 'purchase_date'}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              >
                <option value="purchase_date">Account eligible on the trip purchase date</option>
                <option value="purchase_and_loss_date">
                  Account eligible on the purchase date and on the loss date
                </option>
              </Select>
            )}
          </Field>
          <Field
            label="Reject threshold (%)"
            error={errors.maxRejectPercent}
            hint="A feed with a larger share of rejected records is held and nothing in it is applied."
          >
            {(f) => (
              <Input
                id={f.id}
                type="number"
                name="maxRejectPercent"
                min={0}
                max={50}
                step="0.1"
                defaultValue={previous(state, 'maxRejectPercent') ?? '1'}
                className="max-w-32"
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
        </fieldset>
        <FormMessage state={state} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <SubmitButton pendingLabel="Setting up…">Set up programme</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

export function GoLiveDialog({
  programmeId,
  testPassed,
}: {
  programmeId: string;
  testPassed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(goLive, idle);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Take the programme live"
      description={
        testPassed
          ? 'Live eligibility feeds will be accepted and applied. The first live feed must be a full feed.'
          : 'A programme goes live only after a test feed from the issuer has passed. Upload a test feed first.'
      }
      trigger={
        <Button>
          <Rocket aria-hidden className="size-4" /> Go live
        </Button>
      }
    >
      {state.status === 'success' ? (
        <div className="space-y-4">
          <FormMessage state={state} />
          <div className="flex justify-end">
            <Button onClick={() => setOpen(false)}>Done</Button>
          </div>
        </div>
      ) : (
        <form action={action} className="space-y-4">
          <input type="hidden" name="programmeId" value={programmeId} />
          <ReasonField
            state={state}
            hint="For example, who approved go-live. Recorded in the audit trail."
          />
          <FormMessage state={state} />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton pendingLabel="Going live…">Go live</SubmitButton>
          </div>
        </form>
      )}
    </Dialog>
  );
}

export function ProgrammeStatusDialog({
  programmeId,
  current,
}: {
  programmeId: string;
  current: CardProgramme['status'];
}) {
  const options = PROGRAMME_STATUS_TRANSITIONS[current];
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(changeProgrammeStatus, idle);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  if (options.length === 0) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Change programme status"
      description="Suspending stops new feeds from being applied; cardholders already eligible keep their cover."
      trigger={<Button variant="secondary">Change status</Button>}
    >
      <form action={action} className="space-y-4">
        <input type="hidden" name="programmeId" value={programmeId} />
        <Field label="New status" required error={errors.status}>
          {(f) => (
            <Select
              id={f.id}
              name="status"
              defaultValue={previous(state, 'status')}
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            >
              {options.map((s) => (
                <option key={s} value={s}>
                  {s === 'live' ? 'Live (resume)' : sentenceCase(s)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <ReasonField state={state} />
        <FormMessage state={state} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
          <SubmitButton>Change status</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Feeds

export function UploadFeedForm({
  programmeId,
  liveAllowed,
}: {
  programmeId: string;
  liveAllowed: boolean;
}) {
  const [state, action] = useActionState(uploadFeed, idle);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  return (
    <form action={action} className="space-y-4 p-5" aria-label="Upload an eligibility feed">
      <input type="hidden" name="programmeId" value={programmeId} />
      <Field
        label="Feed file"
        required
        error={errors.file}
        hint="Format v1 (pipe-separated). Up to 100 MB here; larger feeds go through the API or SFTP."
      >
        {(f) => (
          <Input
            id={f.id}
            type="file"
            name="file"
            required
            accept=".txt,.dat,.psv,text/plain"
            className="py-2 file:mr-3 file:rounded-md file:border-0 file:bg-surface-muted file:px-3 file:py-1 file:text-sm"
            aria-invalid={f.invalid}
            aria-describedby={f.describedBy}
          />
        )}
      </Field>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-fg">Mode</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="inline-flex items-center gap-2">
            <input
              type="radio"
              name="mode"
              value="test"
              defaultChecked={!liveAllowed || previous(state, 'mode') === 'test'}
            />
            Test (checked, never applied)
          </label>
          <label
            className={
              liveAllowed
                ? 'inline-flex items-center gap-2'
                : 'inline-flex items-center gap-2 text-muted'
            }
          >
            <input
              type="radio"
              name="mode"
              value="live"
              disabled={!liveAllowed}
              defaultChecked={liveAllowed && previous(state, 'mode') !== 'test'}
            />
            Live {liveAllowed ? '' : '(after go-live)'}
          </label>
        </div>
      </fieldset>
      <FormMessage state={state} />
      <div className="flex justify-end">
        <SubmitButton pendingLabel="Uploading…">
          <Upload aria-hidden className="size-4" /> Upload feed
        </SubmitButton>
      </div>
    </form>
  );
}

export function RejectFeedDialog({ programmeId, feedId }: { programmeId: string; feedId: string }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(rejectFeed, idle);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Reject this feed"
      description="Nothing in it was applied. Rejecting it frees its sequence number so the issuer can send a corrected file."
      trigger={<Button variant="danger">Reject feed</Button>}
    >
      {state.status === 'success' ? (
        <div className="space-y-4">
          <FormMessage state={state} />
          <div className="flex justify-end">
            <Button onClick={() => setOpen(false)}>Done</Button>
          </div>
        </div>
      ) : (
        <form action={action} className="space-y-4">
          <input type="hidden" name="programmeId" value={programmeId} />
          <input type="hidden" name="feedId" value={feedId} />
          <ReasonField state={state} />
          <FormMessage state={state} />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton variant="danger" pendingLabel="Rejecting…">
              Reject feed
            </SubmitButton>
          </div>
        </form>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- Eligibility and cover

function EligibilityResult({ title, answer }: { title: string; answer: EligibilityAnswer }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-fg">{title}</p>
        <Badge tone={answer.eligible ? 'success' : 'danger'}>
          {answer.eligible ? 'Eligible' : 'Not eligible'}
        </Badge>
      </div>
      <DescriptionList
        items={[
          { term: 'Date', value: answer.date },
          { term: 'Card product', value: answer.productCode ?? '—' },
          {
            term: 'Eligibility period',
            value: answer.period
              ? `${answer.period.from} to ${answer.period.to ?? 'open-ended'}`
              : '—',
          },
          {
            term: 'Supported by feed',
            value: answer.supportedByFeed
              ? `Sequence ${answer.supportedByFeed.sequence ?? '—'}, as of ${answer.supportedByFeed.asOfDate ?? '—'}`
              : 'No feed covers this date',
          },
          { term: 'Programme in force', value: answer.programmeInForce ? 'Yes' : 'No' },
        ]}
      />
    </div>
  );
}

/** The last submitted value: after an error, or after an answer so the next check can adjust it. */
function value(state: EligibilityState | CoverState, name: string): string | undefined {
  return state.status === 'success' ? state.kept?.[name]?.[0] : previous(state, name);
}

export function EligibilityCheckForm({ programmeId }: { programmeId: string }) {
  const [state, action] = useActionState<EligibilityState, FormData>(checkEligibility, idle);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  return (
    <div className="space-y-4 p-5">
      <form
        action={action}
        className="grid gap-4 sm:grid-cols-[1fr_auto_auto] sm:items-end"
        aria-label="Check eligibility"
      >
        <input type="hidden" name="programmeId" value={programmeId} />
        <Field
          label="Account reference"
          required
          error={errors.accountRef}
          hint="The issuer's token, never a card number."
        >
          {(f) => (
            <Input
              id={f.id}
              name="accountRef"
              required
              defaultValue={value(state, 'accountRef')}
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <Field label="Date" required error={errors.date}>
          {(f) => (
            <Input
              id={f.id}
              type="date"
              name="date"
              required
              defaultValue={value(state, 'date') ?? today()}
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <SubmitButton variant="secondary" pendingLabel="Checking…" className="mb-[22px]">
          <Search aria-hidden className="size-4" /> Check
        </SubmitButton>
      </form>
      {state.status === 'error' ? <FormMessage state={state} /> : null}
      {state.status === 'success' && state.answer ? (
        <div aria-live="polite">
          <EligibilityResult title="Answer" answer={state.answer} />
        </div>
      ) : null}
    </div>
  );
}

export function CoverCheckForm({ programmes }: { programmes: { code: string; name: string }[] }) {
  const [state, action] = useActionState<CoverState, FormData>(verifyCover, idle);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  const result = state.status === 'success' ? state.result : undefined;
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <form action={action} className="space-y-4 lg:col-span-2" aria-label="Verify cover">
        <Field label="Programme" required error={errors.programmeCode}>
          {(f) => (
            <Select
              id={f.id}
              name="programmeCode"
              required
              defaultValue={value(state, 'programmeCode')}
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            >
              {programmes.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name} ({p.code})
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Account reference"
          required
          error={errors.accountRef}
          hint="The issuer's token for the cardholder account, never the card number."
        >
          {(f) => (
            <Input
              id={f.id}
              name="accountRef"
              required
              defaultValue={value(state, 'accountRef')}
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Trip purchase date" required error={errors.purchaseDate}>
            {(f) => (
              <Input
                id={f.id}
                type="date"
                name="purchaseDate"
                required
                defaultValue={value(state, 'purchaseDate')}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
          <Field label="Loss date" required error={errors.lossDate}>
            {(f) => (
              <Input
                id={f.id}
                type="date"
                name="lossDate"
                required
                defaultValue={value(state, 'lossDate')}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
        </div>
        <fieldset className="space-y-3 rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-medium text-fg">
            Payment (if the programme has a payment condition)
          </legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Trip cost (USD)" error={errors['payment.tripCost']}>
              {(f) => (
                <Input
                  id={f.id}
                  name="tripCost"
                  inputMode="decimal"
                  defaultValue={value(state, 'tripCost')}
                  aria-invalid={f.invalid}
                  aria-describedby={f.describedBy}
                />
              )}
            </Field>
            <Field label="Paid with the card (USD)" error={errors['payment.amountPaidWithAccount']}>
              {(f) => (
                <Input
                  id={f.id}
                  name="amountPaidWithAccount"
                  inputMode="decimal"
                  defaultValue={value(state, 'amountPaidWithAccount')}
                  aria-invalid={f.invalid}
                  aria-describedby={f.describedBy}
                />
              )}
            </Field>
          </div>
        </fieldset>
        {state.status === 'error' ? <FormMessage state={state} /> : null}
        <div className="flex justify-end">
          <SubmitButton pendingLabel="Verifying…">Verify cover</SubmitButton>
        </div>
      </form>

      <div className="lg:col-span-3" aria-live="polite">
        {result ? (
          <div className="space-y-4">
            <div
              className={`flex items-start gap-3 rounded-xl border p-5 ${result.covered ? 'border-success/30 bg-success-soft' : 'border-danger/30 bg-danger-soft'}`}
            >
              {result.covered ? (
                <CheckCircle2 aria-hidden className="mt-0.5 size-6 text-success" />
              ) : (
                <XCircle aria-hidden className="mt-0.5 size-6 text-danger" />
              )}
              <div>
                <p className="text-lg font-semibold text-fg">
                  {result.covered ? 'Covered' : 'Not covered'}
                </p>
                <p className="text-sm text-muted">
                  {result.programme.name} · master policy {result.masterPolicy.policyNumber} (
                  {result.masterPolicy.underwriter})
                  {result.certificateNumber ? ` · certificate ${result.certificateNumber}` : ''}
                </p>
                {result.reasons.length ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-fg">
                    {result.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
            <EligibilityResult title="On the purchase date" answer={result.onPurchaseDate} />
            <EligibilityResult title="On the loss date" answer={result.onLossDate} />
            <div className="rounded-lg border border-border p-4 text-sm">
              <p className="font-semibold text-fg">Payment condition</p>
              <p className="mt-1 text-muted">
                {paymentConditionLabel(result.paymentCondition.rule)}
              </p>
              <p className="mt-1 text-fg">{result.paymentCondition.explanation}</p>
            </div>
          </div>
        ) : (
          <div className="flex h-full min-h-40 items-center justify-center rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">
            The answer appears here, with the feed versions behind it. Every verification is
            recorded in the audit trail.
          </div>
        )}
      </div>
    </div>
  );
}
