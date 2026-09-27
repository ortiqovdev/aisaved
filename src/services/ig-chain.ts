import { logger } from '../lib/logger.ts';
import { BlockedError, PermanentError, TransientError, errMessage } from '../lib/errors.ts';

/**
 * Bir nechta yo'l bilan bitta natijani olish — birinchisi ishlamasa keyingisi.
 *
 * Nega kerak: Instagram reels'ini olishning har bir yo'li (tashqi API, yt-dlp
 * cookies bilan, yt-dlp login'siz) alohida-alohida bloklanishi mumkin. Ilgari
 * faqat bitta yo'l bor edi va u bloklansa — foydalanuvchi darhol xato olardi.
 *
 * Qoidalar:
 *   - BlockedError   → yo'l SOVUTILADI (COOLDOWN_MS davomida chaqirilmaydi —
 *                      bloklangan manbaga urilaverish blokni uzaytiradi), keyingisi
 *   - TransientError → keyingi yo'l (tarmoq, 5xx)
 *   - boshqa xato    → zanjir to'xtaydi: post o'zi yaroqsiz (yopiq, video yo'q,
 *                      juda uzun) — boshqa yo'l ham shuni aytadi
 * Hammasi bloklangan bo'lsa — BlockedError: job eng yaqin sovish tugagach
 * qayta urinadi.
 */

export interface Strategy<T> {
  name: string;
  run: () => Promise<T>;
}

export const COOLDOWN_MS = 10 * 60_000;
/** Hammasi bloklanganda qayta urinish: eng yaqin sovish tugashi, lekin shu oraliqda. */
const MIN_RETRY_MS = 2 * 60_000;
const MAX_RETRY_MS = COOLDOWN_MS;

export class Chain {
  /** yo'l nomi → shu vaqtgacha (ms) chaqirilmaydi */
  private readonly coolUntil = new Map<string, number>();
  private readonly label: string;
  private readonly now: () => number;

  constructor(label: string, now: () => number = Date.now) {
    this.label = label;
    this.now = now;
  }

  /** Admin panel / monitoring uchun: hozir sovitilayotgan yo'llar. */
  cooling(): Array<{ name: string; msLeft: number }> {
    const t = this.now();
    return [...this.coolUntil]
      .filter(([, until]) => until > t)
      .map(([name, until]) => ({ name, msLeft: until - t }));
  }

  async run<T>(strategies: Array<Strategy<T>>): Promise<T> {
    if (strategies.length === 0) {
      throw new PermanentError(`${this.label}: birorta ham yo'l sozlanmagan`);
    }
    const t = this.now();
    const ready = strategies.filter((s) => (this.coolUntil.get(s.name) ?? 0) <= t);
    let lastTransient: TransientError | null = null;

    for (const s of ready) {
      try {
        const result = await s.run();
        this.coolUntil.delete(s.name);
        return result;
      } catch (e) {
        if (e instanceof BlockedError) {
          this.coolUntil.set(s.name, this.now() + COOLDOWN_MS);
          logger.warn({ chain: this.label, strategy: s.name, err: errMessage(e) }, 'Yo\'l bloklandi — sovitiladi, keyingisi');
          continue;
        }
        if (e instanceof TransientError) {
          lastTransient = e;
          logger.warn({ chain: this.label, strategy: s.name, err: errMessage(e) }, 'Yo\'l vaqtincha ishlamadi — keyingisi');
          continue;
        }
        throw e;
      }
    }

    // Kamida bittasi bloklanmagan-u, vaqtincha yiqilgan — oddiy qayta urinish
    if (lastTransient) throw lastTransient;

    const now = this.now();
    const soonest = Math.min(...strategies.map((s) => this.coolUntil.get(s.name) ?? now));
    const retryIn = Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, soonest - now));
    throw new BlockedError(
      `${this.label}: barcha yo'llar bloklangan (${strategies.map((s) => s.name).join(', ')})`,
      retryIn,
    );
  }
}
