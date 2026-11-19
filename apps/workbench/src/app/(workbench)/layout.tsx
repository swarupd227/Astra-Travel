import { ROLE_LABELS } from '@astra/contracts';
import { getMe, getSession } from '@/lib/api';
import { env } from '@/lib/env';
import { visibleNavigation } from '@/lib/navigation';
import { MobileNav, Sidebar } from '@/components/shell/sidebar';
import { UserMenu } from '@/components/shell/user-menu';
import { Logo } from '@/components/shell/logo';

export const dynamic = 'force-dynamic';

function environmentName(): string {
  const base = env().API_BASE_URL;
  return /localhost|127\.0\.0\.1/.test(base) ? 'Local' : 'Hosted';
}

export default async function WorkbenchLayout({ children }: { children: React.ReactNode }) {
  const [me, session] = await Promise.all([getMe(), getSession()]);

  if (!me) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border border-border bg-surface p-8 text-center shadow-card">
          <h1 className="text-lg font-semibold text-fg">You don’t have access yet</h1>
          <p className="mt-2 text-sm text-muted">
            You signed in as{' '}
            <strong className="text-fg">{session?.name ?? 'an unknown user'}</strong>, but your
            account has no Astra Travel role. Ask a platform administrator to add you to the right
            group.
          </p>
          <form action="/api/auth/logout" method="post" className="mt-6">
            <button type="submit" className="text-sm font-medium text-primary hover:underline">
              Sign out
            </button>
          </form>
        </div>
      </main>
    );
  }

  const sections = visibleNavigation(me.permissions);
  const environment = environmentName();
  const name = me.name ?? session?.name ?? me.subject;

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-primary px-4 py-2 text-primary-contrast focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to main content
      </a>
      <Sidebar sections={sections} environment={environment} />
      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-4 border-b border-border bg-surface/85 px-4 backdrop-blur sm:px-6 lg:px-8">
          <div className="flex items-center gap-2 lg:hidden">
            <MobileNav sections={sections} environment={environment} />
            <span className="rounded-lg bg-sidebar px-2 py-1">
              <Logo />
            </span>
          </div>
          <p className="hidden text-sm text-muted lg:block">
            Assurant Travel · Policy management platform
          </p>
          <UserMenu name={name} email={me.email} roleLabels={me.roles.map((r) => ROLE_LABELS[r])} />
        </header>
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto max-w-7xl px-4 py-8 outline-none sm:px-6 lg:px-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
