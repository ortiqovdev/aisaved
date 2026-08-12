/**
 * Qayta urinib ko'rish MA'NOSIZ bo'lgan xatolar.
 * Worker bunday xatoda darhol `failed` qiladi (retry qilmaydi).
 * Masalan: media URL muddati o'tgan, fayl juda katta, user o'chirilgan.
 */
export class PermanentError extends Error {
  /** Foydalanuvchiga Telegram orqali ko'rsatiladigan matn (ixtiyoriy). */
  readonly userMessage: string | undefined;

  constructor(message: string, userMessage?: string) {
    super(message);
    this.name = 'PermanentError';
    this.userMessage = userMessage;
  }
}

/** Vaqtinchalik xato — retry qilinadi (tarmoq uzilishi, 5xx, 429). */
export class TransientError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'TransientError';
    this.retryAfterMs = retryAfterMs;
  }
}

export function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  return new Error(typeof e === 'string' ? e : JSON.stringify(e));
}

export function errMessage(e: unknown): string {
  return toError(e).message;
}

/** `AbortSignal.timeout` bilan fetch — tarmoq osilib qolmasligi uchun. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = toError(e);
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new TransientError(`So'rov ${timeoutMs}ms ichida javob bermadi: ${url}`);
    }
    throw new TransientError(`Tarmoq xatosi: ${err.message}`);
  }
}

/** Eksponensial backoff + jitter (ms). */
export function backoffMs(attempt: number, baseMs = 15_000, maxMs = 15 * 60_000): number {
  const exp = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
  const jitter = Math.floor(Math.random() * (exp * 0.2));
  return exp + jitter;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
