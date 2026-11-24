'use client';

import { useActionState, useMemo, useState } from 'react';
import { AlertTriangle, Plus, Save, Trash2 } from 'lucide-react';
import {
  BENEFIT_GROUP_LABELS,
  COVERAGE_LEVEL_LABELS,
  PACKAGING,
  PACKAGING_LABELS,
  PLAN_SETTINGS,
  PLAN_SETTING_LABELS,
  type CatalogueDocument,
  type PlanDocument,
  type PlanProblem,
  type PlanValue,
} from '@astra/contracts';
import { requiredValues } from '@astra/plans/required';
import { Button } from '@/components/ui/button';
import { FormMessage, Input, Select, SubmitButton } from '@/components/ui/form';
import { Badge, Card, CardHeader, Notice } from '@/components/ui/primitives';
import { saveVersion, type SaveState } from './actions';

export interface BuilderVariable {
  ref: string;
  label: string;
  type: string;
  constraints: Record<string, unknown>;
}

type Bounds = PlanDocument['bounds'];
type Kind = 'base' | 'state' | 'account';

const idle: SaveState = { status: 'idle' };
const inputClass = 'h-9';

/** The filed range or options of a variable, in words. */
export function filedRange(v: BuilderVariable): string {
  const c = v.constraints;
  const unit = c.unit === 'usd' ? '' : c.unit ? ` ${String(c.unit)}` : '';
  const money = (n: unknown) => (c.unit === 'usd' ? `$${Number(n).toLocaleString('en-US')}` : String(n));
  switch (v.type) {
    case 'numeric_range':
    case 'time_period':
      return `Filed range ${money(c.min)} to ${money(c.max)}${unit}`;
    case 'percentage_range':
      return `Filed range ${String(c.min)}% to ${String(c.max)}%`;
    case 'limit_basis':
    case 'wording_choice':
      return `Filed options: ${((c.options as string[]) ?? []).join(' · ')}`;
    case 'optional_benefit':
      return 'Included or not';
    default:
      return c.source === 'dataset' ? 'Filled from reference data' : 'Free text as filed';
  }
}

function ValueInput({
  v,
  value,
  onChange,
  disabled,
  label,
}: {
  v: BuilderVariable;
  value: PlanValue | undefined;
  onChange: (value: PlanValue) => void;
  disabled: boolean;
  label: string;
}) {
  const c = v.constraints;
  const options = (c.options as string[]) ?? [];
  switch (v.type) {
    case 'numeric_range':
    case 'time_period':
      return (
        <Input
          type="number"
          aria-label={label}
          className={inputClass}
          disabled={disabled}
          value={typeof value === 'number' ? value : ''}
          min={c.min as number}
          max={c.max as number}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
    case 'percentage_range': {
      const pv = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
      const bases = (c.bases as string[]) ?? [];
      return (
        <div className="flex gap-2">
          <Input
            type="number"
            aria-label={`${label} (%)`}
            className={inputClass}
            disabled={disabled}
            value={pv ? pv.percent : ''}
            onChange={(e) =>
              onChange(e.target.value === '' ? null : { percent: Number(e.target.value), ...(pv?.basis ? { basis: pv.basis } : {}) })
            }
          />
          {bases.length ? (
            <Select
              aria-label={`${label} basis`}
              className={inputClass}
              disabled={disabled}
              value={pv?.basis ?? ''}
              onChange={(e) => onChange({ percent: pv?.percent ?? 0, basis: e.target.value })}
            >
              <option value="">Basis…</option>
              {bases.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </Select>
          ) : null}
        </div>
      );
    }
    case 'limit_basis':
      return (
        <Select aria-label={label} className={inputClass} disabled={disabled} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">Choose…</option>
          {options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </Select>
      );
    case 'wording_choice': {
      const chosen = Array.isArray(value) ? value : [];
      if (!c.multiple) {
        return (
          <Select aria-label={label} className={inputClass} disabled={disabled} value={chosen[0] ?? ''} onChange={(e) => onChange(e.target.value ? [e.target.value] : null)}>
            <option value="">Choose the filed wording…</option>
            {options.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </Select>
        );
      }
      return (
        <fieldset className="space-y-1" aria-label={label}>
          {options.map((o) => (
            <label key={o} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                disabled={disabled}
                checked={chosen.includes(o)}
                onChange={(e) => onChange(e.target.checked ? [...chosen, o] : chosen.filter((x) => x !== o))}
              />
              {o}
            </label>
          ))}
        </fieldset>
      );
    }
    case 'optional_benefit':
      return (
        <Select
          aria-label={label}
          className={inputClass}
          disabled={disabled}
          value={value === true ? 'yes' : value === false ? 'no' : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'yes')}
        >
          <option value="">Choose…</option>
          <option value="yes">Included</option>
          <option value="no">Not included</option>
        </Select>
      );
    default:
      return c.source === 'dataset' ? (
        <p className="text-sm text-muted">Filled from reference data when documents are produced.</p>
      ) : (
        <Input aria-label={label} className={inputClass} disabled={disabled} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || null)} />
      );
  }
}

function ProblemText({ problems, path }: { problems: PlanProblem[]; path: string }) {
  const mine = problems.filter((p) => p.path === path || p.path.startsWith(`${path}.`));
  if (!mine.length) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {mine.map((p, i) => (
        <li key={i} className="flex gap-1 text-xs font-medium text-danger">
          <AlertTriangle aria-hidden className="mt-0.5 size-3 shrink-0" />
          {p.message}
        </li>
      ))}
    </ul>
  );
}

export function PlanBuilder({
  versionId,
  kind,
  initial,
  effectiveFrom,
  catalogue,
  variables,
  bounds: parentBounds,
  problems: initialProblems,
  editable,
}: {
  versionId: string;
  kind: Kind;
  initial: PlanDocument;
  effectiveFrom: string;
  catalogue: CatalogueDocument;
  variables: BuilderVariable[];
  bounds: Bounds;
  problems: PlanProblem[];
  editable: boolean;
}) {
  const [doc, setDoc] = useState<PlanDocument>(initial);
  const [from, setFrom] = useState(effectiveFrom);
  const [state, action] = useActionState(saveVersion, idle);
  const [extra, setExtra] = useState('');
  const vars = useMemo(() => new Map(variables.map((v) => [v.ref, v])), [variables]);
  const problems = state.status === 'success' && state.saved ? state.saved.problems : initialProblems;
  const serverErrors: PlanProblem[] =
    state.status === 'error' ? Object.entries(state.fieldErrors).map(([path, message]) => ({ path, message })) : [];
  const allProblems = [...serverErrors, ...problems];

  // Account plans keep the structure of the plan they come from and change only open values.
  const structureLocked = !editable || kind === 'account';
  const required = requiredValues(doc, catalogue);
  const shownValues = [...new Set([...required, ...Object.keys(doc.values)])];
  const settingRefs = new Set(doc.settings.map((s) => `${s.variable.source}:${s.variable.key}`));

  const update = (patch: Partial<PlanDocument>) => setDoc((d) => ({ ...d, ...patch }));
  const setValue = (ref: string, value: PlanValue) => update({ values: { ...doc.values, [ref]: value } });
  const removeValue = (ref: string) => {
    const { [ref]: _drop, ...rest } = doc.values;
    update({ values: rest });
  };

  const groups = [...new Set(catalogue.benefits.map((b) => b.group))];
  const categories = [...new Set(catalogue.coveredReasons.map((r) => r.category))];

  return (
    <form action={action} className="space-y-6" noValidate>
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="document" value={JSON.stringify(doc)} />
      <input type="hidden" name="effectiveFrom" value={from} />

      {kind === 'account' ? (
        <Notice tone="neutral" title="Account plan">
          Benefits, covered reasons and settings come from the state plan. Only the values the base plan leaves open can change, within its
          bounds.
        </Notice>
      ) : null}

      <Card>
        <CardHeader title="Benefits" description="Benefits from the approved catalogue, how each is sold, and the rate manual benefit that prices it." />
        <div className="divide-y divide-border">
          {groups.map((g) => (
            <fieldset key={g} className="px-5 py-4">
              <legend className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
                {BENEFIT_GROUP_LABELS[g as keyof typeof BENEFIT_GROUP_LABELS] ?? g}
              </legend>
              <div className="space-y-3">
                {catalogue.benefits
                  .filter((b) => b.group === g)
                  .map((b) => {
                    const pb = doc.benefits.find((x) => x.code === b.code);
                    return (
                      <div key={b.code} className="grid items-center gap-3 sm:grid-cols-[1fr_12rem_9rem]">
                        <label className="flex items-center gap-2 text-sm font-medium text-fg">
                          <input
                            type="checkbox"
                            checked={!!pb}
                            disabled={structureLocked}
                            onChange={(e) =>
                              update({
                                benefits: e.target.checked
                                  ? [...doc.benefits, { code: b.code, packaging: 'packaged', ratingBenefit: null }]
                                  : doc.benefits.filter((x) => x.code !== b.code),
                              })
                            }
                          />
                          {b.name}
                        </label>
                        {pb ? (
                          <>
                            <Select
                              aria-label={`${b.name}: how it is sold`}
                              className={inputClass}
                              disabled={structureLocked}
                              value={pb.packaging}
                              onChange={(e) =>
                                update({
                                  benefits: doc.benefits.map((x) =>
                                    x.code === b.code ? { ...x, packaging: e.target.value as (typeof PACKAGING)[number] } : x,
                                  ),
                                })
                              }
                            >
                              {PACKAGING.map((p) => (
                                <option key={p} value={p}>
                                  {PACKAGING_LABELS[p]}
                                </option>
                              ))}
                            </Select>
                            <Input
                              aria-label={`${b.name}: rate manual benefit`}
                              placeholder="Rated as (e.g. TCAN)"
                              className={`${inputClass} font-mono uppercase`}
                              disabled={structureLocked}
                              value={pb.ratingBenefit ?? ''}
                              onChange={(e) =>
                                update({
                                  benefits: doc.benefits.map((x) =>
                                    x.code === b.code ? { ...x, ratingBenefit: e.target.value.toUpperCase() || null } : x,
                                  ),
                                })
                              }
                            />
                          </>
                        ) : null}
                        <div className="sm:col-span-3">
                          <ProblemText problems={allProblems} path={`benefits.${b.code}`} />
                        </div>
                      </div>
                    );
                  })}
              </div>
            </fieldset>
          ))}
          {catalogue.upgrades.length ? (
            <fieldset className="px-5 py-4">
              <legend className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Upgrades</legend>
              <div className="space-y-3">
                {catalogue.upgrades.map((u) => {
                  const pu = doc.upgrades.find((x) => x.code === u.code);
                  return (
                    <div key={u.code} className="grid items-center gap-3 sm:grid-cols-[1fr_12rem]">
                      <label className="flex items-center gap-2 text-sm font-medium text-fg">
                        <input
                          type="checkbox"
                          checked={!!pu}
                          disabled={structureLocked}
                          onChange={(e) =>
                            update({
                              upgrades: e.target.checked
                                ? [...doc.upgrades, { code: u.code, packaging: 'optional_upgrade' }]
                                : doc.upgrades.filter((x) => x.code !== u.code),
                            })
                          }
                        />
                        {u.name}
                      </label>
                      {pu ? (
                        <Select
                          aria-label={`${u.name}: how it is sold`}
                          className={inputClass}
                          disabled={structureLocked}
                          value={pu.packaging}
                          onChange={(e) =>
                            update({
                              upgrades: doc.upgrades.map((x) =>
                                x.code === u.code ? { ...x, packaging: e.target.value as (typeof PACKAGING)[number] } : x,
                              ),
                            })
                          }
                        >
                          {PACKAGING.map((p) => (
                            <option key={p} value={p}>
                              {PACKAGING_LABELS[p]}
                            </option>
                          ))}
                        </Select>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </fieldset>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Covered reasons"
          description="Trip Cancellation and Interruption reasons and who they cover. Together they make the peril package used in rating."
        />
        <div className="divide-y divide-border">
          {categories.length === 0 ? <p className="px-5 py-4 text-sm text-muted">The catalogue has no covered reasons.</p> : null}
          {categories.map((cat) => (
            <fieldset key={cat} className="px-5 py-4">
              <legend className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{cat}</legend>
              <div className="space-y-3">
                {catalogue.coveredReasons
                  .filter((r) => r.category === cat)
                  .map((r) => {
                    const pr = doc.coveredReasons.find((x) => x.code === r.code);
                    return (
                      <div key={r.code}>
                        <label className="flex items-start gap-2 text-sm text-fg">
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={!!pr}
                            disabled={structureLocked}
                            onChange={(e) =>
                              update({
                                coveredReasons: e.target.checked
                                  ? [...doc.coveredReasons, { code: r.code, levels: [...r.coverageLevels] }]
                                  : doc.coveredReasons.filter((x) => x.code !== r.code),
                              })
                            }
                          />
                          <span>
                            {r.text}
                            {r.upgrade ? (
                              <span className="ml-2">
                                <Badge tone="neutral">With {catalogue.upgrades.find((u) => u.code === r.upgrade)?.name ?? r.upgrade}</Badge>
                              </span>
                            ) : null}
                          </span>
                        </label>
                        {pr ? (
                          <div className="mt-1 ml-6 flex flex-wrap gap-3" role="group" aria-label={`${r.text}: who is covered`}>
                            {r.coverageLevels.map((l) => (
                              <label key={l} className="flex items-center gap-1.5 text-xs text-muted">
                                <input
                                  type="checkbox"
                                  disabled={structureLocked}
                                  checked={pr.levels.includes(l)}
                                  onChange={(e) =>
                                    update({
                                      coveredReasons: doc.coveredReasons.map((x) =>
                                        x.code === r.code
                                          ? { ...x, levels: e.target.checked ? [...x.levels, l] : x.levels.filter((y) => y !== l) }
                                          : x,
                                      ),
                                    })
                                  }
                                />
                                {COVERAGE_LEVEL_LABELS[l]}
                              </label>
                            ))}
                          </div>
                        ) : null}
                        <div className="ml-6">
                          <ProblemText problems={allProblems} path={`coveredReasons.${r.code}`} />
                        </div>
                      </div>
                    );
                  })}
              </div>
            </fieldset>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Values"
          description="A value for every amount, basis and wording the included benefits use. Each must be within the range filed on the form."
        />
        <div className="divide-y divide-border">
          {shownValues.length === 0 ? <p className="px-5 py-4 text-sm text-muted">Include a benefit to see the values it needs.</p> : null}
          {shownValues
            .filter((ref) => !settingRefs.has(ref))
            .map((ref) => {
              const v = vars.get(ref);
              const bound = parentBounds[ref];
              const fixed = kind === 'account' && !bound;
              const label = v?.label ?? ref;
              return (
                <div key={ref} className="grid gap-3 px-5 py-3 sm:grid-cols-[1fr_16rem]">
                  <div>
                    <p className="text-sm font-medium text-fg">
                      {label}
                      {required.includes(ref) ? <span className="sr-only"> (required)</span> : null}
                    </p>
                    <p className="text-xs text-muted">
                      {v ? filedRange(v) : 'Not in the approved variable maps'}
                      {kind === 'account'
                        ? fixed
                          ? ' · fixed by the base plan'
                          : ` · account plans: ${bound!.options ? bound!.options.join(', ') : `${bound!.min ?? '—'} to ${bound!.max ?? '—'}`}`
                        : ''}
                    </p>
                    <ProblemText problems={allProblems} path={`values.${ref}`} />
                  </div>
                  <div className="space-y-2">
                    {v ? (
                      <ValueInput v={v} label={label} value={doc.values[ref]} disabled={!editable || fixed} onChange={(x) => setValue(ref, x)} />
                    ) : null}
                    {kind === 'base' && v && ['numeric_range', 'time_period', 'limit_basis'].includes(v.type) ? (
                      <BoundEditor
                        v={v}
                        bound={doc.bounds[ref]}
                        disabled={!editable}
                        onChange={(b) => {
                          const { [ref]: _drop, ...rest } = doc.bounds;
                          update({ bounds: b ? { ...rest, [ref]: b } : rest });
                        }}
                      />
                    ) : null}
                    {editable && !required.includes(ref) && kind !== 'account' ? (
                      <Button variant="ghost" size="sm" onClick={() => removeValue(ref)}>
                        <Trash2 aria-hidden className="size-3.5" /> Remove value
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
        </div>
        {editable && kind !== 'account' ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
            <Select aria-label="Add a value for another variable" className={`${inputClass} max-w-sm`} value={extra} onChange={(e) => setExtra(e.target.value)}>
              <option value="">Another variable…</option>
              {variables
                .filter((v) => !shownValues.includes(v.ref))
                .map((v) => (
                  <option key={v.ref} value={v.ref}>
                    {v.label}
                  </option>
                ))}
            </Select>
            <Button
              variant="secondary"
              size="sm"
              disabled={!extra}
              onClick={() => {
                setValue(extra, null);
                setExtra('');
              }}
            >
              <Plus aria-hidden className="size-3.5" /> Add value
            </Button>
          </div>
        ) : null}
      </Card>

      <Settings doc={doc} variables={variables} vars={vars} editable={editable && kind !== 'account'} problems={allProblems} update={update} />

      <Card>
        <CardHeader title="Dates" />
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
          <label className="space-y-1.5 text-sm font-medium text-fg">
            Effective from
            <Input type="date" value={from} disabled={!editable} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="space-y-1.5 text-sm font-medium text-fg">
            Product type (rating)
            <Input
              value={doc.productType ?? ''}
              disabled={structureLocked}
              placeholder="As named in the rate manual, if it rates by product"
              onChange={(e) => update({ productType: e.target.value || null })}
            />
          </label>
        </div>
      </Card>

      {editable ? (
        <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface/95 px-4 py-3 shadow-sm backdrop-blur">
          <FormMessage state={state} />
          <SubmitButton pendingLabel="Checking and saving…">
            <Save aria-hidden className="size-4" /> Save draft
          </SubmitButton>
        </div>
      ) : null}
    </form>
  );
}

function BoundEditor({
  v,
  bound,
  disabled,
  onChange,
}: {
  v: BuilderVariable;
  bound: Bounds[string] | undefined;
  disabled: boolean;
  onChange: (b: Bounds[string] | null) => void;
}) {
  const options = (v.constraints.options as string[]) ?? [];
  return (
    <div className="rounded-md border border-dashed border-border p-2">
      <label className="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          disabled={disabled}
          checked={!!bound}
          onChange={(e) =>
            onChange(e.target.checked ? (v.type === 'limit_basis' ? { options } : { min: v.constraints.min as number, max: v.constraints.max as number }) : null)
          }
        />
        Account plans may change this
      </label>
      {bound && v.type !== 'limit_basis' ? (
        <div className="mt-2 flex items-center gap-2">
          <Input
            type="number"
            aria-label={`${v.label}: lowest for account plans`}
            className="h-8 text-xs"
            disabled={disabled}
            value={bound.min ?? ''}
            onChange={(e) => onChange({ ...bound, min: e.target.value === '' ? undefined : Number(e.target.value) })}
          />
          <span className="text-xs text-muted">to</span>
          <Input
            type="number"
            aria-label={`${v.label}: highest for account plans`}
            className="h-8 text-xs"
            disabled={disabled}
            value={bound.max ?? ''}
            onChange={(e) => onChange({ ...bound, max: e.target.value === '' ? undefined : Number(e.target.value) })}
          />
        </div>
      ) : null}
      {bound && v.type === 'limit_basis' ? (
        <div className="mt-2 flex flex-wrap gap-3">
          {options.map((o) => (
            <label key={o} className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                disabled={disabled}
                checked={bound.options?.includes(o) ?? false}
                onChange={(e) =>
                  onChange({ ...bound, options: e.target.checked ? [...(bound.options ?? []), o] : (bound.options ?? []).filter((x) => x !== o) })
                }
              />
              {o}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Settings({
  doc,
  variables,
  vars,
  editable,
  problems,
  update,
}: {
  doc: PlanDocument;
  variables: BuilderVariable[];
  vars: Map<string, BuilderVariable>;
  editable: boolean;
  problems: PlanProblem[];
  update: (patch: Partial<PlanDocument>) => void;
}) {
  const [adding, setAdding] = useState('');
  const unused = PLAN_SETTINGS.filter((s) => !doc.settings.some((x) => x.setting === s));
  const setRow = (i: number, patch: Partial<PlanDocument['settings'][number]>) =>
    update({ settings: doc.settings.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  return (
    <Card>
      <CardHeader
        title="Plan conditions and coverage timing"
        description="Review period, lookback, CFAR and Trip Interruption settings, when cover starts and ends, and extensions. Each is bound to a form variable, so its filed range applies; rules and documents read the same values."
      />
      <div className="divide-y divide-border">
        {doc.settings.length === 0 ? <p className="px-5 py-4 text-sm text-muted">No conditions set yet.</p> : null}
        {doc.settings.map((s, i) => {
          const ref = `${s.variable.source}:${s.variable.key}`;
          const v = vars.get(ref);
          const label = PLAN_SETTING_LABELS[s.setting];
          return (
            <div key={s.setting} className="grid gap-3 px-5 py-3 sm:grid-cols-[1fr_14rem_14rem_auto]">
              <div>
                <p className="text-sm font-medium text-fg">{label}</p>
                <p className="text-xs text-muted">{v ? filedRange(v) : 'Choose the form variable it is filed as'}</p>
                <ProblemText problems={problems} path={`settings.${s.setting}`} />
              </div>
              <Select
                aria-label={`${label}: form variable`}
                className={inputClass}
                disabled={!editable}
                value={ref}
                onChange={(e) => {
                  const [source, key] = e.target.value.split(':') as ['schedule' | 'policy', string];
                  setRow(i, { variable: { source, key }, value: null });
                }}
              >
                <option value="schedule:not_chosen">Form variable…</option>
                {variables.map((x) => (
                  <option key={x.ref} value={x.ref}>
                    {x.label}
                  </option>
                ))}
              </Select>
              {v ? <ValueInput v={v} label={label} value={s.value} disabled={!editable} onChange={(value) => setRow(i, { value })} /> : <span />}
              {editable ? (
                <Button variant="ghost" size="sm" aria-label={`Remove ${label}`} onClick={() => update({ settings: doc.settings.filter((_, j) => j !== i) })}>
                  <Trash2 aria-hidden className="size-3.5" />
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
      {editable && unused.length ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
          <Select aria-label="Add a condition" className={`${inputClass} max-w-sm`} value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Add a condition…</option>
            {unused.map((s) => (
              <option key={s} value={s}>
                {PLAN_SETTING_LABELS[s]}
              </option>
            ))}
          </Select>
          <Button
            variant="secondary"
            size="sm"
            disabled={!adding}
            onClick={() => {
              // The form variable is chosen next; nothing is guessed.
              update({
                settings: [
                  ...doc.settings,
                  { setting: adding as (typeof PLAN_SETTINGS)[number], variable: { source: 'schedule', key: 'not_chosen' }, value: null },
                ],
              });
              setAdding('');
            }}
          >
            <Plus aria-hidden className="size-3.5" /> Add condition
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
