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
}
