import {
  Bot,
  Calculator,
  ChartColumn,
  CreditCard,
  FileText,
  Handshake,
  House,
  Inbox,
  Package,
  Settings,
  ShieldCheck,
  Stamp,
} from 'lucide-react';
import type { NavIcon as NavIconName } from '@/lib/navigation';

const ICONS = {
  home: House,
  inbox: Inbox,
  policies: FileText,
  sales: Calculator,
  underwriting: ShieldCheck,
  products: Package,
  partners: Handshake,
  card: CreditCard,
  billing: ChartColumn,
  compliance: Stamp,
  agents: Bot,
  operations: Settings,
} as const;

export function NavIcon({ name, className }: { name: NavIconName; className?: string }) {
  const Icon = ICONS[name];
  return <Icon aria-hidden className={className} />;
}
