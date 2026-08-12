import { GrammyError } from 'grammy';
import { env } from '../config/env.ts';
import { logger, type Logger } from '../lib/logger.ts';
import { PermanentError, TransientError, errMessage } from '../lib/errors.ts';
import type { RequestRow } from '../db/types.ts';
import * as usersRepo from '../db/users.repo.ts';
import * as requestsRepo from '../db/requests.repo.ts';
import { downloadVideo, extractAudioSnippet, safeUnlink } from '../services/media.ts';
import { identifySong, type SongInfo } from '../services/audd.ts';
import { sendResult } from '../bot/notify.ts';

/**
 * Bitta jobni to'liq bajaradi:
 *   yuklab olish → audio ajratish → musiqa aniqlash → Telegram'ga yuborish
 *
 * Xatolar yuqoriga uzatiladi; retry qarorini worker loop qabul qiladi.
 */
export async function processRequest(job: RequestRow): Promise<void> {
  const log = logger.child({ requestId: job.id, attempt: job.attempts });

  const user = await usersRepo.findById(job.user_id);
  if (!user) {
    throw new PermanentError(`user_id=${job.user_id} topilmadi`);
  }

  let videoPath: string | null = null;
  let audioPath: string | null = null;

  try {
    // 1) Video (media URL ~7 kun amal qiladi — shu sabab darhol yuklaymiz)
    const downloaded = await downloadVideo(job.media_url, job.id);
    videoPath = downloaded.filePath;

    // 2) Musiqa aniqlash uchun qisqa audio parcha (ffmpeg bo'lsa)
    audioPath = await extractAudioSnippet(videoPath);

    // 3) AudD
    const song = await identifyWithFallback(audioPath ?? videoPath, job, log);

    // 4) Telegram'ga yuborish
    await sendToTelegram(user.telegram_id, videoPath, song);

    // 5) Bazaga yozish
    await requestsRepo.markDone(job.id, {
      video_file_path: videoPath,
      song_title: song?.title ?? null,
      song_artist: song?.artist ?? null,
      song_album: song?.album ?? null,
      song_link: song?.link ?? null,
    });

    log.info({ song: song?.title ?? null }, 'Job muvaffaqiyatli yakunlandi');
  } finally {
    // Vaqtinchalik fayllar har qanday holatda tozalanadi
    await safeUnlink(audioPath);
    await safeUnlink(videoPath);
  }
}

/**
 * Musiqa aniqlanmasa yoki API xato bersa — oxirgi urinishda video baribir
 * yuboriladi (MD talabi: "musiqa aniqlanmadi" deb yoziladi).
 */
async function identifyWithFallback(
  filePath: string,
  job: RequestRow,
  log: Logger,
): Promise<SongInfo | null> {
  try {
    return await identifySong(filePath);
  } catch (e) {
    const isLastAttempt = job.attempts >= env.MAX_ATTEMPTS;
    if (e instanceof TransientError && !isLastAttempt) {
      throw e; // butun job qayta urinadi
    }
    log.warn({ err: errMessage(e) }, 'Musiqa aniqlanmadi — video musiqasiz yuboriladi');
    return null;
  }
}

/** Telegram xatolarini retry-qilinadigan / qilinmaydiganga ajratadi. */
async function sendToTelegram(
  telegramId: number,
  videoPath: string,
  song: SongInfo | null,
): Promise<void> {
  try {
    await sendResult(telegramId, videoPath, song);
  } catch (e) {
    if (e instanceof GrammyError) {
      // 403 — user botni bloklagan yoki chatni o'chirgan: qayta urinish foydasiz
      if (e.error_code === 403) {
        throw new PermanentError(`Telegram 403: ${e.description}`);
      }
      // 413 / "file is too big"
      if (e.error_code === 413 || /too big|too large/i.test(e.description)) {
        throw new PermanentError(
          `Telegram fayl hajmi limiti: ${e.description}`,
          '📦 Video Telegram limitidan (50MB) katta bo\'lgani uchun yuborib bo\'lmadi.',
        );
      }
      // 429 — flood control
      if (e.error_code === 429) {
        const retryAfter = (e.parameters?.retry_after ?? 30) * 1000;
        throw new TransientError(`Telegram 429: ${e.description}`, retryAfter);
      }
      throw new TransientError(`Telegram ${e.error_code}: ${e.description}`);
    }
    throw new TransientError(`Telegram'ga yuborishda xato: ${errMessage(e)}`);
  }
}
