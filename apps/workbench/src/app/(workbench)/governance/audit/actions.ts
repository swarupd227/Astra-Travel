'use server';

import type { AuditVerification } from '@astra/contracts';
import { api, ApiProblem } from '@/lib/api';

export type VerifyState =
  | { status: 'idle' }
  | { status: 'done'; ok: boolean; message: string }
  | { status: 'error'; message: string };

const plural = (n: number, noun: string) =>
  `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`;

export async function verifyAuditTrail(): Promise<VerifyState> {
  try {
    const r = await api<AuditVerification>('/v1/audit/verify', { method: 'POST' });
    if (r.ok) {
      return {
        status: 'done',
        ok: true,
        message: `Intact: ${plural(r.rowsChecked, 'record')} and ${plural(r.sealsChecked, 'seal')} checked.`,
      };
    }
    return {
      status: 'done',
      ok: false,
      message: `Integrity check failed at ${r.firstMismatch?.kind} ${r.firstMismatch?.ref}. Escalate to security.`,
    };
  } catch (err) {
    if (err && typeof err === 'object' && 'digest' in err) throw err;
    return {
      status: 'error',
      message: err instanceof ApiProblem ? err.message : 'Verification could not run.',
    };
  }
}
