'use client';

import { useActionState, useState } from 'react';
import { Calculator, Check, Layers, RotateCw } from 'lucide-react';
import { Field, FormMessage, Input, Select, SubmitButton, Textarea } from '@/components/ui/form';
import { idle } from '@/lib/actions';
import {
  approveRule,
  createBatch,
  createCommissionRule,
  createProgrammePremium,
  createProgrammeRule,
  recalculateRecord,
  retryBatch,
} from './actions';

export function CreateBatchForm() {
  const [state, action] = useActionState(createBatch, idle);
  return (
    <form action={action} className="space-y-2">
      <SubmitButton pendingLabel="Making the batch…">
        <Layers aria-hidden className="size-4" /> Collect ready records into a batch
      </SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}

export function RetryBatchForm({ batchId }: { batchId: string }) {
  const [state, action] = useActionState(retryBatch, idle);
  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="batchId" value={batchId} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Queuing…">
        <RotateCw aria-hidden className="size-3.5" /> Send again
      </SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}

export function RecalculateForm({ recordId }: { recordId: string }) {
  const [state, action] = useActionState(recalculateRecord, idle);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="recordId" value={recordId} />
      <SubmitButton pendingLabel="Recalculating…">
        <Calculator aria-hidden className="size-4" /> Recalculate
      </SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}

export function ApproveRuleForm({ ruleId, programme }: { ruleId: string; programme?: boolean }) {
  const [state, action] = useActionState(approveRule, idle);
  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="ruleId" value={ruleId} />
      {programme ? <input type="hidden" name="programme" value="1" /> : null}
      <SubmitButton variant="secondary" size="sm" pendingLabel="Approving…">
        <Check aria-hidden className="size-3.5" /> Approve
      </SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}

export function CommissionRuleForm({ accounts }: { accounts: { id: string; name: string }[] }) {
  const [state, action] = useActionState(createCommissionRule, idle);
  const [kind, setKind] = useState('flat');
  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Account">
          {(f) => (
            <Select id={f.id} name="accountId" required aria-describedby={f.describedBy}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Effective from">
          {(f) => (
            <Input
              id={f.id}
              name="effectiveFrom"
              type="date"
              required
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <Field label="How commission is calculated">
          {(f) => (
            <Select
              id={f.id}
              name="kind"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              aria-describedby={f.describedBy}
            >
              <option value="flat">A flat percent of premium</option>
              <option value="tiered">Tiered by the account’s premium in the month</option>
              <option value="volume">By the number of policies sold in the month</option>
              <option value="none">No commission</option>
            </Select>
          )}
        </Field>
        {kind === 'flat' ? (
          <Field label="Percent">
            {(f) => (
              <Input
                id={f.id}
                name="percent"
                inputMode="decimal"
                required
                aria-describedby={f.describedBy}
              />
            )}
          </Field>
        ) : null}
      </div>
      {kind === 'tiered' ? (
        <Field
          label="Tiers"
          hint="One per line as “dollars up to: percent”, rising; the last line is “rest: percent”."
        >
          {(f) => (
            <Textarea
              id={f.id}
              name="tiers"
              rows={4}
              required
              placeholder={'10000: 10\nrest: 12'}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
      ) : null}
      {kind === 'volume' ? (
        <Field label="Bands" hint="One per line as “policies from: percent”, starting at 0.">
          {(f) => (
            <Textarea
              id={f.id}
              name="bands"
              rows={4}
              required
              placeholder={'0: 8\n50: 10'}
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
      ) : null}
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Proposing…">Propose this rule</SubmitButton>
    </form>
  );
}

export function ProgrammeRuleForm({ programmes }: { programmes: { id: string; name: string }[] }) {
  const [state, action] = useActionState(createProgrammeRule, idle);
  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Card programme">
          {(f) => (
            <Select id={f.id} name="programmeId" required aria-describedby={f.describedBy}>
              {programmes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Effective from">
          {(f) => (
            <Input
              id={f.id}
              name="effectiveFrom"
              type="date"
              required
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
        <Field label="Rate per eligible account per month" hint="In dollars.">
          {(f) => (
            <Input
              id={f.id}
              name="rate"
              inputMode="decimal"
              required
              aria-describedby={f.describedBy}
            />
          )}
        </Field>
      </div>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Proposing…">Propose this rate</SubmitButton>
    </form>
  );
}

export function ProgrammePremiumForm({
  programmes,
}: {
  programmes: { id: string; name: string }[];
}) {
  const [state, action] = useActionState(createProgrammePremium, idle);
  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Card programme">
          {(f) => (
            <Select id={f.id} name="programmeId" required aria-describedby={f.describedBy}>
              {programmes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Month" hint="Counts the accounts eligible on its last day.">
          {(f) => (
            <Input id={f.id} name="month" type="month" required aria-describedby={f.describedBy} />
          )}
        </Field>
      </div>
      <FormMessage state={state} />
      <SubmitButton variant="secondary" pendingLabel="Calculating…">
        Create the month’s premium record
      </SubmitButton>
    </form>
  );
}
