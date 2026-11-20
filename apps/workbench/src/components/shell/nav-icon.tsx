import {
  Activity,
  Bot,
  Building2,
  Flag,
  Home,
  Inbox,
  ScrollText,
  Sparkles,
  UserRound,
  Webhook,
} from 'lucide-react';
import type { NavIcon as NavIconName } from '@/lib/navigation';

const ICONS = {
  home: Home,
  building: Building2,
  webhook: Webhook,
  activity: Activity,
  scroll: ScrollText,
  flag: Flag,
  user: UserRound,
  sparkles: Sparkles,
  bot: Bot,
  inbox: Inbox,
} as const;

export function NavIcon({ name, className }: { name: NavIconName; className?: string }) {
  const Icon = ICONS[name];
  return <Icon aria-hidden className={className} />;
}
