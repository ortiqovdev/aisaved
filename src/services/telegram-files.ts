import { GrammyError } from 'grammy';
import { bot } from '../bot/index.ts';
import { env } from '../config/env.ts';
import { PermanentError, TransientError, errMessage } from '../lib/errors.ts';

/**
 * file_id dan yuklab olinadigan URL yasaydi.
 *
 * Bazada aynan `file_id` saqlanadi, URL emas — chunki:
 *   1) URL ichida bot tokeni bo'ladi, uni bazaga yozish xavfli;
 *   2) URL taxminan 1 soatda eskiradi, file_id esa doimiy.
 * Shuning uchun URL har safar ishlov berish paytida yangidan olinadi.
 */
export async function resolveTelegramFileUrl(fileId: string): Promise<string> {
  try {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) {
      throw new PermanentError(`Telegram file_path bo'sh (file_id=${fileId})`);
    }
    return `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  } catch (e) {
    if (e instanceof PermanentError) throw e;

    if (e instanceof GrammyError) {
      if (/too big/i.test(e.description)) {
        throw new PermanentError(
          `Telegram fayli juda katta: ${e.description}`,
          '📦 Fayl 20MB dan katta — Telegram botlari bunday faylni yuklab ololmaydi. ' +
            'Qisqaroq video yuboring.',
        );
      }
      if (e.error_code === 400) {
        throw new PermanentError(
          `Telegram getFile 400: ${e.description}`,
          '❌ Bu faylni ola olmadim. Iltimos, qaytadan yuboring.',
        );
      }
      throw new TransientError(`Telegram getFile ${e.error_code}: ${e.description}`);
    }
    throw new TransientError(`Telegram getFile xatosi: ${errMessage(e)}`);
  }
}
