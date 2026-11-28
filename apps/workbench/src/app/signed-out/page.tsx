import Link from 'next/link';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { Logo } from '@/components/shell/logo';
import { buttonClass } from '@/components/ui/button';

export const metadata = { title: 'Signed out' };

const MESSAGES: Record<string, { title: string; body: string }> = {
  expired: {
    title: 'Your sign-in took too long',
    body: 'For your security the sign-in request expired. Please try again.',
  },
  failed: {
    title: 'We couldn’t sign you in',
    body: 'Your sign-in was not confirmed. Please try again, or contact support if it keeps happening.',
  },
};

export default async function SignedOutPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const problem = reason ? MESSAGES[reason] : undefined;
  const message = problem ?? {
    title: 'You have signed out',
    body: 'Your session has ended. You can close this window or sign in again.',
  };
  const Icon = problem ? CircleAlert : CircleCheck;
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-sidebar p-6">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-32 size-[28rem] rounded-full bg-[#4f6ef7]/25 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-40 -left-24 size-[28rem] rounded-full bg-[#0d9488]/25 blur-3xl"
      />
      <div className="relative mb-8">
        <Logo endorsement />
      </div>
      <div className="relative w-full max-w-sm rounded-2xl bg-surface p-8 text-center shadow-overlay">
        <Icon
          aria-hidden
          className={
            problem ? 'mx-auto mb-4 size-10 text-warning' : 'mx-auto mb-4 size-10 text-success'
          }
        />
        <h1 className="text-lg font-semibold text-fg">{message.title}</h1>
        <p className="mt-2 text-sm text-muted">{message.body}</p>
        <Link
          href="/api/auth/login"
          prefetch={false}
          className={buttonClass('primary', 'md', 'mt-6 w-full')}
        >
          Sign in
        </Link>
      </div>
      <p className="relative mt-6 text-xs text-[#c3cee2]">For authorised Assurant users only</p>
    </main>
  );
}
