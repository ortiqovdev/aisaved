/**
 * Faqat worker jarayoni (HTTP server va Telegram polling'siz).
 *
 * Yuk oshganda workerni alohida konteynerda ko'paytirish uchun:
 *   npm run worker
 *
 * Bir nechta nusxa parallel ishlashi xavfsiz — joblar Postgres darajasida
 * FOR UPDATE SKIP LOCKED bilan band qilinadi.
 */
import { logger } from './lib/logger.ts';
import { errMessage } from './lib/errors.ts';
import { assertDbReady } from './db/supabase.ts';
import { ensureTmpDir } from './services/media.ts';
import { startWorkers, stopWorkers } from './workers/index.ts';

async function main(): Promise<void> {
  await assertDbReady();
  await ensureTmpDir();
  startWorkers();

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'Worker to\'xtatilmoqda...');
    stopWorkers();
    setTimeout(() => process.exit(0), 5_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  logger.fatal({ err: errMessage(e) }, 'Worker ishga tushmadi');
  process.exit(1);
});
