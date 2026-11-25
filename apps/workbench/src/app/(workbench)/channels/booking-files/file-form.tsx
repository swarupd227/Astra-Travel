'use client';

import { useActionState } from 'react';
import { Upload } from 'lucide-react';
import { Field, FormMessage, Input, Select, SubmitButton } from '@/components/ui/form';
import { idle } from '@/lib/actions';
import { sendBookingFile } from './actions';

export function BookingFileForm({ accounts, fixedAccountId }: { accounts: { id: string; name: string }[]; fixedAccountId: string | null }) {
  const [state, action] = useActionState(sendBookingFile, idle);
  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {fixedAccountId ? (
          <input type="hidden" name="accountId" value={fixedAccountId} />
        ) : (
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
        )}
        <Field label="Bookings file" hint="CSV, one row per traveller; rows with the same booking_ref are one booking.">{(f) => <Input id={f.id} name="file" type="file" accept=".csv,text/csv,text/plain" required aria-describedby={f.describedBy} />}</Field>
      </div>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Processing the bookings…">
        <Upload aria-hidden className="size-4" /> Send the file
      </SubmitButton>
    </form>
  );
}
