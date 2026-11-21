import { FeedProcessor } from '@astra/card';
import { LocalFileStore, type Logger, type Pool } from '@astra/platform';
import type { WorkerConfig } from './config';
import { Loop } from './loops';

/**
 * Eligibility feed processing (E21-F02-S01). One feed at a time per worker: a large feed is a heavy,
 * set-based database job, and sequence order means feeds of one programme cannot overlap anyway.
 */
export function cardFeedLoop(pool: Pool, config: WorkerConfig, logger: Logger): Loop {
  const processor = new FeedProcessor(pool, new LocalFileStore(config.FILE_STORE_DIR), logger);
  return new Loop(
    'card-feeds',
    config.WORKER_POLL_MS * 2,
    async () => {
      const feedId = await processor.claimNext();
      if (!feedId) return false;
      try {
        const outcome = await processor.process(feedId);
        logger.info(
          { feedId, status: outcome.status, reason: outcome.reason },
          'Eligibility feed processed',
        );
      } catch (err) {
        // The claim expires and the feed is retried; staging is cleared before it is parsed again.
        logger.error({ err, feedId }, 'Eligibility feed processing failed');
      }
      return true;
    },
    logger,
  );
}
