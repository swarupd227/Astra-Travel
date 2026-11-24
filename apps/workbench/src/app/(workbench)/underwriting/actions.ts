'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { EvaluationResult, Referral, RuleSet, RuleSetDocument } from '@astra/contracts';
import { api } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

const num = (v: string) => (v === '' ? undefined : Number(v));

/** One traveller's quote from the form fields shared by the check page and the test case dialog. */
function buildInput(form: FormData) {
  const country = text(form, 'destinationCountry').toUpperCase();
  const region = text(form, 'destinationRegion');
  const able = text(form, 'ableToTravel');
  const dob = text(form, 'dateOfBirth');
  return {
    stage: text(form, 'stage') || 'quote',
    travellers: [
      {
        id: 'T1',
        firstName: text(form, 'firstName'),
        lastName: text(form, 'lastName'),
        ...(dob ? { dateOfBirth: dob } : {}),
        ...(text(form, 'age') ? { age: num(text(form, 'age')) } : {}),
        ...(text(form, 'costPerTraveller') ? { costPerTraveller: text(form, 'costPerTraveller') } : {}),
      },
    ],
    trip: {
      purchaseDate: text(form, 'purchaseDate'),
      ...(text(form, 'initialDepositDate') ? { initialDepositDate: text(form, 'initialDepositDate') } : {}),
      departureDate: text(form, 'departureDate'),
      returnDate: text(form, 'returnDate'),
      destinations: country || region ? [{ ...(country ? { country } : {}), ...(region ? { region } : {}) }] : [],
    },
    insuredPercent: num(text(form, 'insuredPercent')) ?? 100,
    ableToTravel: able === 'yes' ? true : able === 'no' ? false : null,
    ...(text(form, 'businessSegment') ? { businessSegment: text(form, 'businessSegment') } : {}),
    term: text(form, 'term') || 'single_trip',
    benefits: text(form, 'benefits')
      .split(/[,;\s]+/)
      .filter(Boolean),
  };
}

export type CheckState = ActionState & { result?: EvaluationResult };

export async function checkEligibility(_prev: CheckState, form: FormData): Promise<CheckState> {
  try {
    const result = await api<EvaluationResult>('/v1/underwriting/evaluate', {
      method: 'POST',
      body: { planVersionId: text(form, 'planVersionId'), input: buildInput(form) },
    });
    return { status: 'success', message: 'Checked.', result };
  } catch (err) {
    return fromError(err, form);
  }
}

export async function saveTestCase(_prev: ActionState, form: FormData): Promise<ActionState> {
  const planId = text(form, 'planId');
  const rules = text(form, 'expectedRules')
    .split(/[,;\s]+/)
    .filter(Boolean);
  const waiver = text(form, 'expectedWaiver');
  const cfar = text(form, 'expectedCfar');
  try {
    await api(`/v1/plans/${encodeURIComponent(planId)}/rule-test-cases`, {
      method: 'POST',
      body: {
        name: text(form, 'name'),
        input: buildInput(form),
        expected: {
          outcome: text(form, 'expectedOutcome'),
          ...(rules.length ? { referralRules: rules } : {}),
          ...(waiver ? { waiver: waiver === 'yes' } : {}),
          ...(cfar ? { cfarOffered: cfar === 'yes' } : {}),
          ...(text(form, 'expectedReason') ? { reasonsInclude: [text(form, 'expectedReason')] } : {}),
        },
      },
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/underwriting/plans/${planId}`);
  return { status: 'success', message: 'Test case saved. Run the tests on a rule set to check it.' };
}

export async function removeTestCase(_prev: ActionState, form: FormData): Promise<ActionState> {
  const planId = text(form, 'planId');
  try {
    await api(`/v1/plans/${encodeURIComponent(planId)}/rule-test-cases/${encodeURIComponent(text(form, 'caseId'))}`, { method: 'DELETE' });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/underwriting/plans/${planId}`);
  return { status: 'success', message: 'Removed.' };
}

export async function startRuleSet(_prev: ActionState, form: FormData): Promise<ActionState> {
  const planId = text(form, 'planId');
  let rs: RuleSet;
  try {
    rs = await api<RuleSet>(`/v1/plans/${encodeURIComponent(planId)}/rule-sets`, { method: 'POST', body: { effectiveFrom: text(form, 'effectiveFrom') } });
  } catch (err) {
    return fromError(err, form);
  }
  redirect(`/underwriting/rule-sets/${rs.id}?created=1`);
}

export type SaveState = ActionState & { saved?: RuleSet };

export async function saveRuleSet(_prev: SaveState, form: FormData): Promise<SaveState> {
  const id = text(form, 'ruleSetId');
  let document: RuleSetDocument;
  try {
    document = JSON.parse(text(form, 'document')) as RuleSetDocument;
  } catch {
    return { status: 'error', message: 'The rule set could not be read. Reload the page.', fieldErrors: {}, values: {} };
  }
  try {
    const saved = await api<RuleSet>(`/v1/rule-sets/${encodeURIComponent(id)}`, { method: 'PUT', body: { document, effectiveFrom: text(form, 'effectiveFrom') } });
    revalidatePath(`/underwriting/rule-sets/${id}`);
    return {
      status: 'success',
      message: saved.problems.length ? `Saved, with ${saved.problems.length} thing${saved.problems.length === 1 ? '' : 's'} to fix before approval.` : 'Saved. The draft has no problems and can be approved.',
      saved,
    };
  } catch (err) {
    return fromError(err, form);
  }
}

export async function approveRuleSet(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'ruleSetId');
  try {
    await api(`/v1/rule-sets/${encodeURIComponent(id)}/approve`, { method: 'POST', body: { note: text(form, 'note') } });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/underwriting/rule-sets/${id}`);
  redirect(`/underwriting/rule-sets/${id}?done=approved`);
}

export async function publishRuleSet(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'ruleSetId');
  try {
    await api(`/v1/rule-sets/${encodeURIComponent(id)}/publish`, { method: 'POST' });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/underwriting/rule-sets/${id}`);
  redirect(`/underwriting/rule-sets/${id}?done=published`);
}

export async function runRuleTests(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'ruleSetId');
  try {
    const run = await api<{ total: number; passed: number }>(`/v1/rule-sets/${encodeURIComponent(id)}/test-runs`, { method: 'POST' });
    revalidatePath(`/underwriting/rule-sets/${id}`);
    return run.passed === run.total
      ? { status: 'success', message: `All ${run.total} test cases pass.` }
      : { status: 'error', message: `${run.passed} of ${run.total} test cases pass.`, fieldErrors: {}, values: {} };
  } catch (err) {
    return fromError(err, form);
  }
}

export async function loadSanctionsList(_prev: ActionState, form: FormData): Promise<ActionState> {
  const sdn = form.get('sdn');
  const alt = form.get('alt');
  if (!(sdn instanceof File) || sdn.size === 0) {
    return { status: 'error', message: 'Choose SDN.CSV from the OFAC download.', fieldErrors: { sdn: 'Choose a file' }, values: {} };
  }
  try {
    await api('/v1/sanctions-lists', {
      method: 'POST',
      body: {
        source: text(form, 'source'),
        ...(text(form, 'publishedOn') ? { publishedOn: text(form, 'publishedOn') } : {}),
        sdnCsv: await sdn.text(),
        ...(alt instanceof File && alt.size > 0 ? { altCsv: await alt.text() } : {}),
      },
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath('/underwriting/sanctions');
  return { status: 'success', message: 'List loaded as a draft. Someone else approves it before it is used.' };
}

export async function decideSanctionsList(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    await api(`/v1/sanctions-lists/${encodeURIComponent(text(form, 'listId'))}/decision`, {
      method: 'POST',
      body: { decision: text(form, 'decision'), reason: text(form, 'reason') },
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath('/underwriting/sanctions');
  return { status: 'success', message: text(form, 'decision') === 'approve' ? 'Approved. Screening now uses this list.' : 'Rejected.' };
}

export async function decideReferral(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'referralId');
  let r: Referral;
  try {
    r = await api<Referral>(`/v1/referrals/${encodeURIComponent(id)}/decision`, {
      method: 'POST',
      body: { decision: text(form, 'decision'), reason: text(form, 'reason') },
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath('/underwriting/referrals');
  redirect(`/underwriting/referrals/${r.id}?done=${r.status}`);
}
