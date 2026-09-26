import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { trySendText } from '../bot/notify.ts';
import { escapeHtml } from '../bot/messages.ts';

/**
 * Admin'ga (ADMIN_TELEGRAM_IDS) Telegram orqali ogohlantirish.
 *
 * Bitta turdagi xabar (`key`) sukut bo'yicha soatiga ko'pi bilan bir marta —
 * masalan cookies eskirsa, har bir reels uchun alohida xabar kelmasin.
 * Xotirada: server qayta ishga tushsa hisob boshidan boshlanadi.
 */
const lastSent = new Map<string, number>();
const DEFAULT_THROTTLE_MS = 60 * 60_000;

export interface AlertOptions {
  /** Shu vaqt ichida bir xil `key` qayta yuborilmaydi. 0 — har safar. */
  throttleMs?: number;
}

/**
 * @param key   ogohlantirish turi (throttle uchun)
 * @param title qisqa sarlavha (oddiy matn)
 * @param lines tafsilotlar (oddiy matn — HTML'dan himoyalanadi)
 */
export async function alertAdmin(
  key: string,
  title: string,
  lines: string[] = [],
  { throttleMs = DEFAULT_THROTTLE_MS }: AlertOptions = {},
): Promise<void> {
  const now = Date.now();
  if (throttleMs > 0 && now - (lastSent.get(key) ?? 0) < throttleMs) return;
  lastSent.set(key, now);

  logger.warn({ alert: key, title, lines }, 'Admin ogohlantirishi');
  if (env.ADMIN_TELEGRAM_IDS.length === 0) return;

  const text = [`<b>${escapeHtml(title)}</b>`, ...lines.map((l) => escapeHtml(l))].join('\n');
  await Promise.all(env.ADMIN_TELEGRAM_IDS.map((id) => trySendText(id, text)));
}

/** Kutmasdan yuborish — chaqiruvchi oqimni to'xtatmasin. */
export function alertAdminLater(key: string, title: string, lines: string[] = [], opts?: AlertOptions): void {
  void alertAdmin(key, title, lines, opts).catch((e: unknown) =>
    logger.warn({ err: String(e), alert: key }, 'Admin ogohlantirishi yuborilmadi'),
  );
}
