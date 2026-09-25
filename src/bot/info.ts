/**
 * `getMe` dan olinadigan bot ma'lumotlari — ishga tushishda to'ldiriladi.
 * Alohida modul: bot/index.ts bilan aylanma importga tushmaslik uchun.
 */
interface BotInfo {
  username: string;
  /** BotFather'da inline rejim yoqilganmi (`/setinline`). */
  supportsInline: boolean;
}

let info: BotInfo = { username: '', supportsInline: false };

export const setBotInfo = (value: BotInfo): void => {
  info = value;
};

export const getBotInfo = (): BotInfo => info;
