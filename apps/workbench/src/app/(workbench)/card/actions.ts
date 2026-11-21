'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type {
  CardProgramme,
  CoverVerification,
  EligibilityAnswer,
  EligibilityFeed,
  MasterPolicy,
} from '@astra/contracts';
import { api, apiUpload } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const states = (value: string) =>
  value
    .toUpperCase()
    .split(/[\s,;]+/)
    .filter(Boolean);

function money(value: string): number | undefined {
  if (value === '') return undefined;
  const n = Number(value.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : Number.NaN;
}

export async function createMasterPolicy(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    await api<MasterPolicy>('/v1/master-policies', {
      method: 'POST',
      idempotencyKey: text(form, 'idempotencyKey'),
      body: {
        accountId: text(form, 'accountId'),
        policyNumber: text(form, 'policyNumber').toUpperCase(),
        underwriter: text(form, 'underwriter'),
        states: states(text(form, 'states')),
        effectiveFrom: text(form, 'effectiveFrom'),
        effectiveTo: text(form, 'effectiveTo') || null,
      },
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath('/card/master-policies');
  return { status: 'success', message: 'Master policy registered.' };
}

export async function createProgramme(_prev: ActionState, form: FormData): Promise<ActionState> {
  let programme: CardProgramme;
  const rule = text(form, 'paymentRule');
  try {
    programme = await api<CardProgramme>('/v1/card-programmes', {
      method: 'POST',
      idempotencyKey: text(form, 'idempotencyKey'),
      body: {
        masterPolicyId: text(form, 'masterPolicyId'),
        code: text(form, 'code').toUpperCase(),
        name: text(form, 'name'),
        cardProduct: text(form, 'cardProduct'),
        states: states(text(form, 'states')),
        effectiveFrom: text(form, 'effectiveFrom'),
        effectiveTo: text(form, 'effectiveTo') || null,
        paymentCondition:
          rule === 'partial'
            ? { rule, minimumPercent: Number(text(form, 'minimumPercent')) }
            : { rule },
        eligibilityRule: text(form, 'eligibilityRule'),
        maxRejectPercent: Number(text(form, 'maxRejectPercent') || '1'),
      },
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath('/card/programmes');
  redirect(`/card/programmes/${programme.id}?created=1`);
}

export async function goLive(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'programmeId');
  try {
    await api<CardProgramme>(`/v1/card-programmes/${encodeURIComponent(id)}/go-live`, {
      method: 'POST',
      body: { reason: text(form, 'reason') },
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/card/programmes/${id}`);
  // The page re-renders without the go-live dialog, so the confirmation lives on the page itself.
  redirect(`/card/programmes/${id}?live=1`);
}

export async function changeProgrammeStatus(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = text(form, 'programmeId');
  try {
    const p = await api<CardProgramme>(`/v1/card-programmes/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      body: { status: text(form, 'status'), reason: text(form, 'reason') },
    });
    revalidatePath(`/card/programmes/${id}`);
    return { status: 'success', message: `The programme is now ${p.status}.` };
  } catch (err) {
    return fromError(err, form);
  }
}

export async function uploadFeed(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'programmeId');
  const mode = text(form, 'mode');
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return {
      status: 'error',
      message: 'Choose a feed file to upload.',
      fieldErrors: { file: 'Choose a file' },
      values: { mode: [mode] },
    };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      status: 'error',
      message: 'Files over 100 MB are sent through the API or SFTP, not the workbench.',
      fieldErrors: { file: 'The file is larger than 100 MB' },
      values: { mode: [mode] },
    };
  }
  const fileName =
    file.name
      .replace(/[^A-Za-z0-9 ._()-]/g, '_')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 200) || 'eligibility-feed.txt';
  try {
    const res = await apiUpload<EligibilityFeed>(
      `/v1/card-programmes/${encodeURIComponent(id)}/feeds`,
      file,
      {
        mode,
        fileName,
      },
    );
    revalidatePath(`/card/programmes/${id}`);
    return {
      status: 'success',
      message:
        res.status === 200
          ? `This file was already received (feed status: ${res.body.status}). Nothing new was queued.`
          : `${mode === 'test' ? 'Test feed' : 'Feed'} received and queued for processing. Its result appears in the list below.`,
    };
  } catch (err) {
    return fromError(err, form);
  }
}

export async function rejectFeed(_prev: ActionState, form: FormData): Promise<ActionState> {
  const programmeId = text(form, 'programmeId');
  const feedId = text(form, 'feedId');
  try {
    await api<EligibilityFeed>(
      `/v1/card-programmes/${encodeURIComponent(programmeId)}/feeds/${encodeURIComponent(feedId)}/reject`,
      { method: 'POST', body: { reason: text(form, 'reason') } },
    );
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/card/programmes/${programmeId}`);
  revalidatePath(`/card/programmes/${programmeId}/feeds/${feedId}`);
  return {
    status: 'success',
    message: 'Feed rejected. The issuer can send a corrected file with the same sequence.',
  };
}

/** What was submitted, so a form keeps its values after an answer (React resets forms after actions). */
function kept(form: FormData): Record<string, string[]> {
  const values: Record<string, string[]> = {};
  for (const [k, v] of form.entries())
    if (typeof v === 'string' && !k.startsWith('$ACTION')) (values[k] ??= []).push(v);
  return values;
}

export type EligibilityState = ActionState & {
  answer?: EligibilityAnswer;
  kept?: Record<string, string[]>;
};

export async function checkEligibility(
  _prev: EligibilityState,
  form: FormData,
): Promise<EligibilityState> {
  const id = text(form, 'programmeId');
  try {
    const answer = await api<EligibilityAnswer>(
      `/v1/card-programmes/${encodeURIComponent(id)}/eligibility-checks`,
      {
        method: 'POST',
        body: { accountRef: text(form, 'accountRef'), date: text(form, 'date') },
      },
    );
    return {
      status: 'success',
      message: answer.eligible ? 'Eligible' : 'Not eligible',
      answer,
      kept: kept(form),
    };
  } catch (err) {
    return fromError(err, form);
  }
}

export type CoverState = ActionState & {
  result?: CoverVerification;
  kept?: Record<string, string[]>;
};

export async function verifyCover(_prev: CoverState, form: FormData): Promise<CoverState> {
  const tripCost = money(text(form, 'tripCost'));
  const paid = money(text(form, 'amountPaidWithAccount'));
  if (
    Number.isNaN(tripCost) ||
    Number.isNaN(paid) ||
    (tripCost === undefined) !== (paid === undefined)
  ) {
    const state = fromError(null, form);
    return {
      ...state,
      message:
        'Enter both the trip cost and the amount paid with the card in dollars, or leave both empty.',
      fieldErrors: { 'payment.tripCost': 'Enter both amounts or neither' },
    } as CoverState;
  }
  try {
    const result = await api<CoverVerification>('/v1/cover-verifications', {
      method: 'POST',
      body: {
        type: 'certificate',
        programmeCode: text(form, 'programmeCode'),
        accountRef: text(form, 'accountRef'),
        purchaseDate: text(form, 'purchaseDate'),
        lossDate: text(form, 'lossDate'),
        ...(tripCost !== undefined && paid !== undefined
          ? { payment: { tripCost, amountPaidWithAccount: paid } }
          : {}),
      },
    });
    return {
      status: 'success',
      message: result.covered ? 'Covered' : 'Not covered',
      result,
      kept: kept(form),
    };
  } catch (err) {
    return fromError(err, form);
  }
}
