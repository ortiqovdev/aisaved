import { InputFile } from 'grammy';
import { bot } from './index.ts';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import { escapeHtml } from './messages.ts';
import { buildSongMessage } from './results.ts';
import type { SongInfo } from '../services/audd.ts';

/** Qisqa caption — video bilan birga ketadi (Telegram limiti 1024 belgi). */
export function buildCaption(song: SongInfo | null): string {
  if (!song) {
    return '🎵 Musiqa aniqlanmadi.\n<i>Ba\'zan reels\'da original ovoz yoki juda qisqa parcha bo\'ladi.</i>';
  }
  const lines = [`🎵 <b>${escapeHtml(song.title)}</b>`, `👤 ${escapeHtml(song.artist)}`];
  if (song.album) lines.push(`💿 ${escapeHtml(song.album)}`);
  return lines.join('\n');
}

/**
 * Instagram'dan kelgan reels uchun: video + caption, so'ng alohida xabarda
 * versiyalar va havolalar (tugmalar bilan).
 */
export async function sendResult(
  telegramId: number,
  videoPath: string,
  song: SongInfo | null,
): Promise<void> {
  await bot.api.sendVideo(telegramId, new InputFile(videoPath), {
    caption: buildCaption(song),
    parse_mode: 'HTML',
    supports_streaming: true,
  });

  // Tugmali batafsil xabar faqat musiqa topilganda mantiqli
  if (song) await sendSongOnly(telegramId, song);

  logger.info({ telegramId, song: song?.title ?? null }, 'Natija Telegram\'ga yuborildi');
}

/**
 * Faqat musiqa natijasi: muqova rasmi + versiyalar ro'yxati + inline tugmalar.
 * Foydalanuvchi faylni o'zi yuborgan holat uchun (videoni qaytarish shart emas).
 */
export async function sendSongOnly(telegramId: number, song: SongInfo | null): Promise<void> {
  const message = await buildSongMessage(song);

  if (message.coverUrl) {
    try {
      await bot.api.sendPhoto(telegramId, message.coverUrl, {
        caption: message.text,
        parse_mode: 'HTML',
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
