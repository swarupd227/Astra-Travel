'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { ParityRun, RateManual, RatingResult } from '@astra/contracts';
import { api, apiUpload } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

export async function loadManual(_prev: ActionState, form: FormData): Promise<ActionState> {
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return {
      status: 'error',
      message: 'Choose the manual file (JSON).',
      fieldErrors: { file: 'Choose a file' },
      values: {},
    };
  }
  let document: unknown;
  try {
    document = JSON.parse(await file.text());
  } catch {
    return {
      status: 'error',
      message: 'The file is not valid JSON.',
      fieldErrors: { file: 'Not JSON' },
      values: {},
    };
  }
  let manual: RateManual;
  try {
    manual = await api<RateManual>('/v1/rate-manuals', {
      method: 'POST',
      body: {
        code: text(form, 'code').toUpperCase(),
        state: text(form, 'state').toUpperCase(),
        benefit: text(form, 'benefit').toUpperCase(),
        effectiveFrom: text(form, 'effectiveFrom'),
        source: text(form, 'source'),
        illustrative: form.get('illustrative') === 'on',
        document,
      },
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath('/rating/manuals');
  redirect(`/rating/manuals/${manual.id}?loaded=1`);
}

export async function approveManual(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'manualId');
  try {
    await api<RateManual>(`/v1/rate-manuals/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      body: { note: text(form, 'note') },
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/rating/manuals/${id}`);
  redirect(`/rating/manuals/${id}?done=approved`);
}

export async function publishManual(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'manualId');
  try {
    await api<RateManual>(`/v1/rate-manuals/${encodeURIComponent(id)}/publish`, { method: 'POST' });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/rating/manuals/${id}`);
  redirect(`/rating/manuals/${id}?done=published`);
}

export async function importParity(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'manualId');
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return {
      status: 'error',
      message: 'Choose the CSV file of cases.',
      fieldErrors: { file: 'Choose a file' },
      values: {},
    };
  }
  try {
    const res = await apiUpload<{ imported: number }>(
      `/v1/rate-manuals/${encodeURIComponent(id)}/parity-cases`,
      file,
      { source: text(form, 'source'), rateDate: text(form, 'rateDate') },
      'text/csv',
    );
    revalidatePath(`/rating/manuals/${id}`);
    return {
      status: 'success',
      message: `${res.body.imported} cases imported. Run them to check parity.`,
    };
  } catch (err) {
    return fromError(err, form);
  }
}

export async function runParity(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'manualId');
  try {
    const run = await api<ParityRun>(`/v1/rate-manuals/${encodeURIComponent(id)}/parity-runs`, {
      method: 'POST',
    });
    revalidatePath(`/rating/manuals/${id}`);
    return {
      status: run.passed === run.total ? 'success' : 'error',
      message: `${run.passed} of ${run.total} cases match to the cent.`,
      fieldErrors: {},
      values: {},
    } as ActionState;
  } catch (err) {
    return fromError(err, form);
  }
}

export type RateState = ActionState & {
  result?: RatingResult & { preview: boolean };
  kept?: Record<string, string>;
};

const optionalNumber = (v: string) => (v === '' ? null : Number(v));
const list = (v: string) =>
  v
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Builds a rating request from the calculator form and rates it. */
export async function rateTrip(_prev: RateState, form: FormData): Promise<RateState> {
  const kept = Object.fromEntries(
    [...form.entries()]
      .filter(([k, v]) => typeof v === 'string' && !k.startsWith('$'))
      .map(([k, v]) => [k, v as string]),
  );
  const perils = list(text(form, 'perils')).map((p) => {
    const [peril, levels = 'self'] = p.split(':');
    return {
      peril: peril!.trim(),
      levels: levels
        .split('|')
        .map((l) => l.trim())
        .filter(Boolean),
    };
  });
  const supplemental = list(text(form, 'supplemental')).map((s) => {
    const [code, amount] = s.split(':');
    return { code: code!.trim(), amount: (amount ?? '').trim() };
  });
  const region = text(form, 'destinationRegion');
  const scope = text(form, 'destinationScope');
  try {
    const result = await api<RatingResult & { preview: boolean }>('/v1/rating/rate', {
      method: 'POST',
      body: {
        ...(text(form, 'manualId') ? { manualId: text(form, 'manualId') } : {}),
        request: {
          state: text(form, 'state').toUpperCase(),
          benefit: text(form, 'benefit').toUpperCase(),
          rateDate: text(form, 'rateDate'),
          traveller: {
            age: optionalNumber(text(form, 'age')),
            preExistingWaived: text(form, 'waived') === '' ? null : text(form, 'waived') === 'yes',
          },
          trip: {
            costPerTraveller: text(form, 'tripCost'),
            purchaseDate: text(form, 'purchaseDate'),
            departureDate: text(form, 'departureDate'),
            returnDate: text(form, 'returnDate'),
            initialDepositDate: text(form, 'initialDepositDate') || null,
            destinations:
              region || scope
                ? [{ region: region || null, scope: (scope || null) as 'domestic' | null, days: 1 }]
                : [],
            penaltyDays: optionalNumber(text(form, 'penaltyDays')),
          },
          account: {
            businessSegment: text(form, 'businessSegment') || null,
            notCollected: list(text(form, 'notCollected')),
          },
          plan: {
            packageType: text(form, 'packageType'),
            lookbackDays: optionalNumber(text(form, 'lookbackDays')),
            productType: text(form, 'productType') || null,
            perils,
            waivedExclusions: list(text(form, 'waivedExclusions')),
            supplemental,
          },
        },
      },
    });
    return { status: 'success', message: 'Rated.', result, kept };
  } catch (err) {
    return { ...fromError(err, form), kept } as RateState;
  }
}
