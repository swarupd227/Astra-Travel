'use client';

import { useActionState, useId, useState } from 'react';
import { ClipboardCheck, Eye } from 'lucide-react';
import { SERVICING_LABELS, SERVICING_TYPES, type ServicingType } from '@astra/contracts';
import { Field, FormMessage, Input, Select, SubmitButton, Textarea } from '@/components/ui/form';
import { Badge, Notice } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { idle } from '@/lib/actions';
import { applyServicing, previewServicing, type PreviewState } from './servicing-actions';

interface Props {
  policyId: string;
  travellers: { id: string; name: string }[];
  optionalBenefits: { code: string; name: string }[];
}

const money = (v: string) => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Preview a change, cancellation or correction, then confirm it against the price shown (E06). */
export function ServicingPanel({ policyId, travellers, optionalBenefits }: Props) {
  const [type, setType] = useState<ServicingType>('cancel');
  const [state, preview] = useActionState<PreviewState, FormData>(previewServicing, idle);
  const [applied, apply] = useActionState(applyServicing, idle);
  const key = useId();
  const p = state.status === 'success' ? state.preview : undefined;
  const traveller = (
    <Field label="Traveller">
      {(f) => (
        <Select id={f.id} name="travellerId" aria-describedby={f.describedBy}>
          {travellers.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
  const noLoss = (
    <label className="flex items-start gap-2 text-sm text-fg">
      <input type="checkbox" name="noLoss" className="mt-1 size-4" />
      <span>The traveller has had no loss that would lead to a claim.</span>
    </label>
  );
  return (
    <div className="space-y-5">
      <form action={preview} className="space-y-4">
        <input type="hidden" name="policyId" value={policyId} />
        <Field label="What do you want to do?">
          {(f) => (
            <Select id={f.id} name="type" value={type} onChange={(e) => setType(e.target.value as ServicingType)} aria-describedby={f.describedBy}>
              {SERVICING_TYPES.map((t) => (
                <option key={t} value={t}>
                  {SERVICING_LABELS[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {type === 'cancel' ? noLoss : null}
        {type === 'change_dates' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="New departure date">{(f) => <Input id={f.id} name="departureDate" type="date" required aria-describedby={f.describedBy} />}</Field>
            <Field label="New return date">{(f) => <Input id={f.id} name="returnDate" type="date" required aria-describedby={f.describedBy} />}</Field>
          </div>
        ) : null}
        {type === 'change_cost' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {traveller}
            <Field label="Insured trip cost" hint="For this traveller, in dollars.">
              {(f) => <Input id={f.id} name="costPerTraveller" inputMode="decimal" required aria-describedby={f.describedBy} />}
            </Field>
          </div>
        ) : null}
        {type === 'add_traveller' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First name">{(f) => <Input id={f.id} name="firstName" required aria-describedby={f.describedBy} />}</Field>
            <Field label="Last name">{(f) => <Input id={f.id} name="lastName" required aria-describedby={f.describedBy} />}</Field>
            <Field label="Date of birth">{(f) => <Input id={f.id} name="dateOfBirth" type="date" required aria-describedby={f.describedBy} />}</Field>
            <Field label="Insured trip cost">{(f) => <Input id={f.id} name="costPerTraveller" inputMode="decimal" required aria-describedby={f.describedBy} />}</Field>
          </div>
        ) : null}
        {type === 'remove_traveller' ? (
          <>
            {traveller}
            {noLoss}
          </>
        ) : null}
        {type === 'change_destinations' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Country" hint="Two-letter code, for example FR.">{(f) => <Input id={f.id} name="country" maxLength={2} aria-describedby={f.describedBy} />}</Field>
            <Field label="Region">{(f) => <Input id={f.id} name="region" aria-describedby={f.describedBy} />}</Field>
          </div>
        ) : null}
        {type === 'add_benefits' ? (
          optionalBenefits.length ? (
            <Field label="Benefit or upgrade">
              {(f) => (
                <Select id={f.id} name="benefit" aria-describedby={f.describedBy}>
                  {optionalBenefits.map((b) => (
                    <option key={b.code} value={b.code}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : (
            <p className="text-sm text-muted">Every optional benefit of this plan is already on the policy.</p>
          )
        ) : null}
        {type === 'correct' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {traveller}
            <span />
            <Field label="Corrected first name" hint="Leave blank to keep.">{(f) => <Input id={f.id} name="firstName" aria-describedby={f.describedBy} />}</Field>
            <Field label="Corrected last name">{(f) => <Input id={f.id} name="lastName" aria-describedby={f.describedBy} />}</Field>
            <Field label="Corrected date of birth">{(f) => <Input id={f.id} name="dateOfBirth" type="date" aria-describedby={f.describedBy} />}</Field>
            <Field label="Purchaser email">{(f) => <Input id={f.id} name="email" type="email" aria-describedby={f.describedBy} />}</Field>
          </div>
        ) : null}
        <Field label="Reason" hint="Kept on the policy’s history and in the audit trail.">
          {(f) => <Textarea id={f.id} name="reason" required minLength={3} maxLength={500} aria-describedby={f.describedBy} />}
        </Field>
        {state.status === 'error' ? <FormMessage state={state} /> : null}
        <SubmitButton variant="secondary" pendingLabel="Working it out…">
          <Eye aria-hidden className="size-4" /> Show what this would do
        </SubmitButton>
      </form>

      {p ? (
        <div className="space-y-4 rounded-lg border border-border p-4" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-fg">{p.allowed ? 'What would change' : 'This cannot be done'}</h3>
            <Badge tone={p.reviewPeriod.inReview ? 'success' : 'neutral'}>{p.reviewPeriod.inReview ? 'Review period running' : 'Review period over'}</Badge>
          </div>
          <p className="text-sm text-fg">{p.summary}</p>
          {!p.allowed ? (
            <Notice tone="warning" title="Why not">
              <ul className="list-disc pl-5">
                {p.problems.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </Notice>
          ) : (
            <>
              {p.changes.length ? (
                <Table caption="What changes">
                  <THead>
                    <tr>
                      <TH>What</TH>
                      <TH>Now</TH>
                      <TH>After</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {p.changes.map((c, i) => (
                      <TR key={i}>
                        <TD>{c.what}</TD>
                        <TD className="font-mono text-xs break-all">{c.before}</TD>
                        <TD className="font-mono text-xs break-all">{c.after}</TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              ) : null}
              <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                {p.premium ? (
                  <>
                    <dt className="text-muted">Premium</dt>
                    <dd className="font-mono">
                      {money(p.premium.before)} → {money(p.premium.after)}
                    </dd>
                  </>
                ) : null}
                <dt className="text-muted">Charged</dt>
                <dd className="font-mono">{money(p.money.charge)}</dd>
                <dt className="text-muted">Refunded</dt>
                <dd className="font-mono">{money(p.money.refund)}</dd>
                <dt className="text-muted">Kept</dt>
                <dd className="font-mono">{money(p.money.retained)}</dd>
              </dl>
              <p className="text-sm text-muted">{p.money.explanation}</p>
              <form action={apply} className="space-y-3">
                <input type="hidden" name="policyId" value={policyId} />
                <input type="hidden" name="request" value={JSON.stringify(state.status === 'success' ? state.request : {})} />
                <input type="hidden" name="confirmAmount" value={p.confirmAmount} />
                <input type="hidden" name="idempotencyKey" value={`${key}-${p.confirmAmount}-${p.summary.length}`.replace(/[^A-Za-z0-9._:-]/g, '-')} />
                <FormMessage state={applied} />
                <SubmitButton pendingLabel="Making the change…">
                  <ClipboardCheck aria-hidden className="size-4" /> Confirm at this price
                </SubmitButton>
              </form>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
