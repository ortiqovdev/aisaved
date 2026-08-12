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
  MAX_VIDEO_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  TMP_DIR: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v : path.join(os.tmpdir(), 'instareel'))),
  USE_FFMPEG: boolish(true),
  FFMPEG_PATH: z.string().default('ffmpeg'),
});

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
