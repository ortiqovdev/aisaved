import { logger } from '../lib/logger.ts';
import { supabase } from './supabase.ts';

/**
 * Ilova holati (0008 `app_kv`): kalit → JSON qiymat. Qo'llanmagan bazada —
 * xotirada (server qayta ishga tushsa yo'qoladi).
 */
const TABLE = 'app_kv';
let useMemory = false;
const memory = new Map<string, unknown>();

function isMissingTable(error: { code?: string; message: string }): boolean {
  return error.code === 'PGRST205' || error.code === '42P01' || /does not exist|could not find the table/i.test(error.message);
}

function switchToMemory(error: { message: string }): void {
  if (useMemory) return;
  useMemory = true;
  logger.warn(
    { err: error.message },
    '⚠️  0008 migratsiyasi QO\'LLANMAGAN — ilova holati xotirada (yangilangan Instagram token qayta ishga tushganda yo\'qoladi). ' +
      'supabase/migrations/0008_app_kv.sql ni SQL Editor\'da ishga tushiring.',
  );
}

export async function getKv<T>(key: string): Promise<T | null> {
  if (!useMemory) {
    const { data, error } = await supabase.from(TABLE).select('value').eq('key', key).maybeSingle<{ value: T }>();
    if (!error) return data?.value ?? null;
    if (!isMissingTable(error)) throw new Error(`${TABLE} o'qishda xato: ${error.message}`);
    switchToMemory(error);
  }
  return (memory.get(key) as T | undefined) ?? null;
}

export async function setKv(key: string, value: unknown): Promise<void> {
  if (!useMemory) {
    const { error } = await supabase
      .from(TABLE)
      .upsert({ key, value, updated_at: new Date().toISOString() });
    if (!error) return;
    if (!isMissingTable(error)) throw new Error(`${TABLE} yozishda xato: ${error.message}`);
    switchToMemory(error);
  }
  memory.set(key, value);
}
