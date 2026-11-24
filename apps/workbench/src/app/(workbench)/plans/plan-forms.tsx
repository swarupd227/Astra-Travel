'use client';

import { useActionState, useState } from 'react';
import { FilePlus2, FlaskConical, Play, Plus, Rocket, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, FormMessage, Input, Select, SubmitButton, Textarea } from '@/components/ui/form';
import { idle, previous } from '@/lib/actions';
import { approveVersion, createPlan, publishVersion, removeTestCase, runTests, saveTestCase, startDraft } from './actions';

export interface PlanOption {
  id: string;
  label: string;
}

export function NewPlanDialog({
  catalogues,
  basePlans,
  statePlans,
  accounts,
}: {
  catalogues: PlanOption[];
  basePlans: PlanOption[];
  statePlans: PlanOption[];
  accounts: PlanOption[];
}) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(createPlan, idle);
  const [kind, setKind] = useState(previous(state, 'kind') ?? 'base');
  const errors = state.status === 'error' ? state.fieldErrors : {};
  const parents = kind === 'state' ? basePlans : statePlans;
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      wide
      title="New plan"
      description="A base plan is a template built from an approved benefit catalogue. A state plan adapts an approved base plan for one state and is what gets published. An account plan adapts a published state plan for one account, within the base plan's bounds."
      trigger={
        <Button>
          <Plus aria-hidden className="size-4" /> New plan
        </Button>
      }
    >
      <form action={action} className="space-y-4" noValidate>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-fg">Kind of plan</legend>
          <div className="flex flex-wrap gap-4">
            {[
              ['base', 'Base plan'],
              ['state', 'State plan'],
              ['account', 'Account plan'],
            ].map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input type="radio" name="kind" value={value} checked={kind === value} onChange={() => setKind(value!)} />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Plan code" required error={errors.code} hint="Capital letters, digits and hyphens, for example TC-DE-0426.">
            {(f) => (
              <Input
                id={f.id}
                name="code"
                required
                defaultValue={previous(state, 'code')}
                className="font-mono uppercase"
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
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
        </div>
        <Field label="Plan name" required error={errors.name}>
          {(f) => <Input id={f.id} name="name" required defaultValue={previous(state, 'name')} aria-invalid={f.invalid} aria-describedby={f.describedBy} />}
        </Field>
        {kind === 'base' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Benefit catalogue" required error={errors.catalogueId} hint={catalogues.length ? undefined : 'No catalogue is approved yet.'}>
              {(f) => (
                <Select id={f.id} name="catalogueId" required defaultValue={previous(state, 'catalogueId')} aria-invalid={f.invalid} aria-describedby={f.describedBy}>
                  <option value="">Choose…</option>
                  {catalogues.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Term" required error={errors.term}>
              {(f) => (
                <Select id={f.id} name="term" defaultValue={previous(state, 'term') ?? 'single_trip'} aria-invalid={f.invalid} aria-describedby={f.describedBy}>
                  <option value="single_trip">Single trip</option>
                  <option value="annual">Annual</option>
                </Select>
              )}
            </Field>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={kind === 'state' ? 'Base plan' : 'State plan'}
              required
              error={errors.parentPlanId}
              hint={parents.length ? undefined : kind === 'state' ? 'No base plan has an approved version yet.' : 'No state plan is published yet.'}
            >
              {(f) => (
                <Select id={f.id} name="parentPlanId" required defaultValue={previous(state, 'parentPlanId')} aria-invalid={f.invalid} aria-describedby={f.describedBy}>
                  <option value="">Choose…</option>
                  {parents.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {kind === 'state' ? (
              <Field label="State" required error={errors.state} hint="Two-letter code, for example DE.">
                {(f) => (
                  <Input
                    id={f.id}
                    name="state"
                    required
                    maxLength={2}
                    defaultValue={previous(state, 'state')}
                    className="uppercase"
                    aria-invalid={f.invalid}
                    aria-describedby={f.describedBy}
                  />
                )}
              </Field>
            ) : (
              <Field label="Account" required error={errors.accountId}>
                {(f) => (
                  <Select id={f.id} name="accountId" required defaultValue={previous(state, 'accountId')} aria-invalid={f.invalid} aria-describedby={f.describedBy}>
                    <option value="">Choose…</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
          </div>
        )}
        <FormMessage state={state} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <SubmitButton pendingLabel="Creating…">Create plan</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

export function ApproveVersionForm({ versionId }: { versionId: string }) {
  const [state, action] = useActionState(approveVersion, idle);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="versionId" value={versionId} />
      <Field label="What you checked" required error={state.status === 'error' ? state.fieldErrors.note : undefined}>
        {(f) => <Textarea id={f.id} name="note" required minLength={5} maxLength={500} aria-invalid={f.invalid} aria-describedby={f.describedBy} />}
      </Field>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Approving…">Approve version</SubmitButton>
    </form>
  );
}

export function PublishVersionForm({ versionId, ready }: { versionId: string; ready: boolean }) {
  const [state, action] = useActionState(publishVersion, idle);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="versionId" value={versionId} />
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Publishing…" disabled={!ready}>
        <Rocket aria-hidden className="size-4" /> Publish
      </SubmitButton>
      {!ready ? <p className="text-xs text-muted">Every check above must pass first.</p> : null}
    </form>
  );
}

export function StartDraftForm({ planId }: { planId: string }) {
  const [state, action] = useActionState(startDraft, idle);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="planId" value={planId} />
      <Field label="New version effective from" required error={state.status === 'error' ? state.fieldErrors.effectiveFrom : undefined}>
        {(f) => <Input id={f.id} type="date" name="effectiveFrom" required aria-invalid={f.invalid} aria-describedby={f.describedBy} />}
      </Field>
      <SubmitButton pendingLabel="Starting…" variant="secondary">
        <FilePlus2 aria-hidden className="size-4" /> Start a new draft
      </SubmitButton>
      <div className="basis-full">
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function RunTestsForm({ versionId, cases }: { versionId: string; cases: number }) {
  const [state, action] = useActionState(runTests, idle);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="versionId" value={versionId} />
      <SubmitButton pendingLabel="Rating the test cases…" variant="secondary" disabled={cases === 0}>
        <Play aria-hidden className="size-4" /> Run {cases} test case{cases === 1 ? '' : 's'}
      </SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}

export function TestCaseDialog({ planId }: { planId: string }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(saveTestCase, idle);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  const err = (prefix: string) => Object.entries(errors).find(([k]) => k.startsWith(prefix))?.[1];
  const keep = (name: string, fallback = '') => previous(state, name) ?? fallback;
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      wide
      title="Add a rating test case"
      description="A quote with the totals you expect, to the cent, from the filed manual or an Assurant workbook. The plan supplies the benefits, package types, perils and settings. A case with the same name is replaced."
      trigger={
        <Button variant="secondary">
          <FlaskConical aria-hidden className="size-4" /> Add test case
        </Button>
      }
    >
      <form action={action} className="space-y-4" noValidate>
        <input type="hidden" name="planId" value={planId} />
        <Field label="Case name" required error={errors.name}>
          {(f) => <Input id={f.id} name="name" required defaultValue={keep('name')} aria-invalid={f.invalid} aria-describedby={f.describedBy} />}
        </Field>
        <Field
          label="Travellers"
          required
          error={err('input.travellers')}
          hint="One per line: age, trip cost, pre-existing waiver (yes or no). For example: 45, 4200, yes"
        >
          {(f) => <Textarea id={f.id} name="travellers" required rows={3} defaultValue={keep('travellers')} aria-invalid={f.invalid} aria-describedby={f.describedBy} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-4">
          {[
            ['rateDate', 'Rate date'],
            ['purchaseDate', 'Purchase date'],
            ['departureDate', 'Departure'],
            ['returnDate', 'Return'],
          ].map(([name, label]) => (
            <Field key={name} label={label!} required error={err(`input.${name === 'rateDate' ? 'rateDate' : `trip.${name}`}`)}>
              {(f) => <Input id={f.id} type="date" name={name} required defaultValue={keep(name!)} aria-invalid={f.invalid} aria-describedby={f.describedBy} />}
            </Field>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Destination region" error={err('input.trip.destinations')}>
            {(f) => <Input id={f.id} name="destinationRegion" defaultValue={keep('destinationRegion')} aria-invalid={f.invalid} aria-describedby={f.describedBy} />}
          </Field>
          <Field label="Cancellation penalty days" error={err('input.trip.penaltyDays')}>
            {(f) => <Input id={f.id} type="number" name="penaltyDays" defaultValue={keep('penaltyDays')} aria-invalid={f.invalid} aria-describedby={f.describedBy} />}
          </Field>
          <Field label="Business segment" error={err('input.account')}>
            {(f) => <Input id={f.id} name="businessSegment" defaultValue={keep('businessSegment')} aria-invalid={f.invalid} aria-describedby={f.describedBy} />}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Expected policy total" error={err('expected')} hint="For example 103.94.">
            {(f) => <Input id={f.id} name="expectedTotal" inputMode="decimal" defaultValue={keep('expectedTotal')} aria-invalid={f.invalid} aria-describedby={f.describedBy} />}
          </Field>
          <Field label="Expected per benefit" hint="For example TCAN: 103.94; TINT: 12.10">
            {(f) => <Input id={f.id} name="expectedPerBenefit" defaultValue={keep('expectedPerBenefit')} aria-invalid={f.invalid} aria-describedby={f.describedBy} />}
          </Field>
        </div>
        <FormMessage state={state} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
          <SubmitButton pendingLabel="Saving…">Save test case</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

export function RemoveTestCaseButton({ planId, caseId, name }: { planId: string; caseId: string; name: string }) {
  const [state, action] = useActionState(removeTestCase, idle);
  return (
    <form action={action}>
      <input type="hidden" name="planId" value={planId} />
      <input type="hidden" name="caseId" value={caseId} />
      <SubmitButton pendingLabel="Removing…" variant="ghost" size="sm" aria-label={`Remove test case ${name}`}>
        <Trash2 aria-hidden className="size-3.5" />
      </SubmitButton>
      {state.status === 'error' ? <p className="text-xs text-danger">{state.message}</p> : null}
    </form>
  );
}
