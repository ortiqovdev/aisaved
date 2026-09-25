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
  type DownloadedFile,
  extractAudioSnippet,
  measureLoudnessDb,
  probeDurationSeconds,
  safeUnlink,
  snippetOffsets,
} from '../services/media.ts';
import { identifySong, type SongInfo } from '../services/audd.ts';
import { resolveTelegramFileUrl } from '../services/telegram-files.ts';
import {
  resolveInstagramMedia,
  type MediaKind,
  type ResolvedItem,
} from '../services/ig-resolver.ts';
import {
  IG_REACTION,
  instagramMessageIdOf,
  trySendInstagramReaction,
  type IgReaction,
} from '../services/instagram.ts';
import { IG_LINK_SOURCE, TELEGRAM_SOURCE } from '../lib/constants.ts';
import { msg, type Lang } from '../i18n/index.ts';
import { langOfUser } from '../i18n/user-lang.ts';
import { deliverMedia, deliverSong, fromDownloaded, type OutMedia } from '../bot/notify.ts';
import {
  dropMediaCache,
  getMediaCache,
  putMediaCache,
  type CachedMedia,
} from '../db/media-cache.repo.ts';
import { forgetStatusCard, statusCardOf } from '../bot/status-card.ts';

/**
 * Bitta jobni to'liq bajaradi:
 *   yuklab olish → audio ajratish → musiqa aniqlash → Telegram'ga yuborish
 *
 * Xatolar yuqoriga uzatiladi; retry qarorini worker loop qabul qiladi.
 */
export async function processRequest(job: RequestRow): Promise<void> {
  const log = logger.child({ requestId: job.id, attempt: job.attempts });

  const user = await usersRepo.findByIdCached(job.user_id);
  if (!user) {
    throw new PermanentError(`user_id=${job.user_id} topilmadi`);
  }
  const lang = langOfUser(user);

  // Media uch manbadan kelishi mumkin:
  //   telegram_file → foydalanuvchi faylni botga tashlagan (video unda bor)
  //   ig_link       → Instagram havolasi (video resolver orqali topiladi)
  //   ig_reel/...   → Instagram DM webhook'i (CDN havolasi payloadda keladi)
  const fromTelegram = job.media_type === TELEGRAM_SOURCE;
  const fromLink = job.media_type === IG_LINK_SOURCE;

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
    await reactOnInstagram(job, user.ig_scoped_id, IG_REACTION.ok);
    return;
  }

  const tempFiles: string[] = [];

  // Ikki xil ish:
  //   telegram_file → musiqa aniqlash (video botga tashlangan yoki natija
  //                   videosi tagidagi "🎵" bosilgan) — javob o'sha videoga
  //   ig_link / ig_reel / ig_post → YUKLAB olish (video, rasm yoki butun
  //                   karusel); qo'shiq avtomatik emas, "🎵" tugmasi orqali
  //
  // Ikkalasida ham "⏳ Qabul qilindi" kartasi bo'lsa — natija o'sha kartaning
  // o'rniga chiqadi (foydalanuvchiga bitta xabar). Kartaning ID'si oxirida
  // o'qiladi: job band qilinganda bot uni hali yubormagan bo'lishi mumkin.
  const replyTo = fromTelegram ? telegramMessageIdOf(job.ig_message_id) : undefined;

  try {
    // 0) Kesh: ayni fayl avval aniqlangan bo'lsa AudD'ni bezovta qilmaymiz
    //    (file_unique_id doimiy — bir videoni ko'p odam so'rasa ham bitta so'rov).
    const cached = fromTelegram ? await lookupCache(job, log) : null;
    if (cached) {
      const statusId = await statusCardOf(job.id);
      await withTelegramErrors(() =>
        deliverSong(user.telegram_id, cached, lang, statusId, replyTo),
      );
      forgetStatusCard(job.id);
      await requestsRepo.markDelivered(job.id, {
        song_title: cached.title,
        song_artist: cached.artist,
        song_album: cached.album,
        song_link: cached.link,
      });
      log.info({ song: cached.title }, 'Job keshdan yakunlandi (AudD chaqirilmadi)');
      return;
    }

    let song: SongInfo | null = null;
    if (fromTelegram) {
      // 1-3) Musiqa: file_id → vaqtinchalik URL (~1 soat) → yuklash → bir
      //      necha parcha o'rnini sinab aniqlash (reels boshida ko'pincha gap
      //      yoki sukunat bo'ladi)
      const url = await resolveTelegramFileUrl(job.media_url);
      const file = await downloadMedia(url, job.id, { allowAudio: true });
      tempFiles.push(file.filePath);
      song = await identifyWithFallback(file.filePath, job, log, tempFiles);

      const statusId = await statusCardOf(job.id);
      await withTelegramErrors(() =>
        deliverSong(user.telegram_id, song, lang, statusId, replyTo),
      );
    } else {
      // 1-3) Post: bitta video/rasm yoki butun karusel
      await deliverPost(job, user.telegram_id, lang, fromLink, log, tempFiles);
    }
    forgetStatusCard(job.id);

    // 4) Yuborildi + tugadi — bitta so'rov bilan
    await requestsRepo.markDelivered(job.id, {
      song_title: song?.title ?? null,
      song_artist: song?.artist ?? null,
      song_album: song?.album ?? null,
      song_link: song?.link ?? null,
    });

    log.info({ song: song?.title ?? null }, 'Job muvaffaqiyatli yakunlandi');

    // 7) Instagram'dan kelgan bo'lsa — reelsga ✅ (u yerda matn yozilmaydi)
    await reactOnInstagram(job, user.ig_scoped_id, IG_REACTION.ok);
  } finally {
    // Vaqtinchalik fayllar har qanday holatda tozalanadi
    for (const f of tempFiles) await safeUnlink(f);
  }
}

/** `ig:<shortcode>` → shortcode (media keshi kaliti). CDN job'larida yo'q. */
function shortcodeOf(job: RequestRow): string | null {
  return job.file_unique_id?.startsWith('ig:') ? job.file_unique_id.slice(3) : null;
}

/** Webhookdagi CDN havolasi turi: reels/video — video; post/share — noma'lum. */
function kindOfJob(mediaType: string | null): MediaKind | null {
  return mediaType === 'ig_reel' || mediaType === 'reel' || mediaType === 'video' ? 'video' : null;
}

/**
 * Postni yetkazadi — eng tezidan boshlab:
 *
 *   1. Media keshi — bu post avval yuborilgan: Telegram file_id orqali bir
 *      zumda; RapidAPI ham, yuklab olish ham yo'q.
 *   2. URL orqali — Telegram faylni Instagram CDN'dan o'zi oladi (video ≤20 MB,
 *      rasm ≤5 MB). Serverimiz faylni yuklab olmaydi va qayta yuklamaydi.
 *   3. Yuklab olib yuborish — URL ishlamasa (katta fayl, turi noma'lum,
 *      CDN Telegram'ni kiritmadi).
 *
 * Yuborilgan fayllarning file_id'lari keshga yoziladi.
 */
async function deliverPost(
  job: RequestRow,
  chatId: number,
  lang: Lang,
  fromLink: boolean,
  log: Logger,
  tempFiles: string[],
): Promise<void> {
  const shortcode = shortcodeOf(job);

  // 1) Kesh
  if (shortcode) {
    const cached = await getMediaCache(shortcode);
    if (cached) {
      try {
        const items: OutMedia[] = cached.map((c) => ({ kind: c.kind, source: { fileId: c.fileId } }));
        await deliverMedia(chatId, items, lang, await statusCardOf(job.id));
        log.info({ shortcode }, 'Post keshdan yuborildi (RapidAPI chaqirilmadi)');
        return;
      } catch (e) {
        if (!canFallBack(e)) throw toJobError(e);
        log.warn({ shortcode, err: errMessage(e) }, 'Keshdagi file_id ishlamadi — kesh tozalanadi');
        await dropMediaCache(shortcode);
      }
    }
  }

  let items: ResolvedItem[] = [{ url: job.media_url, kind: kindOfJob(job.media_type) }];
  if (fromLink) {
    const resolved = await resolveInstagramMedia(job.media_url);
    log.info(
      { files: resolved.items.length, title: resolved.title, author: resolved.author },
      'Havoladan post topildi',
    );
    items = resolved.items;
  }

  // 2) URL orqali — turi hamma fayl uchun ma'lum bo'lsagina
  let delivered: CachedMedia[] | null = null;
  if (items.every((i) => i.kind !== null)) {
    try {
      const out: OutMedia[] = items.map((i) => ({ kind: i.kind!, source: { url: i.url } }));
      delivered = await deliverMedia(chatId, out, lang, await statusCardOf(job.id));
    } catch (e) {
      if (!canFallBack(e)) throw toJobError(e);
      log.info({ err: errMessage(e) }, 'URL orqali ketmadi — yuklab olib yuboramiz');
    }
  }

  // 3) Yuklab olib yuborish
  if (!delivered) {
    const files = await downloadItems(items.map((i) => i.url), job, log);
    tempFiles.push(...files.map((f) => f.filePath));
    const statusId = await statusCardOf(job.id);
    delivered = await withTelegramErrors(() =>
      deliverMedia(chatId, fromDownloaded(files), lang, statusId),
    );
  }

  if (shortcode && delivered.length > 0) await putMediaCache(shortcode, delivered);
}

/**
 * Fayllarni yuklab oladi. Karuselda bitta fayl doimiy xato bersa (o'chirilgan,
 * format) — qolganlari baribir yuboriladi. Vaqtinchalik xatoda esa butun job
 * qayta urinadi.
 */
async function downloadItems(
  urls: string[],
  job: RequestRow,
  log: Logger,
): Promise<DownloadedFile[]> {
  const files: DownloadedFile[] = [];
  let firstError: unknown = null;
  for (const url of urls) {
    try {
      files.push(await downloadMedia(url, job.id, { allowImage: true }));
    } catch (e) {
      if (urls.length === 1 || !(e instanceof PermanentError)) {
        for (const f of files) await safeUnlink(f.filePath);
        throw e;
      }
      firstError ??= e;
      log.warn({ err: errMessage(e) }, 'Karusel fayli yuklanmadi — qolganlari yuboriladi');
    }
  }
  if (files.length === 0) throw firstError;
  return files;
}

/**
 * Telegram'dan kelgan so'rovning video xabari ID'si (`tg:<chat>:<msg>[:song]`) —
 * musiqa natijasi o'sha videoga javob bo'lib chiqishi uchun.
 */
function telegramMessageIdOf(igMessageId: string | null): number | undefined {
  const id = Number(igMessageId?.split(':')[2]);
  return igMessageId?.startsWith('tg:') && Number.isInteger(id) && id > 0 ? id : undefined;
}

/**
 * Instagram DM orqali kelgan so'rovning xabariga reaksiya qo'yadi.
 * Telegram'dan kelgan so'rovlarda (yoki IGSID bo'lmasa) hech narsa qilmaydi.
 */
export async function reactOnInstagram(
  job: RequestRow,
  igScopedId: string | null,
  reaction: IgReaction,
): Promise<void> {
  const messageId = instagramMessageIdOf(job.ig_message_id);
  if (!messageId || !igScopedId) return;
  await trySendInstagramReaction(igScopedId, messageId, reaction);
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

  /**
   * Xizmat ishlamayapti (token yaroqsiz, obuna tugagan, limit) — bu "musiqa
   * topilmadi" EMAS. Ilgari shunday deb ko'rsatilardi va muammo haftalab
   * sezilmay qolgan edi. Endi foydalanuvchiga rostini aytamiz, logda esa xato.
   */
  log.error({ err: errMessage(lastError) }, 'Musiqa aniqlash xizmati ishlamadi (AudD)');
  if (lastError instanceof PermanentError) throw lastError;
  throw new PermanentError(errMessage(lastError), msg('songServiceDown'));
}

/** Telegram xatolarini retry-qilinadigan / qilinmaydiganga ajratadi. */
async function withTelegramErrors<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (e) {
    throw toJobError(e);
  }
}

function toJobError(e: unknown): Error {
  if (e instanceof GrammyError) {
    // 403 — user botni bloklagan yoki chatni o'chirgan: qayta urinish foydasiz
    if (e.error_code === 403) {
      return new PermanentError(`Telegram 403: ${e.description}`);
    }
    // 413 / "file is too big"
    if (e.error_code === 413 || /too big|too large/i.test(e.description)) {
      return new PermanentError(
        `Telegram fayl hajmi limiti: ${e.description}`,
        msg('errTooBigForTelegram'),
      );
    }
    // 429 — flood control
    if (e.error_code === 429) {
      const retryAfter = (e.parameters?.retry_after ?? 30) * 1000;
      return new TransientError(`Telegram 429: ${e.description}`, retryAfter);
    }
    return new TransientError(`Telegram ${e.error_code}: ${e.description}`);
  }
  return new TransientError(`Telegram'ga yuborishda xato: ${errMessage(e)}`);
}

/**
 * Tezkor urinish (kesh yoki URL) yiqilganda keyingi usulga o'tish mumkinmi?
 * Flood limit yoki bloklangan bot — hech bir usul ishlamaydi, darhol chiqamiz.
 */
function canFallBack(e: unknown): boolean {
  return !(e instanceof GrammyError && (e.error_code === 429 || e.error_code === 403));
}
