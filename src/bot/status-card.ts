import { fileURLToPath } from 'node:url';
import { InputFile } from 'grammy';
import { bot } from './index.ts';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import { t, type Lang, type MsgKey } from '../i18n/index.ts';
import * as requestsRepo from '../db/requests.repo.ts';

/**
 * "Qabul qilindi" kartasi — foydalanuvchiga bitta xabar boradi.
 *
 * Havola yoki reels kelganda darhol shu karta yuboriladi, ish tugagach esa
 * yangi xabar emas, AYNAN SHU xabar videoga / rasmga / qo'shiq natijasiga
 * aylantiriladi (xato bo'lsa — matni xatoga almashadi). Chat toza qoladi.
 *
 * Nega rasm: Telegram matnli xabarni media'ga aylantira olmaydi
 * (editMessageMedia faqat media xabarda ishlaydi), shuning uchun karta
 * boshidanoq rasm — brend belgisi bilan qora kartochka.
 */
const CARD_PATH = fileURLToPath(new URL('../../assets/status-card.png', import.meta.url));

/** Rasm bir marta yuklanadi, keyin Telegram file_id orqali qayta ishlatiladi. */
let cardFileId: string | null = null;

/**
 * Kartani yuboradi.
 * @returns xabar ID'si; yuborib bo'lmasa null — u holda oddiy matn yuboriladi
 *          va natija keyin alohida xabar bo'lib keladi.
 */
export async function sendStatusCard(
  chatId: number,
  lang: Lang,
  key: MsgKey,
  replyTo?: number,
): Promise<number | null> {
  const reply = replyTo
    ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
    : {};
  try {
    const sent = await bot.api.sendPhoto(chatId, cardFileId ?? new InputFile(CARD_PATH), {
      caption: t(lang, key),
      ...reply,
    });
    cardFileId ??= sent.photo.at(-1)?.file_id ?? null;
    return sent.message_id;
  } catch (e) {
    logger.warn({ chatId, err: errMessage(e) }, 'Status kartasini yuborib bo\'lmadi — matn yuboriladi');
    await bot.api.sendMessage(chatId, t(lang, key), reply).catch(() => undefined);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Qaysi job qaysi kartaga tegishli
//
// Asosiy manba — bazadagi `requests.status_message_id` (0004 migratsiyasi):
// alohida worker jarayoni ham, qayta ishga tushgan server ham uni ko'radi.
// Xotiradagi xarita — migratsiyasiz bazada va tezkor yo'l sifatida.
// ---------------------------------------------------------------------------

const byRequest = new Map<number, number>();

/**
 * Karta → job bog'lanishi. Bazaga u `enqueue` paytida birga yoziladi
 * (karta navbatdan OLDIN yuboriladi — worker uni hech qachon "ko'rmay"
 * qolmasin); bu yerda faqat xotiradagi nusxa.
 */
export function rememberStatusCard(requestId: number, messageId: number): void {
  byRequest.set(requestId, messageId);
}

/** Kartaning matnini almashtiradi (masalan navbat limiti). Xato — e'tiborsiz. */
export async function setStatusCardText(chatId: number, messageId: number, text: string): Promise<void> {
  await bot.api
    .editMessageCaption(chatId, messageId, { caption: text, parse_mode: 'HTML' })
    .catch((e: unknown) => logger.debug({ err: errMessage(e) }, 'Karta matni o\'zgarmadi'));
}

/** Dublikat so'rov — kartaga ehtiyoj qolmadi. */
export async function dropStatusCard(chatId: number, messageId: number | null): Promise<void> {
  if (messageId) await bot.api.deleteMessage(chatId, messageId).catch(() => undefined);
}

/** Job'ning kartasi (bo'lmasa null). Worker natijani yuborish OLDIDAN chaqiradi. */
export async function statusCardOf(requestId: number): Promise<number | null> {
  const cached = byRequest.get(requestId);
  if (cached) return cached;
  try {
    return await requestsRepo.getStatusMessageId(requestId);
  } catch {
    return null;
  }
}

/** Karta natijaga aylantirilgach — xaritani tozalaymiz. */
export function forgetStatusCard(requestId: number): void {
  byRequest.delete(requestId);
}
