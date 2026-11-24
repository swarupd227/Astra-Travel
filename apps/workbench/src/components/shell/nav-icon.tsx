import {
  Activity,
  BadgeCheck,
  Calculator,
  Bot,
  Building2,
  CreditCard,
  Database,
  FileText,
  Flag,
  Home,
  Inbox,
  Layers,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Stamp,
  Table2,
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
  card: CreditCard,
  shield: ShieldCheck,
  check: BadgeCheck,
  file: FileText,
  stamp: Stamp,
  database: Database,
  table: Table2,
  calculator: Calculator,
  layers: Layers,
} as const;

export function NavIcon({ name, className }: { name: NavIconName; className?: string }) {
  const Icon = ICONS[name];
  return <Icon aria-hidden className={className} />;
}
