'use client';

import type { ComponentProps } from 'react';
import { FileCheck2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { IssueForm } from '../quote-forms';

/** Buying on the traveller's behalf, opened only when someone means to do it. */
export function IssueButton(props: ComponentProps<typeof IssueForm>) {
  return (
    <Dialog
      wide
      title="Issue the policy"
      description="For a traveller who cannot buy it themselves, such as by phone. The same checks and price apply."
      trigger={
        <Button>
          <FileCheck2 aria-hidden className="size-4" /> Issue policy
        </Button>
      }
    >
      <IssueForm {...props} />
    </Dialog>
  );
}
