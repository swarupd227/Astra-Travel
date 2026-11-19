import type { Logger } from '@astra/platform';

/**
 * A background loop that runs `tick` on an interval or when woken (for example by LISTEN/NOTIFY).
 * A tick that reports more work runs again immediately. Ticks never overlap, and `stop` waits for the
 * running tick to finish so shutdown never abandons work half-way.
 */
export class Loop {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  private pendingWake = false;

  constructor(
    readonly name: string,
    private readonly intervalMs: number,
    /** Returns true if there may be more work right away. */
    private readonly tick: () => Promise<boolean>,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.schedule(0);
  }

  wake(): void {
    if (this.stopped) return;
    if (this.running) {
      this.pendingWake = true;
      return;
    }
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), delay);
  }

  private async run(): Promise<void> {
    if (this.running || this.stopped) return;
    let more = false;
    this.running = (async () => {
      try {
        more = await this.tick();
      } catch (err) {
        this.logger.error({ err, loop: this.name }, 'Background loop iteration failed');
      }
    })();
    await this.running;
    this.running = undefined;
    const again = more || this.pendingWake;
    this.pendingWake = false;
    this.schedule(again ? 0 : this.intervalMs);
  }
}
