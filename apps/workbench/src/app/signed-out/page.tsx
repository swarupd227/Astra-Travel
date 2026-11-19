import Link from 'next/link';
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
    body: 'The identity provider did not confirm your sign-in. Please try again, or contact support if it keeps happening.',
  },
};

export default async function SignedOutPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const message = (reason && MESSAGES[reason]) || {
    title: 'You have signed out',
    body: 'Your workbench session has ended. Close this window or sign in again to continue.',
  };
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-sidebar p-6">
      <div className="mb-8">
        <Logo />
      </div>
      <div className="w-full max-w-sm rounded-2xl bg-surface p-8 text-center shadow-overlay">
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
      <p className="mt-6 text-xs text-[#c3cee2]/70">
        Astra Travel · for authorised Assurant users only
      </p>
    </main>
  );
}
