import clsx from 'clsx';
import { Sparkles } from 'lucide-react';

/** The mark that says "an AI agent did, or will do, this". Used nowhere else. */
export function AgentMark({
  size = 'md',
  className,
}: {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={clsx(
        'ai-fill flex shrink-0 items-center justify-center text-white',
        size === 'sm' && 'size-6 rounded-md',
        size === 'md' && 'size-8 rounded-lg',
        size === 'lg' && 'size-12 rounded-2xl',
        className,
      )}
    >
      <Sparkles
        className={clsx(size === 'sm' ? 'size-3.5' : size === 'lg' ? 'size-6' : 'size-4')}
      />
    </span>
  );
}
