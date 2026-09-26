import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import { supabase } from '../db/supabase.ts';
import { getKv, setKv } from '../db/kv.repo.ts';
import { alertAdmin } from './alerts.ts';
import { hasInstagramCookies, instagramCookieArgs } from './ig-cookies.ts';

/**
 * Monitoring — muammo bo'lsa admin Telegram'da darhol biladi (foydalanuvchi
 * shikoyatidan emas):
 *   - ishga tushish (versiya, cookies holati)
 *   - navbat tiqilib qoldi (job'lar 10 daqiqadan ko'p kutyapti)
 *   - xatolar ko'paydi (oxirgi 30 daqiqada yarmidan ko'pi xato)
 *   - har 500 foydalanuvchida hisobot (xarajat/limitlarni qayta ko'rish vaqti)
 *
 * Cookies, token, Shazam va Telegram polling xatolari — o'z joylarida
 * (alertAdminLater) yuboriladi.
 */
const CHECK_INTERVAL_MS = 5 * 60_000;
const MILESTONE_INTERVAL_MS = 60 * 60_000;
const STUCK_AFTER_MIN = 10;
const FAILURE_WINDOW_MIN = 30;
const MIN_FAILURES = 5;
export const USERS_MILESTONE_STEP = 500;

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

async function count(table: string, apply: (q: any) => any = (q) => q): Promise<number> {
  const { count: n, error } = await apply(supabase.from(table).select('*', { count: 'exact', head: true }));
  if (error) throw new Error(`${table} sanashda xato: ${error.message}`);
  return n ?? 0;
}

async function checkQueue(): Promise<void> {
  const stuckQueued = await count('requests', (q) =>
    q.eq('status', 'queued').lt('next_attempt_at', minutesAgo(STUCK_AFTER_MIN)),
  );
  const stuckProcessing = await count('requests', (q) =>
    q.eq('status', 'processing').lt('locked_at', minutesAgo(STUCK_AFTER_MIN + 5)),
  );
  if (stuckQueued + stuckProcessing > 0) {
    await alertAdmin('queue-stuck', '🟡 Navbat tiqilib qoldi', [
      `${STUCK_AFTER_MIN}+ daqiqa kutayotgan: ${stuckQueued}, osilib qolgan: ${stuckProcessing}.`,
      'Worker ishlamayotgan bo\'lishi mumkin — Render loglarini tekshiring.',
    ]);
  }
}

async function checkFailures(): Promise<void> {
  const { data, error } = await supabase
    .from('requests')
    .select('status, error_message')
    .gte('completed_at', minutesAgo(FAILURE_WINDOW_MIN))
    .in('status', ['done', 'failed']);
  if (error) throw new Error(`requests o'qishda xato: ${error.message}`);
  const rows = data ?? [];
  const failed = rows.filter((r) => r.status === 'failed');
  if (failed.length < MIN_FAILURES || failed.length / rows.length < 0.5) return;

  // Eng ko'p uchragan xato — sababni darhol ko'rish uchun
  const counts = new Map<string, number>();
  for (const r of failed) {
    const k = String(r.error_message ?? '').slice(0, 120);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const [topError, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  await alertAdmin('failures', '🔴 Xatolar ko\'paydi', [
    `Oxirgi ${FAILURE_WINDOW_MIN} daqiqada: ${failed.length} xato / ${rows.length} so'rov.`,
    `Eng ko'p (${topCount} marta): ${topError}`,
  ]);
}

/** Har 500 foydalanuvchida bir marta — umumiy holat hisoboti. */
async function checkUsersMilestone(): Promise<void> {
  const users = await count('users');
  const milestone = Math.floor(users / USERS_MILESTONE_STEP) * USERS_MILESTONE_STEP;
  if (milestone < USERS_MILESTONE_STEP) return;
  const last = (await getKv<number>('users_milestone')) ?? 0;
  if (milestone <= last) return;

  const since = minutesAgo(24 * 60);
  const [linked, day, dayFailed, requestsTotal] = await Promise.all([
    count('users', (q) => q.eq('link_status', 'linked')),
    count('requests', (q) => q.gte('created_at', since)),
    count('requests', (q) => q.gte('created_at', since).eq('status', 'failed')),
    count('requests'),
  ]);
  await alertAdmin(
    'users-milestone',
    `📈 ${milestone} foydalanuvchi!`,
    [
      `Jami: ${users}, Instagram bog'langan: ${linked}`,
      `Oxirgi 24 soat: ${day} so'rov, ${dayFailed} xato`,
      `requests jadvalida: ${requestsTotal} qator`,
      'Tekshirish vaqti: Supabase Usage (500 MB / 5 GB), Instagram cookies akkaunti limiti, Render resurslari.',
    ],
    { throttleMs: 0 },
  );
  await setKv('users_milestone', milestone);
}

/** Barcha davriy tekshiruvlarni bir marta — qo'lda tekshirish uchun. */
export async function runMonitoringChecks(): Promise<void> {
  await checkQueue();
  await checkFailures();
  await checkUsersMilestone();
}

function every(ms: number, name: string, fn: () => Promise<void>): void {
  setInterval(() => {
    void fn().catch((e: unknown) => logger.warn({ err: errMessage(e), check: name }, 'Monitoring tekshiruvi yiqildi'));
  }, ms).unref();
}

export function startMonitoring(): void {
  // Ishga tushish xabari — deploy yoki Render qayta ishga tushirganini ko'rish uchun
  setTimeout(() => {
    void (async () => {
      await instagramCookieArgs().catch(() => []);
      const commit = (process.env['RENDER_GIT_COMMIT'] ?? '').slice(0, 7) || 'lokal';
      await alertAdmin(
        'startup',
        '🟢 Bot ishga tushdi',
        [
          `Versiya: ${commit}`,
          `Instagram cookies: ${hasInstagramCookies() ? 'bor' : 'YO\'Q — reels yuklanmaydi'}`,
        ],
        { throttleMs: 0 },
      );
    })().catch((e: unknown) => logger.warn({ err: errMessage(e) }, 'Ishga tushish xabari yuborilmadi'));
  }, 30_000).unref();

  every(CHECK_INTERVAL_MS, 'queue', checkQueue);
  every(CHECK_INTERVAL_MS, 'failures', checkFailures);
  every(MILESTONE_INTERVAL_MS, 'milestone', checkUsersMilestone);
}
