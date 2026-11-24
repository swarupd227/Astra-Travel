'use client';

import { useActionState, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Bot, Check, Loader2, X } from 'lucide-react';
import type { FormVariableInput } from '@astra/contracts';
import { Button } from '@/components/ui/button';
import { Field, FormMessage, Input, SubmitButton, Textarea } from '@/components/ui/form';
import { Badge } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { idle } from '@/lib/actions';
import { applyVariableMap, askAgent, closeProposal, loadDraftManual, type AskState } from './actions';

/** Re-reads the page every few seconds while an agent run is queued or running. */
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), 6000);
    return () => clearInterval(id);
  }, [active, router]);
  return active ? (
    <p className="flex items-center gap-2 text-sm text-muted" role="status">
      <Loader2 aria-hidden className="size-4 animate-spin" /> The agent is working. This page updates by itself.
    </p>
  ) : null;
}

export function AskAgentForm({ agentId, agentName, question, label }: { agentId: string; agentName: string; question: string; label: string }) {
  const [state, action] = useActionState<AskState, FormData>(askAgent, idle);
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (state.status === 'success' && state.runId) router.replace(`${pathname}?asked=${state.runId}`);
  }, [state, router, pathname]);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="question" value={question} />
      <SubmitButton pendingLabel={`Asking ${agentName}…`} variant="secondary">
        <Bot aria-hidden className="size-4" /> {label}
      </SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}

export function CloseProposalForm({ proposalId, items }: { proposalId: string; items: string[] }) {
  const [state, action] = useActionState(closeProposal, idle);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="proposalId" value={proposalId} />
      <input type="hidden" name="items" value={JSON.stringify(items)} />
      <Field label="Note (optional)" hint="Kept with the decision, for the agent's review.">
        {(f) => <Textarea id={f.id} name="note" maxLength={1000} aria-describedby={f.describedBy} />}
      </Field>
      <FormMessage state={state} />
      <div className="flex flex-wrap gap-2">
        <button name="mode" value="rejected" className="inline-flex h-10 items-center gap-2 rounded-lg border border-border-strong bg-surface px-4 text-sm font-medium text-fg hover:bg-surface-muted">
          <X aria-hidden className="size-4" /> Reject the whole proposal
        </button>
      </div>
    </form>
  );
}

// ---------------- Variable map ----------------

export interface VariableItem {
  variable: FormVariableInput;
  rationale: string;
  page: number | null;
  check: { ok: boolean; detail: string } | null;
}

const rangeText = (v: FormVariableInput) => {
  const c = v.constraints as Record<string, unknown>;
  if ('min' in c && 'max' in c) return `${String(c.min)} to ${String(c.max)}${c.unit ? ` ${String(c.unit)}` : ''}${Array.isArray(c.bases) && c.bases.length ? ` (${(c.bases as string[]).join(', ')})` : ''}`;
  if (Array.isArray(c.options)) return (c.options as string[]).join(' · ');
  if (c.source) return `${String(c.source)}${c.dataset ? `: ${String(c.dataset)}` : ''}`;
  return '—';
};

export function VariableReview({ proposalId, editionId, items, open }: { proposalId: string; editionId: string; items: VariableItem[]; open: boolean }) {
  const [state, action] = useActionState(applyVariableMap, idle);
  // Variables that verified and agree with the form-reading rule are ticked; the rest are left for the person to decide.
  const [pick, setPick] = useState<Record<string, boolean>>(() => Object.fromEntries(items.map((i) => [i.variable.key, i.check?.ok !== false])));
  const [edit, setEdit] = useState<Record<string, { key: string; label: string; min?: string; max?: string }>>(() =>
    Object.fromEntries(
      items.map((i) => {
        const c = i.variable.constraints as { min?: number; max?: number };
        return [i.variable.key, { key: i.variable.key, label: i.variable.label, min: c.min?.toString(), max: c.max?.toString() }];
      }),
    ),
  );
  const picked = items
    .filter((i) => pick[i.variable.key])
    .map((i) => {
      const e = edit[i.variable.key]!;
      return { key: i.variable.key, original: i.variable, corrected: { key: e.key, label: e.label, ...(e.min !== undefined && e.min !== '' ? { min: Number(e.min) } : {}), ...(e.max !== undefined && e.max !== '' ? { max: Number(e.max) } : {}) } };
    });
  const setE = (k: string, patch: Partial<{ key: string; label: string; min: string; max: string }>) => setEdit((s) => ({ ...s, [k]: { ...s[k]!, ...patch } }));
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="proposalId" value={proposalId} />
      <input type="hidden" name="editionId" value={editionId} />
      <input type="hidden" name="items" value={JSON.stringify(items.map((i) => i.variable.key))} />
      <input type="hidden" name="picked" value={JSON.stringify(picked)} />
      <Table caption="Proposed variables">
        <THead>
          <tr>
            <TH>Save</TH>
            <TH>Wording from the form</TH>
            <TH>Variable</TH>
            <TH>Type and filed range</TH>
            <TH>Why</TH>
          </tr>
        </THead>
        <tbody>
          {items.map((i) => {
            const k = i.variable.key;
            const e = edit[k]!;
            const numeric = 'min' in (i.variable.constraints as object);
            return (
              <TR key={k}>
                <TD>
                  <input type="checkbox" aria-label={`Save ${i.variable.label}`} disabled={!open} checked={!!pick[k]} onChange={(ev) => setPick((s) => ({ ...s, [k]: ev.target.checked }))} />
                </TD>
                <TD className="max-w-xs">
                  <span className="block font-mono text-xs break-words">{i.variable.excerpt}</span>
                  <span className="text-xs text-muted">Page {i.page ?? '?'}</span>
                  {i.check && !i.check.ok ? (
                    <span className="mt-1 block">
                      <Badge tone="warning">Check this</Badge> <span className="text-xs">{i.check.detail}</span>
                    </span>
                  ) : null}
                </TD>
                <TD className="min-w-48 space-y-1">
                  <Input aria-label={`Label for ${k}`} className="h-8 text-xs" disabled={!open} value={e.label} onChange={(ev) => setE(k, { label: ev.target.value })} />
                  <Input aria-label={`Key for ${k}`} className="h-8 font-mono text-xs" disabled={!open} value={e.key} onChange={(ev) => setE(k, { key: ev.target.value })} />
                </TD>
                <TD className="min-w-44">
                  <span className="block text-xs font-medium">{i.variable.type.replace(/_/g, ' ')}</span>
                  <span className="block text-xs text-muted">{rangeText(i.variable)}</span>
                  {numeric ? (
                    <span className="mt-1 flex items-center gap-1">
                      <Input type="number" aria-label={`Lowest for ${k}`} className="h-8 w-24 text-xs" disabled={!open} value={e.min ?? ''} onChange={(ev) => setE(k, { min: ev.target.value })} />
                      <span className="text-xs text-muted">to</span>
                      <Input type="number" aria-label={`Highest for ${k}`} className="h-8 w-24 text-xs" disabled={!open} value={e.max ?? ''} onChange={(ev) => setE(k, { max: ev.target.value })} />
                    </span>
                  ) : null}
                </TD>
                <TD className="max-w-xs text-xs text-muted">{i.rationale}</TD>
              </TR>
            );
          })}
        </tbody>
      </Table>
      {open ? (
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton pendingLabel="Saving to the draft map…">
            <Check aria-hidden className="size-4" /> Save {picked.length} variable{picked.length === 1 ? '' : 's'} to the draft map
          </SubmitButton>
          <span className="text-xs text-muted">They are saved to the edition’s draft map with your corrections; someone else approves the map.</span>
        </div>
      ) : null}
      <FormMessage state={state} />
    </form>
  );
}

// ---------------- Rate manual ----------------

export interface ManualTable {
  id: string;
  name: string;
  page: string;
  rows: number;
  ok: boolean | null;
  detail: string;
}

export function ManualReview({
  proposalId,
  manual,
  tables,
  source,
  open,
}: {
  proposalId: string;
  manual: { code: string; state: string; benefit: string; effectiveFrom: string; document: unknown };
  tables: ManualTable[];
  source: string;
  open: boolean;
}) {
  const [state, action] = useActionState(loadDraftManual, idle);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  return (
    <div className="space-y-4">
      <Table caption="Drafted tables">
        <THead>
          <tr>
            <TH>Table</TH>
            <TH>Manual page</TH>
            <TH className="text-right">Rows</TH>
            <TH>Factors on that page</TH>
          </tr>
        </THead>
        <tbody>
          {tables.map((t) => (
            <TR key={t.id}>
              <TD>
                <span className="font-mono text-xs">{t.id}</span> {t.name}
              </TD>
              <TD className="font-mono text-xs">{t.page}</TD>
              <TD className="text-right tabular-nums">{t.rows}</TD>
              <TD>
                {t.ok === null ? <Badge tone="neutral">Not checked</Badge> : <Badge tone={t.ok ? 'success' : 'warning'}>{t.ok ? 'All found' : 'Check this'}</Badge>}
                <span className="mt-1 block text-xs text-muted break-words">{t.detail}</span>
              </TD>
            </TR>
          ))}
        </tbody>
      </Table>
      {open ? (
        <form action={action} className="space-y-4 rounded-lg border border-border p-4" noValidate>
          <p className="text-sm font-medium text-fg">Load as a draft manual</p>
          <p className="text-xs text-muted">Compare each table with the filed pages first. Loading creates a draft: a second rating analyst approves it, it must be filed, and every parity case must match before it can be published.</p>
          <input type="hidden" name="proposalId" value={proposalId} />
          <input type="hidden" name="manual" value={JSON.stringify({ document: manual.document })} />
          <input type="hidden" name="items" value={JSON.stringify(tables.map((t) => t.id))} />
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Manual code" required error={errors.code}>
              {(f) => <Input id={f.id} name="code" required defaultValue={manual.code} className="font-mono uppercase" aria-invalid={f.invalid} aria-describedby={f.describedBy} />}
            </Field>
            <Field label="State" required error={errors.state}>
              {(f) => <Input id={f.id} name="state" required maxLength={2} defaultValue={manual.state} className="uppercase" aria-invalid={f.invalid} aria-describedby={f.describedBy} />}
            </Field>
            <Field label="Benefit" required error={errors.benefit}>
              {(f) => <Input id={f.id} name="benefit" required defaultValue={manual.benefit} className="font-mono uppercase" aria-invalid={f.invalid} aria-describedby={f.describedBy} />}
            </Field>
            <Field label="Effective from" required error={errors.effectiveFrom}>
              {(f) => <Input id={f.id} type="date" name="effectiveFrom" required defaultValue={manual.effectiveFrom} aria-invalid={f.invalid} aria-describedby={f.describedBy} />}
            </Field>
          </div>
          <Field label="Source" required error={errors.source} hint="The filed document the tables were read from.">
            {(f) => <Input id={f.id} name="source" required defaultValue={source} aria-invalid={f.invalid} aria-describedby={f.describedBy} />}
          </Field>
          <Field label="Note (optional)">{(f) => <Textarea id={f.id} name="note" maxLength={1000} />}</Field>
          <FormMessage state={state} />
          {state.status === 'error' && Object.keys(errors).length > 1 ? (
            <ul className="max-h-32 list-disc overflow-y-auto pl-5 text-xs text-danger">
              {Object.entries(errors).map(([k, m]) => (
                <li key={k + m}>
                  {k}: {m}
                </li>
              ))}
            </ul>
          ) : null}
          <SubmitButton pendingLabel="Loading the draft…">Load as a draft manual</SubmitButton>
        </form>
      ) : null}
    </div>
  );
}

// ---------------- Parity ----------------

export function MarkReviewedForm({ proposalId, items }: { proposalId: string; items: string[] }) {
  const [state, action] = useActionState(closeProposal, idle);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="proposalId" value={proposalId} />
      <input type="hidden" name="items" value={JSON.stringify(items)} />
      <input type="hidden" name="mode" value="reviewed" />
      <FormMessage state={state} />
      <Button type="submit">
        <Check aria-hidden className="size-4" /> Mark as reviewed
      </Button>
    </form>
  );
}
