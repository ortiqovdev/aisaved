/**
 * Telegram bot profilini barcha tillarda o'rnatadi:
 *   - description        — bo'sh chatda "Start" tugmasi ustida chiqadigan matn
 *   - short description  — bot profilidagi "About" (ulashishda ham ko'rinadi)
 *
 * Matnlar `src/i18n/locales/*` da. Til kodisiz yozilgani — standart (inglizcha),
 * qolganlari foydalanuvchining Telegram ilovasi tiliga qarab ko'rsatiladi.
 * Faqat o'zgargan matn yoziladi, shuning uchun qayta ishga tushirish xavfsiz.
 *
 *   npm run bot:profile
 *
 * Buyruqlar menyusi bu yerda emas — u server ishga tushganda o'rnatiladi
 * (`setupBotCommands`).
 */
import { Api } from 'grammy';
import { env } from '../config/env.ts';
import { DEFAULT_LANG, LANGS, t, type Lang } from '../i18n/index.ts';

const api = new Api(env.TELEGRAM_BOT_TOKEN);
const vars = { account: env.IG_ACCOUNT_USERNAME };

/** undefined — til kodisiz (standart) yozuv. */
const targets: Array<Lang | undefined> = [undefined, ...LANGS];

let changed = 0;
for (const code of targets) {
  const lang = code ?? DEFAULT_LANG;
  const other = code ? { language_code: code } : {};
  const label = code ?? 'default';

  const description = t(lang, 'botDescription', vars);
  const current = await api.getMyDescription(other);
  if (current.description !== description) {
    await api.setMyDescription(description, other);
    changed += 1;
    console.log(`  ${label}: description yangilandi`);
  }

  const short = t(lang, 'botShortDescription', vars);
  const currentShort = await api.getMyShortDescription(other);
  if (currentShort.short_description !== short) {
    await api.setMyShortDescription(short, other);
    changed += 1;
    console.log(`  ${label}: short description yangilandi`);
  }
}

console.log(changed === 0 ? 'Hammasi dolzarb — o\'zgarish yo\'q.' : `Tayyor: ${changed} ta o'zgarish.`);
