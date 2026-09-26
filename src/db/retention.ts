import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import { supabase } from './supabase.ts';

/**
 * Eski yozuvlarni tozalash — bepul Supabase'dagi 500 MB baza to'lmasligi uchun.
 *
 * Bitta so'rov ~1.5 KB (indekslar bilan): tozalanmasa 1000 faol foydalanuvchi
 * bazani taxminan bir oyda to'ldiradi. Faqat tugaganlari (done/failed)
 * o'chiriladi — navbatdagi va ishlanayotganlariga tegilmaydi. Keshlar ham
 * cheksiz o'smasin: eski post qayta so'ralsa, shunchaki qaytadan yuklanadi.
 *
 * Bir nechta jarayonda (ilova + alohida worker) ishlasa ham zarari yo'q —
 * ikkinchisi o'chiradigan narsa topmaydi.
 */
const FIRST_RUN_DELAY_MS = 60_000;
const INTERVAL_MS = 6 * 60 * 60_000;

let timer: NodeJS.Timeout | null = null;

const cutoffIso = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

/** @param statuses — berilsa, faqat shu holatdagi qatorlar o'chiriladi */
async function deleteOlderThan(table: string, days: number, statuses?: string[]): Promise<number> {
  const base = supabase.from(table).delete({ count: 'exact' }).lt('created_at', cutoffIso(days));
  const { count, error } = await (statuses ? base.in('status', statuses) : base);
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

export async function runRetention(): Promise<void> {
  const deleted: Record<string, number> = {};
  const jobs: Array<[table: string, days: number, statuses?: string[]]> = [
    ['requests', env.REQUESTS_RETENTION_DAYS, ['done', 'failed']],
    ['media_cache', env.CACHE_RETENTION_DAYS],
    ['song_cache', env.CACHE_RETENTION_DAYS],
    // Bir martalik bog'lash kalitlari 30 daqiqa amal qiladi — kuni o'tganlari keraksiz
    ['ig_link_tokens', 1],
  ];

  for (const [table, days, statuses] of jobs) {
    if (days <= 0) continue;
    try {
      deleted[table] = await deleteOlderThan(table, days, statuses);
    } catch (e) {
      // Jadval yo'q (migratsiya qo'llanmagan) yoki tarmoq — keyingi safar
      logger.warn({ table, err: errMessage(e) }, 'Eski yozuvlarni tozalab bo\'lmadi');
    }
  }

  if (Object.values(deleted).some((n) => n > 0)) {
    logger.info({ deleted }, 'Eski yozuvlar tozalandi');
  }
}

/** Ishga tushgandan 1 daqiqa keyin, so'ng har 6 soatda. */
export function startRetention(): void {
  if (env.REQUESTS_RETENTION_DAYS <= 0 && env.CACHE_RETENTION_DAYS <= 0) return;
  const tick = (): void => {
    void runRetention().catch((e: unknown) =>
      logger.warn({ err: errMessage(e) }, 'Tozalashda kutilmagan xato'),
    );
  };
  timer = setTimeout(function repeat() {
    tick();
    timer = setTimeout(repeat, INTERVAL_MS);
    timer.unref();
  }, FIRST_RUN_DELAY_MS);
  timer.unref();
}

export function stopRetention(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
