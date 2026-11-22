'use client';

import { useActionState, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, MousePointerSquareDashed, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  VARIABLE_TYPE_LABELS,
  VARIABLE_TYPES,
  type BracketSpan,
  type FormVariable,
  type VariableMap,
  type VariableType,
} from '@astra/contracts';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, FormMessage, Input, Select, SubmitButton, Textarea } from '@/components/ui/form';
import { Badge, Card, CardHeader, EmptyState, Notice } from '@/components/ui/primitives';
import { idle, previous, type ActionState } from '@/lib/actions';
import { approveMap, discardMap, removeVariable, saveVariable, startMap } from '../actions';

interface Draft {
  key: string;
  label: string;
  type: VariableType;
  constraints: Record<string, unknown>;
  textStart: number;
  textEnd: number;
  excerpt: string;
  notes: string;
  existing: boolean;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/<<|>>|\[|\]|optional/g, ' ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'v_$1')
    .slice(0, 48) || 'variable';

const lines = (v: unknown) => (Array.isArray(v) ? (v as string[]).join('\n') : '');

function describe(v: { type: VariableType; constraints: Record<string, unknown> }): string {
  const c = v.constraints;
  switch (v.type) {
    case 'numeric_range':
      return c.unit === 'usd'
        ? `$${Number(c.min).toLocaleString('en-US')} to $${Number(c.max).toLocaleString('en-US')}`
        : `${c.min} to ${c.max}`;
    case 'percentage_range':
      return `${c.min}% to ${c.max}%${(c.bases as string[])?.length ? ` of ${(c.bases as string[]).join(' or ')}` : ''}`;
    case 'time_period':
      return `${c.min} to ${c.max} ${c.unit}`;
    case 'wording_choice':
    case 'limit_basis':
      return (c.options as string[]).join(' / ') + (c.multiple ? ' (one or more)' : '');
    case 'insert_placeholder':
      return c.source === 'dataset'
        ? `From reference data: ${c.dataset}`
        : c.source === 'url'
          ? 'A web address'
          : 'Controlled text';
    default:
      return 'Included or not';
  }
}

/** The form text with variables (mapped) and suggested wording highlighted. Every highlight is a button. */
function FormTextView({
  text,
  pageStarts,
  variables,
  candidates,
  onPick,
  containerRef,
}: {
  text: string;
  pageStarts: number[];
  variables: FormVariable[];
  candidates: BracketSpan[];
  onPick: (s: {
    start: number;
    end: number;
    existing?: FormVariable;
    candidate?: BracketSpan;
  }) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const marks = useMemo(() => {
    const chosen: {
      start: number;
      end: number;
      variable?: FormVariable;
      candidate?: BracketSpan;
    }[] = [];
    const overlaps = (s: number, e: number) => chosen.some((m) => s < m.end && e > m.start);
    for (const v of [...variables].sort((a, b) => a.textStart - b.textStart)) {
      if (!overlaps(v.textStart, v.textEnd))
        chosen.push({ start: v.textStart, end: v.textEnd, variable: v });
    }
    for (const c of candidates)
      if (!c.mapped && !overlaps(c.start, c.end))
        chosen.push({ start: c.start, end: c.end, candidate: c });
    return chosen.sort((a, b) => a.start - b.start);
  }, [variables, candidates]);

  const plain = (from: number, to: number): ReactNode[] => {
    const out: ReactNode[] = [];
    let i = from;
    while (i < to) {
      const ff = text.indexOf('\f', i);
      const stop = ff === -1 || ff >= to ? to : ff;
      if (stop > i) {
        out.push(
          <span key={`t${i}`} data-start={i}>
            {text.slice(i, stop)}
          </span>,
        );
      }
      if (stop < to) {
        const page = pageStarts.indexOf(stop + 1) + 1;
        out.push(
          <span
            key={`p${stop}`}
            className="my-3 block border-t border-dashed border-border pt-1 text-xs font-medium text-subtle"
            aria-label={`Page ${page}`}
          >
            Page {page}
          </span>,
        );
        i = stop + 1;
      } else i = stop;
    }
    return out;
  };

  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of marks) {
    parts.push(...plain(at, m.start));
    const v = m.variable;
    parts.push(
      <button
        key={`m${m.start}`}
        type="button"
        data-start={m.start}
        onClick={() => onPick({ start: m.start, end: m.end, existing: v, candidate: m.candidate })}
        className={
          v
            ? 'rounded-sm bg-success-soft px-0.5 text-left text-fg underline decoration-success decoration-2 underline-offset-2 hover:bg-success/20'
            : 'rounded-sm bg-warning-soft px-0.5 text-left text-fg underline decoration-warning decoration-dotted decoration-2 underline-offset-2 hover:bg-warning/20'
        }
        aria-label={
          v
            ? `Variable ${v.key}: ${text.slice(m.start, m.end)}`
            : `Suggested: ${text.slice(m.start, m.end)}`
        }
      >
        {text.slice(m.start, m.end)}
      </button>,
    );
    at = m.end;
  }
  parts.push(...plain(at, text.length));

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      role="region"
      aria-label="Form text"
      className="max-h-[70vh] overflow-y-auto whitespace-pre-wrap break-words p-5 font-serif text-[15px] leading-7 text-fg"
    >
      {parts}
    </div>
  );
}

function offsetIn(container: HTMLElement, node: Node, offset: number): number | null {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  const seg = el?.closest('[data-start]') as HTMLElement | null;
  if (!seg || !container.contains(seg)) return null;
  if (node.nodeType !== Node.TEXT_NODE)
    return Number(seg.dataset.start) + (offset > 0 ? (seg.textContent ?? '').length : 0);
  return Number(seg.dataset.start) + offset;
}

function VariableEditor({
  draft,
  mapId,
  editionId,
  datasets,
  onClose,
}: {
  draft: Draft;
  mapId: string;
  editionId: string;
  datasets: { code: string; name: string }[];
  onClose: () => void;
}) {
  const [state, action] = useActionState(saveVariable, idle);
  const [type, setType] = useState<VariableType>(draft.type);
  const [source, setSource] = useState(String(draft.constraints.source ?? 'dataset'));
  const errors = state.status === 'error' ? state.fieldErrors : {};
  const c = draft.constraints;
  const err = (k: string) => errors[k] ?? errors[`constraints.${k}`];
  useEffect(() => {
    if (state.status === 'success') onClose();
  }, [state, onClose]);
  return (
    <Dialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      wide
      title={draft.existing ? `Edit ${draft.key}` : 'Map this wording'}
      description="Record the filed range or options exactly as the form allows."
    >
      <form action={action} className="space-y-4" noValidate>
        <input type="hidden" name="mapId" value={mapId} />
        <input type="hidden" name="editionId" value={editionId} />
        <input type="hidden" name="textStart" value={draft.textStart} />
        <input type="hidden" name="textEnd" value={draft.textEnd} />
        <input type="hidden" name="excerpt" value={draft.excerpt} />
        <figure className="rounded-lg border border-border bg-surface-muted px-4 py-3">
          <figcaption className="mb-1 text-xs font-medium uppercase tracking-wide text-subtle">
            Form wording
          </figcaption>
          <blockquote className="whitespace-pre-wrap font-serif text-sm text-fg">
            {draft.excerpt}
          </blockquote>
        </figure>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Label" required error={errors.label}>
            {(f) => (
              <Input
                id={f.id}
                name="label"
                required
                defaultValue={previous(state, 'label') ?? draft.label}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
          <Field
            label="Key"
            required
            error={errors.key}
            hint={
              draft.existing
                ? 'Keys cannot be renamed; remove and add instead.'
                : 'Lower case, digits and _.'
            }
          >
            {(f) => (
              <Input
                id={f.id}
                name="key"
                required
                readOnly={draft.existing}
                defaultValue={previous(state, 'key') ?? draft.key}
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
        </div>
        <Field label="Type" required error={errors.type}>
          {(f) => (
            <Select
              id={f.id}
              name="type"
              value={type}
              onChange={(e) => setType(e.target.value as VariableType)}
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            >
              {VARIABLE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {VARIABLE_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {type === 'numeric_range' || type === 'percentage_range' || type === 'time_period' ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label={type === 'percentage_range' ? 'Filed minimum (%)' : 'Filed minimum'}
              required
              error={err('min')}
            >
              {(f) => (
                <Input
                  id={f.id}
                  name="min"
                  type="number"
                  step="any"
                  required
                  defaultValue={String(c.min ?? '')}
                  aria-invalid={f.invalid}
                  aria-describedby={f.describedBy}
                />
              )}
            </Field>
            <Field
              label={type === 'percentage_range' ? 'Filed maximum (%)' : 'Filed maximum'}
              required
              error={err('max')}
            >
              {(f) => (
                <Input
                  id={f.id}
                  name="max"
                  type="number"
                  step="any"
                  required
                  defaultValue={String(c.max ?? '')}
                  aria-invalid={f.invalid}
                  aria-describedby={f.describedBy}
                />
              )}
            </Field>
            {type === 'numeric_range' ? (
              <Field label="Unit" required>
                {(f) => (
                  <Select id={f.id} name="unit" defaultValue={String(c.unit ?? 'usd')}>
                    <option value="usd">US dollars</option>
                    <option value="number">Number</option>
                  </Select>
                )}
              </Field>
            ) : type === 'time_period' ? (
              <Field label="Unit" required>
                {(f) => (
                  <Select id={f.id} name="periodUnit" defaultValue={String(c.unit ?? 'days')}>
                    {['hours', 'days', 'months', 'years'].map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : null}
          </div>
        ) : null}
        {type === 'percentage_range' ? (
          <Field
            label="Bases"
            error={err('bases')}
            hint="One per line, as filed (for example Air Cost, Trip Cost). Leave empty if the form gives none."
          >
            {(f) => (
              <Textarea
                id={f.id}
                name="bases"
                defaultValue={lines(c.bases)}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
        ) : null}
        {type === 'wording_choice' || type === 'limit_basis' ? (
          <Field
            label="Filed options"
            required
            error={err('options')}
            hint="One per line, exactly as filed. At least two."
          >
            {(f) => (
              <Textarea
                id={f.id}
                name="options"
                required
                defaultValue={lines(c.options)}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
        ) : null}
        {type === 'wording_choice' ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="multiple" defaultChecked={c.multiple !== false} /> More
            than one option may be chosen
          </label>
        ) : null}
        {type === 'insert_placeholder' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Value comes from" required>
              {(f) => (
                <Select
                  id={f.id}
                  name="source"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                >
                  <option value="dataset">Reference data</option>
                  <option value="url">A web address</option>
                  <option value="text">Controlled text</option>
                </Select>
              )}
            </Field>
            {source === 'dataset' ? (
              <Field label="Dataset" required error={err('dataset')}>
                {(f) => (
                  <Select
                    id={f.id}
                    name="dataset"
                    defaultValue={String(c.dataset ?? 'prohibited_destinations')}
                    aria-invalid={f.invalid}
                    aria-describedby={f.describedBy}
                  >
                    {datasets.map((d) => (
                      <option key={d.code} value={d.code}>
                        {d.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : null}
          </div>
        ) : null}
        <Field label="Notes" error={errors.notes}>
          {(f) => (
            <Textarea
              id={f.id}
              name="notes"
              maxLength={1000}
              defaultValue={previous(state, 'notes') ?? draft.notes}
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <FormMessage state={state} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <SubmitButton pendingLabel="Saving…">Save variable</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

function SmallAction({
  action,
  fields,
  label,
  pending,
  icon,
  variant = 'ghost',
}: {
  action: (s: ActionState, f: FormData) => Promise<ActionState>;
  fields: Record<string, string>;
  label: string;
  pending: string;
  icon?: ReactNode;
  variant?: 'ghost' | 'secondary' | 'primary';
}) {
  const [state, run] = useActionState(action, idle);
  return (
    <form action={run} className="inline">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <SubmitButton
        variant={variant === 'ghost' ? 'secondary' : variant}
        pendingLabel={pending}
        className={variant === 'ghost' ? 'h-8 px-2 text-xs' : ''}
      >
        {icon}
        {label}
      </SubmitButton>
      {state.status === 'error' ? (
        <span role="alert" className="ml-2 text-xs text-danger">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

export function MapWorkspace({
  editionId,
  text,
  pageStarts,
  brackets,
  draft,
  current,
  canEdit,
  me,
  datasets,
}: {
  editionId: string;
  text: string;
  pageStarts: number[];
  brackets: BracketSpan[];
  draft: VariableMap | null;
  current: VariableMap | null;
  canEdit: boolean;
  me: string;
  datasets: { code: string; name: string }[];
}) {
  const map = draft ?? current;
  const editing = !!draft && canEdit;
  const [editor, setEditor] = useState<Draft | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [approveState, approve] = useActionState(approveMap, idle);
  const variables = map?.variables ?? [];
  const unmapped = brackets.filter((b) => !b.mapped);

  const open = (start: number, end: number, existing?: FormVariable, candidate?: BracketSpan) => {
    if (!editing) return;
    const excerpt = text.slice(start, end);
    setEditor(
      existing
        ? {
            key: existing.key,
            label: existing.label,
            type: existing.type,
            constraints: existing.constraints,
            textStart: start,
            textEnd: end,
            excerpt,
            notes: existing.notes ?? '',
            existing: true,
          }
        : {
            key: slug(excerpt),
            label:
              excerpt
                .replace(/[[\]<>]/g, '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 120) || 'Variable',
            type: candidate?.suggestion?.type ?? 'optional_benefit',
            constraints: candidate?.suggestion?.constraints ?? {},
            textStart: start,
            textEnd: end,
            excerpt,
            notes: '',
            existing: false,
          },
    );
  };

  const mapSelection = () => {
    const sel = window.getSelection();
    const container = textRef.current;
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !container) {
      setHint('Select the wording in the form text first.');
      return;
    }
    const r = sel.getRangeAt(0);
    const start = offsetIn(container, r.startContainer, r.startOffset);
    const end = offsetIn(container, r.endContainer, r.endOffset);
    if (start === null || end === null || end <= start) {
      setHint('Select wording inside the form text.');
      return;
    }
    setHint(null);
    open(start, end);
  };

  return (
    <Card>
      <CardHeader
        title={map ? `Variable map, version ${map.version}` : 'Variable map'}
        description={
          draft
            ? `Draft by ${draft.contributors.join(', ')}. Approved by someone who did not build it, it replaces the current map.`
            : current
              ? `Approved by ${current.approvedBy}. Approved maps never change; start a new version to make changes.`
              : 'Each bracketed option or value in the form becomes a variable with its filed range.'
        }
        actions={
          canEdit && !draft ? (
            <SmallAction
              action={startMap}
              fields={{ editionId }}
              label={current ? 'Start new version' : 'Start variable map'}
              pending="Starting…"
              icon={<Plus aria-hidden className="size-4" />}
              variant="primary"
            />
          ) : null
        }
      />
      {approveState.status === 'error' ? (
        <div className="px-5 pt-4">
          <FormMessage state={approveState} />
        </div>
      ) : null}
      <div className="grid lg:grid-cols-5">
        <div className="border-b border-border lg:col-span-3 lg:border-b-0 lg:border-r">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-2 text-xs text-muted">
            <span className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-4 rounded-sm bg-success-soft ring-1 ring-success"
                />{' '}
                Variable
              </span>
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-4 rounded-sm bg-warning-soft ring-1 ring-warning"
                />{' '}
                Suggested, not mapped
              </span>
            </span>
            {editing ? (
              <Button variant="secondary" size="sm" onClick={mapSelection}>
                <MousePointerSquareDashed aria-hidden className="size-4" /> Map selected text
              </Button>
            ) : null}
          </div>
          {hint ? (
            <p role="status" className="px-5 pt-3 text-sm text-warning">
              {hint}
            </p>
          ) : null}
          <FormTextView
            text={text}
            pageStarts={pageStarts}
            variables={variables}
            candidates={brackets}
            containerRef={textRef}
            onPick={(s) => open(s.start, s.end, s.existing, s.candidate)}
          />
        </div>
        <div className="space-y-6 p-5 lg:col-span-2">
          <section aria-labelledby="vars-h">
            <h3 id="vars-h" className="mb-2 text-sm font-semibold text-fg">
              Variables <Badge tone="neutral">{variables.length}</Badge>
            </h3>
            {variables.length === 0 ? (
              <p className="text-sm text-muted">
                {editing
                  ? 'Choose highlighted wording, or select wording and map it.'
                  : 'None yet.'}
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {variables.map((v) => (
                  <li key={v.key} className="flex items-start justify-between gap-2 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-fg">{v.key}</p>
                      <p className="text-sm text-fg">{v.label}</p>
                      <p className="text-xs text-muted">
                        {VARIABLE_TYPE_LABELS[v.type]} · {describe(v)} · page {v.page}
                      </p>
                    </div>
                    {editing ? (
                      <div className="flex shrink-0 gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Edit ${v.key}`}
                          onClick={() => open(v.textStart, v.textEnd, v)}
                        >
                          <Pencil aria-hidden className="size-4" />
                        </Button>
                        <SmallAction
                          action={removeVariable}
                          fields={{ mapId: draft!.id, editionId, key: v.key }}
                          label="Remove"
                          pending="…"
                          icon={<Trash2 aria-hidden className="size-4" />}
                        />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
          {editing && unmapped.length ? (
            <section aria-labelledby="sugg-h">
              <h3 id="sugg-h" className="mb-2 text-sm font-semibold text-fg">
                Suggested from the form <Badge tone="warning">{unmapped.length}</Badge>
              </h3>
              <p className="mb-2 text-xs text-muted">
                Read from the bracketed wording. Check each one against the filing before saving.
              </p>
              <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                {unmapped.map((b) => (
                  <li
                    key={`${b.start}-${b.end}`}
                    className="flex items-start justify-between gap-2 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-serif text-sm text-fg" title={b.text}>
                        {b.text}
                      </p>
                      <p className="text-xs text-muted">
                        {b.suggestion
                          ? `${VARIABLE_TYPE_LABELS[b.suggestion.type]} · ${b.suggestion.why}`
                          : 'No clear type: choose one.'}
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => open(b.start, b.end, undefined, b)}
                    >
                      Map
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {draft && canEdit ? (
            <section
              aria-labelledby="approve-h"
              className="space-y-3 rounded-lg border border-border p-4"
            >
              <h3 id="approve-h" className="text-sm font-semibold text-fg">
                Approve
              </h3>
              {draft.contributors.includes(me) ? (
                <Notice tone="neutral">
                  You built or edited this draft, so someone else must approve it.
                </Notice>
              ) : (
                <form action={approve} className="space-y-3">
                  <input type="hidden" name="mapId" value={draft.id} />
                  <input type="hidden" name="editionId" value={editionId} />
                  <Field
                    label="What you checked"
                    required
                    error={
                      approveState.status === 'error' ? approveState.fieldErrors.note : undefined
                    }
                  >
                    {(f) => (
                      <Textarea
                        id={f.id}
                        name="note"
                        required
                        minLength={5}
                        maxLength={500}
                        aria-invalid={f.invalid}
                        aria-describedby={f.describedBy}
                      />
                    )}
                  </Field>
                  <SubmitButton pendingLabel="Approving…">
                    <CheckCircle2 aria-hidden className="size-4" /> Approve map
                  </SubmitButton>
                </form>
              )}
              <SmallAction
                action={discardMap}
                fields={{ mapId: draft.id, editionId }}
                label="Discard draft"
                pending="Discarding…"
              />
            </section>
          ) : null}
          {!map && !canEdit ? <EmptyState title="No variable map yet" /> : null}
        </div>
      </div>
      {editor && draft ? (
        <VariableEditor
          draft={editor}
          mapId={draft.id}
          editionId={editionId}
          datasets={datasets}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </Card>
  );
}
