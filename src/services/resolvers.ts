import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { PermanentError, TransientError, errMessage, fetchWithTimeout } from '../lib/errors.ts';
import { msg } from '../i18n/index.ts';
import { resolveInstagramMedia, type ResolvedItem } from './ig-resolver.ts';
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
      return { items: (await resolveInstagramMedia(url)).items };
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
 */
const YT_FORMAT = 'bv*[ext=mp4][vcodec^=avc1][height<=1080]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b';

async function resolveYouTube(link: string, jobId: number): Promise<ResolvedPost> {
  const dir = await ensureTmpDir();
  const base = path.join(dir, `yt-${jobId}-${randomUUID().slice(0, 8)}`);
  const maxMb = Math.floor(env.MAX_VIDEO_BYTES / (1024 * 1024));
  const ffmpegDir = /[\\/]/.test(env.FFMPEG_PATH) ? ['--ffmpeg-location', path.dirname(env.FFMPEG_PATH)] : [];

  const args = [
    '--no-simulate', '-j', '--no-warnings', '--no-progress', '--no-playlist',
    '--js-runtimes', 'node',
    ...ffmpegDir,
    '-f', YT_FORMAT,
    '--merge-output-format', 'mp4',
    '--max-filesize', `${maxMb}M`,
    '--match-filter', `duration<=?${env.YOUTUBE_MAX_SECONDS}`,
    '-o', `${base}.%(ext)s`,
    link,
  ];

  let stdout = '';
  let stderr = '';
  try {
    ({ stdout, stderr } = await runCommand(env.YTDLP_PATH, args, 180_000, { allowFailure: true }));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PermanentError('yt-dlp topilmadi (YTDLP_PATH)', msg('errPlatformUnavailable'));
    }
    throw new TransientError(`yt-dlp: ${errMessage(e)}`);
  }

  const filePath = `${base}.mp4`;
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || stat.size === 0) {
    await safeUnlink(filePath);
    const out = `${stdout}\n${stderr}`;
    logger.warn({ link, out: out.slice(-400) }, 'yt-dlp faylni yuklamadi');
    if (/does not pass filter/i.test(out)) {
      throw new PermanentError('YouTube: video juda uzun', msg('errVideoTooLong'));
    }
    if (/larger than max-filesize/i.test(out)) {
      throw new PermanentError('YouTube: fayl limitdan katta', msg('errVideoOverLimit', {
        limit: `${maxMb} MB`,
      }));
    }
    if (/private|unavailable|removed|not available|sign in/i.test(out)) {
      throw new PermanentError(`YouTube: ${out.trim().split('\n').at(-1)}`, msg('errResolverCantFetch'));
    }
    throw new TransientError(`yt-dlp natija bermadi: ${out.trim().slice(-300)}`);
  }

  const music = youtubeMusicOf(stdout);
  logger.info({ link, bytes: stat.size, music }, 'YouTube video yuklab olindi');
  return {
    items: [],
    downloaded: [{ filePath, bytes: stat.size, contentType: 'video/mp4' }],
    music,
  };
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
