import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { PermanentError, TransientError, errMessage, fetchWithTimeout } from '../lib/errors.ts';

export async function ensureTmpDir(): Promise<string> {
  await fsp.mkdir(env.TMP_DIR, { recursive: true });
  return env.TMP_DIR;
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
export async function downloadVideo(url: string, requestId: number): Promise<DownloadedFile> {
  await ensureTmpDir();
  const filePath = path.join(env.TMP_DIR, `reel-${requestId}-${Date.now()}.mp4`);

  const res = await fetchWithTimeout(url, { redirect: 'follow' }, 120_000);

  if (!res.ok) {
    if (res.status === 403 || res.status === 404 || res.status === 410) {
      throw new PermanentError(
        `Media URL amal qilmaydi (${res.status})`,
        '⏳ Bu videoning havolasi eskirgan. Iltimos, reels\'ni Instagram\'da qaytadan yuboring.',
      );
    }
    if (res.status === 429 || res.status >= 500) {
      throw new TransientError(`Media yuklashda ${res.status}`);
    }
    throw new PermanentError(`Media yuklashda kutilmagan status: ${res.status}`);
  }

  // Server hajmni oldindan aytsa — behuda yuklamaymiz
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > 0 && declared > env.MAX_VIDEO_BYTES) {
    throw new PermanentError(
      `Video juda katta: ${declared} bayt`,
      `📦 Video hajmi juda katta (${formatBytes(declared)}). Telegram bot orqali ${formatBytes(env.MAX_VIDEO_BYTES)} dan kattasini yuborib bo'lmaydi.`,
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
        `📦 Video hajmi ${formatBytes(env.MAX_VIDEO_BYTES)} dan katta — Telegram orqali yuborib bo'lmaydi.`,
      );
    }
    throw new TransientError(`Videoni saqlashda xato: ${errMessage(e)}`);
  }

  if (bytes === 0) {
    await safeUnlink(filePath);
    throw new TransientError('Yuklab olingan fayl bo\'sh');
  }

  logger.info({ requestId, bytes, filePath }, 'Video yuklab olindi');
  return { filePath, bytes, contentType: res.headers.get('content-type') };
}

/**
 * ffmpeg bo'lsa videodan qisqa audio parcha ajratadi (mp3, 12s).
 * Musiqa aniqlash uchun butun video kerak emas — bu ancha tez va arzon.
 * ffmpeg topilmasa null qaytaradi, chaqiruvchi videoning o'zini yuboradi.
 */
export async function extractAudioSnippet(
  videoPath: string,
  startSeconds = 0,
  durationSeconds = 12,
): Promise<string | null> {
  if (!env.USE_FFMPEG) return null;

  const audioPath = videoPath.replace(/\.mp4$/i, '') + `-snippet.mp3`;
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
      { err: errMessage(e) },
      'ffmpeg ishlamadi — video faylning o\'zi musiqa aniqlashga yuboriladi',
    );
    await safeUnlink(audioPath);
    return null;
  }

  try {
    const stat = await fsp.stat(audioPath);
    if (stat.size < 1024) {
      await safeUnlink(audioPath);
      return null;
    }
  } catch {
    return null;
  }

  return audioPath;
}

function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} ${timeoutMs}ms ichida tugamadi`));
    }, timeoutMs);

    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} kod ${code} bilan tugadi: ${stderr.slice(0, 300)}`));
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
