/**
 * `getMe` dan olinadigan bot ma'lumotlari — ishga tushishda to'ldiriladi.
 * Alohida modul: bot/index.ts bilan aylanma importga tushmaslik uchun.
 */
interface BotInfo {
  username: string;
  /** BotFather'da inline rejim yoqilganmi (`/setinline`). */
  supportsInline: boolean;
  /** Privacy mode o'chiqmi — guruhdagi oddiy xabarlarni ham ko'radimi (@BotFather → /setprivacy). */
  readsGroupMessages: boolean;
}

let info: BotInfo = { username: '', supportsInline: false, readsGroupMessages: false };

export const setBotInfo = (value: BotInfo): void => {
  info = value;
};

export const getBotInfo = (): BotInfo => info;
