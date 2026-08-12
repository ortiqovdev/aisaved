import { supabase } from './supabase.ts';
import type { RequestRow } from './types.ts';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';

interface EnqueueInput {
  userId: number;
  igMessageId: string | null;
  mediaUrl: string;
  mediaType: string | null;
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

/** Navbat holati (health endpoint uchun). */
export async function queueStats(): Promise<Record<string, number>> {
  const statuses = ['queued', 'processing', 'done', 'failed'] as const;
  const out: Record<string, number> = {};
  for (const s of statuses) {
    const { count, error } = await supabase
      .from('requests')
      .select('id', { count: 'exact', head: true })
      .eq('status', s);
    if (error) throw new Error(`Navbat statistikasida xato: ${error.message}`);
    out[s] = count ?? 0;
  }
  return out;
}
