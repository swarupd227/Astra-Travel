'use client';

import { useActionState, useState } from 'react';
import { FlaskConical, Play, Plus, Rocket, Save, ShieldCheck, Trash2, Upload } from 'lucide-react';
import {
  LIMIT_KINDS,
  LIMIT_LABELS,
  RULE_FIELDS,
  RULE_FIELD_LABELS,
  RULE_OPS,
  RULE_OP_LABELS,
  type Condition,
  type EvaluationResult,
  type RuleProblem,
  type RuleSetDocument,
} from '@astra/contracts';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, FormMessage, Input, Select, SubmitButton, Textarea } from '@/components/ui/form';
import { Badge, Card, CardHeader, Notice } from '@/components/ui/primitives';
import { idle, previous } from '@/lib/actions';
import {
  approveRuleSet,
  checkEligibility,
  decideReferral,
  decideSanctionsList,
  loadSanctionsList,
  publishRuleSet,
  removeTestCase,
  runRuleTests,
  saveRuleSet,
  saveTestCase,
  startRuleSet,
  type CheckState,
  type SaveState,
} from './actions';

// ---------------- Quote fields shared by the check page and the test case dialog ----------------

export function CaseFields({ state, today }: { state: { status: string; values?: Record<string, string[]> }; today: string }) {
  const keep = (name: string, fallback = '') => (state.status === 'error' ? (state.values?.[name]?.[0] ?? fallback) : fallback);
  const date = (name: string, label: string, required = true, hint?: string) => (
    <Field label={label} required={required} hint={hint}>
      {(f) => <Input id={f.id} type="date" name={name} required={required} defaultValue={keep(name, name === 'purchaseDate' ? today : '')} aria-describedby={f.describedBy} />}
    </Field>
  );
  const text = (name: string, label: string, opts: { required?: boolean; hint?: string; type?: string; className?: string } = {}) => (
    <Field label={label} required={opts.required} hint={opts.hint}>
      {(f) => <Input id={f.id} name={name} type={opts.type ?? 'text'} required={opts.required} defaultValue={keep(name)} className={opts.className} aria-describedby={f.describedBy} />}
    </Field>
  );
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        {text('firstName', 'First name', { required: true })}
        {text('lastName', 'Last name', { required: true })}
        {date('dateOfBirth', 'Date of birth', false, 'Needed for the duplicate check; sharpens sanctions screening.')}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {text('age', 'Age', { type: 'number', hint: 'Taken from the date of birth when blank.' })}
        {text('costPerTraveller', 'Trip cost per traveller', { hint: 'For example 4200.00' })}
        {text('insuredPercent', 'Trip costs insured (%)', { type: 'number', hint: '100 means all relevant costs.' })}
      </div>
      <div className="grid gap-4 sm:grid-cols-4">
        {date('purchaseDate', 'Purchase date')}
        {date('initialDepositDate', 'Initial deposit date', false, 'Needed to show the time-sensitive period.')}
        {date('departureDate', 'Departure')}
        {date('returnDate', 'Return')}
      </div>
      <div className="grid gap-4 sm:grid-cols-4">
        {text('destinationCountry', 'Destination country', { hint: 'Two letters, for example FR.', className: 'uppercase' })}
        {text('destinationRegion', 'Destination region')}
        {text('businessSegment', 'Business segment')}
        {text('benefits', 'Benefits wanted', { hint: 'Catalogue codes, separated by commas.' })}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Able to travel">
          {(f) => (
            <Select id={f.id} name="ableToTravel" defaultValue={keep('ableToTravel', 'yes')}>
              <option value="yes">Confirmed</option>
              <option value="no">Not able</option>
              <option value="">Not asked yet</option>
            </Select>
          )}
        </Field>
        <Field label="Stage">
          {(f) => (
            <Select id={f.id} name="stage" defaultValue={keep('stage', 'quote')}>
              <option value="quote">Quote</option>
              <option value="bind">Bind</option>
              <option value="change">Change</option>
            </Select>
          )}
        </Field>
        <Field label="Term">
          {(f) => (
            <Select id={f.id} name="term" defaultValue={keep('term', 'single_trip')}>
              <option value="single_trip">Single trip</option>
              <option value="annual">Annual</option>
            </Select>
          )}
        </Field>
      </div>
    </div>
  );
}

const OUTCOME_TONES = { eligible: 'success', ineligible: 'danger', referred: 'warning', held: 'warning' } as const;
const OUTCOME_LABELS = { eligible: 'Eligible', ineligible: 'Not eligible', referred: 'Referred to an underwriter', held: 'Held: possible sanctions match' } as const;

export function EvaluationView({ r }: { r: EvaluationResult }) {
  const groups = [...new Set(r.checks.map((c) => c.area))];
  return (
    <div className="space-y-4" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={OUTCOME_TONES[r.outcome]}>{OUTCOME_LABELS[r.outcome]}</Badge>
        {r.preview ? <Badge tone="neutral">Preview</Badge> : null}
        <span className="text-xs text-muted">Rule set version {r.ruleSet.version}</span>
      </div>
      {r.reasons.length ? (
        <ul className="list-disc space-y-1 pl-5 text-sm text-danger">
          {r.reasons.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      ) : null}
      {r.referrals.length ? (
        <ul className="space-y-1 text-sm">
          {r.referrals.map((x) => (
            <li key={x.rule}>
              <span className="font-mono text-xs">{x.rule}</span> ({x.recommendation === 'recommend_decline' ? 'recommends decline' : 'refer'}): {x.reason}
            </li>
          ))}
        </ul>
      ) : null}
      {r.screening.possibleMatches.length ? (
        <ul className="space-y-1 text-sm">
          {r.screening.possibleMatches.map((m) => (
            <li key={`${m.travellerId}-${m.uid}`}>
              Possible match with <strong>{m.name}</strong> {m.program ? `(${m.program}) ` : ''}— score {m.score}. {m.reason}.
            </li>
          ))}
        </ul>
      ) : null}
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-medium text-fg">Pre-existing condition waiver</dt>
          <dd className="text-muted">{r.waiver.applies ? 'Applies' : 'Does not apply'}</dd>
        </div>
        <div>
          <dt className="font-medium text-fg">CFAR</dt>
          <dd className="text-muted">{r.cfar.offered ? 'Offered' : 'Not offered'}</dd>
        </div>
      </dl>
      <details className="rounded-md border border-border">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-fg">All checks ({r.checks.length})</summary>
        <div className="divide-y divide-border">
          {groups.map((g) => (
            <div key={g} className="px-3 py-2">
              <p className="text-xs font-semibold tracking-wide text-muted uppercase">{g.replace(/_/g, ' ')}</p>
              <ul className="mt-1 space-y-1 text-sm">
                {r.checks
                  .filter((c) => c.area === g)
                  .map((c, i) => (
                    <li key={i} className="flex gap-2">
                      <span className={c.passed ? 'text-success' : 'text-warning'} aria-hidden>
                        {c.passed ? '✓' : '•'}
                      </span>
                      <span>
                        <span className="sr-only">{c.passed ? 'Passed: ' : 'Not passed: '}</span>
                        {c.detail}
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      </details>
      <pre className="overflow-x-auto rounded-md bg-subtle p-3 text-xs whitespace-pre-wrap">{r.summary}</pre>
    </div>
  );
}

export function CheckForm({ planVersions, today }: { planVersions: { id: string; label: string }[]; today: string }) {
  const [state, action] = useActionState<CheckState, FormData>(checkEligibility, idle);
  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_26rem]">
      <form action={action} className="space-y-4" noValidate>
        <Field label="Plan version" required error={state.status === 'error' ? state.fieldErrors.planVersionId : undefined}>
          {(f) => (
            <Select id={f.id} name="planVersionId" required defaultValue={previous(state, 'planVersionId')}>
              <option value="">Choose…</option>
              {planVersions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <CaseFields state={state} today={today} />
        <FormMessage state={state} />
        {state.status === 'error' && Object.keys(state.fieldErrors).length ? (
          <ul className="list-disc pl-5 text-xs text-danger">
            {Object.entries(state.fieldErrors).map(([k, m]) => (
              <li key={k}>
                {k}: {m}
              </li>
            ))}
          </ul>
        ) : null}
        <SubmitButton pendingLabel="Checking…">
          <ShieldCheck aria-hidden className="size-4" /> Check eligibility
        </SubmitButton>
      </form>
      <Card>
        <CardHeader title="Result" description="Uses the rule set published for the plan on the purchase date, with the sanctions list, prohibited destinations and cover register in force." />
        <div className="p-5">{state.status === 'success' && state.result ? <EvaluationView r={state.result} /> : <p className="text-sm text-muted">Fill in the case and check it.</p>}</div>
      </Card>
    </div>
  );
}

// ---------------- Test cases ----------------

export function TestCaseDialog({ planId, today }: { planId: string; today: string }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(saveTestCase, idle);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      wide
      title="Add a rule test case"
      description="A case and the outcome you expect from the rule set. A case with the same name is replaced. The plan's current version and the data in force are used."
      trigger={
        <Button variant="secondary">
          <FlaskConical aria-hidden className="size-4" /> Add test case
        </Button>
      }
    >
      <form action={action} className="space-y-4" noValidate>
        <input type="hidden" name="planId" value={planId} />
        <Field label="Case name" required error={errors.name}>
          {(f) => <Input id={f.id} name="name" required defaultValue={previous(state, 'name')} aria-invalid={f.invalid} aria-describedby={f.describedBy} />}
        </Field>
        <CaseFields state={state} today={today} />
        <fieldset className="space-y-3 rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-medium text-fg">Expected</legend>
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Outcome" required error={errors['expected.outcome']}>
              {(f) => (
                <Select id={f.id} name="expectedOutcome" defaultValue={previous(state, 'expectedOutcome') ?? 'eligible'}>
                  <option value="eligible">Eligible</option>
                  <option value="ineligible">Not eligible</option>
                  <option value="referred">Referred</option>
                  <option value="held">Held</option>
                </Select>
              )}
            </Field>
            <Field label="Waiver">
              {(f) => (
                <Select id={f.id} name="expectedWaiver" defaultValue={previous(state, 'expectedWaiver') ?? ''}>
                  <option value="">Not checked</option>
                  <option value="yes">Applies</option>
                  <option value="no">Does not apply</option>
                </Select>
              )}
            </Field>
            <Field label="CFAR">
              {(f) => (
                <Select id={f.id} name="expectedCfar" defaultValue={previous(state, 'expectedCfar') ?? ''}>
                  <option value="">Not checked</option>
                  <option value="yes">Offered</option>
                  <option value="no">Not offered</option>
                </Select>
              )}
            </Field>
            <Field label="Referral rules that fire" hint="Rule codes, separated by commas.">
              {(f) => <Input id={f.id} name="expectedRules" defaultValue={previous(state, 'expectedRules')} aria-describedby={f.describedBy} />}
            </Field>
          </div>
          <Field label="A reason it contains" hint="Part of a reason shown when not eligible.">
            {(f) => <Input id={f.id} name="expectedReason" defaultValue={previous(state, 'expectedReason')} aria-describedby={f.describedBy} />}
          </Field>
        </fieldset>
        <FormMessage state={state} />
        {state.status === 'error' && Object.keys(errors).length > 1 ? (
          <ul className="max-h-32 list-disc overflow-y-auto pl-5 text-xs text-danger">
            {Object.entries(errors).map(([k, m]) => (
              <li key={k}>
                {k}: {m}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
          <SubmitButton pendingLabel="Saving…">Save test case</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

export function RemoveCaseButton({ planId, caseId, name }: { planId: string; caseId: string; name: string }) {
  const [state, action] = useActionState(removeTestCase, idle);
  return (
    <form action={action}>
      <input type="hidden" name="planId" value={planId} />
      <input type="hidden" name="caseId" value={caseId} />
      <SubmitButton pendingLabel="…" variant="ghost" size="sm" aria-label={`Remove test case ${name}`}>
        <Trash2 aria-hidden className="size-3.5" />
      </SubmitButton>
      {state.status === 'error' ? <p className="text-xs text-danger">{state.message}</p> : null}
    </form>
  );
}

// ---------------- Rule set lifecycle ----------------

export function StartRuleSetForm({ planId }: { planId: string }) {
  const [state, action] = useActionState(startRuleSet, idle);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="planId" value={planId} />
      <Field label="Effective from" required error={state.status === 'error' ? state.fieldErrors.effectiveFrom : undefined}>
        {(f) => <Input id={f.id} type="date" name="effectiveFrom" required aria-describedby={f.describedBy} />}
      </Field>
      <SubmitButton pendingLabel="Starting…" variant="secondary">
        <Plus aria-hidden className="size-4" /> Start a rule set draft
      </SubmitButton>
      <div className="basis-full">
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function ApproveRuleSetForm({ ruleSetId }: { ruleSetId: string }) {
  const [state, action] = useActionState(approveRuleSet, idle);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="ruleSetId" value={ruleSetId} />
      <Field label="What you checked" required error={state.status === 'error' ? state.fieldErrors.note : undefined}>
        {(f) => <Textarea id={f.id} name="note" required minLength={5} maxLength={500} aria-describedby={f.describedBy} />}
      </Field>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Approving…">Approve rule set</SubmitButton>
    </form>
  );
}

export function PublishRuleSetForm({ ruleSetId, ready }: { ruleSetId: string; ready: boolean }) {
  const [state, action] = useActionState(publishRuleSet, idle);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="ruleSetId" value={ruleSetId} />
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Publishing…" disabled={!ready}>
        <Rocket aria-hidden className="size-4" /> Publish
      </SubmitButton>
      {!ready ? <p className="text-xs text-muted">Every check above must pass first.</p> : null}
    </form>
  );
}

export function RunRuleTestsForm({ ruleSetId, cases }: { ruleSetId: string; cases: number }) {
  const [state, action] = useActionState(runRuleTests, idle);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="ruleSetId" value={ruleSetId} />
      <SubmitButton pendingLabel="Running…" variant="secondary" disabled={cases === 0}>
        <Play aria-hidden className="size-4" /> Run {cases} test case{cases === 1 ? '' : 's'}
      </SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}

// ---------------- Rule set editor ----------------

type Cmp = { field: (typeof RULE_FIELDS)[number]; op: (typeof RULE_OPS)[number]; value: number | string | (number | string)[] };
/** A rule the editor can show: all of / any of a list of comparisons. Nested rules are read-only here. */
function flatten(c: Condition): { match: 'all' | 'any'; items: Cmp[] } | null {
  const isCmp = (x: Condition): x is Cmp => 'field' in x;
  if (isCmp(c)) return { match: 'all', items: [c] };
  if ('all' in c && c.all.every(isCmp)) return { match: 'all', items: c.all as Cmp[] };
  if ('any' in c && c.any.every(isCmp)) return { match: 'any', items: c.any as Cmp[] };
  return null;
}
const NUMERIC_FIELDS = new Set(['traveller_age', 'cost_per_traveller', 'trip_days', 'total_trip_cost', 'traveller_count', 'days_before_departure', 'insured_percent']);
const valueText = (v: Cmp['value']) => (Array.isArray(v) ? v.join(', ') : String(v));
function parseValue(field: string, op: string, raw: string): Cmp['value'] {
  const one = (s: string) => (NUMERIC_FIELDS.has(field) && s.trim() !== '' && !Number.isNaN(Number(s)) ? Number(s) : s.trim());
  return op === 'in' || op === 'not_in' ? raw.split(',').map(one).filter((x) => x !== '') : one(raw);
}

export function RuleSetEditor({ ruleSetId, initial, effectiveFrom, problems: initialProblems, editable }: { ruleSetId: string; initial: RuleSetDocument; effectiveFrom: string; problems: RuleProblem[]; editable: boolean }) {
  const [doc, setDoc] = useState<RuleSetDocument>(initial);
  const [from, setFrom] = useState(effectiveFrom);
  const [state, action] = useActionState<SaveState, FormData>(saveRuleSet, idle);
  const problems = state.status === 'success' && state.saved ? state.saved.problems : initialProblems;
  const update = (patch: Partial<RuleSetDocument>) => setDoc((d) => ({ ...d, ...patch }));
  const inputCls = 'h-9';

  return (
    <form action={action} className="space-y-6" noValidate>
      <input type="hidden" name="ruleSetId" value={ruleSetId} />
      <input type="hidden" name="document" value={JSON.stringify(doc)} />
      <input type="hidden" name="effectiveFrom" value={from} />
      {problems.length ? (
        <Notice tone="warning" title="To fix before approval">
          <ul className="list-disc pl-5">
            {problems.map((p) => (
              <li key={p.path + p.message}>{p.message}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <Card>
        <CardHeader title="Plan limits" description="A quote outside a limit is not eligible, and the reason says which limit." />
        <div className="space-y-3 p-5">
          {doc.limits.length === 0 ? <p className="text-sm text-muted">No limits.</p> : null}
          {doc.limits.map((l, i) => (
            <div key={l.code} className="grid items-center gap-3 sm:grid-cols-[1fr_10rem_auto]">
              <Select aria-label="Limit" className={inputCls} disabled={!editable} value={l.kind} onChange={(e) => update({ limits: doc.limits.map((x, j) => (j === i ? { ...x, kind: e.target.value as (typeof LIMIT_KINDS)[number] } : x)) })}>
                {LIMIT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {LIMIT_LABELS[k]}
                  </option>
                ))}
              </Select>
              <Input type="number" aria-label={`${LIMIT_LABELS[l.kind]}: value`} className={inputCls} disabled={!editable} value={l.value} onChange={(e) => update({ limits: doc.limits.map((x, j) => (j === i ? { ...x, value: Number(e.target.value) } : x)) })} />
              {editable ? (
                <Button variant="ghost" size="sm" aria-label={`Remove ${LIMIT_LABELS[l.kind]}`} onClick={() => update({ limits: doc.limits.filter((_, j) => j !== i) })}>
                  <Trash2 aria-hidden className="size-3.5" />
                </Button>
              ) : null}
            </div>
          ))}
          {editable ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const kind = LIMIT_KINDS.find((k) => !doc.limits.some((l) => l.kind === k)) ?? 'max_age';
                update({ limits: [...doc.limits, { code: `${kind}_${doc.limits.length + 1}`, kind, value: 0 }] });
              }}
            >
              <Plus aria-hidden className="size-3.5" /> Add limit
            </Button>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader title="Referral rules" description="A case that meets a rule goes to an underwriter with a summary. A rule can recommend a decline; a person always decides it." />
        <div className="divide-y divide-border">
          {doc.referralRules.length === 0 ? <p className="px-5 py-4 text-sm text-muted">No referral rules.</p> : null}
          {doc.referralRules.map((r, ri) => {
            const flat = flatten(r.when);
            const set = (patch: Partial<typeof r>) => update({ referralRules: doc.referralRules.map((x, j) => (j === ri ? { ...x, ...patch } : x)) });
            const setItems = (match: 'all' | 'any', items: Cmp[]) => set({ when: match === 'all' ? { all: items } : { any: items } });
            return (
              <fieldset key={r.code} className="space-y-3 px-5 py-4" aria-label={`Rule ${r.name}`}>
                <div className="grid gap-3 sm:grid-cols-[1fr_12rem_auto]">
                  <Input aria-label="Rule name" className={inputCls} disabled={!editable} value={r.name} onChange={(e) => set({ name: e.target.value })} />
                  <Select aria-label="Action" className={inputCls} disabled={!editable} value={r.action} onChange={(e) => set({ action: e.target.value as 'refer' | 'recommend_decline' })}>
                    <option value="refer">Refer</option>
                    <option value="recommend_decline">Recommend decline</option>
                  </Select>
                  {editable ? (
                    <Button variant="ghost" size="sm" aria-label={`Remove rule ${r.name}`} onClick={() => update({ referralRules: doc.referralRules.filter((_, j) => j !== ri) })}>
                      <Trash2 aria-hidden className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
                {flat ? (
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 text-sm">
                      Refer when
                      <Select aria-label="Match" className={`${inputCls} w-auto`} disabled={!editable} value={flat.match} onChange={(e) => setItems(e.target.value as 'all' | 'any', flat.items)}>
                        <option value="all">all of these are true</option>
                        <option value="any">any of these is true</option>
                      </Select>
                    </label>
                    {flat.items.map((c, ci) => (
                      <div key={ci} className="grid items-center gap-2 sm:grid-cols-[1fr_9rem_1fr_auto]">
                        <Select aria-label="Field" className={inputCls} disabled={!editable} value={c.field} onChange={(e) => setItems(flat.match, flat.items.map((x, k) => (k === ci ? { ...x, field: e.target.value as Cmp['field'] } : x)))}>
                          {RULE_FIELDS.map((f) => (
                            <option key={f} value={f}>
                              {RULE_FIELD_LABELS[f]}
                            </option>
                          ))}
                        </Select>
                        <Select aria-label="Comparison" className={inputCls} disabled={!editable} value={c.op} onChange={(e) => setItems(flat.match, flat.items.map((x, k) => (k === ci ? { ...x, op: e.target.value as Cmp['op'], value: Array.isArray(x.value) && !['in', 'not_in'].includes(e.target.value) ? (x.value[0] ?? '') : x.value } : x)))}>
                          {RULE_OPS.map((o) => (
                            <option key={o} value={o}>
                              {RULE_OP_LABELS[o]}
                            </option>
                          ))}
                        </Select>
                        <Input aria-label="Value" className={inputCls} disabled={!editable} defaultValue={valueText(c.value)} onChange={(e) => setItems(flat.match, flat.items.map((x, k) => (k === ci ? { ...x, value: parseValue(x.field, x.op, e.target.value) } : x)))} />
                        {editable && flat.items.length > 1 ? (
                          <Button variant="ghost" size="sm" aria-label="Remove condition" onClick={() => setItems(flat.match, flat.items.filter((_, k) => k !== ci))}>
                            <Trash2 aria-hidden className="size-3.5" />
                          </Button>
                        ) : null}
                      </div>
                    ))}
                    {editable ? (
                      <Button variant="ghost" size="sm" onClick={() => setItems(flat.match, [...flat.items, { field: 'traveller_age', op: 'gte', value: 0 }])}>
                        <Plus aria-hidden className="size-3.5" /> Add condition
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <Notice tone="neutral">This rule uses nested conditions, which the editor shows but does not change. Edit it through the API.</Notice>
                )}
                <Input aria-label="Reason shown to the underwriter" className={inputCls} disabled={!editable} value={r.reason} onChange={(e) => set({ reason: e.target.value })} />
              </fieldset>
            );
          })}
        </div>
        {editable ? (
          <div className="border-t border-border px-5 py-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                update({
                  referralRules: [
                    ...doc.referralRules,
                    { code: `rule_${doc.referralRules.length + 1}_${Date.now().toString(36)}`, name: 'New rule', when: { all: [{ field: 'traveller_age', op: 'gte', value: 0 }] }, action: 'refer', reason: 'Describe why this case needs a person.' },
                  ],
                })
              }
            >
              <Plus aria-hidden className="size-3.5" /> Add referral rule
            </Button>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="Other checks" />
        <div className="space-y-4 p-5">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" disabled={!editable} checked={doc.ableToTravelRequired} onChange={(e) => update({ ableToTravelRequired: e.target.checked })} />
            <span>
              Require the able-to-travel confirmation
              <span className="block text-xs text-muted">Needed to bind; a “not able” answer is never eligible.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" disabled={!editable} checked={doc.prohibitedDestinations} onChange={(e) => update({ prohibitedDestinations: e.target.checked })} />
            <span>
              Block prohibited destinations
              <span className="block text-xs text-muted">From the prohibited destinations reference data in force on the departure date.</span>
            </span>
          </label>
          <div className="space-y-2">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" disabled={!editable} checked={doc.sanctions.enabled} onChange={(e) => update({ sanctions: { ...doc.sanctions, enabled: e.target.checked } })} />
              <span>
                Screen travellers against the OFAC list
                <span className="block text-xs text-muted">A possible match holds the bind and creates a review task.</span>
              </span>
            </label>
            <label className="ml-6 flex items-center gap-2 text-sm">
              Match threshold
              <Input type="number" step="0.01" min={0.5} max={1} aria-label="Sanctions match threshold" className="h-9 w-24" disabled={!editable || !doc.sanctions.enabled} value={doc.sanctions.matchThreshold} onChange={(e) => update({ sanctions: { ...doc.sanctions, matchThreshold: Number(e.target.value) } })} />
              <span className="text-xs text-muted">0.5 to 1. Lower finds more possible matches. Compliance confirms the value.</span>
            </label>
          </div>
          <div className="space-y-2">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" disabled={!editable} checked={doc.duplicates.enabled} onChange={(e) => update({ duplicates: { ...doc.duplicates, enabled: e.target.checked } })} />
              <span>Check for duplicate cover at bind</span>
            </label>
            <label className="ml-6 flex items-center gap-2 text-sm">
              <input type="checkbox" disabled={!editable || !doc.duplicates.enabled} checked={doc.duplicates.allowSingleAndAnnual} onChange={(e) => update({ duplicates: { ...doc.duplicates, allowSingleAndAnnual: e.target.checked } })} />
              Allow one single-trip and one annual policy for the same trip
            </label>
          </div>
          <Field label="Benefits available only when bought within the time-sensitive period" hint="Catalogue benefit codes, separated by commas.">
            {(f) => (
              <Input
                id={f.id}
                className={inputCls}
                disabled={!editable}
                defaultValue={doc.timeBasedBenefits.map((b) => b.benefit).join(', ')}
                onChange={(e) =>
                  update({
                    timeBasedBenefits: e.target.value
                      .split(/[,\s]+/)
                      .filter(Boolean)
                      .map((benefit) => ({ benefit })),
                  })
                }
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
          <label className="block max-w-xs space-y-1.5 text-sm font-medium text-fg">
            Effective from
            <Input type="date" disabled={!editable} value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
        </div>
      </Card>

      {editable ? (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface/95 px-4 py-3 shadow-sm backdrop-blur">
          <FormMessage state={state} />
          <SubmitButton pendingLabel="Saving…">
            <Save aria-hidden className="size-4" /> Save draft
          </SubmitButton>
        </div>
      ) : null}
    </form>
  );
}

// ---------------- Sanctions lists and referrals ----------------

export function LoadSanctionsDialog() {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(loadSanctionsList, idle);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      wide
      title="Load the OFAC SDN list"
      description="Upload SDN.CSV (and ALT.CSV for aliases) as published by the US Treasury. Only individuals are screened. The list is a draft until someone else approves it."
      trigger={
        <Button>
          <Upload aria-hidden className="size-4" /> Load list
        </Button>
      }
    >
      <form action={action} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="SDN.CSV" required error={errors.sdn ?? errors.sdnCsv}>
            {(f) => <Input id={f.id} type="file" name="sdn" accept=".csv,text/csv" required className="py-2" aria-invalid={f.invalid} aria-describedby={f.describedBy} />}
          </Field>
          <Field label="ALT.CSV (aliases)" hint="Optional.">
            {(f) => <Input id={f.id} type="file" name="alt" accept=".csv,text/csv" className="py-2" aria-describedby={f.describedBy} />}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Source" required error={errors.source} hint="Where and when it was downloaded.">
            {(f) => <Input id={f.id} name="source" required defaultValue={previous(state, 'source')} aria-invalid={f.invalid} aria-describedby={f.describedBy} />}
          </Field>
          <Field label="Published on" error={errors.publishedOn}>
            {(f) => <Input id={f.id} type="date" name="publishedOn" defaultValue={previous(state, 'publishedOn')} aria-describedby={f.describedBy} />}
          </Field>
        </div>
        <FormMessage state={state} />
        {state.status === 'error' && Object.keys(errors).length > 1 ? (
          <ul className="max-h-32 list-disc overflow-y-auto pl-5 text-xs text-danger">
            {Object.entries(errors).map(([k, m]) => (
              <li key={k + m}>{m}</li>
            ))}
          </ul>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
          <SubmitButton pendingLabel="Checking and loading…">Load list</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

export function SanctionsDecisionForm({ listId }: { listId: string }) {
  const [state, action] = useActionState(decideSanctionsList, idle);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="listId" value={listId} />
      <Field label="What you checked" required>
        {(f) => <Input id={f.id} name="reason" required minLength={5} className="h-9 w-64" aria-describedby={f.describedBy} />}
      </Field>
      <button name="decision" value="approve" className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-fg hover:opacity-90">
        Approve
      </button>
      <button name="decision" value="reject" className="h-9 rounded-md border border-border px-3 text-sm font-medium hover:bg-subtle">
        Reject
      </button>
      <div className="basis-full">
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function ReferralDecisionForm({ referralId, sanctions }: { referralId: string; sanctions: boolean }) {
  const [state, action] = useActionState(decideReferral, idle);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="referralId" value={referralId} />
      <Field label="Reason" required error={state.status === 'error' ? state.fieldErrors.reason : undefined} hint="Returned to the channel with the decision.">
        {(f) => <Textarea id={f.id} name="reason" required minLength={5} maxLength={1000} aria-describedby={f.describedBy} />}
      </Field>
      <FormMessage state={state} />
      <div className="flex flex-wrap gap-2">
        <button name="decision" value="approved" className="h-10 rounded-lg bg-primary px-4 text-sm font-medium text-primary-fg hover:opacity-90">
          {sanctions ? 'Clear the match' : 'Approve'}
        </button>
        <button name="decision" value="declined" className="h-10 rounded-lg border border-border px-4 text-sm font-medium hover:bg-subtle">
          {sanctions ? 'Confirm the match and decline' : 'Decline'}
        </button>
      </div>
    </form>
  );
}
