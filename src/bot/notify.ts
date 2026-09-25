import { InputFile, InputMediaBuilder } from 'grammy';
import type { InlineKeyboardMarkup, Message } from 'grammy/types';
import { bot } from './index.ts';
import { getBotInfo } from './info.ts';
import { photoActionsKeyboard, videoActionsKeyboard } from './video-actions.ts';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import { buildSongMessage } from './results.ts';
import type { SongInfo } from '../services/audd.ts';
import { isImageContentType, type DownloadedFile } from '../services/media.ts';
import { t, type Lang } from '../i18n/index.ts';

/**
 * Natijani foydalanuvchiga yetkazish.
 *
 * `statusId` — "⏳ Qabul qilindi" kartasi ([status-card.ts]). Bor bo'lsa,
 * natija yangi xabar emas, AYNAN SHU xabarning o'zi bo'lib chiqadi: karta
 * videoga / rasmga / qo'shiq natijasiga aylantiriladi. Aylantirib bo'lmasa
 * (foydalanuvchi kartani o'chirgan va h.k.) — natija yangi xabar bo'lib
 * ketadi, karta esa o'chiriladi. Ikkala holatda ham chatda bitta xabar qoladi.
 */

type MediaKind = 'video' | 'photo';

const kindOf = (file: DownloadedFile): MediaKind =>
  isImageContentType(file.contentType) ? 'photo' : 'video';

/** Telegram albomida ko'pi bilan 10 ta fayl. */
const ALBUM_LIMIT = 10;

/** Faylni kartaning o'rniga qo'yadi (yoki yangi xabar qilib yuboradi). */
async function placeMedia(
  chatId: number,
  statusId: number | null,
  kind: MediaKind,
  filePath: string,
  caption: string,
  keyboard: InlineKeyboardMarkup,
): Promise<Message> {
  if (statusId) {
    const media =
      kind === 'video'
        ? InputMediaBuilder.video(new InputFile(filePath), { caption, supports_streaming: true })
        : InputMediaBuilder.photo(new InputFile(filePath), { caption });
    try {
      const edited = await bot.api.editMessageMedia(chatId, statusId, media, {
        reply_markup: keyboard,
      });
      if (edited !== true) return edited;
    } catch (e) {
      logger.debug({ chatId, statusId, err: errMessage(e) }, 'Kartani aylantirib bo\'lmadi — yangi xabar');
    }
  }

  const sent =
    kind === 'video'
      ? await bot.api.sendVideo(chatId, new InputFile(filePath), {
          caption,
          supports_streaming: true,
          reply_markup: keyboard,
        })
      : await bot.api.sendPhoto(chatId, new InputFile(filePath), { caption, reply_markup: keyboard });
  await deleteQuietly(chatId, statusId);
  return sent;
}

async function deleteQuietly(chatId: number, messageId: number | null): Promise<void> {
  if (messageId) await bot.api.deleteMessage(chatId, messageId).catch(() => undefined);
}

/**
 * Yuklab olingan fayl(lar):
 *   1 ta video → tagida "🎵 · ⭕ · 📤" tugmalari
 *   1 ta rasm  → tagida "📤" tugmasi
 *   karusel    → albom (Telegram albomiga tugma qo'yib bo'lmaydi)
 */
export async function deliverDownloads(
  chatId: number,
  files: DownloadedFile[],
  lang: Lang,
  statusId: number | null,
): Promise<void> {
  const [single] = files;
  if (files.length === 1 && single) {
    await deliverSingle(chatId, single, lang, statusId);
    return;
  }

  for (let i = 0; i < files.length; i += ALBUM_LIMIT) {
    const chunk = files.slice(i, i + ALBUM_LIMIT).map((file, j) => {
      const caption = i === 0 && j === 0 ? { caption: t(lang, 'albumReadyCaption', { n: files.length }) } : {};
      return kindOf(file) === 'video'
        ? InputMediaBuilder.video(new InputFile(file.filePath), { supports_streaming: true, ...caption })
        : InputMediaBuilder.photo(new InputFile(file.filePath), caption);
    });
    await bot.api.sendMediaGroup(chatId, chunk);
  }
  await deleteQuietly(chatId, statusId);
  logger.info({ chatId, files: files.length }, 'Albom Telegram\'ga yuborildi');
}

async function deliverSingle(
  chatId: number,
  file: DownloadedFile,
  lang: Lang,
  statusId: number | null,
): Promise<void> {
  const kind = kindOf(file);
  const caption = t(lang, kind === 'video' ? 'videoReadyCaption' : 'photoReadyCaption');
  const keyboardFor = (fileId: string | null) =>
    kind === 'video' ? videoActionsKeyboard(lang, fileId) : photoActionsKeyboard(lang, fileId);

  const message = await placeMedia(chatId, statusId, kind, file.filePath, caption, keyboardFor(null));

  // Inline ulashish uchun faylning file_id si kerak — u faqat yuborilgach
  // ma'lum bo'ladi, shuning uchun "📤" tugmasi ikkinchi qadamda yangilanadi.
  const fileId = message.video?.file_id ?? message.photo?.at(-1)?.file_id ?? null;
  if (getBotInfo().supportsInline && fileId) {
    await bot.api
      .editMessageReplyMarkup(chatId, message.message_id, { reply_markup: keyboardFor(fileId) })
      .catch((e: unknown) =>
        logger.debug({ err: errMessage(e) }, 'Ulashish tugmasini qo\'shib bo\'lmadi'),
      );
  }
  logger.info({ chatId, kind }, 'Fayl Telegram\'ga yuborildi');
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
  if (statusId) {
    const message = await buildSongMessage(song, lang);
    const markup = message.keyboard ? { reply_markup: message.keyboard } : {};
    try {
      if (message.coverUrl) {
        await bot.api.editMessageMedia(
          chatId,
          statusId,
          InputMediaBuilder.photo(message.coverUrl, { caption: message.text, parse_mode: 'HTML' }),
          markup,
        );
      } else {
        await bot.api.editMessageCaption(chatId, statusId, {
          caption: message.text,
          parse_mode: 'HTML',
          ...markup,
        });
      }
      logger.info({ chatId, song: song?.title ?? null }, 'Musiqa natijasi (karta o\'rnida)');
      return;
    } catch (e) {
      logger.debug({ chatId, err: errMessage(e) }, 'Kartani natijaga aylantirib bo\'lmadi — yangi xabar');
    }
  }

  await sendSongOnly(chatId, song, lang, replyTo);
  await deleteQuietly(chatId, statusId);
}

/** Xato: karta matni xatoga almashtiriladi (karta bo'lmasa — oddiy xabar). */
export async function showFailure(
  chatId: number,
  text: string,
  statusId: number | null,
): Promise<void> {
  if (statusId) {
    try {
      await bot.api.editMessageCaption(chatId, statusId, { caption: text, parse_mode: 'HTML' });
      return;
    } catch (e) {
      logger.debug({ chatId, err: errMessage(e) }, 'Karta matnini o\'zgartirib bo\'lmadi');
    }
  }
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

  if (message.coverUrl) {
    try {
      await bot.api.sendPhoto(telegramId, message.coverUrl, {
        caption: message.text,
        parse_mode: 'HTML',
        ...reply,
        ...(message.keyboard ? { reply_markup: message.keyboard } : {}),
      });
      logger.info({ telegramId, song: song?.title ?? null }, 'Musiqa natijasi yuborildi (muqova bilan)');
      return;
    } catch (e) {
      // Muqova URL'i ishlamasa — matnli variantga tushamiz
      logger.debug({ err: errMessage(e) }, 'Muqova yuborilmadi, matn bilan davom etamiz');
    }
  }

  await bot.api.sendMessage(telegramId, message.text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...reply,
    ...(message.keyboard ? { reply_markup: message.keyboard } : {}),
  });
  logger.info({ telegramId, song: song?.title ?? null }, 'Musiqa natijasi yuborildi');
}

export async function sendText(telegramId: number, text: string): Promise<void> {
  await bot.api.sendMessage(telegramId, text, { parse_mode: 'HTML' });
}

/** Xato bo'lsa ham chaqiruvchini to'xtatmaydi (masalan user botni bloklagan). */
export async function trySendText(telegramId: number, text: string): Promise<void> {
  try {
    await sendText(telegramId, text);
  } catch (e) {
    logger.warn({ telegramId, err: errMessage(e) }, 'Telegram xabari yuborilmadi');
  }
}
