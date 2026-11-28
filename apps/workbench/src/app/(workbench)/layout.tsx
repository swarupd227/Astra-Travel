import Link from 'next/link';
import { ROLE_LABELS } from '@astra/contracts';
import { quickActions } from '@/lib/actions-menu';
import { getAgents } from '@/lib/agent-data';
import { copilotSuggestions, copilotUnavailableReason } from '@/lib/agents';
import { getMe, getSession } from '@/lib/api';
import { env } from '@/lib/env';
import { homeGroups, visibleNavigation } from '@/lib/navigation';
import { CopilotButton, CopilotPanel, CopilotShift } from '@/components/copilot/panel';
import { CopilotProvider } from '@/components/copilot/provider';
import { CommandMenu, type CommandEntry } from '@/components/shell/command-menu';
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

  const navigation = visibleNavigation(me.permissions);
  const defaultOpen = homeGroups(me.roles);
  const environment = environmentName();
  const name = me.name ?? session?.name ?? me.subject;

  const commands: CommandEntry[] = [
    ...quickActions(me.permissions).map((a) => ({ ...a, section: 'Action' })),
    ...navigation.primary.map((i) => ({ ...i, section: 'Page' })),
    ...navigation.groups.flatMap((g) => g.items.map((i) => ({ ...i, section: g.label }))),
  ].map(({ href, label, section, description }) => ({ href, label, section, description }));

  const canAsk = me.permissions.includes('agents:use');
  const copilot = {
    allowed: canAsk,
    unavailableReason: canAsk ? copilotUnavailableReason(await getAgents()) : null,
    suggestions: copilotSuggestions(me.permissions),
  };

  return (
    <CopilotProvider availability={copilot}>
      <div className="min-h-dvh">
        <a
          href="#main"
          className="sr-only z-50 rounded-md bg-primary px-4 py-2 text-primary-contrast focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
        >
          Skip to main content
        </a>
        <Sidebar navigation={navigation} defaultOpen={defaultOpen} environment={environment} />
        <CopilotShift>
          <header className="sticky top-0 z-20 flex h-16 items-center gap-2 border-b border-border bg-surface/85 px-3 backdrop-blur sm:gap-4 sm:px-6 lg:px-8">
            <div className="flex items-center gap-1 lg:hidden">
              <MobileNav
                navigation={navigation}
                defaultOpen={defaultOpen}
                environment={environment}
              />
              <Link href="/" aria-label="Astra Travel home" className="rounded-lg md:mr-2">
                <Logo tone="default" wordmarkClassName="max-[419px]:hidden" />
              </Link>
            </div>
            <div className="flex min-w-0 flex-1 justify-end sm:justify-start">
              <CommandMenu
                entries={commands}
                canSearchPolicies={me.permissions.includes('policies:read')}
              />
            </div>
            <CopilotButton />
            <UserMenu
              name={name}
              email={me.email}
              roleLabels={me.roles.map((r) => ROLE_LABELS[r])}
            />
          </header>
          <main
            id="main"
            tabIndex={-1}
            className="mx-auto max-w-7xl px-4 py-6 outline-none sm:px-6 sm:py-8 lg:px-8"
          >
            {children}
          </main>
        </CopilotShift>
        <CopilotPanel />
      </div>
    </CopilotProvider>
  );
}
