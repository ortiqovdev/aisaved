import { GrammyError } from 'grammy';
import { env } from '../config/env.ts';
import { logger, type Logger } from '../lib/logger.ts';
import { PermanentError, TransientError, errMessage } from '../lib/errors.ts';
import type { RequestRow } from '../db/types.ts';
import * as usersRepo from '../db/users.repo.ts';
import * as requestsRepo from '../db/requests.repo.ts';
import {
  SILENCE_THRESHOLD_DB,
  downloadMedia,
  extractAudioSnippet,
  measureLoudnessDb,
  probeDurationSeconds,
  safeUnlink,
  snippetOffsets,
} from '../services/media.ts';
import { identifySong, type SongInfo } from '../services/audd.ts';
import { resolveTelegramFileUrl } from '../services/telegram-files.ts';
import { TELEGRAM_SOURCE } from '../lib/constants.ts';
import { sendResult, sendSongOnly } from '../bot/notify.ts';

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

  // Media ikki manbadan kelishi mumkin: Instagram DM yoki to'g'ridan-to'g'ri Telegram
  const fromTelegram = job.media_type === TELEGRAM_SOURCE;

  /**
   * Natija allaqachon yuborilgan bo'lsa — ikkinchi marta yubormaymiz.
   *
   * Bunday holat yuborish muvaffaqiyatli o'tib, `markDone` bazaga yozilmay
   * qolganda yuzaga keladi: job 'processing' da qoladi va stale-lock
   * muddatidan keyin qayta olinadi. `sent_at` bo'lmasa foydalanuvchi ayni
   * natijani ikki marta olardi.
   */
  if (job.sent_at) {
    log.warn({ sentAt: job.sent_at }, 'Natija avval yuborilgan — faqat baza yangilanadi');
    await requestsRepo.markDone(job.id, {
      video_file_path: null,
      song_title: job.song_title,
      song_artist: job.song_artist,
      song_album: job.song_album,
      song_link: job.song_link,
    });
    return;
  }

  let videoPath: string | null = null;
  const tempFiles: string[] = [];

  try {
    // 0) Kesh: ayni fayl avval aniqlangan bo'lsa AudD'ni bezovta qilmaymiz.
    //    Instagram'da CDN URL har safar boshqacha bo'ladi, shuning uchun
    //    kesh faqat Telegram fayllari uchun ishlaydi (file_unique_id doimiy).
    const cached = await lookupCache(job, log);
    if (cached) {
      await withTelegramErrors(() => sendSongOnly(user.telegram_id, cached));
      await requestsRepo.markSent(job.id);
      await requestsRepo.markDone(job.id, {
        video_file_path: null,
        song_title: cached.title,
        song_artist: cached.artist,
        song_album: cached.album,
        song_link: cached.link,
      });
      log.info({ song: cached.title }, 'Job keshdan yakunlandi (AudD chaqirilmadi)');
      return;
    }

    // 1) Manba havolasi.
    //    Instagram: webhookdagi CDN URL (~7 kun amal qiladi — darhol yuklaymiz)
    //    Telegram:  file_id -> vaqtinchalik URL (~1 soat)
    const sourceUrl = fromTelegram
      ? await resolveTelegramFileUrl(job.media_url)
      : job.media_url;

    const downloaded = await downloadMedia(sourceUrl, job.id, { allowAudio: fromTelegram });
    videoPath = downloaded.filePath;

    // 2-3) Musiqa aniqlash. Bir necha parcha o'rnini sinab ko'radi —
    //      reels boshida ko'pincha gap yoki sukunat bo'ladi.
    const song = await identifyWithFallback(videoPath, job, log, tempFiles);

    // 4) Javob.
    //    Telegram'dan kelgan bo'lsa videoni qaytarib yubormaymiz — u foydalanuvchida
    //    allaqachon bor. Instagram'dan kelganda esa video + caption yuboriladi.
    if (fromTelegram) {
      await withTelegramErrors(() => sendSongOnly(user.telegram_id, song));
    } else {
      await withTelegramErrors(() => sendResult(user.telegram_id, videoPath!, song));
    }

    // 5) Yuborilgani belgilanadi — keyingi qadam yiqilsa ham takror yuborilmaydi
    await requestsRepo.markSent(job.id);

    // 6) Bazaga yozish
    await requestsRepo.markDone(job.id, {
      // Fayl vaqtinchalik — yuborilgach o'chiriladi, shuning uchun bazada
      // o'lik yo'lni saqlamaymiz.
      video_file_path: null,
      song_title: song?.title ?? null,
      song_artist: song?.artist ?? null,
      song_album: song?.album ?? null,
      song_link: song?.link ?? null,
    });

    log.info({ song: song?.title ?? null }, 'Job muvaffaqiyatli yakunlandi');
  } finally {
    // Vaqtinchalik fayllar har qanday holatda tozalanadi
    for (const f of tempFiles) await safeUnlink(f);
    await safeUnlink(videoPath);
  }
}

/**
 * Avval aniqlangan ayni faylning natijasi (agar bo'lsa).
 * Kesh xatosi asosiy oqimni to'xtatmaydi — shunchaki keshsiz davom etadi.
 */
async function lookupCache(job: RequestRow, log: Logger): Promise<SongInfo | null> {
  if (!env.RESULT_CACHE_ENABLED || !job.file_unique_id) return null;

  let row: RequestRow | null = null;
  try {
    row = await requestsRepo.findCachedResult(job.file_unique_id, job.id);
  } catch (e) {
    log.debug({ err: errMessage(e) }, 'Keshni o\'qib bo\'lmadi');
    return null;
  }
  if (!row?.song_title || !row.song_artist) return null;

  log.info({ cachedFrom: row.id, song: row.song_title }, 'Natija keshdan olindi');
  // Spotify/Apple havolalari va muqova bazada saqlanmaydi — Deezer'dan
  // qayta topiladi (results.ts baribir Deezer qidiruvini bajaradi).
  return {
    title: row.song_title,
    artist: row.song_artist,
    album: row.song_album,
    link: row.song_link,
    spotifyUrl: null,
    appleUrl: null,
    coverUrl: null,
  };
}

/**
 * Musiqani aniqlaydi. Videoning bir nechta joyidan parcha olib ko'radi:
 * reels'ning ilk sekundlari ko'pincha gap/sukunat bo'lgani uchun 0-sekunddan
 * olingan parcha bilan natija chiqmasligi mumkin.
 *
 * API xato bersa yoki hech qayerdan topilmasa — oxirgi urinishda video
 * baribir yuboriladi ("musiqa aniqlanmadi" deb yoziladi).
 */
async function identifyWithFallback(
  mediaPath: string,
  job: RequestRow,
  log: Logger,
  tempFiles: string[],
): Promise<SongInfo | null> {
  const snippetLen = env.AUDD_SNIPPET_SECONDS;
  const duration = await probeDurationSeconds(mediaPath);
  const offsets = env.AUDD_MULTI_PASS ? snippetOffsets(duration, snippetLen) : [0];

  log.debug({ duration, offsets }, 'Musiqa aniqlash rejasi');

  let lastError: unknown = null;
  let usedSnippet = false;

  for (const offset of offsets) {
    const snippet = await extractAudioSnippet(mediaPath, offset, snippetLen);
    if (snippet) {
      tempFiles.push(snippet);
      usedSnippet = true;

      // Jim parchadan AudD barmoq izi yasay olmaydi — so'rovni behuda
      // sarflamaymiz va keyingi offsetga o'tamiz.
      const db = await measureLoudnessDb(snippet);
      if (db !== null && db < SILENCE_THRESHOLD_DB) {
        log.debug({ offset, db }, 'Parcha jim — AudD\'ga yuborilmadi');
        continue;
      }
    } else if (usedSnippet) {
      // Oldinroq parcha muvaffaqiyatli ajratilgan, bu offset esa video
      // tashqarisida — keyingisini sinashning ma'nosi yo'q.
      continue;
    }

    try {
      const song = await identifySong(snippet ?? mediaPath);
      if (song) {
        if (offset > 0) log.info({ offset }, 'Musiqa videoning o\'rtasidan topildi');
        return song;
      }
      log.debug({ offset }, 'Bu parchada musiqa topilmadi');
    } catch (e) {
      lastError = e;
      // Doimiy xato (yaroqsiz token) — boshqa offsetlar ham foydasiz
      if (e instanceof PermanentError) break;
      log.debug({ offset, err: errMessage(e) }, 'AudD xatosi — keyingi parcha');
    }

    // ffmpeg yo'q bo'lsa butun faylning o'zi yuborilgan — takrorlash foydasiz
    if (!snippet) break;
  }

  if (lastError === null) return null; // hamma parcha tekshirildi, musiqa yo'q

  const isLastAttempt = job.attempts >= env.MAX_ATTEMPTS;
  if (lastError instanceof TransientError && !isLastAttempt) {
    throw lastError; // butun job qayta urinadi
  }
  log.warn({ err: errMessage(lastError) }, 'Musiqa aniqlanmadi — natija musiqasiz yuboriladi');
  return null;
}

/** Telegram xatolarini retry-qilinadigan / qilinmaydiganga ajratadi. */
async function withTelegramErrors(send: () => Promise<void>): Promise<void> {
  try {
    await send();
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
