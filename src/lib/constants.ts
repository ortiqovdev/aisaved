/**
 * Boshqa modullarga bog'liq bo'lmagan umumiy konstantalar.
 * (Alohida fayl — bot ↔ services orasida aylanma import bo'lmasligi uchun.)
 */

/** Bot API orqali fayl YUKLAB OLISH limiti. Yuborish limiti boshqa — 50MB. */
export const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** `requests.media_type` qiymati: media Telegram'dan kelgan (Instagram'dan emas). */
export const TELEGRAM_SOURCE = 'telegram_file';

/**
 * `requests.media_type` qiymati: foydalanuvchi Telegram'ga Instagram HAVOLASINI
 * tashlagan. Bunda `media_url` — instagram.com havolasi; video fayl ishlov
 * berish paytida resolver orqali topiladi.
 */
export const IG_LINK_SOURCE = 'ig_link';
