import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/** "true" / "1" / "yes" ni boolean'ga aylantiradi. */
const boolish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return def;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(20, 'TELEGRAM_BOT_TOKEN yaroqsiz'),

  /**
   * Mock rejim. `MOCK_MODE` — umumiy kalit; `MOCK_INSTAGRAM` va `MOCK_AUDD`
   * bilan har birini alohida boshqarish mumkin (masalan AudD haqiqiy,
   * Instagram esa hali mock). Telegram HAR DOIM haqiqiy.
   * Ishlab chiqarishda hammasi false bo'lishi kerak.
   */
  MOCK_MODE: boolish(false),
  MOCK_INSTAGRAM: boolish(false),
  MOCK_AUDD: boolish(false),
  MOCK_SAMPLE_VIDEO_URL: z
    .string()
    .url()
    .default('https://www.w3schools.com/html/mov_bbb.mp4'),

  // Instagram / Meta
  IG_ACCOUNT_USERNAME: z.string().min(1).transform((v) => v.replace(/^@/, '')),
  IG_APP_SECRET: z.string().min(1),
  IG_ACCESS_TOKEN: z.string().min(1),
  IG_WEBHOOK_VERIFY_TOKEN: z.string().min(1),
  IG_GRAPH_BASE_URL: z
    .string()
    .url()
    .default('https://graph.instagram.com/v23.0')
    .transform((v) => v.replace(/\/+$/, '')),

  /**
   * Instagram HAVOLASIDAN video faylini topib beruvchi tashqi xizmat.
   *
   * Meta rasmiy API orqali boshqa odamning reels faylini bermaydi, shuning
   * uchun havola oqimi shu endpointga tayanadi. Bo'sh bo'lsa — havola qabul
   * qilinadi, lekin foydalanuvchiga "hozircha yoqilmagan" deb javob beriladi.
   *
   * `{url}` shabloni haqiqiy havola bilan almashtiriladi; shablon bo'lmasa
   * havola `?url=` parametri sifatida qo'shiladi.
   */
  IG_RESOLVER_URL: z.string().default(''),
  IG_RESOLVER_METHOD: z
    .string()
    .default('GET')
    .transform((v) => (v.trim().toUpperCase() === 'POST' ? 'POST' : 'GET')),
  /** Qo'shimcha sarlavhalar, JSON obyekt: {"x-api-key":"..."} */
  IG_RESOLVER_HEADERS: z.string().default(''),
  /** Javobdagi video havolasining yo'li, masalan `data.media.0.url`. Bo'sh bo'lsa avtomatik qidiriladi. */
  IG_RESOLVER_VIDEO_PATH: z.string().default(''),
  IG_RESOLVER_TITLE_PATH: z.string().default(''),
  IG_RESOLVER_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(45_000),

  // AudD.io
  AUDD_API_TOKEN: z.string().min(1),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  // Worker
  WORKER_ENABLED: boolish(true),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(500).default(3000),
  WORKER_STALE_LOCK_SECONDS: z.coerce.number().int().min(30).default(300),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  /**
   * Telegram sendVideo limiti aynan 50MB. Aynan 50MB fayl bizning
   * tekshiruvdan o'tib, Telegram'da rad etiladi — shuning uchun default
   * 48MB (xavfsizlik zaxirasi bilan).
   */
  MAX_VIDEO_BYTES: z.coerce.number().int().positive().default(48 * 1024 * 1024),
  /** Bitta foydalanuvchi navbatda ushlab turishi mumkin bo'lgan so'rovlar soni. */
  MAX_PENDING_PER_USER: z.coerce.number().int().min(1).max(50).default(3),
  /**
   * AudD'ga yuboriladigan audio parchaning uzunligi (sekund).
   * AudD hujjatlari 2–12 sekundni tavsiya qiladi; uzunroq parcha bilan
   * "barmoq izi yasab bo'lmadi" (300) xatosi ko'proq uchraydi.
   */
  AUDD_SNIPPET_SECONDS: z.coerce.number().int().min(3).max(20).default(12),
  /**
   * Birinchi parchada musiqa topilmasa, videoning boshqa joyidan olib
   * qayta urinish. Aniqlash sifatini sezilarli oshiradi, lekin AudD
   * so'rovlarini ko'paytiradi (limit tor bo'lsa false qiling).
   */
  AUDD_MULTI_PASS: boolish(true),
  /** Bir xil fayl qayta yuborilsa, avvalgi natijani qayta ishlatish. */
  RESULT_CACHE_ENABLED: boolish(true),
  TMP_DIR: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v : path.join(os.tmpdir(), 'instareel'))),
  USE_FFMPEG: boolish(true),
  FFMPEG_PATH: z.string().default('ffmpeg'),
});

/**
 * Mock rejimni hal qilish va hali olinmagan kalitlar o'rniga placeholder
 * qo'yish — shunda ilova ishga tushadi. Haqiqiy kalit kelgach mos
 * MOCK_* ni false qilasiz va sxema yana uni majburiy talab qiladi.
 */
const asBool = (v: string | undefined): boolean =>
  ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase());
const isSet = (name: string): boolean => (process.env[name] ?? '').trim() !== '';

const mockAll = asBool(process.env['MOCK_MODE']);
const mockInstagram = isSet('MOCK_INSTAGRAM') ? asBool(process.env['MOCK_INSTAGRAM']) : mockAll;
const mockAudd = isSet('MOCK_AUDD') ? asBool(process.env['MOCK_AUDD']) : mockAll;

// Hal qilingan qiymatlarni sxema ko'radigan holga keltiramiz
process.env['MOCK_INSTAGRAM'] = String(mockInstagram);
process.env['MOCK_AUDD'] = String(mockAudd);

if (mockInstagram) {
  for (const [key, value] of Object.entries({
    IG_APP_SECRET: 'mock-app-secret',
    IG_ACCESS_TOKEN: 'mock-access-token',
    IG_WEBHOOK_VERIFY_TOKEN: 'mock-verify-token',
  })) {
    if (!isSet(key)) process.env[key] = value;
  }
}
if (mockAudd && !isSet('AUDD_API_TOKEN')) {
  process.env['AUDD_API_TOKEN'] = 'mock-audd-token';
}

// Supabase paneli o'z snippetida `NEXT_PUBLIC_SUPABASE_URL` nomini beradi —
// shu nom bilan yozilgan bo'lsa ham qabul qilamiz.
if (!process.env['SUPABASE_URL'] && process.env['NEXT_PUBLIC_SUPABASE_URL']) {
  process.env['SUPABASE_URL'] = process.env['NEXT_PUBLIC_SUPABASE_URL'];
}

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // Logger hali tayyor emas — konfiguratsiya xatosi jarayonni to'xtatadi.
  console.error(`\n❌ .env fayl noto'g'ri yoki to'liq emas:\n${issues}\n`);
  console.error('   .env.example dan nusxa oling: cp .env.example .env\n');
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

export const isProd = env.NODE_ENV === 'production';
