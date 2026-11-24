'use client';

import { useActionState, useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  BENEFIT_GROUP_LABELS,
  BENEFIT_GROUPS,
  COVERAGE_LEVEL_LABELS,
  COVERAGE_LEVELS,
  LIMIT_BASES,
  LIMIT_BASIS_LABELS,
  UPGRADE_KIND_LABELS,
  UPGRADE_KINDS,
  type Amount,
  type Benefit,
  type BenefitCatalogue,
  type CoveredReason,
  type Upgrade,
  type VariableRef,
  type VariableType,
} from '@astra/contracts';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, FormMessage, Input, Select, SubmitButton, Textarea } from '@/components/ui/form';
import { Badge, Card, CardHeader, EmptyState, Notice } from '@/components/ui/primitives';
import { idle, type ActionState } from '@/lib/actions';
import {
  approveCatalogue,
  discardCatalogue,
  removeItem,
  saveItem,
  startCatalogue,
} from './actions';

export interface CatalogueVariable {
  source: 'schedule' | 'policy';
  key: string;
  label: string;
  type: VariableType;
  describe: string;
}

type Section = 'benefits' | 'coveredReasons' | 'upgrades';
const refId = (r: VariableRef | null | undefined) => (r ? `${r.source}:${r.key}` : '');
const toRef = (id: string): VariableRef | null => {
  if (!id) return null;
  const [source, key] = id.split(':') as ['schedule' | 'policy', string];
  return { source, key };
};

function VarSelect({
  label,
  vars,
  types,
  value,
  onChange,
  required,
  hint,
}: {
  label: string;
  vars: CatalogueVariable[];
  types: VariableType[];
  value: VariableRef | null;
  onChange: (v: VariableRef | null) => void;
  required?: boolean;
  hint?: string;
}) {
  const options = vars.filter((v) => types.includes(v.type));
  return (
    <Field
      label={label}
      required={required}
      hint={hint ?? (options.length ? undefined : 'No variable of this type in the approved maps.')}
    >
      {(f) => (
        <Select
          id={f.id}
          value={refId(value)}
          onChange={(e) => onChange(toRef(e.target.value))}
          aria-describedby={f.describedBy}
          required={required}
        >
          <option value="">{required ? 'Choose a variable' : 'None'}</option>
          {options.map((v) => (
            <option key={`${v.source}:${v.key}`} value={`${v.source}:${v.key}`}>
              {v.label} ({v.source}:{v.key}) · {v.describe}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

function AmountFields({
  legend,
  value,
  onChange,
  vars,
}: {
  legend: string;
  value: Amount | null;
  onChange: (a: Amount | null) => void;
  vars: CatalogueVariable[];
}) {
  const a = value ?? {
    variable: { source: 'schedule' as const, key: '' },
    basis: { kind: 'fixed' as const, basis: 'per_person' as const },
  };
  return (
    <fieldset className="space-y-3 rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-medium text-fg">{legend}</legend>
      <VarSelect
        label="Amount"
        vars={vars}
        types={['numeric_range']}
        value={value ? a.variable : null}
        required
        onChange={(v) => onChange(v ? { ...a, variable: v } : null)}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Basis">
          {(f) => (
            <Select
              id={f.id}
              value={a.basis.kind === 'fixed' ? a.basis.basis : 'variable'}
              onChange={(e) =>
                onChange({
                  ...a,
                  basis:
                    e.target.value === 'variable'
                      ? { kind: 'variable', variable: { source: 'schedule', key: '' } }
                      : { kind: 'fixed', basis: e.target.value as (typeof LIMIT_BASES)[number] },
                })
              }
            >
              {LIMIT_BASES.map((b) => (
                <option key={b} value={b}>
                  {LIMIT_BASIS_LABELS[b]}
                </option>
              ))}
              <option value="variable">Chosen per plan (limit basis variable)</option>
            </Select>
          )}
        </Field>
        {a.basis.kind === 'variable' ? (
          <VarSelect
            label="Limit basis variable"
            vars={vars}
            types={['limit_basis']}
            required
            value={a.basis.variable.key ? a.basis.variable : null}
            onChange={(v) =>
              onChange({
                ...a,
                basis: { kind: 'variable', variable: v ?? { source: 'schedule', key: '' } },
              })
            }
          />
        ) : null}
      </div>
    </fieldset>
  );
}

function SaveForm({
  section,
  catalogueId,
  editionId,
  payload,
  onSaved,
  children,
  onCancel,
}: {
  section: Section;
  catalogueId: string;
  editionId: string;
  payload: unknown;
  onSaved: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const [state, action] = useActionState(saveItem, idle);
  useEffect(() => {
    if (state.status === 'success') onSaved();
  }, [state, onSaved]);
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="catalogueId" value={catalogueId} />
      <input type="hidden" name="editionId" value={editionId} />
      <input type="hidden" name="section" value={section} />
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />
      {children}
      {state.status === 'error' ? (
        <div className="space-y-2">
          <FormMessage state={state} />
          {Object.keys(state.fieldErrors).length > 1 ? (
            <ul className="list-disc pl-5 text-xs text-danger">
              {Object.entries(state.fieldErrors).map(([k, m]) => (
                <li key={k}>{m}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <SubmitButton pendingLabel="Checking and saving…">Save</SubmitButton>
      </div>
    </form>
  );
}

const codeOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'c_$1')
    .slice(0, 48);

function CodeAndName({
  code,
  name,
  setCode,
  setName,
  existing,
}: {
  code: string;
  name: string;
  setCode: (s: string) => void;
  setName: (s: string) => void;
  existing: boolean;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Name" required>
        {(f) => (
          <Input
            id={f.id}
            value={name}
            required
            onChange={(e) => {
              setName(e.target.value);
              if (!existing) setCode(codeOf(e.target.value));
            }}
          />
        )}
      </Field>
      <Field
        label="Code"
        required
        hint={
          existing
            ? 'Codes cannot be renamed; remove and add instead.'
            : 'Lower case, digits and _.'
        }
      >
        {(f) => (
          <Input
            id={f.id}
            value={code}
            readOnly={existing}
            onChange={(e) => setCode(e.target.value)}
            className="font-mono"
            spellCheck={false}
            aria-describedby={f.describedBy}
          />
        )}
      </Field>
    </div>
  );
}

function BenefitEditor({
  initial,
  vars,
  ctx,
  onClose,
}: {
  initial: Benefit | null;
  vars: CatalogueVariable[];
  ctx: { catalogueId: string; editionId: string };
  onClose: () => void;
}) {
  const [b, setB] = useState<Benefit>(
    initial ?? {
      code: '',
      name: '',
      group: 'pre_departure',
      optional: null,
      maximum: {
        variable: { source: 'schedule', key: '' },
        basis: { kind: 'fixed', basis: 'per_person' },
      },
      perDay: null,
      deductible: null,
      subLimits: [],
      eventAmounts: [],
      notes: null,
    },
  );
  const set = <K extends keyof Benefit>(k: K, v: Benefit[K]) => setB((x) => ({ ...x, [k]: v }));
  return (
    <Dialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      wide
      title={initial ? `Edit ${initial.name}` : 'Add a benefit'}
      description="Amounts come from the schedule's approved variable map, so their filed ranges apply."
    >
      <SaveForm section="benefits" {...ctx} payload={b} onSaved={onClose} onCancel={onClose}>
        <CodeAndName
          code={b.code}
          name={b.name}
          setCode={(v) => set('code', v)}
          setName={(v) => set('name', v)}
          existing={!!initial}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Group" required>
            {(f) => (
              <Select
                id={f.id}
                value={b.group}
                onChange={(e) => set('group', e.target.value as Benefit['group'])}
              >
                {BENEFIT_GROUPS.map((g) => (
                  <option key={g} value={g}>
                    {BENEFIT_GROUP_LABELS[g]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <VarSelect
            label="Optional benefit variable"
            hint="Leave empty if the benefit is always included."
            vars={vars}
            types={['optional_benefit']}
            value={b.optional}
            onChange={(v) => set('optional', v)}
          />
        </div>
        <AmountFields
          legend="Maximum benefit"
          value={b.maximum}
          onChange={(a) => a && set('maximum', a)}
          vars={vars}
        />
        {(['perDay', 'deductible'] as const).map((k) => (
          <div key={k} className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!!b[k]}
                onChange={(e) =>
                  set(
                    k,
                    e.target.checked
                      ? {
                          variable: { source: 'schedule', key: '' },
                          basis: { kind: 'fixed', basis: 'per_person' },
                        }
                      : null,
                  )
                }
              />
              {k === 'perDay' ? 'Has a per-day maximum' : 'Has a deductible'}
            </label>
            {b[k] ? (
              <AmountFields
                legend={k === 'perDay' ? 'Per-day maximum' : 'Deductible'}
                value={b[k]}
                onChange={(a) => set(k, a)}
                vars={vars}
              />
            ) : null}
          </div>
        ))}
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-fg">Sub-limits</legend>
          {b.subLimits.map((s, i) => (
            <div key={i} className="space-y-3 rounded-lg border border-border p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Sub-limit name" required>
                  {(f) => (
                    <Input
                      id={f.id}
                      value={s.name}
                      onChange={(e) =>
                        set(
                          'subLimits',
                          b.subLimits.map((x, j) =>
                            j === i
                              ? {
                                  ...x,
                                  name: e.target.value,
                                  code: x.code || codeOf(e.target.value),
                                }
                              : x,
                          ),
                        )
                      }
                    />
                  )}
                </Field>
                <Field label="Code" required>
                  {(f) => (
                    <Input
                      id={f.id}
                      value={s.code}
                      className="font-mono"
                      onChange={(e) =>
                        set(
                          'subLimits',
                          b.subLimits.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)),
                        )
                      }
                    />
                  )}
                </Field>
              </div>
              <AmountFields
                legend="Sub-limit amount"
                value={s.amount}
                vars={vars}
                onChange={(a) =>
                  a &&
                  set(
                    'subLimits',
                    b.subLimits.map((x, j) => (j === i ? { ...x, amount: a } : x)),
                  )
                }
              />
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={s.includedInParent}
                    onChange={(e) =>
                      set(
                        'subLimits',
                        b.subLimits.map((x, j) =>
                          j === i ? { ...x, includedInParent: e.target.checked } : x,
                        ),
                      )
                    }
                  />
                  Included in the maximum benefit (as the schedule says)
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    set(
                      'subLimits',
                      b.subLimits.filter((_, j) => j !== i),
                    )
                  }
                >
                  Remove sub-limit
                </Button>
              </div>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              set('subLimits', [
                ...b.subLimits,
                {
                  code: '',
                  name: '',
                  amount: {
                    variable: { source: 'schedule', key: '' },
                    basis: { kind: 'fixed', basis: 'per_person' },
                  },
                  includedInParent: true,
                  optional: null,
                },
              ])
            }
          >
            <Plus aria-hidden className="size-4" /> Add sub-limit
          </Button>
        </fieldset>
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-fg">
            Event amounts (fixed amounts per event, for example Travel Inconvenience)
          </legend>
          {b.eventAmounts.map((ev, i) => (
            <div
              key={i}
              className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            >
              <Field label="Event" required>
                {(f) => (
                  <Input
                    id={f.id}
                    value={ev.event}
                    onChange={(e) =>
                      set(
                        'eventAmounts',
                        b.eventAmounts.map((x, j) =>
                          j === i
                            ? {
                                ...x,
                                event: e.target.value,
                                code: x.code || codeOf(e.target.value),
                              }
                            : x,
                        ),
                      )
                    }
                  />
                )}
              </Field>
              <VarSelect
                label="Amount"
                vars={vars}
                types={['numeric_range']}
                required
                value={ev.amount.key ? ev.amount : null}
                onChange={(v) =>
                  v &&
                  set(
                    'eventAmounts',
                    b.eventAmounts.map((x, j) => (j === i ? { ...x, amount: v } : x)),
                  )
                }
              />
              <Button
                variant="ghost"
                size="sm"
                className="mb-1"
                onClick={() =>
                  set(
                    'eventAmounts',
                    b.eventAmounts.filter((_, j) => j !== i),
                  )
                }
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              set('eventAmounts', [
                ...b.eventAmounts,
                { code: '', event: '', amount: { source: 'schedule', key: '' } },
              ])
            }
          >
            <Plus aria-hidden className="size-4" /> Add event amount
          </Button>
        </fieldset>
      </SaveForm>
    </Dialog>
  );
}

function ReasonEditor({
  initial,
  categories,
  upgrades,
  ctx,
  onClose,
}: {
  initial: CoveredReason | null;
  categories: string[];
  upgrades: Upgrade[];
  ctx: { catalogueId: string; editionId: string };
  onClose: () => void;
}) {
  const [r, setR] = useState<CoveredReason>(
    initial ?? {
      code: '',
      text: '',
      category: categories[0] ?? '',
      appliesTo: ['trip_cancellation', 'trip_interruption'],
      coverageLevels: ['self'],
      perilNumber: null,
      upgrade: null,
    },
  );
  const set = <K extends keyof CoveredReason>(k: K, v: CoveredReason[K]) =>
    setR((x) => ({ ...x, [k]: v }));
  const toggle = <T extends string>(list: T[], v: T) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  const reasonSets = upgrades.filter((u) => u.kind === 'covered_reason_set');
  return (
    <Dialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      wide
      title={initial ? 'Edit covered reason' : 'Add a covered reason'}
      description="Worded and grouped as in the policy form; the peril number comes from the rating manual."
    >
      <SaveForm section="coveredReasons" {...ctx} payload={r} onSaved={onClose} onCancel={onClose}>
        <Field label="Wording" required>
          {(f) => (
            <Textarea
              id={f.id}
              value={r.text}
              onChange={(e) => {
                set('text', e.target.value);
                if (!initial) set('code', codeOf(e.target.value.split(/[.,;]/)[0] ?? ''));
              }}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Code" required>
            {(f) => (
              <Input
                id={f.id}
                value={r.code}
                readOnly={!!initial}
                className="font-mono"
                onChange={(e) => set('code', e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Category"
            required
            hint="As grouped in the form, for example Medical and Health."
          >
            {(f) => (
              <>
                <Input
                  id={f.id}
                  list="reason-categories"
                  value={r.category}
                  onChange={(e) => set('category', e.target.value)}
                  aria-describedby={f.describedBy}
                />
                <datalist id="reason-categories">
                  {categories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
          <Field label="Peril number" hint="From the rating manual. Required before approval.">
            {(f) => (
              <Input
                id={f.id}
                value={r.perilNumber ?? ''}
                className="font-mono"
                onChange={(e) => set('perilNumber', e.target.value.trim() || null)}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-fg">Applies to</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            {(['trip_cancellation', 'trip_interruption'] as const).map((b) => (
              <label key={b} className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={r.appliesTo.includes(b)}
                  onChange={() => set('appliesTo', toggle(r.appliesTo, b))}
                />
                {b === 'trip_cancellation' ? 'Trip Cancellation' : 'Trip Interruption'}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-fg">Coverage levels</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            {COVERAGE_LEVELS.map((l) => (
              <label key={l} className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={r.coverageLevels.includes(l)}
                  onChange={() => set('coverageLevels', toggle(r.coverageLevels, l))}
                />
                {COVERAGE_LEVEL_LABELS[l]}
              </label>
            ))}
          </div>
        </fieldset>
        <Field
          label="Belongs to"
          hint="Base reasons are in every plan that includes the benefit; others come with an upgrade."
        >
          {(f) => (
            <Select
              id={f.id}
              value={r.upgrade ?? ''}
              onChange={(e) => set('upgrade', e.target.value || null)}
              aria-describedby={f.describedBy}
            >
              <option value="">Base set of covered reasons</option>
              {reasonSets.map((u) => (
                <option key={u.code} value={u.code}>
                  Upgrade: {u.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </SaveForm>
    </Dialog>
  );
}

function UpgradeEditor({
  initial,
  benefits,
  vars,
  ctx,
  onClose,
}: {
  initial: Upgrade | null;
  benefits: Benefit[];
  vars: CatalogueVariable[];
  ctx: { catalogueId: string; editionId: string };
  onClose: () => void;
}) {
  const [u, setU] = useState<Upgrade>(
    initial ?? {
      code: '',
      name: '',
      kind: 'benefit_package',
      offeredBy: { source: 'schedule', key: '' },
      benefits: [],
      replacements: [],
      notes: null,
    },
  );
  const set = <K extends keyof Upgrade>(k: K, v: Upgrade[K]) => setU((x) => ({ ...x, [k]: v }));
  const targets = benefits.flatMap((b) => [
    { id: `${b.code}|maximum`, label: `${b.name}: maximum` },
    ...(b.perDay ? [{ id: `${b.code}|perDay`, label: `${b.name}: per-day maximum` }] : []),
    ...(b.deductible ? [{ id: `${b.code}|deductible`, label: `${b.name}: deductible` }] : []),
    ...b.subLimits.map((s) => ({ id: `${b.code}|sub|${s.code}`, label: `${b.name}: ${s.name}` })),
  ]);
  const targetId = (t: Upgrade['replacements'][number]['target']) =>
    t.kind === 'benefit' ? `${t.benefit}|${t.field}` : `${t.benefit}|sub|${t.subLimit}`;
  const toTarget = (id: string): Upgrade['replacements'][number]['target'] => {
    const [benefit, a, sub] = id.split('|') as [string, string, string?];
    return a === 'sub'
      ? { kind: 'sub_limit', benefit, subLimit: sub! }
      : { kind: 'benefit', benefit, field: a as 'maximum' };
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      wide
      title={initial ? `Edit ${initial.name}` : 'Add an upgrade'}
      description="An optional upgrade offered by the form; it may add benefits or replace base limits."
    >
      <SaveForm section="upgrades" {...ctx} payload={u} onSaved={onClose} onCancel={onClose}>
        <CodeAndName
          code={u.code}
          name={u.name}
          setCode={(v) => set('code', v)}
          setName={(v) => set('name', v)}
          existing={!!initial}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Kind" required>
            {(f) => (
              <Select
                id={f.id}
                value={u.kind}
                onChange={(e) => set('kind', e.target.value as Upgrade['kind'])}
              >
                {UPGRADE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {UPGRADE_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <VarSelect
            label="Offered by"
            required
            vars={vars}
            types={['optional_benefit']}
            value={u.offeredBy.key ? u.offeredBy : null}
            onChange={(v) => v && set('offeredBy', v)}
          />
        </div>
        {u.kind === 'benefit_package' || u.kind === 'sports' ? (
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-fg">Benefits it adds</legend>
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              {benefits.map((b) => (
                <label key={b.code} className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={u.benefits.includes(b.code)}
                    onChange={() =>
                      set(
                        'benefits',
                        u.benefits.includes(b.code)
                          ? u.benefits.filter((x) => x !== b.code)
                          : [...u.benefits, b.code],
                      )
                    }
                  />
                  {b.name}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-fg">Limits it replaces when bought</legend>
          {u.replacements.map((rep, i) => (
            <div key={i} className="space-y-3 rounded-lg border border-border p-3">
              <Field label="Replaces" required>
                {(f) => (
                  <Select
                    id={f.id}
                    value={targetId(rep.target)}
                    onChange={(e) =>
                      set(
                        'replacements',
                        u.replacements.map((x, j) =>
                          j === i ? { ...x, target: toTarget(e.target.value) } : x,
                        ),
                      )
                    }
                  >
                    {targets.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <AmountFields
                legend="Replacement amount"
                value={rep.amount}
                vars={vars}
                onChange={(a) =>
                  a &&
                  set(
                    'replacements',
                    u.replacements.map((x, j) => (j === i ? { ...x, amount: a } : x)),
                  )
                }
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  set(
                    'replacements',
                    u.replacements.filter((_, j) => j !== i),
                  )
                }
              >
                Remove replacement
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            disabled={!targets.length}
            onClick={() =>
              set('replacements', [
                ...u.replacements,
                {
                  target: toTarget(targets[0]!.id),
                  amount: {
                    variable: { source: 'schedule', key: '' },
                    basis: { kind: 'fixed', basis: 'per_person' },
                  },
                },
              ])
            }
          >
            <Plus aria-hidden className="size-4" /> Add replaced limit
          </Button>
        </fieldset>
      </SaveForm>
    </Dialog>
  );
}

function SmallForm({
  action,
  fields,
  children,
  variant = 'secondary',
}: {
  action: (s: ActionState, f: FormData) => Promise<ActionState>;
  fields: Record<string, string>;
  children: ReactNode;
  variant?: 'secondary' | 'primary' | 'danger';
}) {
  const [state, run] = useActionState(action, idle);
  return (
    <form action={run} className="inline">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <SubmitButton
        variant={variant}
        pendingLabel="…"
        className={variant === 'secondary' ? 'h-8 px-2 text-xs' : ''}
      >
        {children}
      </SubmitButton>
      {state.status === 'error' ? (
        <span role="alert" className="ml-2 text-xs text-danger">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

const describeAmount = (a: Amount | null, vars: CatalogueVariable[]) => {
  if (!a) return '—';
  const v = vars.find((x) => x.source === a.variable.source && x.key === a.variable.key);
  const basis =
    a.basis.kind === 'fixed'
      ? LIMIT_BASIS_LABELS[a.basis.basis].toLowerCase()
      : 'basis chosen per plan';
  return `${v ? v.describe : `${a.variable.source}:${a.variable.key}`}, ${basis}`;
};

export function CatalogueEditor({
  editionId,
  draft,
  current,
  vars,
  canEdit,
  me,
  policyEditions,
}: {
  editionId: string;
  draft: BenefitCatalogue | null;
  current: BenefitCatalogue | null;
  vars: CatalogueVariable[];
  canEdit: boolean;
  me: string;
  policyEditions: { id: string; label: string }[];
}) {
  const cat = draft ?? current;
  const editing = !!draft && canEdit;
  const ctx = { catalogueId: draft?.id ?? '', editionId };
  const [editor, setEditor] = useState<{ section: Section; item: unknown } | null>(null);
  const [approveState, approve] = useActionState(approveCatalogue, idle);
  const [startState, start] = useActionState(startCatalogue, idle);
  const doc = cat?.document ?? { benefits: [], coveredReasons: [], upgrades: [] };
  const categories = [...new Set(doc.coveredReasons.map((r) => r.category))].sort();
  const missingPerils = doc.coveredReasons.filter((r) => !r.perilNumber).length;

  if (!cat) {
    return (
      <Card>
        <CardHeader
          title="Benefit catalogue"
          description="Benefits, sub-limits, covered reasons and upgrades from this schedule, built on its approved variable map."
        />
        {canEdit ? (
          <form action={start} className="space-y-4 p-5">
            <input type="hidden" name="editionId" value={editionId} />
            <Field
              label="Policy form edition"
              hint="Covered reasons are worded in the policy form; choose it to refer to its variables."
            >
              {(f) => (
                <Select
                  id={f.id}
                  name="policyEditionId"
                  defaultValue=""
                  aria-describedby={f.describedBy}
                >
                  <option value="">None yet</option>
                  {policyEditions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <FormMessage state={startState} />
            <SubmitButton pendingLabel="Starting…">
              <Plus aria-hidden className="size-4" /> Start the catalogue
            </SubmitButton>
          </form>
        ) : (
          <EmptyState title="No catalogue yet" />
        )}
      </Card>
    );
  }

  const header = (title: string, section: Section, count: number) => (
    <CardHeader
      title={
        <>
          {title} <Badge tone="neutral">{count}</Badge>
        </>
      }
      actions={
        editing ? (
          <Button variant="secondary" size="sm" onClick={() => setEditor({ section, item: null })}>
            <Plus aria-hidden className="size-4" /> Add
          </Button>
        ) : null
      }
    />
  );
  const rowActions = (section: Section, item: { code: string }, label: string) =>
    editing ? (
      <div className="flex shrink-0 gap-1">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Edit ${label}`}
          onClick={() => setEditor({ section, item })}
        >
          <Pencil aria-hidden className="size-4" />
        </Button>
        <SmallForm action={removeItem} fields={{ ...ctx, section, code: item.code }}>
          <Trash2 aria-hidden className="size-4" /> Remove
        </SmallForm>
      </div>
    ) : null;

  return (
    <div className="space-y-6">
      {cat.problems.length ? (
        <Notice
          tone="warning"
          title={`${cat.problems.length} thing${cat.problems.length === 1 ? '' : 's'} to resolve before approval`}
        >
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {cat.problems.slice(0, 20).map((p) => (
              <li key={p.path}>
                <span className="font-mono text-xs">{p.path}</span>: {p.message}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <Card>
        {header('Benefits', 'benefits', doc.benefits.length)}
        {doc.benefits.length === 0 ? (
          <EmptyState
            title="No benefits yet"
            description={
              editing ? 'Add each benefit in the schedule, with its sub-limits.' : undefined
            }
          />
        ) : (
          <div className="divide-y divide-border">
            {BENEFIT_GROUPS.filter((g) => doc.benefits.some((b) => b.group === g)).map((g) => (
              <section key={g} aria-label={BENEFIT_GROUP_LABELS[g]} className="px-5 py-4">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">
                  {BENEFIT_GROUP_LABELS[g]}
                </h3>
                <ul className="space-y-3">
                  {doc.benefits
                    .filter((b) => b.group === g)
                    .map((b) => (
                      <li key={b.code} className="flex items-start justify-between gap-3">
                        <div className="min-w-0 text-sm">
                          <p className="font-medium text-fg">
                            {b.name} {b.optional ? <Badge tone="primary">Optional</Badge> : null}
                          </p>
                          <p className="text-muted">Maximum: {describeAmount(b.maximum, vars)}</p>
                          {b.perDay ? (
                            <p className="text-muted">Per day: {describeAmount(b.perDay, vars)}</p>
                          ) : null}
                          {b.deductible ? (
                            <p className="text-muted">
                              Deductible: {describeAmount(b.deductible, vars)}
                            </p>
                          ) : null}
                          {b.subLimits.length ? (
                            <ul className="mt-1 list-disc pl-5 text-muted">
                              {b.subLimits.map((s) => (
                                <li key={s.code}>
                                  {s.name}: {describeAmount(s.amount, vars)}{' '}
                                  {s.includedInParent
                                    ? '(included in the maximum)'
                                    : '(in addition)'}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          {b.eventAmounts.length ? (
                            <p className="text-muted">{b.eventAmounts.length} event amounts</p>
                          ) : null}
                        </div>
                        {rowActions('benefits', b, b.name)}
                      </li>
                    ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Card>

      <Card>
        {header('Covered reasons', 'coveredReasons', doc.coveredReasons.length)}
        {missingPerils ? (
          <p className="px-5 pt-3 text-sm text-warning">
            {missingPerils} without a peril number from the rating manual.
          </p>
        ) : null}
        {doc.coveredReasons.length === 0 ? (
          <EmptyState title="No covered reasons yet" />
        ) : (
          <div className="divide-y divide-border">
            {categories.map((c) => (
              <section key={c} aria-label={c} className="px-5 py-4">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">
                  {c}
                </h3>
                <ul className="space-y-3">
                  {doc.coveredReasons
                    .filter((r) => r.category === c)
                    .map((r) => (
                      <li key={r.code} className="flex items-start justify-between gap-3">
                        <div className="min-w-0 text-sm">
                          <p className="text-fg">{r.text}</p>
                          <p className="text-muted">
                            {r.coverageLevels.map((l) => COVERAGE_LEVEL_LABELS[l]).join(', ')} ·{' '}
                            {r.appliesTo
                              .map((a) => (a === 'trip_cancellation' ? 'TC' : 'TI'))
                              .join(' and ')}{' '}
                            ·{' '}
                            {r.perilNumber ? (
                              `peril ${r.perilNumber}`
                            ) : (
                              <span className="text-warning">peril number missing</span>
                            )}
                            {r.upgrade
                              ? ` · with ${doc.upgrades.find((u) => u.code === r.upgrade)?.name ?? r.upgrade}`
                              : ''}
                          </p>
                        </div>
                        {rowActions('coveredReasons', r, r.code)}
                      </li>
                    ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Card>

      <Card>
        {header('Upgrades', 'upgrades', doc.upgrades.length)}
        {doc.upgrades.length === 0 ? (
          <EmptyState title="No upgrades yet" />
        ) : (
          <ul className="divide-y divide-border">
            {doc.upgrades.map((u) => (
              <li key={u.code} className="flex items-start justify-between gap-3 px-5 py-4 text-sm">
                <div className="min-w-0">
                  <p className="font-medium text-fg">
                    {u.name} <Badge tone="neutral">{UPGRADE_KIND_LABELS[u.kind]}</Badge>
                  </p>
                  {u.benefits.length ? (
                    <p className="text-muted">
                      Adds:{' '}
                      {u.benefits
                        .map((c) => doc.benefits.find((b) => b.code === c)?.name ?? c)
                        .join(', ')}
                    </p>
                  ) : null}
                  {u.replacements.map((rep, i) => (
                    <p key={i} className="text-muted">
                      Replaces{' '}
                      {doc.benefits.find((b) => b.code === rep.target.benefit)?.name ??
                        rep.target.benefit}{' '}
                      {rep.target.kind === 'benefit'
                        ? rep.target.field === 'maximum'
                          ? 'maximum'
                          : rep.target.field === 'perDay'
                            ? 'per-day maximum'
                            : 'deductible'
                        : `sub-limit ${rep.target.subLimit}`}{' '}
                      with {describeAmount(rep.amount, vars)}
                    </p>
                  ))}
                </div>
                {rowActions('upgrades', u, u.name)}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {draft && canEdit ? (
        <Card className="p-5">
          <h3 className="mb-3 text-sm font-semibold text-fg">Approve this catalogue</h3>
          {draft.contributors.includes(me) ? (
            <Notice tone="neutral">
              You built or edited this draft, so someone else must approve it.
            </Notice>
          ) : (
            <form action={approve} className="space-y-3">
              <input type="hidden" name="catalogueId" value={draft.id} />
              <input type="hidden" name="editionId" value={editionId} />
              <Field label="What you checked" required>
                {(f) => <Textarea id={f.id} name="note" required minLength={5} maxLength={500} />}
              </Field>
              <FormMessage state={approveState} />
              <SubmitButton pendingLabel="Approving…">
                <CheckCircle2 aria-hidden className="size-4" /> Approve catalogue
              </SubmitButton>
            </form>
          )}
          <div className="mt-3">
            <SmallForm action={discardCatalogue} fields={ctx}>
              Discard draft
            </SmallForm>
          </div>
        </Card>
      ) : canEdit && current ? (
        <form action={start}>
          <input type="hidden" name="editionId" value={editionId} />
          <SubmitButton variant="secondary" pendingLabel="Starting…">
            <Plus aria-hidden className="size-4" /> Start new version
          </SubmitButton>
          <FormMessage state={startState} />
        </form>
      ) : null}

      {editor?.section === 'benefits' ? (
        <BenefitEditor
          initial={editor.item as Benefit | null}
          vars={vars}
          ctx={ctx}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {editor?.section === 'coveredReasons' ? (
        <ReasonEditor
          initial={editor.item as CoveredReason | null}
          categories={categories}
          upgrades={doc.upgrades}
          ctx={ctx}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {editor?.section === 'upgrades' ? (
        <UpgradeEditor
          initial={editor.item as Upgrade | null}
          benefits={doc.benefits}
          vars={vars}
          ctx={ctx}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </div>
  );
}
