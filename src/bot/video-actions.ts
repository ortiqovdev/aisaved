import { InlineKeyboard } from 'grammy';
import type { InlineQueryResultCachedPhoto, InlineQueryResultCachedVideo } from 'grammy/types';
import type { BotContext } from './index.ts';
import { getBotInfo } from './info.ts';
import { pickVideo, startRound } from './round.ts';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import { TELEGRAM_SOURCE } from '../lib/constants.ts';
import { t, type Lang } from '../i18n/index.ts';
import * as usersRepo from '../db/users.repo.ts';
import * as requestsRepo from '../db/requests.repo.ts';

/**
 * Yuklab olingan video tagidagi tugmalar:
 *
 *   [🎵 Qo'shiqni topish] [⭕ Dumaloq qilish]    ← yashil (success)
 *   [📤 Ulashish]                                ← ko'k (primary)
 *
 * Qo'shiq endi avtomatik emas, tugma bosilganda aniqlanadi: foydalanuvchi
 * ko'pincha videoni o'zi uchun yuklaydi, AudD so'rovlari esa pullik.
 * Callback'lar video xabarning O'ZIDAN ishlaydi (`callback_query.message.video`),
 * shuning uchun callback_data'da hech qanday ID saqlash shart emas.
 */
export const SONG_ACTION = 'va:song';
export const ROUND_ACTION = 'va:round';

/**
 * @param videoFileId — video yuborilgach ma'lum bo'ladi. Inline rejim yoqilgan
 *   bo'lsa "Ulashish" aynan shu videoni boshqa chatga yuboradi; aks holda bot
 *   havolasini ulashadi.
 */
export function videoActionsKeyboard(lang: Lang, videoFileId: string | null): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(t(lang, 'btnFindSong'), SONG_ACTION)
    .success()
    .text(t(lang, 'btnRound'), ROUND_ACTION)
    .success()
    .row();

  const { username, supportsInline } = getBotInfo();
  if (supportsInline && videoFileId) {
    kb.switchInline(t(lang, 'btnShare'), videoFileId).primary();
  } else if (username) {
    kb.url(t(lang, 'btnShare'), shareUrl(lang, username)).primary();
  }
  return kb;
}

/** Inline so'rovda rasm file_id'si shu prefiks bilan keladi (video — prefikssiz). */
const PHOTO_QUERY_PREFIX = 'p:';

/** Rasm tagida faqat "📤 Ulashish" — qo'shiq va dumaloq video rasmga taalluqli emas. */
export function photoActionsKeyboard(lang: Lang, photoFileId: string | null): InlineKeyboard {
  const kb = new InlineKeyboard();
  const { username, supportsInline } = getBotInfo();
  if (supportsInline && photoFileId) {
    kb.switchInline(t(lang, 'btnShare'), `${PHOTO_QUERY_PREFIX}${photoFileId}`).primary();
  } else if (username) {
    kb.url(t(lang, 'btnShare'), shareUrl(lang, username)).primary();
  }
  return kb;
}

/** Inline rejimsiz ulashish: Telegram'ning standart "kimga yuborish" oynasi. */
function shareUrl(lang: Lang, username: string): string {
  const url = encodeURIComponent(`https://t.me/${username}`);
  const text = encodeURIComponent(t(lang, 'shareText'));
  return `https://t.me/share/url?url=${url}&text=${text}`;
}

/** Callback bosilgan xabardagi video (xabar o'chirilgan/eski bo'lsa — null). */
function videoOfCallback(ctx: BotContext) {
  const message = ctx.callbackQuery?.message;
  if (!message || message.date === 0) return null; // InaccessibleMessage
  const video = pickVideo(message);
  return video ? { message, video } : null;
}

/** 🎵 — video navbatga qo'yiladi; natija video ostiga javob bo'lib keladi. */
export async function handleFindSongButton(ctx: BotContext): Promise<void> {
  const from = ctx.from;
  const found = videoOfCallback(ctx);
  if (!from || !found) {
    await ctx.answerCallbackQuery({ text: ctx.t('roundNeedVideo'), show_alert: true });
    return;
  }

  const user = await usersRepo.getOrCreateByTelegramId({
    telegramId: from.id,
    username: from.username,
    firstName: from.first_name,
    language: ctx.lang,
  });

  const pending = await requestsRepo.pendingCountForUser(user.id);
  if (pending >= env.MAX_PENDING_PER_USER) {
    await ctx.answerCallbackQuery({ text: ctx.t('pendingLimit', { n: pending }), show_alert: true });
    return;
  }

  const row = await requestsRepo.enqueue({
    userId: user.id,
    // `:song` — shu video uchun bitta so'rov: qayta bosish dublikat bo'ladi
    igMessageId: `tg:${found.message.chat.id}:${found.message.message_id}:song`,
    mediaUrl: found.video.fileId,
    mediaType: TELEGRAM_SOURCE,
    fileUniqueId: found.video.fileUniqueId,
  });

  await ctx.answerCallbackQuery({ text: ctx.t(row ? 'songSearching' : 'songAlreadyRequested') });
  if (row) logger.info({ requestId: row.id, telegramId: from.id }, 'Tugma orqali qo\'shiq so\'raldi');
}

/** ⭕ — /round bilan bir xil, faqat video bosilgan xabarning o'zi. */
export async function handleRoundButton(ctx: BotContext): Promise<void> {
  const found = videoOfCallback(ctx);
  if (!found) {
    await ctx.answerCallbackQuery({ text: ctx.t('roundNeedVideo'), show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await startRound(ctx, found.message.chat.id, found.message.message_id, found.video);
}

/**
 * 📤 — inline rejim: "Ulashish" tugmasi `@bot <file_id>` so'rovini ochadi,
 * bu yerda o'sha videoni natija sifatida qaytaramiz. Foydalanuvchi chatni
 * tanlaydi va video "via @bot" belgisi bilan yuboriladi.
 *
 * file_id faqat shu bot uchun amal qiladi va videoning o'zini bildiradi —
 * uni bilgan odam allaqachon videoni ko'rgan, ya'ni hech narsa oshkor bo'lmaydi.
 */
export async function handleShareInlineQuery(ctx: BotContext): Promise<void> {
  const raw = ctx.inlineQuery?.query.trim() ?? '';
  const isPhoto = raw.startsWith(PHOTO_QUERY_PREFIX);
  const fileId = isPhoto ? raw.slice(PHOTO_QUERY_PREFIX.length) : raw;
  if (!/^[\w-]{20,200}$/.test(fileId)) {
    await ctx.answerInlineQuery([], { cache_time: 60 });
    return;
  }

  const caption = ctx.t('shareCaption', { bot: getBotInfo().username });
  const result: InlineQueryResultCachedVideo | InlineQueryResultCachedPhoto = isPhoto
    ? { type: 'photo', id: 'share', photo_file_id: fileId, title: ctx.t('shareTitle'), caption }
    : { type: 'video', id: 'share', video_file_id: fileId, title: ctx.t('shareTitle'), caption };
  try {
    await ctx.answerInlineQuery([result], { cache_time: 86_400, is_personal: false });
  } catch (e) {
    // Yaroqsiz yoki begona file_id — bo'sh ro'yxat bilan javob beramiz
    logger.debug({ err: errMessage(e) }, 'Inline ulashish: video topilmadi');
    await ctx.answerInlineQuery([], { cache_time: 60 }).catch(() => undefined);
  }
}
