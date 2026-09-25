import { bot } from './index.ts';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import { t, type Lang, type MsgKey } from '../i18n/index.ts';
import * as requestsRepo from '../db/requests.repo.ts';

/**
 * "⏳ Qabul qilindi" xabari — emoji loading animatsiyasi bilan.
 *
 * Havola yoki video kelganda darhol shu xabar chiqadi va ostidagi progress
 * aylanib turadi. Natija tayyor bo'lgach u havola xabariga javob bo'lib keladi,
 * loading xabari esa o'chiriladi; xato bo'lsa — matni xatoga almashadi.
 * Chatda ortiqcha xabar qolmaydi.
 */

/** Progress kadrlari — sodda, rasm kerak emas. */
const FRAMES = ['🟩⬜⬜⬜⬜', '🟩🟩⬜⬜⬜', '🟩🟩🟩⬜⬜', '🟩🟩🟩🟩⬜', '🟩🟩🟩🟩🟩'];

/**
 * Telegram tahrirlarni ham limitlaydi: shaxsiy chatda 1.5 s, guruhda 3 s
 * (guruhda daqiqasiga ~20 xabar). Juda uzoq ish bo'lsa animatsiya to'xtaydi.
 */
const INTERVAL_PRIVATE_MS = 1_500;
const INTERVAL_GROUP_MS = 3_000;
const MAX_ANIMATION_MS = 90_000;

const frameText = (base: string, i: number): string => `${base}\n${FRAMES[i % FRAMES.length]}`;

/** chatId:messageId → animatsiya taymeri */
const animations = new Map<string, NodeJS.Timeout>();
const animKey = (chatId: number, messageId: number): string => `${chatId}:${messageId}`;

function startAnimation(chatId: number, messageId: number, base: string): void {
  const key = animKey(chatId, messageId);
  const startedAt = Date.now();
  let frame = 0;
  // Musbat ID — shaxsiy chat, manfiy — guruh/kanal
  const interval = chatId > 0 ? INTERVAL_PRIVATE_MS : INTERVAL_GROUP_MS;

  const timer = setInterval(() => {
    if (Date.now() - startedAt > MAX_ANIMATION_MS) {
      stopAnimation(chatId, messageId);
      return;
    }
    frame += 1;
    bot.api.editMessageText(chatId, messageId, frameText(base, frame)).catch(() => {
      // Xabar o'chirilgan / natijaga almashgan / limit — animatsiyani to'xtatamiz
      stopAnimation(chatId, messageId);
    });
  }, interval);
  timer.unref();
  animations.set(key, timer);
}

function stopAnimation(chatId: number, messageId: number): void {
  const key = animKey(chatId, messageId);
  const timer = animations.get(key);
  if (timer) {
    clearInterval(timer);
    animations.delete(key);
  }
}

/**
 * Loading xabarini yuboradi va animatsiyani boshlaydi.
 * @returns xabar ID'si; yuborib bo'lmasa null (natija baribir keladi)
 */
export async function sendStatusCard(
  chatId: number,
  lang: Lang,
  key: MsgKey,
  replyTo?: number,
): Promise<number | null> {
  const base = t(lang, key);
  try {
    const sent = await bot.api.sendMessage(chatId, frameText(base, 0), {
      ...(replyTo
        ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
        : {}),
    });
    startAnimation(chatId, sent.message_id, base);
    return sent.message_id;
  } catch (e) {
    logger.warn({ chatId, err: errMessage(e) }, 'Loading xabarini yuborib bo\'lmadi');
    return null;
  }
}

/** Natija yuborildi — loading xabari kerak emas. */
export async function finishStatusCard(chatId: number, messageId: number | null): Promise<void> {
  if (!messageId) return;
  stopAnimation(chatId, messageId);
  await bot.api.deleteMessage(chatId, messageId).catch(() => undefined);
}

/** Loading o'rniga matn (xato, navbat limiti). @returns false — o'zgartirib bo'lmadi */
export async function setStatusCardText(chatId: number, messageId: number, text: string): Promise<boolean> {
  stopAnimation(chatId, messageId);
  try {
    await bot.api.editMessageText(chatId, messageId, text, { parse_mode: 'HTML' });
    return true;
  } catch (e) {
    logger.debug({ err: errMessage(e) }, 'Loading matni o\'zgarmadi');
    return false;
  }
}

/** Dublikat so'rov — loading xabariga ehtiyoj qolmadi. */
export const dropStatusCard = finishStatusCard;

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
