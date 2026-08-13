import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';

/**
 * Deezer'ning ochiq API'si — kalit talab qilmaydi.
 *
 * Bizga kerak bo'lgani:
 *   - qo'shiqning bir nechta versiyasi (foydalanuvchi to'g'risini tanlasin)
 *   - albom muqovasi
 *   - 30 soniyalik RASMIY preview (platformaning o'zi tinglatish uchun beradi)
 *
 * DIQQAT: bu yerda to'liq trek yuklab olinmaydi va olinmasligi kerak —
 * to'liq tijoriy qo'shiqni tarqatish mualliflik huquqini buzadi.
 */
const DEEZER_API = 'https://api.deezer.com';
const TIMEOUT_MS = 10_000;

export interface DeezerTrack {
  id: number;
  title: string;
  artist: string;
  album: string | null;
  durationSec: number;
  previewUrl: string | null;
  coverUrl: string | null;
  link: string | null;
}

interface RawTrack {
  id?: number;
  title?: string;
  duration?: number;
  preview?: string;
  link?: string;
  artist?: { name?: string };
  album?: { title?: string; cover_medium?: string; cover_big?: string };
}

function toTrack(raw: RawTrack): DeezerTrack | null {
  if (!raw.id || !raw.title) return null;
  return {
    id: raw.id,
    title: raw.title,
    artist: raw.artist?.name ?? 'Noma\'lum ijrochi',
    album: raw.album?.title ?? null,
    durationSec: raw.duration ?? 0,
    previewUrl: raw.preview || null,
    coverUrl: raw.album?.cover_big || raw.album?.cover_medium || null,
    link: raw.link ?? null,
  };
}

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${DEEZER_API}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      logger.debug({ path, status: res.status }, 'Deezer javob bermadi');
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    // Deezer ishlamasa asosiy oqim to'xtamasligi kerak — musiqa nomi baribir topilgan
    logger.debug({ path, err: errMessage(e) }, 'Deezer so\'rovi muvaffaqiyatsiz');
    return null;
  }
}

/** Qo'shiq nomi bo'yicha bir nechta versiyani qidiradi. */
export async function searchTracks(query: string, limit = 5): Promise<DeezerTrack[]> {
  const data = await get<{ data?: RawTrack[]; error?: unknown }>(
    `/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  );
  if (!data?.data) return [];

  const tracks: DeezerTrack[] = [];
  for (const raw of data.data) {
    const t = toTrack(raw);
    if (t) tracks.push(t);
  }
  return tracks;
}

/** Bitta trekni id bo'yicha oladi (inline tugma bosilganda). */
export async function getTrack(id: number): Promise<DeezerTrack | null> {
  const raw = await get<RawTrack & { error?: unknown }>(`/track/${id}`);
  if (!raw || raw.error) return null;
  return toTrack(raw);
}

/** "Ijrochi Nomi" ko'rinishidagi qidiruv so'rovi. */
export function buildQuery(artist: string, title: string): string {
  return `${artist} ${title}`.trim();
}
