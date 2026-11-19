import { ShieldAlert } from 'lucide-react';
import { PERMISSIONS, type Permission } from '@astra/contracts';
import { Card, EmptyState } from './ui/primitives';

export function AccessDenied({ permission }: { permission: Permission }) {
  return (
    <Card>
      <EmptyState
        icon={<ShieldAlert className="size-5" />}
        title="You don’t have access to this page"
        description={
          <>
            It needs the permission “{PERMISSIONS[permission]}”. If you need it for your work, ask a
            platform administrator to review your role.
          </>
        }
      />
    </Card>
  );
}
