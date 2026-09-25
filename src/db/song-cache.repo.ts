import { supabase } from './supabase.ts';
import { logger } from '../lib/logger.ts';
import type { SongInfo } from '../services/audd.ts';

/**
 * Qo'shiq natijasi keshi (0006: `song_cache`) — kalit Telegram `file_unique_id`.
 *
 * AudD har bir so'rov uchun pul oladi, bitta "🎵" bosish esa 3 tagacha
 * so'rov. Media keshi tufayli bir reels hamma foydalanuvchiga AYNI Telegram
 * fayli bo'lib boradi — demak `file_unique_id` ham bir xil va AudD faqat
 * birinchi bosishda chaqiriladi.
 *
 * "Topilmadi" natijasi ham saqlanadi (24 soat): aks holda har bosish yana
 * 3 ta pullik so'rov bo'lardi. 24 soatdan keyin qayta tekshiriladi — qo'shiq
 * AudD bazasiga keyinroq qo'shilishi mumkin.
 */
export interface SongLookup {
  /** null — avval tekshirilgan va topilmagan. */
  song: SongInfo | null;
}

const NOT_FOUND_TTL_MS = 24 * 60 * 60_000;
const MEMORY_LIMIT = 5000;

const memory = new Map<string, { song: SongInfo | null; at: number }>();
let tableMissing = false;

const isMissingTable = (code: string | undefined): boolean =>
  code === '42P01' || code === 'PGRST205';

function fresh(song: SongInfo | null, at: number): boolean {
  return song !== null || Date.now() - at < NOT_FOUND_TTL_MS;
}

function remember(key: string, song: SongInfo | null, at: number): void {
  memory.delete(key);
  memory.set(key, { song, at });
  if (memory.size > MEMORY_LIMIT) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
}

/**
 * @returns keshdagi natija (song: null — "topilmadi"); keshda yo'q yoki
 *          jadval yo'q bo'lsa null. Xato bo'lsa ham null — kesh ixtiyoriy.
 */
export async function getSongCache(fileUniqueId: string): Promise<SongLookup | null> {
  const hit = memory.get(fileUniqueId);
  if (hit && fresh(hit.song, hit.at)) return { song: hit.song };
  if (tableMissing) return null;

  const { data, error } = await supabase
    .from('song_cache')
    .select('song, created_at')
    .eq('file_unique_id', fileUniqueId)
    .maybeSingle<{ song: SongInfo | null; created_at: string }>();
  if (error) {
    if (isMissingTable(error.code)) {
      tableMissing = true;
      logger.warn('0006 migratsiyasi QO\'LLANMAGAN — qo\'shiq keshi eski usulda (faqat topilganlar)');
    } else {
      logger.debug({ err: error.message }, 'song_cache o\'qilmadi');
    }
    return null;
  }
  if (!data) return null;

  const at = new Date(data.created_at).getTime();
  if (!fresh(data.song, at)) return null;
  remember(fileUniqueId, data.song, at);
  return { song: data.song };
}

/** Jadval bor-yo'qligi — yo'q bo'lsa chaqiruvchi eski keshga qaytadi. */
export const songCacheAvailable = (): boolean => !tableMissing;

export async function putSongCache(fileUniqueId: string, song: SongInfo | null): Promise<void> {
  const now = Date.now();
  remember(fileUniqueId, song, now);
  if (tableMissing) return;

  const { error } = await supabase
    .from('song_cache')
    .upsert(
      { file_unique_id: fileUniqueId, song, created_at: new Date(now).toISOString() },
      { onConflict: 'file_unique_id' },
    );
  if (error) {
    if (isMissingTable(error.code)) tableMissing = true;
    logger.debug({ err: error.message }, 'song_cache yozilmadi (xotirada bor)');
  }
}
