import fsp from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { TransientError, PermanentError, fetchWithTimeout, errMessage } from '../lib/errors.ts';

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

/**
 * Faylni AudD.io ga yuborib musiqani aniqlaydi.
 * @returns topilgan qo'shiq, yoki null — agar musiqa aniqlanmasa
 *          (bu XATO emas: video baribir foydalanuvchiga yuboriladi)
 */
export async function identifySong(filePath: string): Promise<SongInfo | null> {
  if (env.MOCK_AUDD) return mockIdentify(filePath);

  const buf = await fsp.readFile(filePath);

  const form = new FormData();
  form.append('api_token', env.AUDD_API_TOKEN);
  form.append('return', 'apple_music,spotify,deezer');
  form.append('file', new Blob([buf]), path.basename(filePath));

  const res = await fetchWithTimeout(AUDD_ENDPOINT, { method: 'POST', body: form }, 90_000);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 429 || res.status >= 500) {
      throw new TransientError(`AudD ${res.status}: ${text.slice(0, 300)}`);
    }
    throw new PermanentError(`AudD ${res.status}: ${text.slice(0, 300)}`);
  }

  let json: AuddResponse;
  try {
    json = (await res.json()) as AuddResponse;
  } catch (e) {
    throw new TransientError(`AudD javobini o'qib bo'lmadi: ${errMessage(e)}`);
  }

  if (json.status === 'error') {
    const code = json.error?.error_code;
    const msg = json.error?.error_message ?? 'noma\'lum xato';
    // 901 = kunlik limit tugadi, 900 = noto'g'ri API token
    if (code === 901) throw new TransientError(`AudD limiti tugadi: ${msg}`);
    if (code === 900) throw new PermanentError(`AudD tokeni yaroqsiz: ${msg}`);
    throw new TransientError(`AudD xatosi (${code}): ${msg}`);
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
