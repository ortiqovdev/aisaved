import { supabase } from './supabase.ts';
import { logger } from '../lib/logger.ts';
import type { MediaKind } from '../services/ig-resolver.ts';

/**
 * Instagram post → Telegram file_id keshi (0005 migratsiyasi: `media_cache`).
 *
 * Bir marta yuborilgan reels/postni keyingi safar RapidAPI'siz va yuklab
 * olmasdan, Telegram'dagi file_id orqali ~bir soniyada qayta yuboramiz.
 * Virusli reelslarni ko'p odam yuboradi — RapidAPI limiti ham tejaladi.
 *
 * Ikki qavat: xotira (bazaga bormasdan, bot handler'ining o'zida javob
 * berish uchun) va baza (qayta ishga tushganda ham, alohida worker ham).
 */
export interface CachedMedia {
  kind: MediaKind;
  fileId: string;
  /** Postdagi qo'shiq (TikTok) — faqat birinchi elementda saqlanadi. */
  music?: string | null;
  /** Telegram file_unique_id — qo'shiq keshi kaliti (saqlanmaydi, faqat yuborilganda). */
  fileUniqueId?: string;
}

interface StoredItem {
  kind: MediaKind;
  file_id: string;
  music?: string | null;
}

/** Xotirada saqlanadigan postlar soni (eng eskisi chiqarib yuboriladi). */
const MEMORY_LIMIT = 5000;
const memory = new Map<string, CachedMedia[]>();

/** Jadval yo'q (0005 qo'llanmagan) — bazaga qayta-qayta urinmaymiz. */
let tableMissing = false;

function rememberInMemory(shortcode: string, items: CachedMedia[]): void {
  memory.delete(shortcode); // qayta qo'shilsa — ro'yxat oxiriga (eng yangi)
  memory.set(shortcode, items);
  if (memory.size > MEMORY_LIMIT) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
}

const isMissingTable = (code: string | undefined): boolean =>
  code === '42P01' || code === 'PGRST205';

/** Faqat xotiradan — bazaga bormaydi (bot handler'i uchun, 0 ms). */
export function peekMediaCache(shortcode: string): CachedMedia[] | null {
  return memory.get(shortcode) ?? null;
}

/** Xotira, bo'lmasa baza. Xato bo'lsa null — kesh ixtiyoriy tezlashtirish. */
export async function getMediaCache(shortcode: string): Promise<CachedMedia[] | null> {
  const hit = memory.get(shortcode);
  if (hit) return hit;
  if (tableMissing) return null;

  const { data, error } = await supabase
    .from('media_cache')
    .select('items')
    .eq('shortcode', shortcode)
    .maybeSingle<{ items: StoredItem[] }>();
  if (error) {
    if (isMissingTable(error.code)) {
      tableMissing = true;
      logger.warn('0005 migratsiyasi QO\'LLANMAGAN — media keshi faqat xotirada');
    } else {
      logger.debug({ err: error.message }, 'media_cache o\'qilmadi');
    }
    return null;
  }
  if (!data?.items?.length) return null;

  const items = data.items.map((i) => ({ kind: i.kind, fileId: i.file_id, music: i.music ?? null }));
  rememberInMemory(shortcode, items);
  return items;
}

export async function putMediaCache(shortcode: string, items: CachedMedia[]): Promise<void> {
  if (items.length === 0) return;
  rememberInMemory(shortcode, items);
  if (tableMissing) return;

  const stored: StoredItem[] = items.map((i) => ({
    kind: i.kind,
    file_id: i.fileId,
    ...(i.music ? { music: i.music } : {}),
  }));
  const { error } = await supabase
    .from('media_cache')
    .upsert({ shortcode, items: stored }, { onConflict: 'shortcode' });
  if (error) {
    if (isMissingTable(error.code)) tableMissing = true;
    logger.debug({ err: error.message }, 'media_cache yozilmadi (xotirada bor)');
  }
}

/** file_id eskirgan/yaroqsiz bo'lib chiqsa — keshdan olib tashlaymiz. */
export async function dropMediaCache(shortcode: string): Promise<void> {
  memory.delete(shortcode);
  if (tableMissing) return;
  await supabase.from('media_cache').delete().eq('shortcode', shortcode);
}
