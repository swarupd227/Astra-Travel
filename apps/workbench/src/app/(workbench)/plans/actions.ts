'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { Plan, PlanDocument, PlanTestRun, PlanVersion } from '@astra/contracts';
import { api } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

export async function createPlan(_prev: ActionState, form: FormData): Promise<ActionState> {
  const kind = text(form, 'kind');
  const common = {
    kind,
    code: text(form, 'code').toUpperCase(),
    name: text(form, 'name'),
    effectiveFrom: text(form, 'effectiveFrom'),
  };
  const body =
    kind === 'base'
      ? { ...common, term: text(form, 'term'), catalogueId: text(form, 'catalogueId') }
      : kind === 'state'
        ? {
            ...common,
            parentPlanId: text(form, 'parentPlanId'),
            state: text(form, 'state').toUpperCase(),
          }
        : {
            ...common,
            parentPlanId: text(form, 'parentPlanId'),
            accountId: text(form, 'accountId'),
          };
  let created: { plan: Plan; draft: PlanVersion };
  try {
    created = await api<{ plan: Plan; draft: PlanVersion }>('/v1/plans', { method: 'POST', body });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath('/plans');
  redirect(`/plans/versions/${created.draft.id}?created=1`);
}

export type SaveState = ActionState & { saved?: PlanVersion };

/** Saves the builder's document; problems that do not block saving come back on the version. */
export async function saveVersion(_prev: SaveState, form: FormData): Promise<SaveState> {
  const id = text(form, 'versionId');
  let document: PlanDocument;
  try {
    document = JSON.parse(text(form, 'document')) as PlanDocument;
  } catch {
    return {
      status: 'error',
      message: 'The plan could not be read. Reload the page.',
      fieldErrors: {},
      values: {},
    };
  }
  try {
    const saved = await api<PlanVersion>(`/v1/plan-versions/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: { document, effectiveFrom: text(form, 'effectiveFrom') },
    });
    revalidatePath(`/plans/versions/${id}`);
    return {
      status: 'success',
      message: saved.problems.length
        ? `Saved, with ${saved.problems.length} thing${saved.problems.length === 1 ? '' : 's'} to finish before approval.`
        : 'Saved. The draft is complete and can be approved.',
      saved,
    };
  } catch (err) {
    return fromError(err, form);
  }
}

export async function approveVersion(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'versionId');
  try {
    await api(`/v1/plan-versions/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      body: { note: text(form, 'note') },
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/plans/versions/${id}`);
  redirect(`/plans/versions/${id}?done=approved`);
}

export async function publishVersion(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'versionId');
  try {
    await api(`/v1/plan-versions/${encodeURIComponent(id)}/publish`, { method: 'POST' });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/plans/versions/${id}`);
  redirect(`/plans/versions/${id}?done=published`);
}

export async function startDraft(_prev: ActionState, form: FormData): Promise<ActionState> {
  const planId = text(form, 'planId');
  let v: PlanVersion;
  try {
    v = await api<PlanVersion>(`/v1/plans/${encodeURIComponent(planId)}/drafts`, {
      method: 'POST',
      body: { effectiveFrom: text(form, 'effectiveFrom') },
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/plans/${planId}`);
  redirect(`/plans/versions/${v.id}`);
}

export async function runTests(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'versionId');
  try {
    const run = await api<PlanTestRun>(`/v1/plan-versions/${encodeURIComponent(id)}/test-runs`, {
      method: 'POST',
    });
    revalidatePath(`/plans/versions/${id}`);
    return run.passed === run.total
      ? { status: 'success', message: `All ${run.total} test cases pass.` }
      : {
          status: 'error',
          message: `${run.passed} of ${run.total} test cases pass.`,
          fieldErrors: {},
          values: {},
        };
  } catch (err) {
    return fromError(err, form);
  }
}

const optionalNumber = (v: string) => (v === '' ? undefined : Number(v));

/** A rating test case: one quote's travellers, trip and account, and the expected totals to the cent. */
export async function saveTestCase(_prev: ActionState, form: FormData): Promise<ActionState> {
  const planId = text(form, 'planId');
  const travellers = text(form, 'travellers')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      const [age, cost, waived] = l.split(',').map((x) => x.trim());
      return {
        id: `T${i + 1}`,
        age: optionalNumber(age ?? '') ?? null,
        costPerTraveller: cost ?? '',
        preExistingWaived:
          waived === '' || waived === undefined ? null : /^(y|yes|true)$/i.test(waived),
      };
    });
  const region = text(form, 'destinationRegion');
  const perBenefit = Object.fromEntries(
    text(form, 'expectedPerBenefit')
      .split(/[;,\n]/)
      .map((p) => p.split(/[:=]/).map((x) => x.trim()))
      .filter((p) => p.length === 2 && p[0] && p[1])
      .map(([b, v]) => [b!.toUpperCase(), v!]),
  );
  try {
    await api(`/v1/plans/${encodeURIComponent(planId)}/test-cases`, {
      method: 'POST',
      body: {
        name: text(form, 'name'),
        input: {
          rateDate: text(form, 'rateDate'),
          travellers,
          trip: {
            purchaseDate: text(form, 'purchaseDate'),
            departureDate: text(form, 'departureDate'),
            returnDate: text(form, 'returnDate'),
            destinations: region ? [{ region, days: 1 }] : [],
            penaltyDays: optionalNumber(text(form, 'penaltyDays')) ?? null,
          },
          account: { businessSegment: text(form, 'businessSegment') || null, notCollected: [] },
        },
        expected: {
          ...(text(form, 'expectedTotal') ? { policyTotal: text(form, 'expectedTotal') } : {}),
          ...(Object.keys(perBenefit).length ? { perBenefit } : {}),
        },
      },
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/plans/${planId}`);
  return {
    status: 'success',
    message: 'Test case saved. Run the tests on the version to check it.',
  };
}

export async function removeTestCase(_prev: ActionState, form: FormData): Promise<ActionState> {
  const planId = text(form, 'planId');
  try {
    await api(
      `/v1/plans/${encodeURIComponent(planId)}/test-cases/${encodeURIComponent(text(form, 'caseId'))}`,
      { method: 'DELETE' },
    );
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/plans/${planId}`);
  return { status: 'success', message: 'Test case removed.' };
}
