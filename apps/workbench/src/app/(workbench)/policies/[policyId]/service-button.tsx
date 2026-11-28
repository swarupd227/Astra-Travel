'use client';

import type { ComponentProps } from 'react';
import { PencilLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { ServicingPanel } from './servicing-panel';

/** Opens the change, cancellation and correction steps over the policy, so the record stays in place. */
export function ServiceButton(props: ComponentProps<typeof ServicingPanel>) {
  return (
    <Dialog
      wide
      title="Service this policy"
      description="Changes are re-rated and re-screened with the versions the policy was bought with. You see the price before you confirm."
      trigger={
        <Button>
          <PencilLine aria-hidden className="size-4" /> Change or cancel
        </Button>
      }
    >
      <ServicingPanel {...props} />
    </Dialog>
  );
}
