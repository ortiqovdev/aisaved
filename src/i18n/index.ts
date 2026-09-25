import { en, type Messages, type MsgKey } from './locales/en.ts';
import { uz } from './locales/uz.ts';
import { ru } from './locales/ru.ts';
import { ar } from './locales/ar.ts';
import { kk } from './locales/kk.ts';
import { tr } from './locales/tr.ts';

export type { MsgKey } from './locales/en.ts';

/**
 * Qo'llab-quvvatlanadigan tillar. Hammasi Telegram'ning rasmiy interfeys
 * tillari — shuning uchun `from.language_code` orqali avtomatik aniqlanadi.
 * Ro'yxat tartibi — til tanlash tugmalari tartibi.
 */
export const LANGS = ['en', 'uz', 'ru', 'ar', 'kk', 'tr'] as const;
export type Lang = (typeof LANGS)[number];

/** Tili noma'lum yoki qo'llab-quvvatlanmaydigan foydalanuvchi uchun. */
export const DEFAULT_LANG: Lang = 'en';

export const LANG_LABELS: Record<Lang, string> = {
  en: '🇬🇧 English',
  uz: '🇺🇿 O\'zbekcha',
  ru: '🇷🇺 Русский',
  ar: '🇸🇦 العربية',
  kk: '🇰🇿 Қазақша',
  tr: '🇹🇷 Türkçe',
};

/** Sana formatlash uchun `Intl` locale'i. */
export const LANG_LOCALES: Record<Lang, string> = {
  en: 'en-GB',
  uz: 'uz-UZ',
  ru: 'ru-RU',
  ar: 'ar',
  kk: 'kk-KZ',
  tr: 'tr-TR',
};

const DICTIONARIES: Record<Lang, Messages> = { en, uz, ru, ar, kk, tr };

/**
 * Bizda lug'ati yo'q, lekin foydalanuvchisi boshqa tilimizni yaxshi
 * tushunadigan tillar (qo'shni / qardosh tillar).
 */
const LANG_ALIASES: Record<string, Lang> = {
  uk: 'ru',
  be: 'ru',
  tg: 'ru',
  ky: 'kk',
  az: 'tr',
  tk: 'tr',
};

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

/** Telegram `language_code` (masalan "ru", "pt-br") dan tilimizni tanlaydi. */
export function detectLang(code: string | null | undefined): Lang {
  const base = code?.toLowerCase().split(/[-_]/)[0] ?? '';
  if (isLang(base)) return base;
  return LANG_ALIASES[base] ?? DEFAULT_LANG;
}

export type Vars = Record<string, string | number>;

/** Tarjima: `{name}` o'rinlari `vars` bilan almashtiriladi. */
export function t(lang: Lang, key: MsgKey, vars?: Vars): string {
  const template = DICTIONARIES[lang][key] ?? en[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/**
 * Foydalanuvchiga keyinroq (boshqa joyda, uning tili ma'lum bo'lganda)
 * tarjima qilinadigan xabar — masalan xato ichida olib yuriladi.
 */
export interface LocalizedText {
  key: MsgKey;
  vars?: Vars;
}

export const msg = (key: MsgKey, vars?: Vars): LocalizedText =>
  vars ? { key, vars } : { key };
