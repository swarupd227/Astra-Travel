'use client';

import { useActionState } from 'react';
import { Bot, Upload } from 'lucide-react';
import type { RejectionExplanation } from '@astra/contracts';
import { Field, FormMessage, Input, SubmitButton, Textarea } from '@/components/ui/form';
import { idle, previous } from '@/lib/actions';
import { approveMapping, askFeedAgent, decideExplanations, sendSample } from './actions';

export function SampleForm({ programmeId }: { programmeId: string }) {
  const [state, action] = useActionState(sendSample, idle);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="programmeId" value={programmeId} />
      <Field label="Issuer’s file" hint="A delimited text file whose first line names the columns. Only the first 200 lines are kept; card numbers are removed.">
        {(f) => <Input id={f.id} name="file" type="file" accept=".csv,.txt,text/csv,text/plain" required aria-describedby={f.describedBy} />}
      </Field>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Sending…">
        <Upload aria-hidden className="size-4" /> Keep a sample
      </SubmitButton>
    </form>
  );
}

export function AskAgentForm({ question, label }: { question: string; label: string }) {
  const [state, action] = useActionState(askFeedAgent, idle);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="question" value={question} />
      <SubmitButton variant="secondary" pendingLabel="Asking…">
        <Bot aria-hidden className="size-4" /> {label}
      </SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}

export function ApproveMappingForm({ programmeId, sampleId, proposalId, initial, label }: { programmeId: string; sampleId: string; proposalId?: string; initial: string; label: string }) {
  const [state, action] = useActionState(approveMapping, idle);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="programmeId" value={programmeId} />
      <input type="hidden" name="sampleId" value={sampleId} />
      {proposalId ? <input type="hidden" name="proposalId" value={proposalId} /> : null}
      <Field label="Mapping" hint="Correct it here before approving if needed. It is checked against the sample." error={state.status === 'error' ? state.fieldErrors.document : undefined}>
        {(f) => <Textarea id={f.id} name="document" defaultValue={previous(state, 'document') ?? initial} spellCheck={false} aria-describedby={f.describedBy} className="min-h-56 font-mono text-xs" />}
      </Field>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Checking…">{label}</SubmitButton>
    </form>
  );
}

export function ExplanationsForm({ programmeId, proposalId, explanations, counts, canDecide }: { programmeId: string; proposalId: string; explanations: RejectionExplanation[]; counts: Record<string, number>; canDecide: boolean }) {
  const [state, action] = useActionState(decideExplanations, idle);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="programmeId" value={programmeId} />
      <input type="hidden" name="proposalId" value={proposalId} />
      {explanations.map((e) => (
        <fieldset key={e.code} className="rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-medium text-fg">
            {e.code.replace(/_/g, ' ')} ({counts[e.code] ?? 0} records)
          </legend>
          <p className="text-sm text-fg">{e.explanation}</p>
          <p className="mt-2 text-sm text-muted">
            <span className="font-medium">Proposed fix ({e.fix.kind === 'mapping' ? 'change the mapping' : 'the issuer corrects its file'}):</span> {e.fix.detail}
          </p>
          {e.fix.kind === 'mapping' ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-medium text-primary">Show the proposed mapping</summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-surface-muted p-3 text-xs">{JSON.stringify(e.fix.mapping, null, 2)}</pre>
            </details>
          ) : null}
          {canDecide ? (
            <div className="mt-3 flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name={`decision:${e.code}`} value="approved" required className="size-4" /> Approve
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name={`decision:${e.code}`} value="rejected" required className="size-4" /> Reject
              </label>
            </div>
          ) : null}
        </fieldset>
      ))}
      <FormMessage state={state} />
      {canDecide ? <SubmitButton pendingLabel="Recording…">Record my decisions</SubmitButton> : null}
    </form>
  );
}
