import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import { supabase } from './supabase.ts';
import type { UserRow } from './types.ts';

/**
 * Admin panel (/qimmat) ma'lumotlari — 0009 migratsiyasi.
 *
 * Asosiy admin(lar) — ADMIN_TELEGRAM_IDS env'da (bazaga bog'liq emas, 0009
 * qo'llanmagan bo'lsa ham panelga kira oladi). Yordamchi adminlar — `admins`.
 */

// ---------------------------------------------------------------------------
// 0009 bormi — ishga tushishda bir marta tekshiriladi
// ---------------------------------------------------------------------------

let ready = false;
export const adminDbReady = (): boolean => ready;

export async function probeAdminDb(): Promise<void> {
  const [a, c, u] = await Promise.all([
    supabase.from('admins').select('telegram_id').limit(1),
    supabase.from('required_channels').select('chat_id').limit(1),
    supabase.from('users').select('last_active_at, blocked_at, banned_at').limit(1),
  ]);
  ready = !a.error && !c.error && !u.error;
  if (!ready) {
    logger.warn(
      { err: (a.error ?? c.error ?? u.error)?.message },
      '⚠️  0009 migratsiyasi QO\'LLANMAGAN — admin panel, majburiy a\'zolik va statistika o\'chiq. ' +
        'supabase/migrations/0009_admin.sql ni SQL Editor\'da ishga tushiring.',
    );
  }
}

// ---------------------------------------------------------------------------
// Adminlar
// ---------------------------------------------------------------------------

export interface AdminRow {
  telegram_id: number;
  username: string | null;
  phone: string | null;
  added_by: number | null;
  created_at: string;
}

const ADMIN_CACHE_MS = 60_000;
let adminCache: { ids: Set<number>; at: number } | null = null;

export const isOwner = (id: number): boolean => env.ADMIN_TELEGRAM_IDS.includes(id);

export async function listAdmins(): Promise<AdminRow[]> {
  if (!ready) return [];
  const { data, error } = await supabase.from('admins').select('*').order('created_at');
  if (error) throw new Error(`admins o'qishda xato: ${error.message}`);
  return (data ?? []) as AdminRow[];
}

/** Asosiy yoki yordamchi admin (1 daqiqa kesh). */
export async function isAdmin(id: number): Promise<boolean> {
  if (isOwner(id)) return true;
  if (!ready) return false;
  if (!adminCache || Date.now() - adminCache.at > ADMIN_CACHE_MS) {
    try {
      adminCache = { ids: new Set((await listAdmins()).map((a) => Number(a.telegram_id))), at: Date.now() };
    } catch (e) {
      logger.warn({ err: errMessage(e) }, 'Adminlar ro\'yxatini o\'qib bo\'lmadi');
      return false;
    }
  }
  return adminCache.ids.has(id);
}

export async function upsertAdmin(row: {
  telegram_id: number;
  username: string | null;
  phone: string | null;
  added_by: number;
}): Promise<void> {
  const { error } = await supabase.from('admins').upsert(row);
  if (error) throw new Error(`Admin qo'shishda xato: ${error.message}`);
  adminCache = null;
}

export async function removeAdmin(telegramId: number): Promise<void> {
  const { error } = await supabase.from('admins').delete().eq('telegram_id', telegramId);
  if (error) throw new Error(`Adminni o'chirishda xato: ${error.message}`);
  adminCache = null;
}

// ---------------------------------------------------------------------------
// Majburiy kanallar
// ---------------------------------------------------------------------------

export interface ChannelRow {
  chat_id: number;
  title: string;
  username: string | null;
  invite_link: string | null;
}

const CHANNEL_CACHE_MS = 60_000;
let channelCache: { rows: ChannelRow[]; at: number } | null = null;

export async function listChannels(): Promise<ChannelRow[]> {
  if (!ready) return [];
  if (channelCache && Date.now() - channelCache.at < CHANNEL_CACHE_MS) return channelCache.rows;
  const { data, error } = await supabase
    .from('required_channels')
    .select('chat_id, title, username, invite_link')
    .order('created_at');
  if (error) throw new Error(`required_channels o'qishda xato: ${error.message}`);
  channelCache = { rows: (data ?? []) as ChannelRow[], at: Date.now() };
  return channelCache.rows;
}

export async function addChannel(row: ChannelRow & { added_by: number }): Promise<void> {
  const { error } = await supabase.from('required_channels').upsert(row);
  if (error) throw new Error(`Kanal qo'shishda xato: ${error.message}`);
  channelCache = null;
}

export async function removeChannel(chatId: number): Promise<void> {
  const { error } = await supabase.from('required_channels').delete().eq('chat_id', chatId);
  if (error) throw new Error(`Kanalni o'chirishda xato: ${error.message}`);
  channelCache = null;
}

// ---------------------------------------------------------------------------
// Foydalanuvchilar
// ---------------------------------------------------------------------------

export type AdminUserRow = UserRow & {
  last_active_at: string | null;
  blocked_at: string | null;
  banned_at: string | null;
};

/**
 * Tarqatish uchun — bloklamagan va ban qilinmagan barcha foydalanuvchilar.
 * Sahifalash `id` kursori bilan (offset emas): tarqatish paytida kimdir
 * "bloklagan" deb belgilanib ro'yxatdan chiqsa, offset siljib, keyingi
 * foydalanuvchilar o'tkazib yuborilardi.
 */
export async function* allRecipientIds(pageSize = 1000): AsyncGenerator<number> {
  let lastId = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('users')
      .select('id, telegram_id')
      .is('blocked_at', null)
      .is('banned_at', null)
      .gt('id', lastId)
      .order('id')
      .limit(pageSize);
    if (error) throw new Error(`users o'qishda xato: ${error.message}`);
    for (const r of data ?? []) yield Number(r.telegram_id);
    if (!data || data.length < pageSize) return;
    lastId = Number(data[data.length - 1]!.id);
  }
}

export async function countRecipients(): Promise<number> {
  const { count, error } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true })
    .is('blocked_at', null)
    .is('banned_at', null);
  if (error) throw new Error(`users sanashda xato: ${error.message}`);
  return count ?? 0;
}

/** Botni bloklagan (403) / qayta ochgan. */
export async function setBlocked(telegramId: number, blocked: boolean): Promise<void> {
  if (!ready) return;
  const { error } = await supabase
    .from('users')
    .update({ blocked_at: blocked ? new Date().toISOString() : null })
    .eq('telegram_id', telegramId);
  if (error) logger.debug({ err: error.message, telegramId }, 'blocked_at yozilmadi');
}

export async function setBanned(telegramId: number, banned: boolean): Promise<void> {
  const { error } = await supabase
    .from('users')
    .update({ banned_at: banned ? new Date().toISOString() : null })
    .eq('telegram_id', telegramId);
  if (error) throw new Error(`Ban holatini yozishda xato: ${error.message}`);
  bannedCache.delete(telegramId);
}

/** id yoki @username bo'yicha. */
export async function findUser(query: string): Promise<AdminUserRow | null> {
  const q = query.trim().replace(/^@/, '');
  const base = supabase.from('users').select('*');
  const { data, error } = /^\d+$/.test(q)
    ? await base.eq('telegram_id', Number(q)).maybeSingle()
    : // `_` va `%` ilike'da maxsus belgi — username'da `_` ko'p uchraydi
      await base.ilike('telegram_username', q.replace(/[\\%_]/g, '\\$&')).limit(1).maybeSingle();
  if (error) throw new Error(`Foydalanuvchini qidirishda xato: ${error.message}`);
  return (data as AdminUserRow | null) ?? null;
}

export async function countUserRequests(userId: number): Promise<number> {
  const { count, error } = await supabase
    .from('requests')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (error) return 0;
  return count ?? 0;
}

// Ban holati — har bir xabarda bazaga bormaslik uchun kesh (1 daqiqa)
const bannedCache = new Map<number, { banned: boolean; at: number }>();

export async function isBanned(telegramId: number): Promise<boolean> {
  if (!ready) return false;
  const hit = bannedCache.get(telegramId);
  if (hit && Date.now() - hit.at < 60_000) return hit.banned;
  const { data } = await supabase.from('users').select('banned_at').eq('telegram_id', telegramId).maybeSingle();
  const banned = Boolean(data?.banned_at);
  bannedCache.set(telegramId, { banned, at: Date.now() });
  if (bannedCache.size > 20_000) bannedCache.clear();
  return banned;
}

// Oxirgi faollik — har xabarda emas, foydalanuvchi boshiga 15 daqiqada bir yoziladi
const lastTouch = new Map<number, number>();
const TOUCH_EVERY_MS = 15 * 60_000;

export function touchActive(telegramId: number): void {
  if (!ready) return;
  const now = Date.now();
  if (now - (lastTouch.get(telegramId) ?? 0) < TOUCH_EVERY_MS) return;
  lastTouch.set(telegramId, now);
  if (lastTouch.size > 50_000) lastTouch.clear();
  void supabase
    .from('users')
    .update({ last_active_at: new Date(now).toISOString(), blocked_at: null })
    .eq('telegram_id', telegramId)
    .then(({ error }) => {
      if (error) logger.debug({ err: error.message }, 'last_active_at yozilmadi');
    });
}

// ---------------------------------------------------------------------------
// Statistika
// ---------------------------------------------------------------------------

export interface AdminStats {
  total: number;
  linked: number;
  blocked: number;
  banned: number;
  new_day: number;
  new_week: number;
  new_month: number;
  new_year: number;
  active_day: number;
  active_week: number;
  active_month: number;
  active_year: number;
  req_day: number;
  req_week: number;
  req_month: number;
  failed_day: number;
  queued: number;
}

export async function adminStats(): Promise<AdminStats> {
  const { data, error } = await supabase.rpc('admin_stats');
  if (error) throw new Error(`admin_stats xatosi: ${error.message}`);
  return data as AdminStats;
}
