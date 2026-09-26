import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { PermanentError, TransientError, backoffMs, errMessage, sleep } from '../lib/errors.ts';
import type { RequestRow } from '../db/types.ts';
import * as requestsRepo from '../db/requests.repo.ts';
import * as usersRepo from '../db/users.repo.ts';
import { TELEGRAM_SOURCE } from '../lib/constants.ts';
import { showFailure } from '../bot/notify.ts';
import { forgetStatusCard, statusCardOf } from '../bot/status-card.ts';
import {
  IG_REACTION,
  instagramMessageIdOf,
  toPlainText,
  trySendInstagramText,
} from '../services/instagram.ts';
import { msg, t } from '../i18n/index.ts';
import { langOfUser } from '../i18n/user-lang.ts';
import { processRequest, reactOnInstagram, targetChatOf } from './processor.ts';
import { idle, wakeWorkers } from './wake.ts';

/**
 * Bo'sh navbatni faqat 0-slot tez-tez (WORKER_POLL_INTERVAL_MS) tekshiradi,
 * qolganlari — shu oraliqda (zaxira: uyg'otish yetib kelmagan holatlar uchun).
 *
 * Ilgari 8 ta slotning har biri 3 s da bir marta so'rardi: foydalanuvchi
 * bo'lmasa ham sutkasiga ~230 000 ta Supabase so'rovi (bepul tarifdagi 5 GB
 * trafikni yeydi). Endi ~40 000. Yangi job kutmaydi: bot/webhook worker'ni
 * `wakeWorkers()` bilan darhol uyg'otadi, job olgan slot esa keyingisini.
 */
const IDLE_POLL_MS = 60_000;

const WORKER_ID = `${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;

let running = false;
let activeJobs = 0;

/**
 * Supabase jadvali asosidagi navbat.
 *
 * Redis yo'q — `claim_next_request` SQL funksiyasi FOR UPDATE SKIP LOCKED
 * bilan jobni atomik band qiladi, shuning uchun bir nechta worker (yoki
 * bir nechta instans) parallel ishlasa ham bitta job ikki marta bajarilmaydi.
 */
export function startWorkers(): void {
  if (!env.WORKER_ENABLED) {
    logger.warn('WORKER_ENABLED=false — worker ishga tushirilmadi');
    return;
  }
  if (running) return;

  running = true;
  logger.info(
    { workerId: WORKER_ID, concurrency: env.WORKER_CONCURRENCY },
    'Worker ishga tushdi',
  );

  for (let i = 0; i < env.WORKER_CONCURRENCY; i += 1) {
    void loop(i);
  }
}

export function stopWorkers(): void {
  running = false;
}

export function workerStatus(): { running: boolean; activeJobs: number; workerId: string } {
  return { running, activeJobs, workerId: WORKER_ID };
}

async function loop(slot: number): Promise<void> {
  const log = logger.child({ slot });

  while (running) {
    let job: RequestRow | null = null;
    try {
      job = await requestsRepo.claimNext(`${WORKER_ID}#${slot}`);
    } catch (e) {
      log.error({ err: errMessage(e) }, 'Navbatdan job olishda xato');
      await sleep(Math.max(env.WORKER_POLL_INTERVAL_MS, 5000));
      continue;
    }

    if (!job) {
      // Yangi job qo'shilsa bot `wakeWorkers()` bilan darhol uyg'otadi
      await idle(slot === 0 ? env.WORKER_POLL_INTERVAL_MS : Math.max(IDLE_POLL_MS, env.WORKER_POLL_INTERVAL_MS));
      continue;
    }

    // Navbatda yana job bo'lishi mumkin — uxlab yotgan keyingi slot tekshirsin
    wakeWorkers();
    activeJobs += 1;
    try {
      await processRequest(job);
    } catch (e) {
      await handleJobFailure(job, e);
    } finally {
      activeJobs -= 1;
    }
  }

  log.info('Worker loop to\'xtadi');
}

/** Retry qilinsinmi yoki failed bo'lsinmi — shu yerda hal qilinadi. */
async function handleJobFailure(job: RequestRow, e: unknown): Promise<void> {
  const log = logger.child({ requestId: job.id, attempt: job.attempts });
  const message = errMessage(e);
  const permanent = e instanceof PermanentError;
  const canRetry = !permanent && job.attempts < env.MAX_ATTEMPTS;

  if (canRetry) {
    const delay =
      e instanceof TransientError && e.retryAfterMs
        ? e.retryAfterMs
        : backoffMs(job.attempts);
    log.warn({ err: message, retryInMs: delay }, 'Job xato berdi — qayta urinamiz');
    try {
      await requestsRepo.requeue(job.id, delay, message);
    } catch (dbErr) {
      log.error({ err: errMessage(dbErr) }, 'Jobni navbatga qaytarib bo\'lmadi');
    }
    return;
  }

  log.error({ err: message, permanent }, 'Job yakuniy muvaffaqiyatsiz');
  try {
    await requestsRepo.markFailed(job.id, message);
  } catch (dbErr) {
    log.error({ err: errMessage(dbErr) }, 'Jobni failed qilib bo\'lmadi');
  }

  await notifyUserOfFailure(job, e);
}

async function notifyUserOfFailure(job: RequestRow, e: unknown): Promise<void> {
  // Umumiy xabar manbaga qarab farq qiladi: foydalanuvchi videoni botga
  // o'zi tashlagan bo'lsa, "Instagram'da qaytadan yuboring" deyish chalkash.
  const fallback =
    job.media_type === TELEGRAM_SOURCE ? msg('failTelegramSource') : msg('failInstagramSource');

  const userMessage =
    e instanceof PermanentError && e.userMessage ? e.userMessage : fallback;

  try {
    const user = await usersRepo.findByIdCached(job.user_id);
    if (user) {
      const text = t(langOfUser(user), userMessage.key, userMessage.vars);
      // "Qabul qilindi" kartasi bo'lsa — yangi xabar emas, kartaning matni xatoga almashadi
      await showFailure(targetChatOf(job, user.telegram_id), text, await statusCardOf(job.id));
      forgetStatusCard(job.id);
      // Instagram'dan kelgan bo'lsa — reelsga ❌. Sababi yuqorida Telegram'ga
      // ketdi; Instagram chati matn bilan to'lmasin — matn faqat ❌ qo'yib
      // bo'lmasa (aks holda foydalanuvchi Instagram'da hech narsa ko'rmasdi)
      // Fonda: qayta urinishlar ~1 daqiqa worker slotini ushlab turmasin
      const igsid = user.ig_scoped_id;
      void reactOnInstagram(job, igsid, IG_REACTION.fail).then(async (reacted) => {
        if (!reacted && instagramMessageIdOf(job.ig_message_id) && igsid) {
          await trySendInstagramText(igsid, toPlainText(text));
        }
      });
    }
  } catch (dbErr) {
    logger.warn({ err: errMessage(dbErr) }, 'Xato haqida xabar berib bo\'lmadi');
  }
}
