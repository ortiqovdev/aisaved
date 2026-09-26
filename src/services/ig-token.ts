import { createHash } from 'node:crypto';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { errMessage, fetchWithTimeout } from '../lib/errors.ts';
import { getKv, setKv } from '../db/kv.repo.ts';
import { alertAdminLater } from './alerts.ts';

/**
 * Instagram access token — avtomatik yangilanadi.
 *
 * Uzoq muddatli token ~60 kun amal qiladi; muddati o'tsa bot Instagram'da
 * butunlay jim qoladi (DM, profil, reaksiya — hammasi 190 xatosi). Instagram
 * uni `refresh_access_token` bilan yangilashga ruxsat beradi (token kamida
 * 24 soat eski bo'lishi kerak). Bot kuniga bir tekshiradi va 7 kunda bir
 * yangilaydi — 60 kunlik muddatga katta zaxira.
 *
 * Yangi token Render env'iga yozib bo'lmaydi — Supabase'da (0008 `app_kv`)
 * saqlanadi. Admin env'dagi tokenni qo'lda almashtirsa (fingerprint o'zgaradi),
 * bazadagi eski token e'tiborsiz qoldiriladi.
 */
const KV_KEY = 'ig_token';
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const FIRST_CHECK_DELAY_MS = 2 * 60_000;
const REFRESH_EVERY_MS = 7 * 24 * 60 * 60_000;

interface StoredToken {
  token: string;
  /** env'dagi tokenning qisqa xeshi — admin uni almashtirganini sezish uchun. */
  envFingerprint: string;
  refreshedAt: string;
  expiresAt: string | null;
}

const fingerprint = (token: string): string => createHash('sha256').update(token).digest('hex').slice(0, 16);
const ENV_FP = fingerprint(env.IG_ACCESS_TOKEN);

let current = env.IG_ACCESS_TOKEN;

/** Instagram API chaqiruvlari uchun amaldagi token. */
export const igAccessToken = (): string => current;

/** Faqat Instagram Login tokenlari shu endpoint bilan yangilanadi (Facebook Page tokenlari emas). */
const refreshSupported = (): boolean =>
  !env.MOCK_INSTAGRAM && /graph\.instagram\.com/.test(env.IG_GRAPH_BASE_URL);

/** Ishga tushishda: bazada yangilangan token bo'lsa — o'shani ishlatamiz. */
export async function initIgToken(): Promise<void> {
  try {
    const stored = await getKv<StoredToken>(KV_KEY);
    if (stored && stored.envFingerprint === ENV_FP && stored.token) {
      current = stored.token;
      logger.info({ refreshedAt: stored.refreshedAt, expiresAt: stored.expiresAt }, 'Instagram token bazadan olindi (avtomatik yangilangan)');
    } else if (stored) {
      logger.info('Env\'dagi Instagram token almashtirilgan — bazadagi eski token e\'tiborsiz qoldirildi');
    }
  } catch (e) {
    logger.warn({ err: errMessage(e) }, 'Saqlangan Instagram tokenni o\'qib bo\'lmadi — env\'dagisi ishlatiladi');
  }
}

async function refreshIfDue(): Promise<void> {
  const stored = await getKv<StoredToken>(KV_KEY).catch(() => null);
  const last = stored && stored.envFingerprint === ENV_FP ? Date.parse(stored.refreshedAt) : NaN;
  if (Number.isFinite(last) && Date.now() - last < REFRESH_EVERY_MS) return;

  const url = `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(current)}`;
  let body = '';
  try {
    const res = await fetchWithTimeout(url, {}, 20_000);
    body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
    const j = JSON.parse(body) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new Error(`javobda access_token yo'q: ${body.slice(0, 200)}`);

    current = j.access_token;
    const expiresAt = j.expires_in ? new Date(Date.now() + j.expires_in * 1000).toISOString() : null;
    await setKv(KV_KEY, {
      token: current,
      envFingerprint: ENV_FP,
      refreshedAt: new Date().toISOString(),
      expiresAt,
    } satisfies StoredToken);
    logger.info({ expiresAt }, 'Instagram token yangilandi');
  } catch (e) {
    logger.error({ err: errMessage(e) }, 'Instagram tokenni yangilab bo\'lmadi');
    alertAdminLater('ig-token-refresh', '⚠️ Instagram token yangilanmadi', [
      errMessage(e).slice(0, 300),
      'Token muddati tugasa bot Instagram\'da ishlamay qoladi.',
      'Meta Developer → Instagram → API setup → Generate token → yangisini Render → Environment → IG_ACCESS_TOKEN ga yozing.',
    ]);
  }
}

/** 2 daqiqadan keyin, so'ng har 24 soatda tekshiradi (7 kunda bir yangilaydi). */
export function startIgTokenRefresh(): void {
  if (!refreshSupported()) return;
  const tick = (): void => {
    void refreshIfDue().catch((e: unknown) => logger.warn({ err: errMessage(e) }, 'Token tekshiruvida kutilmagan xato'));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, CHECK_INTERVAL_MS).unref();
  }, FIRST_CHECK_DELAY_MS).unref();
}

/**
 * Instagram API javobida token xatosi (190 — muddati o'tgan / bekor qilingan)
 * bo'lsa — admin'ga darhol xabar.
 */
export function reportIfTokenError(status: number, body: string): void {
  if (status !== 400 && status !== 401 && status !== 403) return;
  if (!/"code"\s*:\s*190\b/.test(body)) return;
  alertAdminLater('ig-token-invalid', '🔴 Instagram token yaroqsiz (190)', [
    'Bot Instagram\'ga xabar yubora olmayapti.',
    'Meta Developer → Instagram → API setup → Generate token → Render → Environment → IG_ACCESS_TOKEN.',
    body.slice(0, 200),
  ]);
}
