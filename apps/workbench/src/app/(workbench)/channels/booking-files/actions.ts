'use server';

import { revalidatePath } from 'next/cache';
import type { BookingFile } from '@astra/contracts';
import { apiUpload } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

export async function sendBookingFile(_prev: ActionState, form: FormData): Promise<ActionState> {
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return { status: 'error', message: 'Choose a CSV file.', fieldErrors: {}, values: {} };
  const accountId = text(form, 'accountId');
  try {
    const { body } = await apiUpload<BookingFile>('/v1/booking-files', file, { fileName: file.name, ...(accountId ? { accountId } : {}) }, 'text/csv');
    revalidatePath('/channels/booking-files');
    return body.status === 'rejected'
      ? { status: 'error', message: `The file was refused as a whole: ${body.reason}`, fieldErrors: {}, values: {} }
      : { status: 'success', message: `${body.accepted} of ${body.bookings} bookings accepted, ${body.rejected} rejected. The result file lists each with its reasons.` };
  } catch (err) {
    return fromError(err, form);
  }
}
