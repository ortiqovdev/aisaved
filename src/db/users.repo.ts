import { randomInt } from 'node:crypto';
import { hasMigration0003, supabase } from './supabase.ts';
import type { UserRow } from './types.ts';
import { logger } from '../lib/logger.ts';
import type { Lang } from '../i18n/index.ts';

/** Chalkashmaydigan alifbo: 0/O, 1/I/L yo'q. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;
export const LINK_CODE_PREFIX = 'LINK-';

function generateCodeBody(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET.charAt(randomInt(CODE_ALPHABET.length));
  }
  return out;
}

/** Foydalanuvchi yozadigan matndan kodni normallashtiradi: " link-ab12cd " -> "LINK-AB12CD" */
export function normalizeLinkCode(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase().replace(/\s+/g, '');
  const body = cleaned.match(/^LINK-?([A-Z0-9]{6})$/)?.[1];
  if (!body) return null;
  return `${LINK_CODE_PREFIX}${body}`;
}

async function isCodeTaken(code: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('users')
    .select('id')
    .eq('link_code', code)
    .maybeSingle();
  if (error) throw new Error(`link_code tekshirishda xato: ${error.message}`);
  return data !== null;
}

/** Bazada band bo'lmagan noyob kod yaratadi. */
export async function generateUniqueLinkCode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = `${LINK_CODE_PREFIX}${generateCodeBody()}`;
    if (!(await isCodeTaken(code))) return code;
    logger.warn({ code }, 'link_code to\'qnashdi, qaytadan generatsiya qilinmoqda');
  }
  throw new Error("Noyob link_code yaratib bo'lmadi (10 urinishdan keyin)");
}

export async function findByTelegramId(telegramId: number): Promise<UserRow | null> {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle<UserRow>();
  if (error) throw new Error(`Userni telegram_id bo'yicha topishda xato: ${error.message}`);
  return data;
}

export async function findByIgScopedId(igsid: string): Promise<UserRow | null> {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('ig_scoped_id', igsid)
    .maybeSingle<UserRow>();
  if (error) throw new Error(`Userni IGSID bo'yicha topishda xato: ${error.message}`);
  return data;
}

export async function findByLinkCode(code: string): Promise<UserRow | null> {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('link_code', code)
    .maybeSingle<UserRow>();
  if (error) throw new Error(`Userni link_code bo'yicha topishda xato: ${error.message}`);
  return data;
}

export async function findById(id: number): Promise<UserRow | null> {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', id)
    .maybeSingle<UserRow>();
  if (error) throw new Error(`Userni id bo'yicha topishda xato: ${error.message}`);
  return data;
}

// ---------------------------------------------------------------------------
// Xotiradagi kesh
//
// Supabase'gacha bitta so'rov ~0.5 s — har bir havola/video uchun userni
// qayta o'qish foydalanuvchi javobini sezilarli sekinlashtirardi.
//   - telegram_id → id: hech qachon o'zgarmaydi, muddatsiz saqlanadi
//   - butun qator: 5 daqiqa; shu moduldagi har bir yozuvda yangilanadi.
//     Alohida worker jarayonida (npm run worker) o'zgarish ko'pi bilan
//     5 daqiqa kechikib ko'rinadi (til, Instagram bog'lanishi).
// ---------------------------------------------------------------------------

const USER_TTL_MS = 5 * 60_000;
const idByTelegram = new Map<number, number>();
const rowById = new Map<number, { row: UserRow; at: number }>();

const idByIgsid = new Map<string, number>();

function remember(row: UserRow): UserRow {
  idByTelegram.set(row.telegram_id, row.id);
  if (row.ig_scoped_id) idByIgsid.set(row.ig_scoped_id, row.id);
  rowById.set(row.id, { row, at: Date.now() });
  return row;
}

function forget(id: number | undefined): void {
  if (id !== undefined) rowById.delete(id);
}

/**
 * Instagram webhook'i uchun: userni IGSID bo'yicha, keshdan (5 daqiqa).
 * Keshdagi qator IGSID'ga hali ham mos kelishi tekshiriladi — bog'lanish
 * uzilgan/boshqaga o'tgan bo'lsa (remember() qatorni yangilaydi) bazadan o'qiladi.
 */
export async function findByIgScopedIdCached(igsid: string): Promise<UserRow | null> {
  const id = idByIgsid.get(igsid);
  const hit = id !== undefined ? rowById.get(id) : undefined;
  if (hit && hit.row.ig_scoped_id === igsid && Date.now() - hit.at < USER_TTL_MS) return hit.row;
  const row = await findByIgScopedId(igsid);
  return row ? remember(row) : null;
}

/** Worker uchun: userni id bo'yicha, keshdan (5 daqiqa). */
export async function findByIdCached(id: number): Promise<UserRow | null> {
  const hit = rowById.get(id);
  if (hit && Date.now() - hit.at < USER_TTL_MS) return hit.row;
  const row = await findById(id);
  return row ? remember(row) : null;
}

/**
 * Tezkor yo'l uchun faqat user id: keshda bo'lsa bazaga umuman bormaydi,
 * bo'lmasa userni topadi yoki yaratadi.
 */
export async function userIdFor(input: UpsertInput): Promise<number> {
  return idByTelegram.get(input.telegramId) ?? (await getOrCreateByTelegramId(input)).id;
}

interface UpsertInput {
  telegramId: number;
  username?: string | undefined;
  firstName?: string | undefined;
  /** Yangi user yaratilganda yoziladigan til. */
  language?: Lang | undefined;
}

/**
 * /start uchun: user bo'lsa qaytaradi (profil ma'lumotlarini yangilab),
 * bo'lmasa yangi yozuv + yangi link_code yaratadi.
 */
export async function getOrCreateByTelegramId(input: UpsertInput): Promise<UserRow> {
  const existing = await findByTelegramId(input.telegramId);

  if (existing) {
    const needsUpdate =
      existing.telegram_username !== (input.username ?? null) ||
      existing.telegram_first_name !== (input.firstName ?? null);

    if (needsUpdate) {
      const { data, error } = await supabase
        .from('users')
        .update({
          telegram_username: input.username ?? null,
          telegram_first_name: input.firstName ?? null,
        })
        .eq('id', existing.id)
        .select('*')
        .single<UserRow>();
      if (error) throw new Error(`User profilini yangilashda xato: ${error.message}`);
      return remember(data);
    }

    // Bog'lanmagan userda kod yo'qolib qolgan bo'lsa — yangisini beramiz
    if (existing.link_status === 'pending' && !existing.link_code) {
      return ensureLinkCode(existing.id);
    }
    return remember(existing);
  }

  const linkCode = await generateUniqueLinkCode();
  const { data, error } = await supabase
    .from('users')
    .insert({
      telegram_id: input.telegramId,
      telegram_username: input.username ?? null,
      telegram_first_name: input.firstName ?? null,
      link_code: linkCode,
      link_status: 'pending',
      ...(hasMigration0003() && input.language ? { language: input.language } : {}),
    })
    .select('*')
    .single<UserRow>();

  if (error) {
    // Parallel /start bosilgan bo'lsa (unique violation) — mavjudini qaytaramiz
    if (error.code === '23505') {
      const again = await findByTelegramId(input.telegramId);
      if (again) return remember(again);
    }
    throw new Error(`User yaratishda xato: ${error.message}`);
  }
  return remember(data);
}

export async function ensureLinkCode(userId: number): Promise<UserRow> {
  const code = await generateUniqueLinkCode();
  const { data, error } = await supabase
    .from('users')
    .update({ link_code: code })
    .eq('id', userId)
    .select('*')
    .single<UserRow>();
  if (error) throw new Error(`link_code yozishda xato: ${error.message}`);
  return remember(data);
}

/**
 * Bog'lashni yakunlaydi: IGSID biriktiriladi, kod ishlatib bo'lingani uchun tozalanadi.
 * @returns bog'langan user yoki null (kod egasi topilmasa / IGSID band bo'lsa)
 */
export async function linkUserByCode(code: string, igScopedId: string): Promise<UserRow | null> {
  const user = await findByLinkCode(code);
  if (!user) return null;
  return linkUserToIg(user.id, igScopedId);
}

/**
 * Telegram foydalanuvchisiga IGSID'ni biriktiradi (kod yoki bir martalik
 * havola orqali). Kod tozalanadi — endi kerak emas.
 */
export async function linkUserToIg(userId: number, igScopedId: string): Promise<UserRow> {
  // Shu IGSID boshqa akkauntga bog'langan bo'lsa — avval uni uzamiz
  const occupied = await findByIgScopedId(igScopedId);
  if (occupied && occupied.id !== userId) {
    logger.warn(
      { igScopedId, oldUserId: occupied.id, newUserId: userId },
      'IGSID boshqa userga bog\'langan edi — ko\'chirilmoqda',
    );
    const { error: unlinkErr } = await supabase
      .from('users')
      .update({ ig_scoped_id: null, link_status: 'pending', linked_at: null })
      .eq('id', occupied.id);
    if (unlinkErr) throw new Error(`Eski bog'lanishni uzishda xato: ${unlinkErr.message}`);
    forget(occupied.id);
  }

  const { data, error } = await supabase
    .from('users')
    .update({
      ig_scoped_id: igScopedId,
      link_status: 'linked',
      linked_at: new Date().toISOString(),
      link_code: null,
    })
    .eq('id', userId)
    .select('*')
    .single<UserRow>();

  if (error) throw new Error(`Bog'lashda xato: ${error.message}`);
  return remember(data);
}

/**
 * Foydalanuvchi tilini saqlaydi.
 * @returns false — 0003 migratsiyasi qo'llanmagan (ustun yo'q)
 */
export async function setLanguage(telegramId: number, lang: Lang): Promise<boolean> {
  if (!hasMigration0003()) return false;
  const { error } = await supabase
    .from('users')
    .update({ language: lang })
    .eq('telegram_id', telegramId);
  if (error) throw new Error(`Tilni saqlashda xato: ${error.message}`);
  forget(idByTelegram.get(telegramId));
  return true;
}

/** /unlink — IGSID tozalanadi va yangi kod beriladi. */
export async function unlinkUser(userId: number): Promise<UserRow> {
  const code = await generateUniqueLinkCode();
  const { data, error } = await supabase
    .from('users')
    .update({
      ig_scoped_id: null,
      link_status: 'pending',
      linked_at: null,
      link_code: code,
    })
    .eq('id', userId)
    .select('*')
    .single<UserRow>();
  if (error) throw new Error(`Bog'lanishni uzishda xato: ${error.message}`);
  return remember(data);
}
