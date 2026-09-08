import { supabase, hasMigration0002 } from './supabase.ts';
import type { RequestRow } from './types.ts';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';

interface EnqueueInput {
  userId: number;
  igMessageId: string | null;
  mediaUrl: string;
  mediaType: string | null;
  /** Telegram `file_unique_id` — dedup/kesh kaliti. Instagram'da yo'q. */
  fileUniqueId?: string | null;
}

/**
 * Navbatga yangi job qo'shadi.
 * Meta webhook'ni takroran yuborsa, `ig_message_id` unique bo'lgani uchun
 * dublikat yaratilmaydi — null qaytadi.
 */
export async function enqueue(input: EnqueueInput): Promise<RequestRow | null> {
  const { data, error } = await supabase
    .from('requests')
    .insert({
      user_id: input.userId,
      ig_message_id: input.igMessageId,
      media_url: input.mediaUrl,
      media_type: input.mediaType,
      status: 'queued',
      // Ustun 0002 migratsiyasida qo'shiladi — qo'llanmagan bazada yubormaymiz
      ...(hasMigration0002() ? { file_unique_id: input.fileUniqueId ?? null } : {}),
    })
    .select('*')
    .single<RequestRow>();

  if (error) {
    if (error.code === '23505') {
      logger.info({ igMessageId: input.igMessageId }, 'Dublikat webhook — o\'tkazib yuborildi');
      return null;
    }
    throw new Error(`Navbatga qo'shishda xato: ${error.message}`);
  }
  return data;
}

/**
 * Navbatdan bitta jobni atomik band qiladi (Postgres FOR UPDATE SKIP LOCKED).
 * Bo'sh bo'lsa null.
 */
export async function claimNext(workerId: string): Promise<RequestRow | null> {
  const { data, error } = await supabase.rpc('claim_next_request', {
    p_worker_id: workerId,
    p_stale_seconds: env.WORKER_STALE_LOCK_SECONDS,
  });

  if (error) throw new Error(`claim_next_request xatosi: ${error.message}`);

  const rows = (data ?? []) as RequestRow[];
  return rows[0] ?? null;
}

export interface SongResultPatch {
  song_title: string | null;
  song_artist: string | null;
  song_album: string | null;
  song_link: string | null;
}

/**
 * Natija foydalanuvchiga YUBORILGANINI belgilaydi.
 *
 * Bu `markDone` dan alohida chaqiriladi: agar yuborishdan keyin markDone
 * yozilmasa (tarmoq uzilishi), job stale-lock orqali qayta olinadi va
 * `sent_at` tufayli natija ikkinchi marta yuborilmaydi.
 */
export async function markSent(id: number): Promise<void> {
  if (!hasMigration0002()) return; // ustun yo'q — himoya o'chirilgan

  const { error } = await supabase
    .from('requests')
    .update({ sent_at: new Date().toISOString() })
    .eq('id', id);
  // Bu belgi faqat TAKROR yuborishdan saqlaydi; natija allaqachon
  // foydalanuvchida. Shuning uchun xato bo'lsa jobni yiqitmaymiz.
  if (error) logger.warn({ id, err: error.message }, 'sent_at yozilmadi');
}

export async function markDone(
  id: number,
  patch: SongResultPatch & { video_file_path: string | null },
): Promise<void> {
  const { error } = await supabase
    .from('requests')
    .update({
      ...patch,
      status: 'done',
      error_message: null,
      locked_at: null,
      locked_by: null,
      completed_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw new Error(`Jobni 'done' qilishda xato: ${error.message}`);
}

export async function markFailed(id: number, message: string): Promise<void> {
  const { error } = await supabase
    .from('requests')
    .update({
      status: 'failed',
      error_message: message.slice(0, 1000),
      locked_at: null,
      locked_by: null,
      completed_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw new Error(`Jobni 'failed' qilishda xato: ${error.message}`);
}

/** Retry uchun navbatga qaytaradi (kechiktirilgan holda). */
export async function requeue(id: number, delayMs: number, message: string): Promise<void> {
  const nextAt = new Date(Date.now() + delayMs).toISOString();
  const { error } = await supabase
    .from('requests')
    .update({
      status: 'queued',
      next_attempt_at: nextAt,
      error_message: message.slice(0, 1000),
      locked_at: null,
      locked_by: null,
    })
    .eq('id', id);
  if (error) throw new Error(`Jobni navbatga qaytarishda xato: ${error.message}`);
}

/** /status komandasi uchun oxirgi so'rovlar. */
export async function recentByUser(userId: number, limit = 5): Promise<RequestRow[]> {
  const { data, error } = await supabase
    .from('requests')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`So'rovlar tarixini olishda xato: ${error.message}`);
  return (data ?? []) as RequestRow[];
}

/**
 * Ayni faylning avval muvaffaqiyatli aniqlangan natijasi (kesh).
 *
 * Bir xil videoni qayta yuborish AudD limitini behuda sarflaydi — natija
 * bazada bo'lsa uni qayta ishlatamiz. Faqat musiqa TOPILGAN yozuvlar
 * keshlanadi: "aniqlanmadi" natijasini keshlash yaxshi emas, chunki keyingi
 * urinishda (boshqa parcha bilan) topilishi mumkin.
 */
export async function findCachedResult(
  fileUniqueId: string,
  excludeId: number,
): Promise<RequestRow | null> {
  if (!hasMigration0002()) return null; // ustun yo'q — kesh o'chirilgan

  const { data, error } = await supabase
    .from('requests')
    .select('*')
    .eq('file_unique_id', fileUniqueId)
    .eq('status', 'done')
    .not('song_title', 'is', null)
    .neq('id', excludeId)
    .order('completed_at', { ascending: false })
    .limit(1);
  if (error) {
    // Kesh — ixtiyoriy optimizatsiya, xato bo'lsa oddiy oqim davom etadi
    logger.debug({ err: error.message }, 'Kesh so\'rovi muvaffaqiyatsiz');
    return null;
  }
  return ((data ?? []) as RequestRow[])[0] ?? null;
}

/** Foydalanuvchining navbatdagi (queued + processing) joblari soni — spam himoyasi. */
export async function pendingCountForUser(userId: number): Promise<number> {
  const { count, error } = await supabase
    .from('requests')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('status', ['queued', 'processing']);
  if (error) throw new Error(`Navbatdagi so'rovlarni hisoblashda xato: ${error.message}`);
  return count ?? 0;
}

/**
 * Navbat holati (health endpoint uchun) — bitta RPC bilan.
 *
 * 0002 migratsiyasi `queue_stats()` funksiyasini qo'shadi. Migratsiya hali
 * qo'llanmagan bo'lsa, eski (4 ta COUNT) usuliga qaytamiz.
 */
export async function queueStats(): Promise<Record<string, number>> {
  const statuses = ['queued', 'processing', 'done', 'failed'] as const;
  const out: Record<string, number> = { queued: 0, processing: 0, done: 0, failed: 0 };

  const { data, error } = await supabase.rpc('queue_stats');
  if (!error) {
    for (const row of (data ?? []) as Array<{ status: string; count: number }>) {
      out[row.status] = Number(row.count);
    }
    return out;
  }

  logger.debug({ err: error.message }, 'queue_stats RPC yo\'q — COUNT bilan hisoblanadi');
  for (const s of statuses) {
    const { count, error: countErr } = await supabase
      .from('requests')
      .select('id', { count: 'exact', head: true })
      .eq('status', s);
    if (countErr) throw new Error(`Navbat statistikasida xato: ${countErr.message}`);
    out[s] = count ?? 0;
  }
  return out;
}
