import { DEFAULT_LANG, detectLang, isLang, type Lang } from './index.ts';
import * as usersRepo from '../db/users.repo.ts';
import type { UserRow } from '../db/types.ts';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';

/**
 * telegram_id -> til.
 *
 * Har bir Telegram update'ida bazaga borib kelmaslik uchun. Tilni faqat shu
 * jarayon o'zgartiradi, shuning uchun kesh eskirib qolmaydi. 0003 migratsiyasi
 * qo'llanmagan bazada esa til faqat shu yerda yashaydi.
 */
const cache = new Map<number, Lang>();

/** Bot update'i uchun til: kesh → baza → Telegram interfeys tili. */
export async function resolveTelegramLang(
  telegramId: number,
  languageCode: string | undefined,
): Promise<Lang> {
  const cached = cache.get(telegramId);
  if (cached) return cached;

  let lang = detectLang(languageCode);
  try {
    const user = await usersRepo.findByTelegramId(telegramId);
    if (isLang(user?.language)) {
      lang = user.language;
    } else if (user) {
      // Til ustuni qo'shilishidan oldin yaratilgan user — aniqlanganini
      // saqlab qo'yamiz, worker ham shu tilda yozsin.
      await usersRepo.setLanguage(telegramId, lang);
    }
  } catch (e) {
    // Baza xatosi botni to'xtatmasin — Telegram tili bilan davom etamiz
    logger.debug({ telegramId, err: errMessage(e) }, 'Til bazadan olinmadi');
  }

  cache.set(telegramId, lang);
  return lang;
}

/** /language orqali tanlangan tilni saqlaydi. */
export async function changeLang(telegramId: number, lang: Lang): Promise<void> {
  cache.set(telegramId, lang);
  await usersRepo.setLanguage(telegramId, lang);
}

/** Bazadagi user uchun til (worker, Instagram webhook'i). */
export function langOfUser(user: UserRow | null | undefined): Lang {
  if (!user) return DEFAULT_LANG;
  if (isLang(user.language)) return user.language;
  return cache.get(user.telegram_id) ?? DEFAULT_LANG;
}
