import fsp from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { TransientError, PermanentError, fetchWithTimeout, errMessage } from '../lib/errors.ts';
import { msg } from '../i18n/index.ts';

const AUDD_ENDPOINT = 'https://api.audd.io/';

export interface SongInfo {
  title: string;
  artist: string;
  album: string | null;
  link: string | null;
  spotifyUrl: string | null;
  appleUrl: string | null;
  coverUrl: string | null;
}

interface AuddResponse {
  status?: string;
  error?: { error_code?: number; error_message?: string };
  result?: {
    artist?: string;
    title?: string;
    album?: string;
    release_date?: string;
    song_link?: string;
    spotify?: {
      external_urls?: { spotify?: string };
      album?: { images?: Array<{ url?: string; width?: number }> };
    };
    apple_music?: {
      url?: string;
      artwork?: { url?: string };
    };
  } | null;
}

/** Apple Music muqova URL'i shablon bo'ladi: .../{w}x{h}bb.jpg */
function appleArtwork(template: string | undefined): string | null {
  if (!template) return null;
  return template.replace('{w}', '500').replace('{h}', '500');
}

// ---------------------------------------------------------------------------
// AudD — pullik ZAXIRA: faqat AUDD_ENABLED=true bo'lsa va kunlik chegara
// (AUDD_DAILY_LIMIT) tugamagan bo'lsa chaqiriladi. Hisob jarayon xotirasida
// (UTC kuni bo'yicha) — xarajat oldindan ma'lum bo'lsin.
// ---------------------------------------------------------------------------

let budgetDay = '';
let usedToday = 0;

function rollDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== budgetDay) {
    budgetDay = today;
    usedToday = 0;
  }
}

/** AudD'ni hozir chaqirish mumkinmi (yoqilgan, tokeni bor, kunlik chegara qolgan). */
export function auddAvailable(): boolean {
  if (env.MOCK_AUDD) return true;
  if (!env.AUDD_ENABLED || env.AUDD_API_TOKEN.trim() === '') return false;
  rollDay();
  return env.AUDD_DAILY_LIMIT === 0 || usedToday < env.AUDD_DAILY_LIMIT;
}

/**
 * Faylni AudD.io ga yuborib musiqani aniqlaydi.
 * @returns topilgan qo'shiq, yoki null — agar musiqa aniqlanmasa
 *          (bu XATO emas: video baribir foydalanuvchiga yuboriladi)
 */
export async function identifySong(filePath: string): Promise<SongInfo | null> {
  if (env.MOCK_AUDD) return mockIdentify(filePath);

  rollDay();
  usedToday += 1;
  if (env.AUDD_DAILY_LIMIT > 0 && usedToday === env.AUDD_DAILY_LIMIT) {
    logger.warn({ limit: env.AUDD_DAILY_LIMIT }, 'AudD kunlik chegarasiga yetildi — ertagacha chaqirilmaydi');
  }

  const buf = await fsp.readFile(filePath);

  const form = new FormData();
  form.append('api_token', env.AUDD_API_TOKEN);
  form.append('return', 'apple_music,spotify,deezer');
  form.append('file', new Blob([buf]), path.basename(filePath));

  // AudD odatda 1–1.5 s da javob beradi (o'lchangan: ~0.9 s). Osilib qolgan
  // so'rov foydalanuvchini 90 s kuttirmasin — 15 s dan keyin qayta urinamiz.
  const res = await fetchWithTimeout(AUDD_ENDPOINT, { method: 'POST', body: form }, 15_000);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 429 || res.status >= 500) {
      throw new TransientError(`AudD ${res.status}: ${text.slice(0, 300)}`);
    }
    throw new PermanentError(`AudD ${res.status}: ${text.slice(0, 300)}`, msg('songServiceDown'));
  }

  let json: AuddResponse;
  try {
    json = (await res.json()) as AuddResponse;
  } catch (e) {
    throw new TransientError(`AudD javobini o'qib bo'lmadi: ${errMessage(e)}`);
  }

  if (json.status === 'error') {
    const code = json.error?.error_code;
    const message = json.error?.error_message ?? 'noma\'lum xato';

    // 900 = token yaroqsiz yoki trial/obuna tugagan; 902 = akkaunt limiti
    // tugagan. Ikkalasida ham retry foydasiz — to'ldirish kerak: dashboard.audd.io
    if (code === 900 || code === 902) {
      throw new PermanentError(
        `AudD ${code === 902 ? 'limiti tugagan' : 'tokeni yaroqsiz yoki obuna tugagan'} ` +
          `(dashboard.audd.io): ${message}`,
        msg('songServiceDown'),
      );
    }
    // 901 = kunlik limit tugadi — keyinroq qayta urinish mumkin
    if (code === 901) throw new TransientError(`AudD limiti tugadi: ${message}`);

    /**
     * 300 = "Recognition failed: problem with creating an audio fingerprint".
     *
     * Bu SERVIS xatosi emas — shu parchadan barmoq izi olinmadi (sukunat,
     * shovqin, faqat gap). Qayta urinish AYNI natijani beradi, shuning uchun
     * "topilmadi" deb qaraymiz: chaqiruvchi boshqa parchani sinab ko'radi.
     */
    if (code === 300) {
      logger.info({ filePath, code }, 'AudD: bu parchadan barmoq izi olinmadi');
      return null;
    }

    throw new TransientError(`AudD xatosi (${code}): ${message}`);
  }

  if (!json.result) {
    logger.info({ filePath }, 'AudD: musiqa aniqlanmadi');
    return null;
  }

  const { artist, title, album, song_link, spotify, apple_music } = json.result;
  if (!title && !artist) return null;

  return {
    title: title?.trim() || 'Noma\'lum nom',
    artist: artist?.trim() || 'Noma\'lum ijrochi',
    album: album?.trim() || null,
    link: song_link ?? null,
    spotifyUrl: spotify?.external_urls?.spotify ?? null,
    appleUrl: apple_music?.url ?? null,
    coverUrl: spotify?.album?.images?.[0]?.url ?? appleArtwork(apple_music?.artwork?.url),
  };
}

/**
 * MOCK_MODE uchun soxta natija — haqiqiy AudD chaqirilmaydi.
 * Fayl nomida "nomusic" bo'lsa "aniqlanmadi" holatini ham sinash mumkin.
 */
async function mockIdentify(filePath: string): Promise<SongInfo | null> {
  await new Promise((r) => setTimeout(r, 600)); // tarmoq kechikishini taqlid qiladi

  if (/nomusic/i.test(filePath)) {
    logger.info({ filePath }, '🎵 [MOCK] musiqa aniqlanmadi (sinov holati)');
    return null;
  }

  const song: SongInfo = {
    title: '[MOCK] Blinding Lights',
    artist: 'The Weeknd',
    album: 'After Hours',
    link: 'https://lis.tn/BlindingLights',
    spotifyUrl: null,
    appleUrl: null,
    coverUrl: null,
  };
  logger.info({ filePath, song: song.title }, '🎵 [MOCK] musiqa "aniqlandi"');
  return song;
}
