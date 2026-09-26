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
  probeUrlKind,
  safeUnlink,
  snippetOffsets,
} from '../services/media.ts';
import { auddAvailable, identifySong, type SongInfo } from '../services/audd.ts';
import { identifyWithShazam } from '../services/shazam.ts';
import {
  getSongCache,
  putSongCache,
  songCacheAvailable,
  type SongLookup,
} from '../db/song-cache.repo.ts';
import { resolveTelegramFileUrl } from '../services/telegram-files.ts';
import type { MediaKind } from '../services/ig-resolver.ts';
import { formatMusic, resolvePost, type MusicTag, type ResolvedPost } from '../services/resolvers.ts';
import { prepareNow, takePrepared, type Prepared } from '../services/prepare.ts';
import { platformOfMediaType } from '../services/links.ts';
import {
  IG_REACTION,
  instagramMessageIdOf,
  trySendInstagramReaction,
  type IgReaction,
} from '../services/instagram.ts';
import { TELEGRAM_SOURCE } from '../lib/constants.ts';
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
import { alertAdminLater } from '../services/alerts.ts';

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
  //   *_link        → Instagram/TikTok/YouTube/Pinterest havolasi (resolver)
  //   ig_reel/...   → Instagram DM webhook'i (CDN havolasi payloadda keladi)
  const fromTelegram = job.media_type === TELEGRAM_SOURCE;
  // Guruhda kelgan so'rov natijasi guruhning o'ziga boradi
  const chatId = targetChatOf(job, user.telegram_id);

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
    void reactOnInstagram(job, user.ig_scoped_id, IG_REACTION.ok);
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
    let song: SongInfo | null = null;
    if (fromTelegram) {
      // 0) Kesh: ayni fayl avval tekshirilgan bo'lsa (topilgan yoki
      //    "topilmadi") AudD'ni bezovta qilmaymiz — file_unique_id doimiy.
      // 1-3) Aks holda: yuklash → bir necha parcha o'rnini sinab aniqlash
      //      (reels boshida ko'pincha gap yoki sukunat bo'ladi). Bir xil
      //      faylga bir vaqtdagi so'rovlar bitta AudD chaqiruvini kutadi.
      const cached = await lookupCache(job, log);
      song = cached ? cached.song : await recognizeShared(job, log);

      const statusId = await statusCardOf(job.id);
      await withTelegramErrors(() =>
        deliverSong(chatId, song, lang, statusId, replyTo),
      );
    } else {
      // 1-3) Post: bitta video/rasm yoki butun karusel
      await deliverPost(job, chatId, lang, log, tempFiles);
    }
    forgetStatusCard(job.id);

    // 4) Instagram'dan kelgan bo'lsa — reelsga ✅ (⌛ o'rniga). Kutilmaydi:
    //    Meta xato bersa qayta urinishlar ~1 daqiqa davom etadi, worker slotini
    //    ushlab turmasin. Bazada esa "yuborildi + tugadi".
    void reactOnInstagram(job, user.ig_scoped_id, IG_REACTION.ok);
    await requestsRepo.markDelivered(job.id, {
      song_title: song?.title ?? null,
      song_artist: song?.artist ?? null,
      song_album: song?.album ?? null,
      song_link: song?.link ?? null,
    });

    log.info(
      { song: song?.title ?? null, totalMs: Date.now() - new Date(job.created_at).getTime() },
      'Job muvaffaqiyatli yakunlandi',
    );
  } finally {
    // Vaqtinchalik fayllar har qanday holatda tozalanadi
    for (const f of tempFiles) await safeUnlink(f);
  }
}

/**
 * Media keshi kaliti: `ig:<shortcode>`, `tt:<id>`, `yt:<id>`, `pin:<id>` ...
 * (havola job'larida `file_unique_id` ga shu yoziladi). CDN job'larida yo'q.
 */
function cacheKeyOf(job: RequestRow): string | null {
  const key = job.file_unique_id;
  return key && /^(ig|tt|yt|pin):/.test(key) ? key : null;
}

/** Webhookdagi CDN havolasi turi: reels/video — video; post/share — noma'lum. */
function kindOfJob(mediaType: string | null): MediaKind | null {
  return mediaType === 'ig_reel' || mediaType === 'reel' || mediaType === 'video' ? 'video' : null;
}

/**
 * Natija qaysi chatga boradi: Telegram'dan kelgan so'rov (`tg:<chat>:<msg>`)
 * o'sha chatga — guruhda guruhning o'ziga; Instagram DM'dan kelgani esa
 * foydalanuvchining shaxsiy chatiga.
 */
export function targetChatOf(job: RequestRow, telegramId: number): number {
  const chat = Number(job.ig_message_id?.split(':')[1]);
  return job.ig_message_id?.startsWith('tg:') && Number.isInteger(chat) && chat !== 0
    ? chat
    : telegramId;
}

/**
 * Postni yetkazadi — eng tezidan boshlab:
 *
 *   1. Media keshi — bu post avval yuborilgan: Telegram file_id orqali bir
 *      zumda; resolver ham, yuklab olish ham yo'q.
 *   2. URL orqali — Telegram faylni platforma CDN'idan o'zi oladi (video ≤20 MB,
 *      rasm ≤5 MB). Serverimiz faylni yuklab olmaydi va qayta yuklamaydi.
 *      TikTok uchun bu yagona yo'l bo'lishi mumkin: CDN'i O'zbekistonda yopiq.
 *   3. Yuklab olib yuborish — URL ishlamasa (katta fayl, turi noma'lum,
 *      CDN Telegram'ni kiritmadi). YouTube'da yt-dlp faylni o'zi yuklaydi.
 *
 * Yuborilgan fayllarning file_id'lari (va qo'shiq nomi) keshga yoziladi.
 */
async function deliverPost(
  job: RequestRow,
  chatId: number,
  lang: Lang,
  log: Logger,
  tempFiles: string[],
): Promise<void> {
  const key = cacheKeyOf(job);
  const platform = platformOfMediaType(job.media_type);
  const replyTo = telegramMessageIdOf(job.ig_message_id);

  // Bot/webhook havolani ko'rishi bilan fonda boshlagan tayyorlash (kesh +
  // resolver) — bo'lsa o'shani olamiz, bo'lmasa (alohida worker, qayta urinish)
  // hozir hisoblaymiz. [services/prepare.ts]
  const t0 = Date.now();
  let prepared: Prepared | null = null;
  if (platform) {
    prepared = await ((key ? takePrepared(key) : null) ?? prepareNow(key, platform, job.media_url, job.id));
  } else if (key) {
    const cached = await getMediaCache(key);
    if (cached) prepared = { cached };
  }

  // 1) Kesh — Telegram file_id orqali bir zumda
  if (prepared && 'cached' in prepared) {
    const cached = prepared.cached;
    try {
      const items: OutMedia[] = cached.map((c) => ({ kind: c.kind, source: { fileId: c.fileId } }));
      await deliverMedia(chatId, items, lang, await statusCardOf(job.id), {
        replyTo,
        music: cached[0]?.music,
      });
      log.info({ key, ms: Date.now() - t0 }, 'Post keshdan yuborildi (resolver chaqirilmadi)');
      return;
    } catch (e) {
      if (!canFallBack(e)) throw toJobError(e);
      log.warn({ key, err: errMessage(e) }, 'Keshdagi file_id ishlamadi — kesh tozalanadi');
      await dropMediaCache(key!);
      prepared = platform ? { post: await resolvePost(platform, job.media_url, job.id) } : null;
    }
  }

  let post: ResolvedPost =
    prepared && 'post' in prepared
      ? prepared.post
      : { items: [{ url: job.media_url, kind: kindOfJob(job.media_type) }] };

  // Turi noma'lum fayllar (Instagram DM rasmlari/postlari) — turini sarlavhadan
  // bilib olamiz: shunda ular ham URL orqali ketadi, yuklab-qayta yuklanmaydi
  if (!post.downloaded?.length && post.items.some((i) => i.kind === null)) {
    const tp = Date.now();
    const kinds = await Promise.all(post.items.map((i) => i.kind ?? probeUrlKind(i.url)));
    post = { ...post, items: post.items.map((i, n) => ({ ...i, kind: kinds[n] ?? null })) };
    log.info({ kinds, probeMs: Date.now() - tp }, 'Fayl turlari aniqlandi');
  }
  tempFiles.push(...(post.downloaded ?? []).map((f) => f.filePath));
  if (platform) {
    log.info(
      {
        platform,
        files: post.items.length + (post.downloaded?.length ?? 0),
        music: post.music,
        resolveMs: Date.now() - t0,
      },
      'Havoladan post topildi',
    );
  }
  const options = { replyTo, music: formatMusic(post.music) };

  let delivered: CachedMedia[] | null = null;

  // YouTube: fayl allaqachon yuklangan
  if (post.downloaded?.length) {
    const statusId = await statusCardOf(job.id);
    const files = post.downloaded;
    delivered = await withTelegramErrors(() =>
      deliverMedia(chatId, fromDownloaded(files), lang, statusId, options),
    );
  }

  // 2) URL orqali — turi hamma fayl uchun ma'lum bo'lsagina
  if (!delivered && post.items.every((i) => i.kind !== null)) {
    try {
      const out: OutMedia[] = post.items.map((i) => ({ kind: i.kind!, source: { url: i.url } }));
      delivered = await deliverMedia(chatId, out, lang, await statusCardOf(job.id), options);
    } catch (e) {
      if (!canFallBack(e)) throw toJobError(e);
      log.info({ err: errMessage(e) }, 'URL orqali ketmadi — yuklab olib yuboramiz');
    }
  }

  // 3) Yuklab olib yuborish
  if (!delivered) {
    const files = await downloadItems(post.items.map((i) => i.url), job, log);
    tempFiles.push(...files.map((f) => f.filePath));
    const statusId = await statusCardOf(job.id);
    delivered = await withTelegramErrors(() =>
      deliverMedia(chatId, fromDownloaded(files), lang, statusId, options),
    );
  }

  log.info({ key, ms: Date.now() - t0 }, 'Post yuborildi');

  // Keshlar — fonda: foydalanuvchi videoni allaqachon oldi, bazaga yozishni
  // (~0.5 s har biri) kutib worker'ni ham, ✅ reaksiyani ham ushlab turmaymiz.
  // Ikkala funksiya xatoni o'zi ushlaydi va logga yozadi.
  const writes: Array<Promise<void>> = [];
  if (key && delivered.length > 0) {
    const [first, ...rest] = delivered;
    writes.push(putMediaCache(key, first ? [{ ...first, music: formatMusic(post.music) }, ...rest] : rest));
  }
  // Platforma qo'shiqni aytgan bo'lsa — video ostidagi 🎵 uchun tayyor javob:
  // bosilganda Shazam ham chaqirilmaydi (kalit — yuborilgan videoning file_unique_id)
  if (post.music && env.RESULT_CACHE_ENABLED) {
    for (const d of delivered) {
      if (d.kind === 'video' && d.fileUniqueId) writes.push(putSongCache(d.fileUniqueId, songOfTag(post.music)));
    }
  }
  void Promise.all(writes);
}

/** Platforma aytgan qo'shiq → natija (havolalar va muqovani Deezer qidiruvi topadi). */
function songOfTag(tag: MusicTag): SongInfo {
  return {
    title: tag.title,
    artist: tag.artist || 'Noma\'lum ijrochi',
    album: null,
    link: null,
    spotifyUrl: null,
    appleUrl: null,
    coverUrl: null,
  };
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
  // Karusel fayllari PARALLEL yuklanadi (tartib saqlanadi) — ketma-ket
  // yuklaganda 10 ta rasm 10 barobar ko'p vaqt olardi
  const results = await Promise.allSettled(
    urls.map((url) => downloadMedia(url, job.id, { allowImage: true })),
  );
  const files: DownloadedFile[] = [];
  let firstError: unknown = null;
  let fatal: unknown = null;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      files.push(r.value);
      continue;
    }
    firstError ??= r.reason;
    if (urls.length === 1 || !(r.reason instanceof PermanentError)) fatal ??= r.reason;
    else log.warn({ err: errMessage(r.reason) }, 'Karusel fayli yuklanmadi — qolganlari yuboriladi');
  }
  if (fatal !== null) {
    for (const f of files) await safeUnlink(f.filePath);
    throw fatal;
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
 * @returns false — Instagram so'rovi edi, lekin reaksiya qo'yilmadi
 */
export async function reactOnInstagram(
  job: RequestRow,
  igScopedId: string | null,
  reaction: IgReaction,
): Promise<boolean> {
  const messageId = instagramMessageIdOf(job.ig_message_id);
  if (!messageId || !igScopedId) return true;
  return trySendInstagramReaction(igScopedId, messageId, reaction);
}

/**
 * Avval aniqlangan ayni faylning natijasi (agar bo'lsa).
 * Kesh xatosi asosiy oqimni to'xtatmaydi — shunchaki keshsiz davom etadi.
 */
async function lookupCache(job: RequestRow, log: Logger): Promise<SongLookup | null> {
  if (!env.RESULT_CACHE_ENABLED || !job.file_unique_id) return null;

  // Asosiy kesh (0006): to'liq natija yoki "topilmadi"
  const hit = await getSongCache(job.file_unique_id);
  if (hit) {
    log.info({ song: hit.song?.title ?? null }, 'Qo\'shiq keshdan olindi (AudD chaqirilmadi)');
    return hit;
  }
  if (songCacheAvailable()) return null;

  // Eski kesh — 0006 qo'llanmagan bazada: requests jadvalidagi topilganlar
  let row: RequestRow | null = null;
  try {
    row = await requestsRepo.findCachedResult(job.file_unique_id, job.id);
  } catch (e) {
    log.debug({ err: errMessage(e) }, 'Keshni o\'qib bo\'lmadi');
    return null;
  }
  if (!row?.song_title || !row.song_artist) return null;

  log.info({ cachedFrom: row.id, song: row.song_title }, 'Natija keshdan olindi');
  // Spotify/Apple havolalari va muqova bu yerda saqlanmaydi — Deezer'dan
  // qayta topiladi (results.ts baribir Deezer qidiruvini bajaradi).
  return {
    song: {
      title: row.song_title,
      artist: row.song_artist,
      album: row.song_album,
      link: row.song_link,
      spotifyUrl: null,
      appleUrl: null,
      coverUrl: null,
    },
  };
}

/** URL'dan parcha olib bo'lmadi — faylni to'liq yuklab qayta urinish kerak. */
class RemoteReadError extends Error {
  constructor() {
    super('Parchani URL\'dan olib bo\'lmadi');
  }
}

/** file_unique_id → bajarilayotgan aniqlash (shu jarayon ichida). */
const recognizing = new Map<string, Promise<SongInfo | null>>();

/**
 * Faylni yuklab, qo'shiqni aniqlaydi va natijani keshga yozadi.
 *
 * Virusli video ostidagi "🎵" ni bir vaqtda bir necha kishi bossa, AudD
 * (pullik) bir marta chaqiriladi — qolganlar o'sha natijani kutadi.
 */
async function recognizeShared(job: RequestRow, log: Logger): Promise<SongInfo | null> {
  const key = job.file_unique_id;

  const run = async (): Promise<SongInfo | null> => {
    const tempFiles: string[] = [];
    try {
      // file_id → vaqtinchalik URL (~1 soat)
      const url = await resolveTelegramFileUrl(job.media_url);
      let song: SongInfo | null;
      try {
        // Tez yo'l: ffmpeg faylni YUKLAMAYDI — kerakli parchalarni URL'dan
        // (Range so'rovlari bilan) o'qiydi. Telegram serveridan to'liq yuklash
        // bu yerdan juda sekin: 3 MB video — 48 s, parchalar esa — ~4 s.
        song = await identifyWithFallback(url, job, log, tempFiles, { remote: true });
      } catch (e) {
        if (!(e instanceof RemoteReadError)) throw e;
        // URL'dan o'qib bo'lmadi (ffmpeg o'chiq, format oqimga mos emas) — eski yo'l
        log.info('Parchani URL\'dan olib bo\'lmadi — fayl to\'liq yuklanadi');
        const file = await downloadMedia(url, job.id, { allowAudio: true });
        tempFiles.push(file.filePath);
        song = await identifyWithFallback(file.filePath, job, log, tempFiles);
      }
      // Faqat aniq natija keshlanadi: xato bo'lsa identifyWithFallback otadi
      if (key && env.RESULT_CACHE_ENABLED) await putSongCache(key, song);
      return song;
    } finally {
      for (const f of tempFiles) await safeUnlink(f);
    }
  };

  if (!key) return run();
  const pending = recognizing.get(key);
  if (pending) {
    log.info('Shu fayl hozir aniqlanmoqda — o\'sha natija kutiladi');
    return pending;
  }
  const promise = run().finally(() => recognizing.delete(key));
  recognizing.set(key, promise);
  return promise;
}

/**
 * Musiqani aniqlaydi — bepul manbadan boshlab:
 *
 *   1. Shazam (bepul) — videoning bir necha joyidan olingan parchalarda:
 *      reels boshida ko'pincha gap yoki sukunat bo'ladi, qo'shiq o'rtada.
 *   2. AudD (pullik zaxira) — faqat yoqilgan (AUDD_ENABLED) va kunlik chegara
 *      qolgan bo'lsa, faqat bitta — eng istiqbolli (o'rtadagi) parchada.
 *
 * Jim parchalar hech qayerga yuborilmaydi.
 *
 * @returns qo'shiq; null — hamma manba aniq "topilmadi" dedi
 * @throws  xizmatlar ishlamadi (tarmoq, Shazam bloklagan, AudD limiti) —
 *          bu "topilmadi" EMAS: foydalanuvchiga rostini aytamiz
 */
async function identifyWithFallback(
  mediaPath: string,
  job: RequestRow,
  log: Logger,
  tempFiles: string[],
  { remote = false }: { remote?: boolean } = {},
): Promise<SongInfo | null> {
  // URL'dan parcha olish ffmpeg'siz ishlamaydi — darhol faylni yuklash yo'liga
  if (remote && !env.USE_FFMPEG) throw new RemoteReadError();

  const snippetLen = env.AUDD_SNIPPET_SECONDS;
  const t0 = Date.now();
  const duration = await probeDurationSeconds(mediaPath);
  const offsets = env.AUDD_MULTI_PASS ? snippetOffsets(duration, snippetLen) : [0];
  log.debug({ duration, offsets, remote }, 'Musiqa aniqlash rejasi');

  // Ovozi bor parchalar, istiqbol tartibida (o'rta, bosh, oxir)
  const snippets: string[] = [];
  for (const offset of offsets) {
    const snippet = await extractAudioSnippet(mediaPath, offset, snippetLen);
    if (!snippet) {
      // URL'dan birinchi parcha ham chiqmadi — chaqiruvchi faylni yuklab qayta urinadi
      if (remote && snippets.length === 0 && offset === offsets[0]) throw new RemoteReadError();
      // ffmpeg yo'q — butun faylni bir marta yuboramiz
      if (!remote && snippets.length === 0 && offset === offsets[0]) snippets.push(mediaPath);
      break;
    }
    tempFiles.push(snippet);
    const db = await measureLoudnessDb(snippet);
    if (db !== null && db < SILENCE_THRESHOLD_DB) {
      log.debug({ offset, db }, 'Parcha jim — o\'tkazib yuborildi');
      continue;
    }
    snippets.push(snippet);
  }
  if (snippets.length === 0) return null; // butunlay jim video
  log.debug({ snippets: snippets.length, remote, ms: Date.now() - t0 }, 'Parchalar tayyor');

  let lastError: unknown = null;
  /** Shazam kamida bitta parchani xatosiz tekshirdi — "topilmadi" ishonchli. */
  let shazamAnswered = false;

  // 1) Shazam — bepul
  if (env.SHAZAM_ENABLED) {
    for (const snippet of snippets) {
      try {
        const song = await identifyWithShazam(snippet);
        shazamAnswered = true;
        if (song) {
          log.info({ song: song.title, via: 'shazam' }, 'Qo\'shiq topildi');
          return song;
        }
      } catch (e) {
        lastError = e;
        // Bloklangan/ishlamayapti — qolgan parchalarni urinish foydasiz
        log.warn({ err: errMessage(e) }, 'Shazam ishlamadi');
        break;
      }
    }
  }

  // 2) AudD — pullik zaxira, bitta parcha
  if (auddAvailable()) {
    try {
      const song = await identifySong(snippets[0]!);
      if (song) {
        log.info({ song: song.title, via: 'audd' }, 'Qo\'shiq topildi');
        return song;
      }
      return null;
    } catch (e) {
      // Shazam allaqachon aniq "topilmadi" degan bo'lsa — AudD xatosi natijani buzmasin
      if (shazamAnswered) {
        log.warn({ err: errMessage(e) }, 'AudD ishlamadi — Shazam natijasi ("topilmadi") qoldi');
        return null;
      }
      lastError = e;
    }
  }

  if (lastError === null) return null; // hamma manba aniq "topilmadi" dedi

  const isLastAttempt = job.attempts >= env.MAX_ATTEMPTS;
  if (lastError instanceof TransientError && !isLastAttempt) {
    throw lastError; // butun job keyinroq qayta urinadi
  }

  /**
   * Xizmat ishlamayapti — bu "musiqa topilmadi" EMAS. Ilgari shunday deb
   * ko'rsatilardi va muammo haftalab sezilmay qolgan edi. Endi foydalanuvchiga
   * rostini aytamiz, logda esa xato.
   */
  log.error({ err: errMessage(lastError) }, 'Musiqa aniqlash xizmatlari ishlamadi');
  alertAdminLater('song-service', '🟡 Qo\'shiq aniqlash ishlamayapti', [
    errMessage(lastError).slice(0, 200),
    'Shazam bu serverni bloklagan bo\'lishi mumkin. Zaxira: AUDD_ENABLED=true va AUDD_API_TOKEN.',
  ]);
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
