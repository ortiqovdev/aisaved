import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { PermanentError, TransientError, errMessage, fetchWithTimeout } from '../lib/errors.ts';
import { msg } from '../i18n/index.ts';

export async function ensureTmpDir(): Promise<string> {
  await fsp.mkdir(env.TMP_DIR, { recursive: true });
  return env.TMP_DIR;
}

/**
 * TMP_DIR dagi eskirgan fayllarni o'chiradi.
 *
 * Jarayon job o'rtasida qulab tushsa, `finally` bloki ishlamaydi va
 * vaqtinchalik video diskda qolib ketadi. Uzoq ishlaydigan serverda bu
 * diskni to'ldiradi — shuning uchun ishga tushishda tozalab olamiz.
 */
export async function cleanupTmpDir(maxAgeMs = 6 * 60 * 60_000): Promise<number> {
  let entries: string[];
  try {
    entries = await fsp.readdir(env.TMP_DIR);
  } catch {
    return 0;
  }

  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of entries) {
    const full = path.join(env.TMP_DIR, name);
    try {
      const stat = await fsp.stat(full);
      if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
      await fsp.unlink(full);
      removed += 1;
    } catch {
      // boshqa jarayon ishlatayotgan bo'lishi mumkin — e'tiborsiz qoldiramiz
    }
  }
  if (removed > 0) {
    logger.info({ removed, dir: env.TMP_DIR }, 'Eskirgan vaqtinchalik fayllar tozalandi');
  }
  return removed;
}

/** Davriy tozalash taymeri — ikki marta yoqilmasligi uchun modul ichida. */
let cleanupTimer: NodeJS.Timeout | null = null;

/**
 * `cleanupTmpDir` ni davriy ravishda chaqiradi.
 *
 * Faqat ishga tushishda tozalash YETARLI EMAS: server oylab qayta ishga
 * tushmasligi mumkin, jarayon esa job o'rtasida qulaganda `finally` bloki
 * bajarilmay qoladi va vaqtinchalik video diskda qolib ketadi.
 *
 * Chegaralar arifmetikasi: tekshiruv har SOATDA, fayl esa 5 SOATDAN oshsa
 * o'chiriladi — ya'ni eng yomon holatda ham fayl 6 soatdan ortiq yashamaydi.
 * Maxfiylik siyosatida ("within 6 hours") aynan shu va'da berilgan.
 */
export function startTmpCleanup(intervalMs = 60 * 60_000, maxAgeMs = 5 * 60 * 60_000): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    void cleanupTmpDir(maxAgeMs).catch((e) =>
      logger.warn({ err: errMessage(e) }, 'Davriy tmp tozalash muvaffaqiyatsiz'),
    );
  }, intervalMs);
  // Taymer jarayonni tirik ushlab turmasligi kerak
  cleanupTimer.unref();
  logger.debug({ intervalMs }, 'Vaqtinchalik fayllarni davriy tozalash yoqildi');
}

export function stopTmpCleanup(): void {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}

export interface DownloadedFile {
  filePath: string;
  bytes: number;
  contentType: string | null;
}

/**
 * Webhookdan kelgan CDN havolasi orqali videoni diskka yuklab oladi.
 *
 * DIQQAT: bu URL ~7 kun amal qiladi, shuning uchun job kelishi bilanoq
 * yuklab olamiz. Muddati o'tgan bo'lsa Meta CDN 403/410 qaytaradi —
 * bu holatda retry ma'nosiz (PermanentError).
 */
export interface DownloadOptions {
  /** Telegram'dan kelgan ovozli xabar / audio fayllar uchun. Instagram'da — false. */
  allowAudio?: boolean;
  /** Instagram rasm postlari va karuseldagi rasmlar uchun. Musiqa ishida — false. */
  allowImage?: boolean;
}

/** Yuklab olingan fayl Telegram'ga rasm sifatida yuboriladimi yoki video. */
export function isImageContentType(contentType: string | null): boolean {
  return (contentType?.split(';')[0]?.trim().toLowerCase() ?? '').startsWith('image/');
}

export async function downloadMedia(
  url: string,
  requestId: number,
  options: DownloadOptions = {},
): Promise<DownloadedFile> {
  await ensureTmpDir();

  const res = await fetchWithTimeout(url, { redirect: 'follow' }, 120_000);

  if (!res.ok) {
    if (res.status === 403 || res.status === 404 || res.status === 410) {
      throw new PermanentError(
        `Media URL amal qilmaydi (${res.status})`,
        msg('errLinkExpired'),
      );
    }
    if (res.status === 429 || res.status >= 500) {
      throw new TransientError(`Media yuklashda ${res.status}`);
    }
    throw new PermanentError(`Media yuklashda kutilmagan status: ${res.status}`);
  }

  const contentType = res.headers.get('content-type');
  assertMediaContentType(contentType, url, options);

  // Karuselda bir job bir necha fayl yuklaydi — nomlar to'qnashmasin
  const filePath = path.join(
    env.TMP_DIR,
    `media-${requestId}-${Date.now()}-${randomUUID().slice(0, 8)}${extensionFor(contentType)}`,
  );

  // Server hajmni oldindan aytsa — behuda yuklamaymiz
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > 0 && declared > env.MAX_VIDEO_BYTES) {
    throw new PermanentError(
      `Video juda katta: ${declared} bayt`,
      msg('errVideoTooBig', {
        size: formatBytes(declared),
        limit: formatBytes(env.MAX_VIDEO_BYTES),
      }),
    );
  }
  if (!res.body) throw new TransientError('Media javobida body yo\'q');

  let bytes = 0;
  const writeStream = fs.createWriteStream(filePath);
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);

  source.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > env.MAX_VIDEO_BYTES) {
      source.destroy(new PermanentError(`Video limitdan oshdi: ${bytes} bayt`));
    }
  });

  try {
    await pipeline(source, writeStream);
  } catch (e) {
    await safeUnlink(filePath);
    if (e instanceof PermanentError) {
      throw new PermanentError(
        e.message,
        msg('errVideoOverLimit', { limit: formatBytes(env.MAX_VIDEO_BYTES) }),
      );
    }
    throw new TransientError(`Videoni saqlashda xato: ${errMessage(e)}`);
  }

  if (bytes === 0) {
    await safeUnlink(filePath);
    throw new TransientError('Yuklab olingan fayl bo\'sh');
  }

  logger.info(
    { requestId, bytes, size: formatBytes(bytes), contentType, filePath },
    'Video yuklab olindi',
  );
  return { filePath, bytes, contentType };
}

/**
 * CDN javobi haqiqatan video ekanini tekshiradi.
 *
 * Bu muhim: havola eskirgan yoki noto'g'ri bo'lsa Meta CDN 200 bilan HTML
 * (login sahifasi) yoki JSON xato qaytarishi mumkin. Tekshirmasak, o'sha
 * HTML'ni ".mp4" deb Telegram'ga yuborishga urinamiz va tushunarsiz xato olamiz.
 */
function assertMediaContentType(
  contentType: string | null,
  url: string,
  options: DownloadOptions,
): void {
  if (!contentType) return; // sarlavha yo'q bo'lsa — to'sib qo'ymaymiz

  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';

  if (type.startsWith('video/') || type === 'application/octet-stream') return;
  if (options.allowAudio && type.startsWith('audio/')) return;
  if (options.allowImage && type.startsWith('image/')) return;

  if (type.startsWith('image/')) {
    throw new PermanentError(
      `Video emas, rasm keldi: ${type} (${url.slice(0, 120)})`,
      msg('errImageNotVideo'),
    );
  }

  throw new PermanentError(
    `Kutilmagan content-type: ${type} (${url.slice(0, 120)})`,
    msg('errBadMediaLink'),
  );
}

/** content-type ga qarab fayl kengaytmasi. */
function extensionFor(contentType: string | null): string {
  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  switch (type) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/heic':
      return '.heic';
    case 'video/quicktime':
      return '.mov';
    case 'video/webm':
      return '.webm';
    case 'video/x-matroska':
      return '.mkv';
    case 'audio/mpeg':
      return '.mp3';
    case 'audio/ogg':
    case 'audio/opus':
      return '.ogg';
    case 'audio/mp4':
    case 'audio/x-m4a':
      return '.m4a';
    case 'audio/wav':
    case 'audio/x-wav':
      return '.wav';
    default:
      return type.startsWith('audio/') ? '.audio' : '.mp4';
  }
}

/**
 * Media davomiyligini (sekund) aniqlaydi.
 *
 * ffprobe alohida dastur va har doim mavjud bo'lmasligi mumkin, shuning uchun
 * ffmpeg'ning o'zidan foydalanamiz: kirish faylini ochganda "Duration: ..."
 * satrini stderr'ga chiqaradi. null — aniqlab bo'lmadi.
 */
export async function probeDurationSeconds(filePath: string): Promise<number | null> {
  if (!env.USE_FFMPEG) return null;
  try {
    // Chiqish fayli berilmagani uchun ffmpeg xato kodi bilan tugaydi —
    // bizga faqat metadata satri kerak, shuning uchun allowFailure.
    const { stderr } = await runCommand(
      env.FFMPEG_PATH,
      ['-hide_banner', '-i', filePath],
      20_000,
      { allowFailure: true },
    );
    const m = /Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d+)/.exec(stderr);
    if (!m) return null;
    const total =
      Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`);
    return Number.isFinite(total) && total > 0 ? total : null;
  } catch (e) {
    logger.debug({ err: errMessage(e) }, 'Davomiylikni aniqlab bo\'lmadi');
    return null;
  }
}

/**
 * Musiqa aniqlash uchun eng istiqbolli parcha o'rinlarini tanlaydi (sekundda).
 *
 * Nega kerak: reels'ning ilk sekundlari ko'pincha gap, logo yoki sukunat
 * bo'ladi — 0-sekunddan olingan parcha bilan AudD hech narsa topmaydi,
 * holbuki qo'shiq 5-10 sekunddan boshlanadi. Shuning uchun avval O'RTADAN
 * (eng ehtimolli joydan), keyin boshidan olib ko'ramiz.
 */
export function snippetOffsets(durationSeconds: number | null, snippetLen: number): number[] {
  // Davomiylik noma'lum yoki video parchadan qisqa — bitta urinish yetarli
  if (durationSeconds === null || durationSeconds <= snippetLen + 2) return [0];

  const offsets: number[] = [];
  const mid = Math.floor(durationSeconds / 2 - snippetLen / 2);
  if (mid > 1) offsets.push(mid);
  offsets.push(0);

  // Oxirgi qism: musiqa videoning ikkinchi yarmida boshlanadigan holatlar
  // (boshida uzoq gap yoki intro bo'lgan reels) uchun.
  const late = Math.max(0, Math.floor(durationSeconds - snippetLen - 1));
  if (late > mid + 2) offsets.push(late);

  return offsets;
}

/**
 * Parchaning ENG BALAND nuqtasini (dBFS) qaytaradi. null — aniqlanmadi.
 *
 * Nega kerak: toza sukunatdan AudD barmoq izi yasay olmaydi va 300 xatosini
 * qaytaradi — so'rov behuda ketadi (limit sarflanadi, javob sekinlashadi).
 *
 * Nega `mean_volume` emas, `max_volume`: o'rtacha qiymat aldaydi. O'lchangan
 * haqiqiy misollar:
 *   - tanilgan qo'shiq (AudD namunasi): mean -48.8 dB, max -35.7 dB
 *   - shovqin:                          mean -30.8 dB, max -26.0 dB
 *   - raqamli sukunat:                  mean -91.0 dB, max -91.0 dB
 * Ya'ni jim yozilgan musiqaning o'rtachasi sukunatga juda yaqin bo'ladi —
 * o'rtacha bo'yicha filtrlash haqiqiy musiqani rad etib qo'yardi. Eng baland
 * nuqta esa sukunatni (-91) har qanday real ovozdan ishonchli ajratadi.
 */
export async function measureLoudnessDb(filePath: string): Promise<number | null> {
  if (!env.USE_FFMPEG) return null;
  try {
    const { stderr } = await runCommand(
      env.FFMPEG_PATH,
      ['-hide_banner', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'],
      30_000,
      { allowFailure: true },
    );
    const m = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
    if (!m?.[1]) return null;
    const db = Number(m[1]);
    return Number.isFinite(db) ? db : null;
  } catch {
    return null;
  }
}

/**
 * Bundan jim parcha AudD'ga yuborilmaydi.
 *
 * Raqamli sukunat -91 dB, eng jim haqiqiy musiqa ham -36 dB atrofida —
 * -60 dB ikkisining orasida keng zaxira qoldiradi, ya'ni haqiqiy ovozni
 * xato rad etish xavfi yo'q.
 */
export const SILENCE_THRESHOLD_DB = -60;

/**
 * ffmpeg bo'lsa videodan qisqa audio parcha ajratadi (mp3).
 * Musiqa aniqlash uchun butun video kerak emas — bu ancha tez va arzon.
 * ffmpeg topilmasa null qaytaradi, chaqiruvchi videoning o'zini yuboradi.
 */
export async function extractAudioSnippet(
  videoPath: string,
  startSeconds = 0,
  durationSeconds = env.AUDD_SNIPPET_SECONDS,
): Promise<string | null> {
  if (!env.USE_FFMPEG) return null;

  // Har qanday kengaytmani (.mp4/.mov/.webm) olib tashlaymiz.
  // Offset nomga kiritiladi — ketma-ket parchalar bir-birini yozib ketmasin.
  const audioPath = path.join(
    path.dirname(videoPath),
    `${path.basename(videoPath, path.extname(videoPath))}-s${startSeconds}.mp3`,
  );
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-ss', String(startSeconds),
    '-t', String(durationSeconds),
    '-i', videoPath,
    '-vn',
    '-ac', '1',
    '-ar', '44100',
    '-b:a', '128k',
    audioPath,
  ];

  try {
    await runCommand(env.FFMPEG_PATH, args, 60_000);
  } catch (e) {
    logger.warn(
      { err: errMessage(e), startSeconds },
      'ffmpeg ishlamadi — video faylning o\'zi musiqa aniqlashga yuboriladi',
    );
    await safeUnlink(audioPath);
    return null;
  }

  try {
    const stat = await fsp.stat(audioPath);
    // Juda kichik fayl = ovoz yo'q yoki offset video oxiridan tashqarida
    if (stat.size < 4096) {
      logger.debug({ audioPath, bytes: stat.size, startSeconds }, 'Parcha bo\'sh — o\'tkazildi');
      await safeUnlink(audioPath);
      return null;
    }
  } catch {
    return null;
  }

  return audioPath;
}

/** Telegram dumaloq video (video note) cheklovlari. */
export const VIDEO_NOTE_SIZE = 640;
export const VIDEO_NOTE_MAX_SECONDS = 60;

export interface VideoNoteFile {
  filePath: string;
  /** Natija davomiyligi (sekund, butun) — sendVideoNote `duration` uchun. */
  duration: number;
  /** Asl video 60 soniyadan uzun edi — boshidan 60 soniya olindi. */
  trimmed: boolean;
}

/**
 * Videoni Telegram dumaloq xabari (video note) formatiga o'giradi.
 *
 * Telegram talabi: kvadrat, H.264, ko'pi bilan 60 soniya. Shuning uchun
 * markazdan kvadrat kesiladi (reels 9:16 — tepa va pastdan qirqiladi),
 * 640×640 ga keltiriladi va 60 soniyadan keyingi qism tashlanadi.
 * Ovoz ixtiyoriy (`0:a:0?`) — ovozsiz GIF/video ham ishlaydi.
 *
 * @throws Error — ffmpeg o'chirilgan yoki o'girib bo'lmadi
 */
export async function makeVideoNote(inputPath: string): Promise<VideoNoteFile> {
  if (!env.USE_FFMPEG) throw new Error('USE_FFMPEG=false — video note yasab bo\'lmaydi');

  const sourceDuration = await probeDurationSeconds(inputPath);
  const trimmed = sourceDuration !== null && sourceDuration > VIDEO_NOTE_MAX_SECONDS;

  const outPath = path.join(
    path.dirname(inputPath),
    `${path.basename(inputPath, path.extname(inputPath))}-round.mp4`,
  );
  const size = VIDEO_NOTE_SIZE;
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', inputPath,
    '-t', String(VIDEO_NOTE_MAX_SECONDS),
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', `crop='min(iw,ih)':'min(iw,ih)',scale=${size}:${size}:flags=lanczos,setsar=1,fps=30`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '26',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'main',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-ac', '2',
    '-movflags', '+faststart',
    outPath,
  ];

  try {
    await runCommand(env.FFMPEG_PATH, args, 180_000);
  } catch (e) {
    await safeUnlink(outPath);
    throw e;
  }

  const outDuration = await probeDurationSeconds(outPath);
  const duration = Math.max(
    1,
    Math.round(outDuration ?? Math.min(sourceDuration ?? 1, VIDEO_NOTE_MAX_SECONDS)),
  );
  return { filePath: outPath, duration, trimmed };
}

export interface RunOptions {
  /** true bo'lsa nolga teng bo'lmagan exit kod xato hisoblanmaydi (probe uchun). */
  allowFailure?: boolean;
}

export function runCommand(
  cmd: string,
  args: string[],
  timeoutMs: number,
  options: RunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    // `error` va `close` ikkisi ham chiqishi mumkin — promise bir marta hal bo'ladi
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(() => reject(new Error(`${cmd} ${timeoutMs}ms ichida tugamadi`)));
    }, timeoutMs);

    // Cheklov: buzilgan fayl megabaytlab log chiqarishi mumkin
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < 512_000) stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 64_000) stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      settle(() => reject(err));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || options.allowFailure) settle(() => resolve({ stdout, stderr }));
      else {
        settle(() =>
          reject(new Error(`${cmd} kod ${code} bilan tugadi: ${stderr.slice(0, 300)}`)),
        );
      }
    });
  });
}

export async function safeUnlink(filePath: string | null | undefined): Promise<void> {
  if (!filePath) return;
  try {
    await fsp.unlink(filePath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') logger.warn({ filePath, err: errMessage(e) }, 'Faylni o\'chirib bo\'lmadi');
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
