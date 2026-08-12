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
  logger.info('Supabase ulanishi OK');
}
