import { InputFile } from 'grammy';
import { bot } from './index.ts';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import { escapeHtml } from './messages.ts';
import type { SongInfo } from '../services/audd.ts';

/** Musiqa natijasidan caption yasaydi. */
export function buildCaption(song: SongInfo | null): string {
  if (!song) {
    return '🎵 Musiqa aniqlanmadi.\n<i>Ba\'zan reels\'da original ovoz yoki juda qisqa parcha bo\'ladi.</i>';
  }
  const lines = [`🎵 <b>${escapeHtml(song.title)}</b>\n👤 ${escapeHtml(song.artist)}`];
  if (song.album) lines.push(`💿 ${escapeHtml(song.album)}`);
  if (song.link) lines.push(`🔗 <a href="${escapeHtml(song.link)}">Tinglash</a>`);
  return lines.join('\n');
}

/** Videoni caption bilan yuboradi. */
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
  logger.info({ telegramId, song: song?.title ?? null }, 'Natija Telegram\'ga yuborildi');
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
