'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CirclePause, CirclePlay, FlaskConical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, FormMessage, Input, Select, SubmitButton, Textarea } from '@/components/ui/form';
import { idle, previous } from '@/lib/actions';
import {
  decideVersion,
  resolveReview,
  setAgentStatus,
  setBudget,
  setWarrant,
  startEvaluation,
} from './actions';

function ReasonField({
  state,
  label = 'Reason',
  hint = 'Recorded in the audit trail.',
}: {
  state: Parameters<typeof previous>[0];
  label?: string;
  hint?: string;
}) {
  const errors = state.status === 'error' ? state.fieldErrors : {};
  return (
    <Field label={label} required hint={hint} error={errors.reason ?? errors.note}>
      {(f) => (
        <Textarea
          id={f.id}
          name={label === 'Note' ? 'note' : 'reason'}
          required
          minLength={3}
          maxLength={500}
          defaultValue={previous(state, label === 'Note' ? 'note' : 'reason')}
          aria-invalid={f.invalid}
          aria-describedby={f.describedBy}
        />
      )}
    </Field>
  );
}

export function KillSwitch({
  agentId,
  name,
  status,
}: {
  agentId: string;
  name: string;
  status: 'active' | 'paused' | 'retired';
}) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(setAgentStatus, idle);
  const pausing = status === 'active';
  if (status === 'retired') return null;
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title={pausing ? `Pause ${name}` : `Resume ${name}`}
      description={
        pausing
          ? 'The agent stops before its next model or tool call. Queued and interrupted requests go to people as review tasks.'
          : 'The agent starts answering requests again under its current warrant and budget.'
      }
      trigger={
        <Button variant={pausing ? 'danger' : 'primary'}>
          {pausing ? (
            <CirclePause aria-hidden className="size-4" />
          ) : (
            <CirclePlay aria-hidden className="size-4" />
          )}
          {pausing ? 'Pause agent' : 'Resume agent'}
        </Button>
      }
    >
      <form action={action} className="space-y-4">
        <input type="hidden" name="agentId" value={agentId} />
        <input type="hidden" name="status" value={pausing ? 'paused' : 'active'} />
        <ReasonField state={state} />
        <FormMessage state={state} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
          <SubmitButton variant={pausing ? 'danger' : 'primary'}>
            {pausing ? 'Pause now' : 'Resume'}
          </SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

export function WarrantEditor({
  agentId,
  current,
  proposed,
}: {
  agentId: string;
  current: unknown;
  proposed: unknown;
}) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(setWarrant, idle);
  const [doc, setDoc] = useState(() => JSON.stringify(current ?? proposed, null, 2));
  const errors = state.status === 'error' ? state.fieldErrors : {};
  const docError =
    errors.document ?? Object.entries(errors).find(([k]) => k.startsWith('document'))?.[1];
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setDoc(JSON.stringify(current ?? proposed, null, 2));
      }}
      wide
      title={current ? 'Change the warrant' : 'Set the warrant'}
      description="The warrant lists the tools the agent may use, how often per run, the access it may use, and its limits. Saving creates a new warrant version."
      trigger={
        <Button variant={current ? 'secondary' : 'primary'}>
          {current ? 'Change warrant' : 'Set warrant'}
        </Button>
      }
    >
      <form action={action} className="space-y-4">
        <input type="hidden" name="agentId" value={agentId} />
        <Field label="Warrant (JSON)" required error={docError}>
          {(f) => (
            <Textarea
              id={f.id}
              name="document"
              value={doc}
              onChange={(e) => setDoc(e.target.value)}
              spellCheck={false}
              className="min-h-72 font-mono text-xs"
              aria-invalid={f.invalid}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        {proposed ? (
          <button
            type="button"
            className="text-sm font-medium text-primary hover:underline"
            onClick={() => setDoc(JSON.stringify(proposed, null, 2))}
          >
            Start from the warrant proposed in the agent’s code
          </button>
        ) : null}
        <ReasonField state={state} />
        <FormMessage state={state} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
          <SubmitButton>Save warrant</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

export function BudgetForm({
  agentId,
  limit,
  threshold,
}: {
  agentId: string;
  limit: number | null;
  threshold: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(setBudget, idle);
  const errors = state.status === 'error' ? state.fieldErrors : {};
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Set the monthly budget"
      description="Spend is counted at list price from recorded model usage. The agent stops making model calls when the budget is used up, and a review is raised at the alert threshold."
      trigger={
        <Button variant={limit === null ? 'primary' : 'secondary'}>
          {limit === null ? 'Set budget' : 'Change budget'}
        </Button>
      }
    >
      <form action={action} className="space-y-4">
        <input type="hidden" name="agentId" value={agentId} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Monthly limit (USD)" required error={errors.monthlyLimitUsd}>
            {(f) => (
              <Input
                id={f.id}
                name="monthlyLimitUsd"
                type="number"
                min={0}
                step={0.01}
                required
                defaultValue={previous(state, 'monthlyLimitUsd') ?? limit ?? ''}
                aria-invalid={f.invalid}
              />
            )}
          </Field>
          <Field label="Alert at (% of limit)" required error={errors.alertThresholdPct}>
            {(f) => (
              <Input
                id={f.id}
                name="alertThresholdPct"
                type="number"
                min={1}
                max={100}
                required
                defaultValue={previous(state, 'alertThresholdPct') ?? threshold ?? 80}
                aria-invalid={f.invalid}
              />
            )}
          </Field>
        </div>
        <ReasonField state={state} />
        <FormMessage state={state} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
          <SubmitButton>Save budget</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

export function RunEvaluation({
  agentId,
  version,
  evalSets,
}: {
  agentId: string;
  version: number;
  evalSets: { name: string; version: number; caseCount: number }[];
}) {
  const [state, action] = useActionState(startEvaluation, idle);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="agentVersion" value={version} />
      <label htmlFor={`eval-${version}`} className="sr-only">
        Evaluation set
      </label>
      <Select id={`eval-${version}`} name="evalSet" className="h-8 w-auto text-[13px]">
        {evalSets.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name} v{s.version} ({s.caseCount} cases)
          </option>
        ))}
      </Select>
      <SubmitButton variant="secondary" pendingLabel="Starting…" className="h-8 px-3 text-[13px]">
        <FlaskConical aria-hidden className="size-3.5" /> Evaluate
      </SubmitButton>
      {state.status !== 'idle' ? (
        <span
          role={state.status === 'error' ? 'alert' : 'status'}
          className={`text-xs ${state.status === 'error' ? 'text-danger' : 'text-success'}`}
        >
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

export function VersionDecision({ agentId, version }: { agentId: string; version: number }) {
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<'approve' | 'reject'>('approve');
  const [state, action] = useActionState(decideVersion, idle);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title={`Decide on version ${version}`}
      description="Approval needs a passed evaluation of this version against every evaluation set. Approving makes this version live and retires the previous one."
      trigger={<Button size="sm">Decide</Button>}
    >
      <form action={action} className="space-y-4">
        <input type="hidden" name="agentId" value={agentId} />
        <input type="hidden" name="version" value={version} />
        <fieldset className="flex gap-3">
          <legend className="mb-2 text-sm font-medium text-fg">Decision</legend>
          {(['approve', 'reject'] as const).map((d) => (
            <label
              key={d}
              className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary-soft"
            >
              <input
                type="radio"
                name="decision"
                value={d}
                checked={decision === d}
                onChange={() => setDecision(d)}
                className="accent-[var(--primary)]"
              />
              {d === 'approve' ? 'Approve and make live' : 'Reject'}
            </label>
          ))}
        </fieldset>
        <ReasonField state={state} />
        <FormMessage state={state} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
          <SubmitButton variant={decision === 'approve' ? 'primary' : 'danger'}>
            {decision === 'approve' ? 'Approve' : 'Reject'}
          </SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

export function ResolveReview({ reviewId }: { reviewId: string }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(resolveReview, idle);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Resolve this review"
      description="Record what you did. The resolution is kept in the audit trail and used to evaluate the agent."
      trigger={
        <Button size="sm" variant="secondary">
          Resolve
        </Button>
      }
    >
      <form action={action} className="space-y-4">
        <input type="hidden" name="reviewId" value={reviewId} />
        <Field label="Outcome" required>
          {(f) => (
            <Select
              id={f.id}
              name="resolution"
              defaultValue={previous(state, 'resolution') ?? 'handled'}
            >
              <option value="handled">Handled by a person</option>
              <option value="accepted">Agent behaved correctly</option>
              <option value="rejected">Agent behaved wrongly</option>
            </Select>
          )}
        </Field>
        <ReasonField state={state} label="Note" hint="What you did or found." />
        <FormMessage state={state} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
          <SubmitButton>Resolve</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

/** Refreshes server data while background work (an evaluation) is still running. */
export function AutoRefresh({ active, everyMs = 3_000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(id);
  }, [active, everyMs, router]);
  return null;
}
