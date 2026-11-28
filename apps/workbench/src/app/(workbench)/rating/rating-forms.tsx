'use client';

import { useActionState, useState } from 'react';
import { Calculator, Play, Rocket, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, FormMessage, Input, Select, SubmitButton, Textarea } from '@/components/ui/form';
import { Badge } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { idle, previous } from '@/lib/actions';
import {
  approveManual,
  importParity,
  loadManual,
  publishManual,
  rateTrip,
  runParity,
  type RateState,
} from './actions';

export function LoadManualDialog({ allowIllustrative }: { allowIllustrative: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(loadManual, idle);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      wide
      title="Load a rate manual"
      description="The manual's tables and formula as a JSON document (see docs/rating/manual-format.md). It starts as a draft; a second rating analyst approves it."
      trigger={
        <Button>
          <Upload aria-hidden className="size-4" /> Load manual
        </Button>
      }
    >
      <form action={action} className="space-y-4" noValidate>
        <Field label="Manual file (JSON)" required error={errors.file ?? errors.document}>
          {(f) => (
            <Input
              id={f.id}
              type="file"
              name="file"
              accept=".json,application/json"
              required
              className="py-2"
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Manual code"
            required
            error={errors.code}
            hint="As filed, for example RETR-SP-VU-DE-0426."
          >
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
          <Field label="State" required error={errors.state}>
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
          <Field label="Benefit" required error={errors.benefit} hint="For example TCAN.">
            {(f) => (
              <Input
                id={f.id}
                name="benefit"
                required
                defaultValue={previous(state, 'benefit')}
                className="font-mono uppercase"
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
        </div>
        <Field
          label="Source"
          required
          error={errors.source}
          hint="The filed document this was taken from."
        >
          {(f) => (
            <Input
              id={f.id}
              name="source"
              required
              defaultValue={previous(state, 'source')}
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        {allowIllustrative ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="illustrative" /> Illustrative (estimated loadings;
            demonstration and sandbox only, never publishable)
          </label>
        ) : null}
        <FormMessage state={state} />
        {state.status === 'error' && Object.keys(state.fieldErrors).length > 1 ? (
          <ul className="max-h-40 list-disc overflow-y-auto pl-5 text-xs text-danger">
            {Object.entries(state.fieldErrors).map(([k, m]) => (
              <li key={k}>
                {k}: {m}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <SubmitButton pendingLabel="Checking and loading…">Load manual</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

export function ApproveManualForm({ manualId }: { manualId: string }) {
  const [state, action] = useActionState(approveManual, idle);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="manualId" value={manualId} />
      <Field
        label="What you checked"
        required
        error={state.status === 'error' ? state.fieldErrors.note : undefined}
      >
        {(f) => <Textarea id={f.id} name="note" required minLength={5} maxLength={500} />}
      </Field>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Approving…">Approve manual</SubmitButton>
    </form>
  );
}

export function PublishManualForm({ manualId, ready }: { manualId: string; ready: boolean }) {
  const [state, action] = useActionState(publishManual, idle);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="manualId" value={manualId} />
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Publishing…" variant={ready ? 'primary' : 'secondary'}>
        <Rocket aria-hidden className="size-4" /> Publish
      </SubmitButton>
    </form>
  );
}

export function ParityForms({ manualId, canManage }: { manualId: string; canManage: boolean }) {
  const [importState, importAction] = useActionState(importParity, idle);
  const [runState, runAction] = useActionState(runParity, idle);
  if (!canManage) return null;
  return (
    <div className="grid gap-4 p-5 lg:grid-cols-2">
      <form action={importAction} className="space-y-3" aria-label="Import parity cases">
        <input type="hidden" name="manualId" value={manualId} />
        <Field
          label="Cases (CSV export)"
          required
          hint="One row per case; see docs/rating/parity-cases.md for the columns."
        >
          {(f) => (
            <Input
              id={f.id}
              type="file"
              name="file"
              accept=".csv,text/csv"
              required
              className="py-2"
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Source" required hint="The filed manual or an Assurant workbook.">
            {(f) => <Input id={f.id} name="source" required aria-describedby={f.describedBy} />}
          </Field>
          <Field label="Rate date" required>
            {(f) => <Input id={f.id} type="date" name="rateDate" required />}
          </Field>
        </div>
        <FormMessage state={importState} />
        <SubmitButton variant="secondary" pendingLabel="Importing…">
          <Upload aria-hidden className="size-4" /> Import cases
        </SubmitButton>
      </form>
      <form action={runAction} className="space-y-3" aria-label="Run parity">
        <input type="hidden" name="manualId" value={manualId} />
        <p className="text-sm text-muted">
          Runs every case against this version and compares the amount and each listed factor to the
          cent.
        </p>
        <FormMessage state={runState} />
        <SubmitButton pendingLabel="Running…">
          <Play aria-hidden className="size-4" /> Run parity
        </SubmitButton>
      </form>
    </div>
  );
}

export function RatingCalculator({ manuals }: { manuals: { id: string; label: string }[] }) {
  const [state, action] = useActionState<RateState, FormData>(rateTrip, idle);
  const k = (name: string, fallback = '') => state.kept?.[name] ?? fallback;
  const r = state.status === 'success' ? state.result : undefined;
  return (
    <div className="grid gap-6 xl:grid-cols-5">
      <form action={action} className="space-y-4 xl:col-span-2" aria-label="Rate a trip">
        <Field
          label="Manual"
          hint="Leave on Published to use the manual in effect on the rate date."
        >
          {(f) => (
            <Select
              id={f.id}
              name="manualId"
              defaultValue={k('manualId')}
              aria-describedby={f.describedBy}
            >
              <option value="">Published manual in effect</option>
              {manuals.map((m) => (
                <option key={m.id} value={m.id}>
                  Preview: {m.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="State" required>
            {(f) => (
              <Input
                id={f.id}
                name="state"
                required
                maxLength={2}
                className="uppercase"
                defaultValue={k('state', 'DE')}
              />
            )}
          </Field>
          <Field label="Benefit" required>
            {(f) => (
              <Input
                id={f.id}
                name="benefit"
                required
                className="uppercase"
                defaultValue={k('benefit', 'TCAN')}
              />
            )}
          </Field>
          <Field label="Rate date" required>
            {(f) => (
              <Input id={f.id} type="date" name="rateDate" required defaultValue={k('rateDate')} />
            )}
          </Field>
        </div>
        <fieldset className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
          <legend className="px-1 text-sm font-medium text-fg">Traveller</legend>
          <Field label="Age">
            {(f) => <Input id={f.id} name="age" inputMode="numeric" defaultValue={k('age')} />}
          </Field>
          <Field label="Pre-existing exclusion waived">
            {(f) => (
              <Select id={f.id} name="waived" defaultValue={k('waived')}>
                <option value="">Not given</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </Select>
            )}
          </Field>
        </fieldset>
        <fieldset className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
          <legend className="px-1 text-sm font-medium text-fg">Trip</legend>
          <Field label="Trip cost per traveller" required>
            {(f) => (
              <Input
                id={f.id}
                name="tripCost"
                inputMode="decimal"
                required
                defaultValue={k('tripCost')}
              />
            )}
          </Field>
          <Field label="Purchase date" required>
            {(f) => (
              <Input
                id={f.id}
                type="date"
                name="purchaseDate"
                required
                defaultValue={k('purchaseDate')}
              />
            )}
          </Field>
          <Field label="Departure date" required>
            {(f) => (
              <Input
                id={f.id}
                type="date"
                name="departureDate"
                required
                defaultValue={k('departureDate')}
              />
            )}
          </Field>
          <Field label="Return date" required>
            {(f) => (
              <Input
                id={f.id}
                type="date"
                name="returnDate"
                required
                defaultValue={k('returnDate')}
              />
            )}
          </Field>
          <Field label="Initial deposit date">
            {(f) => (
              <Input
                id={f.id}
                type="date"
                name="initialDepositDate"
                defaultValue={k('initialDepositDate')}
              />
            )}
          </Field>
          <Field label="Full-penalty point (days before departure)">
            {(f) => (
              <Input
                id={f.id}
                name="penaltyDays"
                inputMode="numeric"
                defaultValue={k('penaltyDays')}
              />
            )}
          </Field>
          <Field label="Destination region">
            {(f) => (
              <Input id={f.id} name="destinationRegion" defaultValue={k('destinationRegion')} />
            )}
          </Field>
          <Field label="Domestic or international">
            {(f) => (
              <Select id={f.id} name="destinationScope" defaultValue={k('destinationScope')}>
                <option value="">Not given</option>
                <option value="domestic">Domestic</option>
                <option value="international">International</option>
              </Select>
            )}
          </Field>
        </fieldset>
        <fieldset className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
          <legend className="px-1 text-sm font-medium text-fg">Account and plan</legend>
          <Field label="Business segment">
            {(f) => <Input id={f.id} name="businessSegment" defaultValue={k('businessSegment')} />}
          </Field>
          <Field label="Package type" required>
            {(f) => (
              <Select id={f.id} name="packageType" defaultValue={k('packageType', 'packaged')}>
                <option value="packaged">Packaged</option>
                <option value="optional">Optional or stand-alone</option>
              </Select>
            )}
          </Field>
          <Field label="Lookback period (days)">
            {(f) => (
              <Input
                id={f.id}
                name="lookbackDays"
                inputMode="numeric"
                defaultValue={k('lookbackDays')}
              />
            )}
          </Field>
          <Field label="Product type">
            {(f) => <Input id={f.id} name="productType" defaultValue={k('productType')} />}
          </Field>
          <Field
            label="Covered perils"
            hint="PERIL:level|level; for example DEATH:self|family_member"
          >
            {(f) => (
              <Input
                id={f.id}
                name="perils"
                defaultValue={k('perils')}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
          <Field label="Waived exclusions" hint="Codes, separated by ;">
            {(f) => (
              <Input
                id={f.id}
                name="waivedExclusions"
                defaultValue={k('waivedExclusions')}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
          <Field label="Supplemental benefits" hint="code:amount; for example supplemental:500">
            {(f) => (
              <Input
                id={f.id}
                name="supplemental"
                defaultValue={k('supplemental')}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
          <Field label="Not collected by the account" hint="Variables, separated by ;">
            {(f) => (
              <Input
                id={f.id}
                name="notCollected"
                defaultValue={k('notCollected')}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
        </fieldset>
        <fieldset className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
          <legend className="px-1 text-sm font-medium text-fg">
            CFAR and Trip Interruption (when the manual needs them)
          </legend>
          <Field label="CFAR reimbursement (%)" hint="Filed range 25 to 100.">
            {(f) => (
              <Input
                id={f.id}
                name="cfarPercent"
                inputMode="numeric"
                defaultValue={k('cfarPercent')}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
          <Field label="CFAR basis">
            {(f) => (
              <Select id={f.id} name="cfarBasis" defaultValue={k('cfarBasis', 'trip')}>
                <option value="trip">Trip cost</option>
                <option value="air">Air cost</option>
              </Select>
            )}
          </Field>
          <Field label="Air cost per traveller">
            {(f) => (
              <Input id={f.id} name="airCost" inputMode="decimal" defaultValue={k('airCost')} />
            )}
          </Field>
          <Field label="CFAR eligibility decision" hint="From the cancel-for-any-reason rules.">
            {(f) => (
              <Select
                id={f.id}
                name="cfarEligibility"
                defaultValue={k('cfarEligibility')}
                aria-describedby={f.describedBy}
              >
                <option value="">Not given</option>
                <option value="passed">Passed</option>
                <option value="failed">Did not pass</option>
              </Select>
            )}
          </Field>
          <Field label="Trip Interruption limit (% of trip cost)" hint="For example 150.">
            {(f) => (
              <Input
                id={f.id}
                name="interruptionPercent"
                inputMode="numeric"
                defaultValue={k('interruptionPercent')}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
        </fieldset>
        {state.status === 'error' ? <FormMessage state={state} /> : null}
        <SubmitButton pendingLabel="Rating…">
          <Calculator aria-hidden className="size-4" /> Rate
        </SubmitButton>
      </form>

      <div className="xl:col-span-3" aria-live="polite">
        {r ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-border p-5">
              <p className="text-sm text-muted">
                {r.manual.code} v{r.manual.version} · {r.manual.state} {r.manual.benefit}
              </p>
              <p className="mt-1 text-3xl font-semibold tabular-nums text-fg">${r.amount}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Badge tone={r.kind === 'premium' ? 'success' : 'warning'}>
                  {r.kind === 'premium' ? 'Premium' : 'Loss cost (no multiplier filed)'}
                </Badge>
                {r.preview ? <Badge tone="primary">Preview of an unpublished version</Badge> : null}
                {r.illustrative ? (
                  <Badge tone="danger">Illustrative: not a filed price</Badge>
                ) : null}
              </div>
            </div>
            <Table caption="Rating worksheet">
              <THead>
                <tr>
                  <TH>Step</TH>
                  <TH className="text-right">Value</TH>
                  <TH>Table and band</TH>
                  <TH>Page</TH>
                </tr>
              </THead>
              <tbody>
                {r.steps.map((s, i) => (
                  <TR key={i}>
                    <TD>
                      {s.label}
                      {s.note ? <div className="text-xs text-muted">{s.note}</div> : null}
                    </TD>
                    <TD className="text-right font-mono text-xs tabular-nums">{s.value}</TD>
                    <TD className="text-xs text-muted">
                      {s.table ? `${s.table}${s.band ? ` · ${s.band}` : ''}` : '—'}
                    </TD>
                    <TD className="text-xs text-muted">{s.page ?? '—'}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
            <p className="font-mono text-[11px] text-subtle">Inputs hash {r.inputsHash}</p>
          </div>
        ) : (
          <div className="flex min-h-40 items-center justify-center rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">
            The worksheet appears here: every input, derived value, table, band, factor and formula
            step, with its manual page.
          </div>
        )}
      </div>
    </div>
  );
}
