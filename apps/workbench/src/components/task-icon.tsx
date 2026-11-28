import { MailWarning, ShieldAlert, Unplug, UserRoundSearch } from 'lucide-react';
import type { TaskSource } from '@astra/contracts';
import { AgentMark } from '@/components/copilot/agent-mark';

const ICONS = {
  referral: UserRoundSearch,
  sanctions_hold: ShieldAlert,
  delivery_failure: MailWarning,
  event_delivery: Unplug,
} as const;

/** What kind of work this is, at a glance. Work from an agent carries the agent mark. */
export function TaskIcon({ source }: { source: TaskSource }) {
  if (source === 'agent_proposal' || source === 'agent_review') return <AgentMark />;
  const Icon = ICONS[source];
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-muted"
    >
      <Icon className="size-4" />
    </span>
  );
}
