import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';

/**
 * Instagram cookies — yt-dlp uchun `--cookies` argumenti.
 *
 * Nega kerak: Instagram server (data-markaz) IP'laridan login'siz so'rovlarni
 * tezda bloklaydi — Render'da birinchi reels'larning o'zidayoq "You have
 * exceeded the rate-limit for accessing posts anonymously" chiqdi. Alohida
 * akkaunt cookies'i bilan so'rovlar o'sha akkaunt nomidan ketadi.
 *
 * Manba (birinchi topilgani): IG_COOKIES_FILE (Render Secret File) yoki
 * IG_COOKIES (mazmunning o'zi / base64).
 *
 * Nega nusxa: yt-dlp ish oxirida yangilangan cookies'ni faylga QAYTA YOZADI,
 * Render Secret File esa faqat o'qish uchun. Nusxa TMP_DIR dan tashqarida —
 * u yerdagi eski fayllar har 6 soatda tozalanadi.
 */
const WORKING_COPY = path.join(os.tmpdir(), 'aisaved-ig-cookies.txt');

/** undefined — hali tekshirilmagan; null — cookies yo'q yoki yaroqsiz. */
let content: string | null | undefined;

function readSource(): { text: string; source: string } | null {
  if (env.IG_COOKIES_FILE && fs.existsSync(env.IG_COOKIES_FILE)) {
    return { text: fs.readFileSync(env.IG_COOKIES_FILE, 'utf8'), source: env.IG_COOKIES_FILE };
  }
  const raw = env.IG_COOKIES.trim();
  if (!raw) return null;
  // Env qiymatida tab va yangi qatorlar yo'qolishi mumkin — base64 ham qabul qilinadi
  const text = raw.includes('\t') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return { text, source: 'IG_COOKIES' };
}

function load(): string | null {
  const src = readSource();
  if (!src) {
    logger.info('Instagram cookies berilmagan — so\'rovlar login\'siz (serverda tez bloklanadi)');
    return null;
  }
  const text = src.text.replace(/\r\n/g, '\n');
  // yt-dlp faqat Netscape formatini o'qiydi: sarlavha + tab bilan ajratilgan qatorlar
  if (!/^# (Netscape )?HTTP Cookie File/m.test(text)) {
    logger.error({ source: src.source }, 'Instagram cookies Netscape formatida emas ("# Netscape HTTP Cookie File" sarlavhasi yo\'q) — e\'tiborsiz qoldirildi');
    return null;
  }
  const igLines = text.split('\n').filter((l) => /^\S*instagram\.com\t/.test(l.replace(/^#HttpOnly_/, '')));
  const loggedIn = igLines.some((l) => l.split('\t')[5] === 'sessionid');
  if (!loggedIn) {
    logger.error({ source: src.source, igCookies: igLines.length }, 'Instagram cookies\'da "sessionid" yo\'q — akkauntga kirilmagan holda eksport qilingan');
    return null;
  }
  logger.info({ source: src.source, igCookies: igLines.length }, 'Instagram cookies yuklandi (akkauntga kirilgan)');
  return text;
}

/**
 * Instagram so'rovlari uchun yt-dlp argumentlari: `['--cookies', <fayl>]`
 * yoki cookies bo'lmasa — bo'sh ro'yxat.
 */
export async function instagramCookieArgs(): Promise<string[]> {
  if (content === undefined) content = load();
  if (content === null) return [];
  // Ishchi nusxa yo'qolgan bo'lsa (birinchi chaqiruv, tmp tozalangan) — qayta yozamiz
  if (!fs.existsSync(WORKING_COPY)) {
    await fsp.writeFile(WORKING_COPY, content, { mode: 0o600 });
  }
  return ['--cookies', WORKING_COPY];
}

/** Cookies ishlatilyaptimi — xato xabarlarida aniq maslahat berish uchun. */
export const hasInstagramCookies = (): boolean => typeof content === 'string';
