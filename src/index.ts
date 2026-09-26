import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { env, isProd } from './config/env.ts';
import { logger } from './lib/logger.ts';
import type { UserFromGetMe } from 'grammy/types';
import { errMessage, sleep } from './lib/errors.ts';
import { assertDbReady } from './db/supabase.ts';
import * as requestsRepo from './db/requests.repo.ts';
import { run, type RunnerHandle } from '@grammyjs/runner';
import { bot, setupBotCommands } from './bot/index.ts';
import { setBotInfo } from './bot/info.ts';
import { instagramWebhookRouter } from './webhook/instagram.ts';
import { devMockRouter } from './webhook/dev-mock.ts';
import { startWorkers, stopWorkers, workerStatus } from './workers/index.ts';
import { cleanupTmpDir, ensureTmpDir, startTmpCleanup, stopTmpCleanup } from './services/media.ts';
import { startRetention, stopRetention } from './db/retention.ts';
import { instagramCookieArgs } from './services/ig-cookies.ts';

/** docs/ — loyiha ildizida; src/index.ts (dev) va dist/index.js (build) dan bir xil masofa. */
const DOCS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');

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

// Meta App'ni Live rejimga o'tkazish uchun Privacy Policy URL talab qilinadi
app.get('/privacy', (_req, res) => {
  res.sendFile(path.join(DOCS_DIR, 'index.html'));
});

// Faqat Instagram mock rejimida — webhook'ni taqlid qiluvchi endpointlar
if (env.MOCK_INSTAGRAM) {
  app.use('/dev/mock', devMockRouter);
}

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

/**
 * Ishga tushishda Telegram bilan aloqani o'rnatadi.
 *
 * Nega qayta urinish kerak: ba'zi tarmoqlarda api.telegram.org ga ulanish
 * beqaror bo'ladi — o'lchangan holat: uchtadan bittasi `UND_ERR_CONNECT_TIMEOUT`
 * bilan uziladi, qolgan ikkitasi 600ms da javob beradi. Bitta shunday uzilish
 * butun jarayonni o'ldirmasligi kerak, aks holda server tasodifiy ravishda
 * ko'tarilmay qoladi.
 */
async function getMeWithRetry(attempts = 5): Promise<UserFromGetMe> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await bot.api.getMe();
    } catch (e) {
      if (attempt >= attempts) throw e;
      const delay = Math.min(2000 * 2 ** (attempt - 1), 15_000);
      logger.warn(
        { attempt, of: attempts, err: errMessage(e), retryInMs: delay },
        'Telegram bilan aloqa o\'rnatilmadi — qayta urinamiz',
      );
      await sleep(delay);
    }
  }
}

/**
 * Telegram polling'ini kuzatib turadi va to'xtasa qayta ishga tushiradi.
 *
 * Runner 409 (boshqa getUpdates so'rovi — masalan deploy paytida eski va
 * yangi nusxa bir lahzaga ustma-ust tushsa) va 401 ni tuzatib bo'lmaydigan
 * xato deb to'xtaydi. Kuzatuvsiz bunda server "tirik" ko'rinardi (HTTP,
 * worker ishlaydi), bot esa jimgina javob bermay qolardi.
 */
function superviseRunner(): { stop: () => Promise<void> } {
  let current: RunnerHandle | null = null;
  let stopping = false;
  let delay = 5_000;

  const start = (): void => {
    current = run(bot);
    logger.info('Telegram long polling boshlandi (parallel)');
    const startedAt = Date.now();
    void current.task()?.then(
      () => undefined,
      (e: unknown) => {
        if (stopping) return;
        // Uzoq ishlagan bo'lsa — kechikishni boshidan boshlaymiz
        if (Date.now() - startedAt > 60_000) delay = 5_000;
        logger.error(
          { err: errMessage(e), retryInMs: delay },
          'Telegram polling to\'xtadi — qayta ishga tushiriladi',
        );
        setTimeout(() => {
          if (!stopping) start();
        }, delay).unref();
        delay = Math.min(delay * 2, 60_000);
      },
    );
  };

  start();
  return {
    stop: async () => {
      stopping = true;
      if (current?.isRunning()) await current.stop();
    },
  };
}

/**
 * Bepul hostingda uxlab qolmaslik: o'z manzilimizga tashqaridan (proksi
 * orqali) har 10 daqiqada murojaat — Render 15 daqiqa jimlikdan keyin uxlatadi.
 */
const KEEPALIVE_INTERVAL_MS = 10 * 60_000;

function startKeepAlive(): void {
  if (!env.KEEPALIVE_URL) return;
  const url = `${env.KEEPALIVE_URL}/health`;
  logger.info({ url }, 'Keep-alive yoqildi');
  setInterval(() => {
    fetch(url, { signal: AbortSignal.timeout(30_000) })
      .then((r) => {
        if (!r.ok) logger.warn({ status: r.status }, 'Keep-alive: /health javob bermadi');
      })
      .catch((e: unknown) => logger.warn({ err: errMessage(e) }, 'Keep-alive so\'rovi yiqildi'));
  }, KEEPALIVE_INTERVAL_MS).unref();
}

/** HTTP serverni ochadi; port band bo'lsa — tushunarli xabar bilan to'xtaydi. */
function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port);
    server.once('listening', () => {
      logger.info({ port, env: env.NODE_ENV }, 'HTTP server tayyor — webhook: /webhook/instagram');
      resolve(server);
    });
    server.once('error', (e: NodeJS.ErrnoException) => {
      reject(
        e.code === 'EADDRINUSE'
          ? new Error(
              `${port}-port band — bot allaqachon boshqa oynada ishlayapti. ` +
                `Avvalgisini to'xtating (Ctrl+C) yoki .env da PORT ni o'zgartiring.`,
            )
          : e,
      );
    });
  });
}

async function main(): Promise<void> {
  logger.info(
    {
      instagram: env.MOCK_INSTAGRAM ? 'MOCK' : 'haqiqiy',
      audd: env.MOCK_AUDD ? 'MOCK' : 'haqiqiy',
      telegram: 'haqiqiy',
      supabase: 'haqiqiy',
    },
    'Servis rejimlari',
  );
  if (env.MOCK_INSTAGRAM) {
    logger.warn(
      '⚠️  Instagram MOCK rejimida — webhook imzosi tekshirilmaydi, DM yuborilmaydi. ' +
        'Sinov: POST /dev/mock/text, POST /dev/mock/reel',
    );
  }

  // Port birinchi band qilinadi: bot allaqachon ishlab turgan bo'lsa, ikkinchi
  // nusxa Telegram'ga tegmasdan (update'larni o'chirmasdan) darhol chiqadi
  const server = await listen(env.PORT);

  await assertDbReady();
  await ensureTmpDir();
  // Jarayon avval job o'rtasida qulagan bo'lsa, tmp'da o'lik fayllar qoladi
  await cleanupTmpDir();
  // ...va uzoq ishlaydigan serverda ular yana to'planmasligi uchun davriy ravishda
  startTmpCleanup();

  const me = await getMeWithRetry();
  setBotInfo({
    username: me.username,
    supportsInline: me.supports_inline_queries,
    readsGroupMessages: me.can_read_all_group_messages,
  });
  if (!me.supports_inline_queries) {
    logger.warn(
      'Inline rejim o\'chiq — "Ulashish" tugmasi videoni emas, bot havolasini ulashadi. ' +
        'Yoqish: @BotFather → /setinline',
    );
  }
  logger.info({ username: me.username }, 'Telegram bot ulandi');
  // Buyruqlar menyusi — bezak: o'rnatilmasa ham bot to'liq ishlaydi,
  // shuning uchun bu yerdagi xato (masalan 429 flood limit) serverni to'xtatmaydi.
  await setupBotCommands().catch((e: unknown) =>
    logger.warn({ err: errMessage(e) }, 'Buyruqlar menyusini yangilab bo\'lmadi — keyingi safar'),
  );

  // Telegram: long polling (webhook URL kerak emas). Agar oldin webhook
  // o'rnatilgan bo'lsa, uni olib tashlaymiz.
  //
  // `bot.start()` update'larni KETMA-KET qayta ishlaydi — har bir havola
  // bazaga bir necha so'rov qiladi, shuning uchun 100 kishi bir vaqtda yozsa,
  // oxirgisi daqiqalab kutardi. Runner esa ularni parallel qayta ishlaydi
  // (bitta chat ichidagi tartib `sequentialize` bilan saqlanadi).
  await bot.api.deleteWebhook({ drop_pending_updates: !isProd });
  await bot.init();
  const polling = superviseRunner();

  startWorkers();
  startRetention();
  startKeepAlive();
  // Instagram cookies holati logda darhol ko'rinsin (bor/yo'q/yaroqsiz)
  void instagramCookieArgs().catch((e: unknown) =>
    logger.warn({ err: errMessage(e) }, 'Instagram cookies faylini tayyorlab bo\'lmadi'),
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'To\'xtatilmoqda...');
    stopWorkers();
    stopTmpCleanup();
    stopRetention();
    try {
      await polling.stop();
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
