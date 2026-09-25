import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';

/**
 * service_role kaliti bilan ishlaydigan klient — RLS'ni chetlab o'tadi.
 * Faqat backend ichida ishlatiladi, hech qachon tashqariga chiqmasligi kerak.
 */
export const supabase: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application-name': 'instareel-to-telegram' } },
  },
);

/**
 * 0002 migratsiyasi qo'llanganmi?
 *
 * Migratsiyalar Supabase panelida QO'LDA ishga tushiriladi, shuning uchun kod
 * hali qo'llanmagan bazada ham ishlashi kerak. Ishga tushishda ustunlar
 * mavjudligini tekshirib qo'yamiz va yo'q bo'lsa tegishli funksiyalarni
 * o'chiramiz (bot ishlashda davom etadi, faqat kesh/dedup ishlamaydi).
 */
let migration0002Applied = false;

export const hasMigration0002 = (): boolean => migration0002Applied;

/** 0003: `users.language` ustuni bormi. */
let migration0003Applied = false;

export const hasMigration0003 = (): boolean => migration0003Applied;

/** 0004: `requests.status_message_id` ustuni bormi. */
let migration0004Applied = false;

export const hasMigration0004 = (): boolean => migration0004Applied;

/** Ishga tushishda ulanishni tekshiradi — sxema yo'q bo'lsa darhol bilamiz. */
export async function assertDbReady(): Promise<void> {
  const { error } = await supabase.from('users').select('id').limit(1);
  if (error) {
    logger.error({ err: error }, 'Supabase ulanishida xato');
    throw new Error(
      `Supabase'ga ulanib bo'lmadi yoki 'users' jadvali yo'q: ${error.message}. ` +
        `supabase/migrations/0001_init.sql faylini SQL Editor'da ishga tushiring.`,
    );
  }

  const probe = await supabase.from('requests').select('sent_at, file_unique_id').limit(1);
  migration0002Applied = probe.error === null;

  if (migration0002Applied) {
    logger.info('Supabase ulanishi OK (0002 migratsiyasi qo\'llangan)');
  } else {
    logger.warn(
      { err: probe.error?.message },
      '⚠️  0002 migratsiyasi QO\'LLANMAGAN — natija keshi va takror-yuborish himoyasi ' +
        'o\'chirilgan. Yoqish uchun supabase/migrations/0002_fixes.sql faylini ' +
        'Supabase SQL Editor\'da ishga tushiring.',
    );
  }

  const statusProbe = await supabase.from('requests').select('status_message_id').limit(1);
  migration0004Applied = statusProbe.error === null;
  if (!migration0004Applied) {
    logger.warn(
      { err: statusProbe.error?.message },
      '⚠️  0004 migratsiyasi QO\'LLANMAGAN — "qabul qilindi" xabari faqat xotirada ' +
        'kuzatiladi. supabase/migrations/0004_status_message.sql ni SQL Editor\'da ishga tushiring.',
    );
  }

  const langProbe = await supabase.from('users').select('language').limit(1);
  migration0003Applied = langProbe.error === null;

  if (!migration0003Applied) {
    logger.warn(
      { err: langProbe.error?.message },
      '⚠️  0003 migratsiyasi QO\'LLANMAGAN — tanlangan til faqat xotirada saqlanadi ' +
        '(qayta ishga tushganda yo\'qoladi). Yoqish uchun ' +
        'supabase/migrations/0003_user_language.sql faylini SQL Editor\'da ishga tushiring.',
    );
  }
}
