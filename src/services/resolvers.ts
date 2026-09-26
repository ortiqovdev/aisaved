import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { PermanentError, TransientError, errMessage, fetchWithTimeout } from '../lib/errors.ts';
import { msg } from '../i18n/index.ts';
import { isResolverConfigured, resolveInstagramMedia, type ResolvedItem } from './ig-resolver.ts';
import { ensureTmpDir, runCommand, safeUnlink, type DownloadedFile } from './media.ts';
import type { Platform } from './links.ts';

/**
 * Havoladan post fayllarini topadi — har bir platforma o'z manbasi bilan:
 *
 *   Instagram → RapidAPI resolver (.env: IG_RESOLVER_*)
 *   TikTok    → tikwm-mos API (bepul, kalitsiz); qo'shiq nomini ham beradi
 *   Pinterest → Pinterest'ning ochiq widget API'si (kalitsiz)
 *   YouTube   → yt-dlp (+ ffmpeg): video va ovoz alohida keladi, birlashtiriladi
 *
 * Birinchi uchtasi fayl HAVOLALARINI qaytaradi (worker ularni avval Telegram'ga
 * URL orqali beradi). YouTube havolalari esa IP'ga bog'langan — Telegram ularni
 * ocha olmaydi, shuning uchun yt-dlp faylni darhol yuklab oladi.
 */
/** Platforma o'zi aytgan qo'shiq (TikTok musiqasi, YouTube "Music" bo'limi). */
export interface MusicTag {
  title: string;
  artist: string;
}

export const formatMusic = (m: MusicTag | null | undefined): string | null =>
  m ? [m.title, m.artist].filter(Boolean).join(' — ') : null;

export interface ResolvedPost {
  items: ResolvedItem[];
  /** Allaqachon yuklab olingan fayllar (YouTube) — `items` o'rniga. */
  downloaded?: DownloadedFile[];
  /**
   * Videodagi qo'shiq, platforma bersa — bepul: 🎵 bosilganda Shazam'ga
   * ham murojaat qilinmaydi.
   */
  music?: MusicTag | null;
}

export async function resolvePost(
  platform: Platform,
  url: string,
  jobId: number,
): Promise<ResolvedPost> {
  switch (platform) {
    case 'instagram':
      return isResolverConfigured()
        ? { items: (await resolveInstagramMedia(url)).items }
        : resolveInstagramWithYtDlp(url, jobId);
    case 'tiktok':
      return resolveTikTok(url);
    case 'pinterest':
      return resolvePinterest(url);
    case 'youtube':
      return resolveYouTube(url, jobId);
  }
}

/** Inline rejim uchun — faqat havola beradigan platformalar (YouTube emas). */
export const resolvesToUrls = (platform: Platform): boolean => platform !== 'youtube';

// ---------------------------------------------------------------------------
// TikTok (tikwm-mos API)
// ---------------------------------------------------------------------------

interface TikwmResponse {
  code?: number;
  msg?: string;
  data?: {
    play?: string;
    hdplay?: string;
    hd_size?: number;
    size?: number;
    cover?: string;
    origin_cover?: string;
    images?: string[];
    music_info?: { title?: string; author?: string; original?: boolean };
  };
}

/** Telegram URL orqali 20 MB gacha videoni o'zi oladi. */
const TELEGRAM_URL_VIDEO_LIMIT = 20 * 1024 * 1024;

async function resolveTikTok(link: string): Promise<ResolvedPost> {
  const template = env.TIKTOK_RESOLVER_URL.trim();
  if (template === '') {
    throw new PermanentError('TIKTOK_RESOLVER_URL sozlanmagan', msg('errPlatformUnavailable'));
  }
  const endpoint = template.replaceAll('{url}', encodeURIComponent(link));
  const res = await fetchWithTimeout(endpoint, { headers: { Accept: 'application/json' } }, 30_000);
  if (res.status === 429 || res.status >= 500) throw new TransientError(`TikTok resolver ${res.status}`);

  let json: TikwmResponse;
  try {
    json = (await res.json()) as TikwmResponse;
  } catch (e) {
    throw new TransientError(`TikTok resolver javobini o'qib bo'lmadi: ${errMessage(e)}`);
  }

  if (json.code !== 0 || !json.data) {
    // Bepul tarif: "Free Api Limit: 1 request/second" — bir soniyadan keyin qayta
    if (/limit/i.test(json.msg ?? '')) throw new TransientError(`TikTok resolver: ${json.msg}`, 2_000);
    throw new PermanentError(`TikTok resolver: ${json.msg ?? 'noma\'lum xato'}`, msg('errResolverNoVideo'));
  }

  const d = json.data;
  const absolute = (u: string): string => (u.startsWith('/') ? `https://www.tikwm.com${u}` : u);
  const thumb = d.cover ?? d.origin_cover ?? null;

  // "original sound - user" — qo'shiq emas, muallifning o'z ovozi
  const m = d.music_info;
  const music: MusicTag | null =
    m && m.original === false && m.title ? { title: m.title, artist: m.author ?? '' } : null;

  // Foto-karusel (TikTok "photo mode")
  if (d.images && d.images.length > 0) {
    return {
      items: d.images.slice(0, 20).map((u) => ({ url: absolute(u), kind: 'photo' as const, thumb: u })),
      music,
    };
  }

  // HD — faqat Telegram URL orqali ola oladigan hajmda bo'lsa
  const hdFits = d.hdplay && d.hd_size !== undefined && d.hd_size <= TELEGRAM_URL_VIDEO_LIMIT;
  const video = hdFits ? d.hdplay : (d.play ?? d.hdplay);
  if (!video) throw new PermanentError('TikTok resolver: video havolasi yo\'q', msg('errResolverNoVideo'));
  return { items: [{ url: absolute(video), kind: 'video', thumb }], music };
}

// ---------------------------------------------------------------------------
// Pinterest (ochiq widget API)
// ---------------------------------------------------------------------------

interface PidgetsResponse {
  status?: string;
  data?: Array<{
    images?: Record<string, { url?: string }>;
    videos?: { video_list?: Record<string, { url?: string; width?: number }> } | null;
  } | null>;
}

/** pin.it qisqa havolasi → pin ID (redirect orqali). */
async function pinIdOf(link: string): Promise<string> {
  const direct = /\/pin\/(?:[^/\s?#]*--)?(\d{6,25})/.exec(link)?.[1];
  if (direct) return direct;

  const res = await fetchWithTimeout(link, { redirect: 'follow' }, 20_000);
  const id = /\/pin\/(?:[^/\s?#]*--)?(\d{6,25})/.exec(res.url)?.[1];
  await res.body?.cancel().catch(() => undefined);
  if (!id) throw new PermanentError(`pin.it havolasi ochilmadi: ${res.url}`, msg('errResolverNoVideo'));
  return id;
}

async function resolvePinterest(link: string): Promise<ResolvedPost> {
  if (!env.PINTEREST_ENABLED) {
    throw new PermanentError('PINTEREST_ENABLED=false', msg('errPlatformUnavailable'));
  }
  const id = await pinIdOf(link);
  const res = await fetchWithTimeout(
    `https://widgets.pinterest.com/v3/pidgets/pins/info/?pin_ids=${id}`,
    { headers: { Accept: 'application/json' } },
    20_000,
  );
  if (res.status === 429 || res.status >= 500) throw new TransientError(`Pinterest ${res.status}`);
  const json = (await res.json().catch(() => ({}))) as PidgetsResponse;
  const pin = json.data?.[0];
  if (!pin) throw new PermanentError(`Pinterest: pin ${id} topilmadi`, msg('errResolverNoVideo'));

  const preview = pin.images?.['564x']?.url ?? pin.images?.['236x']?.url ?? null;

  // Video: to'g'ridan-to'g'ri .mp4 (HLS emas), avval 720p
  const videos = Object.entries(pin.videos?.video_list ?? {}).filter(([, v]) => v.url?.endsWith('.mp4'));
  videos.sort(([a], [b]) => Number(b === 'V_720P') - Number(a === 'V_720P'));
  const mp4 = videos[0]?.[1].url;
  if (mp4) return { items: [{ url: mp4, kind: 'video', thumb: preview }] };

  if (preview) {
    // Asl o'lchamdagi rasm — xuddi shu yo'lning "originals" varianti
    return { items: [{ url: preview.replace(/\/\d+x\//, '/originals/'), kind: 'photo', thumb: preview }] };
  }
  throw new PermanentError(`Pinterest: pin ${id} da media yo'q`, msg('errResolverNoVideo'));
}

// ---------------------------------------------------------------------------
// YouTube (yt-dlp)
// ---------------------------------------------------------------------------

/**
 * H.264 + AAC (Telegram'da hamma joyda o'ynaydi), 1080p gacha, ffmpeg bilan
 * bitta mp4 ga birlashtiriladi. YouTube endi video va ovozni alohida beradi.
 *
 * Sifat HAJMGA qarab tanlanadi: limitga sig'adigan eng yaxshi format. Faqat
 * https (DASH) formatlarida aniq `filesize` bor — m3u8 formatlarida hajm
 * noma'lum, shuning uchun ular birinchi tanlovga kirmaydi. Ilgari 3.5
 * daqiqalik klipda ham 1080p (77 MB) tanlanib, limitdan oshib qolardi.
 * Ovoz uchun limitning 20% i qoldiriladi.
 */
function youtubeFormat(maxBytes: number): string {
  const videoBudget = Math.floor(maxBytes * 0.8);
  return [
    `bv*[ext=mp4][vcodec^=avc1][height<=1080][protocol=https][filesize<${videoBudget}]+ba[ext=m4a][protocol=https]`,
    `b[ext=mp4][protocol=https][filesize<${maxBytes}]`,
    // Hajmi noma'lum bo'lsa — past sifat (baribir --max-filesize himoyalaydi)
    'bv*[ext=mp4][vcodec^=avc1][height<=480]+ba[ext=m4a]',
    'b[height<=480]',
    'b',
  ].join('/');
}

const resolveYouTube = (link: string, jobId: number): Promise<ResolvedPost> =>
  downloadWithYtDlp(link, jobId, {
    label: 'YouTube',
    prefix: 'yt',
    format: youtubeFormat(env.MAX_VIDEO_BYTES),
    maxSeconds: env.YOUTUBE_MAX_SECONDS,
  });

/**
 * Instagram — IG_RESOLVER_URL sozlanmagan bo'lsa, yt-dlp orqali (bepul,
 * login'siz). Meta DM'da ulashilgan reels uchun video emas, faqat sahifa
 * havolasini beradi — shu yo'l bilan u baribir yuklanadi. Instagram
 * login'siz so'rovlarni cheklashi mumkin; unda "rate-limit / login required"
 * xatosi keladi va foydalanuvchiga videoni o'zi tashlash taklif qilinadi.
 *
 * Tezkor yo'l: yt-dlp faylni YUKLAMAYDI — faqat to'g'ridan-to'g'ri mp4
 * havolasini oladi (~4 s), Telegram esa videoni shu havoladan o'zi tortadi.
 * Server faylni yuklab, keyin Telegram'ga qayta yuklashi shart emas (ilgari
 * 2.8 MB reels uchun jami ~18 s edi). Instagram CDN havolasi IP'ga bog'lanmagan
 * (YouTube'dan farqli). Telegram ololmasa — worker o'zi yuklab yuboradi.
 * Reels faqat alohida video+ovoz (DASH) ko'rinishida bo'lsa — yuklab birlashtiramiz.
 */
export async function resolveInstagramWithYtDlp(link: string, jobId: number): Promise<ResolvedPost> {
  const direct = await instagramDirectUrl(link);
  if (direct) return { items: [{ url: direct.url, kind: 'video', thumb: direct.thumb }] };
  return downloadWithYtDlp(link, jobId, {
    label: 'Instagram',
    prefix: 'ig',
    format: 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b',
  });
}

/**
 * Ovozi bilan birga bitta fayl bo'lgan mp4 havolasi (progressive format).
 * @returns null — bunday format yo'q (faqat alohida video+ovoz)
 * @throws  post yopiq/o'chirilgan, video yo'q, Instagram chekladi va h.k.
 */
async function instagramDirectUrl(link: string): Promise<{ url: string; thumb: string | null } | null> {
  const { stdout, stderr } = await runYtDlp(
    [
      '--no-warnings', '--no-playlist',
      // `b` — ovozi ham, videosi ham bor bitta fayl
      '-f', 'b[ext=mp4]',
      '--print', '%(.{url,thumbnail})j',
      link,
    ],
    60_000,
  );

  const line = stdout.split('\n').find((l) => l.trimStart().startsWith('{'));
  if (line) {
    try {
      const j = JSON.parse(line) as { url?: string; thumbnail?: string };
      if (j.url && /^https:\/\//.test(j.url) && !j.url.includes('.m3u8')) {
        return { url: j.url, thumb: j.thumbnail ?? null };
      }
    } catch {
      // buzuq JSON — pastda yuklab olish yo'liga o'tamiz
    }
  }
  const out = `${stdout}\n${stderr}`;
  if (line || /requested format is not available/i.test(out)) return null;
  logger.warn({ link, out: out.slice(-400) }, 'yt-dlp havolani ochmadi');
  throw ytDlpFailure('Instagram', out);
}

/** yt-dlp'ni ishga tushiradi; dastur yo'q bo'lsa — foydalanuvchiga tushunarli xato. */
async function runYtDlp(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  try {
    return await runCommand(env.YTDLP_PATH, args, timeoutMs, { allowFailure: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PermanentError('yt-dlp topilmadi (YTDLP_PATH)', msg('errPlatformUnavailable'));
    }
    throw new TransientError(`yt-dlp: ${errMessage(e)}`);
  }
}

/** yt-dlp chiqishidan xato turini aniqlaydi: doimiy (qayta urinish foydasiz) yoki vaqtinchalik. */
function ytDlpFailure(label: string, out: string): Error {
  const maxMb = Math.floor(env.MAX_VIDEO_BYTES / (1024 * 1024));
  if (/does not pass filter/i.test(out)) {
    return new PermanentError(`${label}: video juda uzun`, msg('errVideoTooLong'));
  }
  if (/larger than max-filesize/i.test(out)) {
    return new PermanentError(`${label}: fayl limitdan katta`, msg('errVideoOverLimit', {
      limit: `${maxMb} MB`,
    }));
  }
  // Instagram: rasm yoki faqat rasmlardan iborat karusel — yt-dlp faqat video oladi
  if (/no video formats found|there is no video/i.test(out)) {
    return new PermanentError(`${label}: postda video yo'q`, msg('errResolverNoVideo'));
  }
  // "empty media response" — Instagram: post o'chirilgan, yopiq yoki login talab qiladi
  if (/private|unavailable|removed|not available|sign in|login required|empty media response/i.test(out)) {
    return new PermanentError(`${label}: ${out.trim().split('\n').at(-1)}`, msg('errResolverCantFetch'));
  }
  return new TransientError(`yt-dlp natija bermadi: ${out.trim().slice(-300)}`);
}

interface YtDlpOptions {
  /** Log va xato matnlari uchun. */
  label: string;
  /** Vaqtinchalik fayl nomi prefiksi. */
  prefix: string;
  format: string;
  /** Shundan uzun videolar yuklanmaydi (sekund); berilmasa — cheklovsiz. */
  maxSeconds?: number;
}

async function downloadWithYtDlp(link: string, jobId: number, opts: YtDlpOptions): Promise<ResolvedPost> {
  const { label } = opts;
  const dir = await ensureTmpDir();
  const base = path.join(dir, `${opts.prefix}-${jobId}-${randomUUID().slice(0, 8)}`);
  const maxMb = Math.floor(env.MAX_VIDEO_BYTES / (1024 * 1024));
  const ffmpegDir = /[\\/]/.test(env.FFMPEG_PATH) ? ['--ffmpeg-location', path.dirname(env.FFMPEG_PATH)] : [];

  // Qo'shiq uchun faqat track/artist maydonlari chop etiladi: to'liq `-j`
  // JSON'i (subtitr havolalari bilan) 512 KB dan oshib, undan keyingi
  // "does not pass filter" / "larger than max-filesize" xabarlarini
  // runCommand chegarasidan tashqariga surib yuborardi — shunda bu xatolar
  // vaqtinchalik deb hisoblanib, bekorga qayta urinilardi. `--print` jim
  // rejimni yoqadi, `--no-quiet` o'sha xabarlarni qaytaradi.
  const args = [
    '--no-simulate', '--print', 'after_move:%(.{track,artist,artists})j',
    '--no-quiet', '--no-warnings', '--no-progress', '--no-playlist',
    '--js-runtimes', 'node',
    ...ffmpegDir,
    '-f', opts.format,
    '--merge-output-format', 'mp4',
    '--max-filesize', `${maxMb}M`,
    ...(opts.maxSeconds ? ['--match-filter', `duration<=?${opts.maxSeconds}`] : []),
    '-o', `${base}.%(ext)s`,
    link,
  ];

  const { stdout, stderr } = await runYtDlp(args, 180_000);

  const filePath = `${base}.mp4`;
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || stat.size === 0) {
    await removeWithPrefix(base);
    const out = `${stdout}\n${stderr}`;
    logger.warn({ link, out: out.slice(-400) }, 'yt-dlp faylni yuklamadi');
    throw ytDlpFailure(label, out);
  }

  const music = youtubeMusicOf(stdout);
  logger.info({ link, bytes: stat.size, music }, `${label} video yuklab olindi`);
  return {
    items: [],
    downloaded: [{ filePath, bytes: stat.size, contentType: 'video/mp4' }],
    music,
  };
}

/**
 * yt-dlp to'xtatilgan yuklashdan qoldirgan fayllarni (`<base>.f137.mp4.part`,
 * `<base>.f140.m4a` ...) o'chiradi — ular tmp papkada o'nlab MB joy egallaydi.
 */
async function removeWithPrefix(base: string): Promise<void> {
  const dir = path.dirname(base);
  const prefix = `${path.basename(base)}.`;
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (name.startsWith(prefix)) await safeUnlink(path.join(dir, name));
  }
}

/**
 * yt-dlp JSON'idagi qo'shiq: YouTube videoda "Music" bo'limi bo'lsa
 * `track` va `artist(s)` maydonlari keladi (klip, rasmiy audio, shorts).
 */
function youtubeMusicOf(stdout: string): MusicTag | null {
  const line = stdout.split('\n').reverse().find((l) => l.trimStart().startsWith('{'));
  if (!line) return null;
  try {
    const j = JSON.parse(line) as { track?: string; artist?: string; artists?: string[] };
    const artist = j.artists?.join(', ') || j.artist || '';
    return j.track ? { title: j.track, artist } : null;
  } catch {
    return null;
  }
}
