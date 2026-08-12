import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { PermanentError, TransientError, backoffMs, errMessage, sleep } from '../lib/errors.ts';
import type { RequestRow } from '../db/types.ts';
import * as requestsRepo from '../db/requests.repo.ts';
import * as usersRepo from '../db/users.repo.ts';
import { trySendText } from '../bot/notify.ts';
import { processRequest } from './processor.ts';

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
      await sleep(env.WORKER_POLL_INTERVAL_MS);
      continue;
    }

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
  const userMessage =
    e instanceof PermanentError && e.userMessage
      ? e.userMessage
      : '❌ Videoni qayta ishlashda xatolik yuz berdi. Iltimos, reels\'ni Instagram\'da qaytadan yuboring.';

  try {
    const user = await usersRepo.findById(job.user_id);
    if (user) await trySendText(user.telegram_id, userMessage);
  } catch (dbErr) {
    logger.warn({ err: errMessage(dbErr) }, 'Xato haqida xabar berib bo\'lmadi');
  }
}
