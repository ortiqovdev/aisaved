import { InputFile, InputMediaBuilder } from 'grammy';
import type { InlineKeyboardMarkup, Message } from 'grammy/types';
import { bot } from './index.ts';
import { getBotInfo } from './info.ts';
import { photoActionsKeyboard, videoActionsKeyboard } from './video-actions.ts';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import { buildSongMessage } from './results.ts';
import type { SongInfo } from '../services/audd.ts';
import type { MediaKind } from '../services/ig-resolver.ts';
import { isImageContentType, type DownloadedFile } from '../services/media.ts';
import type { CachedMedia } from '../db/media-cache.repo.ts';
import { t, type Lang } from '../i18n/index.ts';
import { finishStatusCard, setStatusCardText } from './status-card.ts';

/**
 * Natijani foydalanuvchiga yetkazish.
 *
 * `statusId` — "⏳ Qabul qilindi" loading xabari ([status-card.ts]). Natija
 * havola xabariga javob bo'lib yuborilgach loading o'chiriladi; xato bo'lsa
 * loading matni xatoga almashadi. Chatda ortiqcha xabar qolmaydi.
 */

/**
 * Yuboriladigan fayl manbasi:
 *   { url }    — Telegram faylni o'zi yuklab oladi (video ≤20 MB, rasm ≤5 MB):
 *                serverimiz faylni umuman yuklab olmaydi va qayta yuklamaydi
 *   { fileId } — Telegram'da allaqachon bor (media keshi): bir zumda
 *   { path }   — diskdagi fayl (yuklab olingan)
 */
export type MediaSource = { url: string } | { fileId: string } | { path: string };

export interface OutMedia {
  kind: MediaKind;
  source: MediaSource;
}

export interface DeliverOptions {
  /** Yangi xabar bo'lsa — qaysi xabarga javob (guruhda: havola tashlangan xabar). */
  replyTo?: number | undefined;
  /** Videodagi qo'shiq ("Nom — Ijrochi"), manba bersa — caption oxiriga. */
  music?: string | null | undefined;
}

const replyParams = (replyTo: number | undefined) =>
  replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {};

const withMusic = (caption: string, music: string | null | undefined): string =>
  music ? `${caption}
♬ ${music}` : caption;

/** Har chaqiruvda yangi InputFile — fayl oqimi bir marta o'qiladi. */
function inputOf(source: MediaSource): string | InputFile {
  if ('path' in source) return new InputFile(source.path);
  return 'url' in source ? source.url : source.fileId;
}

export const fromDownloaded = (files: DownloadedFile[]): OutMedia[] =>
  files.map((f) => ({
    kind: isImageContentType(f.contentType) ? 'photo' : 'video',
    source: { path: f.filePath },
  }));

/** Yuborilgan xabardagi fayl — media keshi uchun. */
function cachedOf(message: Message): CachedMedia | null {
  if (message.video) {
    return { kind: 'video', fileId: message.video.file_id, fileUniqueId: message.video.file_unique_id };
  }
  const photo = message.photo?.at(-1);
  return photo ? { kind: 'photo', fileId: photo.file_id, fileUniqueId: photo.file_unique_id } : null;
}

/** Telegram albomida ko'pi bilan 10 ta fayl. */
const ALBUM_LIMIT = 10;

/** Faylni kartaning o'rniga qo'yadi (yoki yangi xabar qilib yuboradi). */
async function placeMedia(
  chatId: number,
  statusId: number | null,
  item: OutMedia,
  caption: string,
  keyboard: InlineKeyboardMarkup,
  replyTo?: number,
): Promise<Message> {
  // Xato bo'lsa (masalan Telegram URL'ni ololmadi) loading xabari joyida
  // qoladi — chaqiruvchi faylni yuklab olib qayta urinadi.
  const sent =
    item.kind === 'video'
      ? await bot.api.sendVideo(chatId, inputOf(item.source), {
          caption,
          supports_streaming: true,
          reply_markup: keyboard,
          ...replyParams(replyTo),
        })
      : await bot.api.sendPhoto(chatId, inputOf(item.source), {
          caption,
          reply_markup: keyboard,
          ...replyParams(replyTo),
        });
  await finishStatusCard(chatId, statusId);
  return sent;
}

/**
 * Post fayl(lar)i:
 *   1 ta video → tagida "🎵 · ⭕ · 📤" tugmalari
 *   1 ta rasm  → tagida "📤" tugmasi
 *   karusel    → albom (Telegram albomiga tugma qo'yib bo'lmaydi)
 *
 * @returns yuborilgan fayllarning Telegram file_id'lari — media keshi uchun
 */
export async function deliverMedia(
  chatId: number,
  items: OutMedia[],
  lang: Lang,
  statusId: number | null,
  options: DeliverOptions = {},
): Promise<CachedMedia[]> {
  const [single] = items;
  if (items.length === 1 && single) {
    const sent = await deliverSingle(chatId, single, lang, statusId, options);
    return sent ? [sent] : [];
  }

  const delivered: CachedMedia[] = [];
  for (let i = 0; i < items.length; i += ALBUM_LIMIT) {
    const chunk = items.slice(i, i + ALBUM_LIMIT).map((item, j) => {
      const caption =
        i === 0 && j === 0
          ? { caption: withMusic(t(lang, 'albumReadyCaption', { n: items.length }), options.music) }
          : {};
      return item.kind === 'video'
        ? InputMediaBuilder.video(inputOf(item.source), { supports_streaming: true, ...caption })
        : InputMediaBuilder.photo(inputOf(item.source), caption);
    });
    const messages = await bot.api.sendMediaGroup(chatId, chunk, replyParams(options.replyTo));
    for (const m of messages) {
      const c = cachedOf(m);
      if (c) delivered.push(c);
    }
  }
  await finishStatusCard(chatId, statusId);
  logger.info({ chatId, files: items.length }, 'Albom Telegram\'ga yuborildi');
  return delivered;
}

async function deliverSingle(
  chatId: number,
  item: OutMedia,
  lang: Lang,
  statusId: number | null,
  options: DeliverOptions,
): Promise<CachedMedia | null> {
  const caption = withMusic(
    t(lang, item.kind === 'video' ? 'videoReadyCaption' : 'photoReadyCaption'),
    options.music,
  );
  const keyboardFor = (fileId: string | null) =>
    item.kind === 'video' ? videoActionsKeyboard(lang, fileId) : photoActionsKeyboard(lang, fileId);

  // Keshdan kelgan bo'lsa file_id oldindan ma'lum — "📤" darhol to'liq
  const knownId = 'fileId' in item.source ? item.source.fileId : null;
  const message = await placeMedia(
    chatId,
    statusId,
    item,
    caption,
    keyboardFor(knownId),
    options.replyTo,
  );
  const sent = cachedOf(message);

  // Inline ulashish uchun faylning file_id si kerak — yangi fayl bo'lsa u
  // faqat yuborilgach ma'lum bo'ladi, shuning uchun "📤" ikkinchi qadamda.
  if (!knownId && getBotInfo().supportsInline && sent) {
    await bot.api
      .editMessageReplyMarkup(chatId, message.message_id, { reply_markup: keyboardFor(sent.fileId) })
      .catch((e: unknown) =>
        logger.debug({ err: errMessage(e) }, 'Ulashish tugmasini qo\'shib bo\'lmadi'),
      );
  }
  logger.info({ chatId, kind: item.kind, via: Object.keys(item.source)[0] }, 'Fayl Telegram\'ga yuborildi');
  return sent;
}

/**
 * Musiqa natijasi: muqova rasmi + versiyalar ro'yxati + inline tugmalar.
 * @param statusId — bor bo'lsa karta natijaga aylantiriladi
 * @param replyTo  — yangi xabar bo'lsa, qaysi videoga javob bo'lishi
 */
export async function deliverSong(
  chatId: number,
  song: SongInfo | null,
  lang: Lang,
  statusId: number | null,
  replyTo?: number,
): Promise<void> {
  await sendSongOnly(chatId, song, lang, replyTo);
  await finishStatusCard(chatId, statusId);
}

/** Xato: loading matni xatoga almashtiriladi (bo'lmasa — oddiy xabar). */
export async function showFailure(
  chatId: number,
  text: string,
  statusId: number | null,
): Promise<void> {
  if (statusId && (await setStatusCardText(chatId, statusId, text))) return;
  await trySendText(chatId, text);
}

/**
 * Musiqa natijasi alohida xabar bo'lib: muqova rasmi + versiyalar + tugmalar.
 * @param replyTo — video xabar ID'si: natija o'sha videoga javob bo'lib chiqadi
 */
export async function sendSongOnly(
  telegramId: number,
  song: SongInfo | null,
  lang: Lang,
  replyTo?: number,
): Promise<void> {
  const message = await buildSongMessage(song, lang);
  const reply = replyTo
    ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
    : {};

  await bot.api.sendMessage(telegramId, message.text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...reply,
    ...(message.keyboard ? { reply_markup: message.keyboard } : {}),
  });
  logger.info({ telegramId, song: song?.title ?? null }, 'Musiqa natijasi yuborildi');
}

export async function sendText(telegramId: number, text: string): Promise<void> {
  // Havola ko'rinishi (masalan Instagram profili) xabarni katta kartaga aylantirmasin
  await bot.api.sendMessage(telegramId, text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}

/** Xato bo'lsa ham chaqiruvchini to'xtatmaydi (masalan user botni bloklagan). */
export async function trySendText(telegramId: number, text: string): Promise<void> {
  try {
    await sendText(telegramId, text);
  } catch (e) {
    logger.warn({ telegramId, err: errMessage(e) }, 'Telegram xabari yuborilmadi');
  }
}
