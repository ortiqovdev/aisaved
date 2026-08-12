import express, { type NextFunction, type Request, type Response } from 'express';
import { env, isProd } from './config/env.ts';
import { logger } from './lib/logger.ts';
import { errMessage } from './lib/errors.ts';
import { assertDbReady } from './db/supabase.ts';
import * as requestsRepo from './db/requests.repo.ts';
import { bot, setupBotCommands } from './bot/index.ts';
import { instagramWebhookRouter } from './webhook/instagram.ts';
import { startWorkers, stopWorkers, workerStatus } from './workers/index.ts';
import { ensureTmpDir } from './services/media.ts';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);

/**
 * JSON parser. `verify` orqali XOM body saqlanadi — Meta webhook imzosi
 * (X-Hub-Signature-256) aynan xom baytlar ustidan hisoblanadi.
 */
app.use(
  express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }),
);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', async (_req, res) => {
  try {
    const queue = await requestsRepo.queueStats();
    res.json({ ok: true, uptime: process.uptime(), worker: workerStatus(), queue });
  } catch (e) {
    res.status(503).json({ ok: false, error: errMessage(e) });
  }
});

app.use('/webhook/instagram', instagramWebhookRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Express xato middleware'i AYNAN 4 ta parametrli bo'lishi shart
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err: err.message, stack: err.stack }, 'Express xatosi');
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await assertDbReady();
  await ensureTmpDir();

  const me = await bot.api.getMe();
  logger.info({ username: me.username }, 'Telegram bot ulandi');
  await setupBotCommands();

  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV },
      `HTTP server tayyor — webhook: /webhook/instagram`,
    );
  });

  // Telegram: long polling (webhook URL kerak emas).
  // Agar oldin webhook o'rnatilgan bo'lsa, uni olib tashlaymiz.
  void bot.start({
    drop_pending_updates: !isProd,
    onStart: () => logger.info('Telegram long polling boshlandi'),
  });

  startWorkers();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'To\'xtatilmoqda...');
    stopWorkers();
    try {
      await bot.stop();
    } catch (e) {
      logger.warn({ err: errMessage(e) }, 'Botni to\'xtatishda xato');
    }
    server.close(() => {
      logger.info('Xayr 👋');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => {
  logger.error({ err: errMessage(reason) }, 'Ushlanmagan promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'Ushlanmagan exception');
  process.exit(1);
});

main().catch((e) => {
  logger.fatal({ err: errMessage(e) }, 'Ishga tushirib bo\'lmadi');
  process.exit(1);
});
