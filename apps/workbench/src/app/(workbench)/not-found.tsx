import { SearchX } from 'lucide-react';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/primitives';

export default function NotFound() {
  return (
    <Card className="mx-auto max-w-lg p-8 text-center">
      <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-full bg-surface-muted text-muted">
        <SearchX aria-hidden className="size-5" />
      </div>
      <h1 className="text-lg font-semibold text-fg">We couldn’t find that</h1>
      <p className="mt-2 text-sm text-muted">
        The record may not exist, or you may not have access to it. Search for it, or start from
        Home.
      </p>
      <div className="mt-6 flex justify-center gap-2">
        <ButtonLink href="/" variant="primary">
          Go to Home
        </ButtonLink>
        <ButtonLink href="/policies">Find a policy</ButtonLink>
      </div>
    </Card>
  );
}
