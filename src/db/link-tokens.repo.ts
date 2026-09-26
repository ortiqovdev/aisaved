import { randomBytes } from 'node:crypto';
import { logger } from '../lib/logger.ts';
import { supabase } from './supabase.ts';

/**
 * Bir martalik bog'lash kalitlari (0007): Instagram'dagi foydalanuvchi
 * t.me/<bot>?start=ig_<token> havolasini bosib, Telegram'ni kodsiz ulaydi.
 *
 * Xavfsizlik: kalit tasodifiy (128 bit), faqat o'sha IGSID'ning DM'iga
 * yuboriladi, 30 daqiqa amal qiladi va BIR MARTA ishlatiladi (iste'mol
 * qilish bitta atomik UPDATE — bir vaqtda ikki START bo'lsa ham bittasi o'tadi).
 *
 * 0007 qo'llanmagan bo'lsa — kalitlar xotirada (server qayta ishga tushsa
 * yo'qoladi; foydalanuvchi Instagram'da qayta yozib, yangisini oladi).
 */

/** Bog'lanishdan oldin yuborilgan media — bog'langach yetkaziladi. */
export interface PendingMedia {
  url: string;
  type: string;
  /** false — Instagram sahifa havolasi (resolver kerak), true — CDN fayl. */
  downloadable: boolean;
  /** Instagram xabar ID'si — dublikat va reaksiya uchun. */
  mid: string | null;
}

const TTL_MS = 30 * 60_000;
/** Bog'lanishgacha ko'pi bilan shuncha media saqlanadi (spam himoyasi). */
const MAX_PENDING = 5;
const TABLE = 'ig_link_tokens';

/** null — hali aniqlanmagan; true — jadval yo'q, xotiradan foydalanamiz. */
let useMemory: boolean | null = null;
const memory = new Map<string, { igsid: string; pending: PendingMedia[]; expiresAt: number; used: boolean }>();

const newToken = (): string => randomBytes(16).toString('base64url');

function isMissingTable(error: { code?: string; message: string }): boolean {
  return error.code === 'PGRST205' || error.code === '42P01' || /does not exist|could not find the table/i.test(error.message);
}

function switchToMemory(error: { message: string }): void {
  if (useMemory) return;
  useMemory = true;
  logger.warn(
    { err: error.message },
    '⚠️  0007 migratsiyasi QO\'LLANMAGAN — bog\'lash kalitlari xotirada (qayta ishga tushganda yo\'qoladi). ' +
      'supabase/migrations/0007_ig_link_tokens.sql ni SQL Editor\'da ishga tushiring.',
  );
}

/** Yangi media ro'yxatga qo'shiladi (mid bo'yicha dublikatsiz, ko'pi bilan MAX_PENDING). */
export function mergePending(a: PendingMedia[], b: PendingMedia[]): PendingMedia[] {
  const out = [...a];
  for (const m of b) {
    if (m.mid && out.some((x) => x.mid === m.mid)) continue;
    out.push(m);
  }
  return out.slice(-MAX_PENDING);
}

/**
 * IGSID uchun kalit beradi. Faol (ishlatilmagan, eskirmagan) kalit bo'lsa —
 * o'shani qaytaradi va yangi media'ni unga qo'shadi: foydalanuvchi ketma-ket
 * 3 ta reels tashlasa, 3 ta turli havola olmaydi.
 */
export async function issueLinkToken(
  igsid: string,
  media: PendingMedia[],
): Promise<{ token: string; reused: boolean }> {
  if (useMemory !== true) {
    const nowIso = new Date().toISOString();
    const active = await supabase
      .from(TABLE)
      .select('token, pending')
      .eq('ig_scoped_id', igsid)
      .is('used_at', null)
      .gt('expires_at', nowIso)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{ token: string; pending: PendingMedia[] }>();

    if (active.error && isMissingTable(active.error)) {
      switchToMemory(active.error);
    } else if (active.error) {
      throw new Error(`${TABLE} o'qishda xato: ${active.error.message}`);
    } else {
      useMemory = false;
      if (active.data) {
        if (media.length > 0) {
          const { error } = await supabase
            .from(TABLE)
            .update({ pending: mergePending(active.data.pending ?? [], media) })
            .eq('token', active.data.token);
          if (error) throw new Error(`${TABLE} yangilashda xato: ${error.message}`);
        }
        return { token: active.data.token, reused: true };
      }
      const token = newToken();
      const { error } = await supabase.from(TABLE).insert({
        token,
        ig_scoped_id: igsid,
        pending: mergePending([], media),
        expires_at: new Date(Date.now() + TTL_MS).toISOString(),
      });
      if (error) throw new Error(`${TABLE} yozishda xato: ${error.message}`);
      return { token, reused: false };
    }
  }

  // Xotira (0007 qo'llanmagan)
  const now = Date.now();
  for (const [token, t] of memory) {
    if (t.expiresAt < now) {
      memory.delete(token);
      continue;
    }
    if (t.igsid === igsid && !t.used) {
      t.pending = mergePending(t.pending, media);
      return { token, reused: true };
    }
  }
  const token = newToken();
  memory.set(token, { igsid, pending: mergePending([], media), expiresAt: now + TTL_MS, used: false });
  return { token, reused: false };
}

/**
 * Kalitni ishlatadi (bir marta).
 * @returns IGSID va kutib turgan media; null — kalit yo'q, eskirgan yoki ishlatilgan
 */
export async function consumeLinkToken(
  token: string,
): Promise<{ igScopedId: string; pending: PendingMedia[] } | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;

  if (useMemory !== true) {
    // Bitta atomik UPDATE: bir vaqtda ikki START bosilsa ham faqat bittasi o'tadi
    const { data, error } = await supabase
      .from(TABLE)
      .update({ used_at: new Date().toISOString() })
      .eq('token', token)
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString())
      .select('ig_scoped_id, pending')
      .maybeSingle<{ ig_scoped_id: string; pending: PendingMedia[] }>();
    if (error && isMissingTable(error)) {
      switchToMemory(error);
    } else if (error) {
      throw new Error(`${TABLE} iste'mol qilishda xato: ${error.message}`);
    } else {
      useMemory = false;
      return data ? { igScopedId: data.ig_scoped_id, pending: data.pending ?? [] } : null;
    }
  }

  const t = memory.get(token);
  if (!t || t.used || t.expiresAt < Date.now()) return null;
  t.used = true;
  return { igScopedId: t.igsid, pending: t.pending };
}
