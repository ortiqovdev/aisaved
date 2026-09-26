import { env } from '../config/env.ts';
import { LANG_LOCALES, t, type Lang, type MsgKey } from '../i18n/index.ts';
import { getBotInfo } from './info.ts';

/**
 * Matnlarning o'zi `src/i18n/locales/*` da. Bu yerda — bir nechta joyda
 * ishlatiladigan, o'zgaruvchi qo'shib yig'iladigan xabarlar.
 */

/** parse_mode: 'HTML' uchun xavfsiz qilish. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Sana va vaqt — foydalanuvchi tilida, BOT_TIMEZONE mintaqasida. */
export function formatDate(iso: string, lang: Lang): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(LANG_LOCALES[lang], {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: env.BOT_TIMEZONE,
  });
}

/** Instagram akkaunt: "@username (Ism)" — HTML'da xavfsiz. */
export function igAccountLabel(username: string | null, name: string | null): string {
  if (!username) return name ? escapeHtml(name) : '—';
  const at = `<a href="https://instagram.com/${encodeURIComponent(username)}">@${escapeHtml(username)}</a>`;
  return name && name !== username ? `${at} (${escapeHtml(name)})` : at;
}

export const IG_PROFILE_URL = `https://ig.me/m/${env.IG_ACCOUNT_USERNAME}`;

/** Instagram akkaunt nomi — HTML'da xavfsiz ko'rinishda. */
const account = (): string => escapeHtml(env.IG_ACCOUNT_USERNAME);

export function linkInstructions(lang: Lang, linkCode: string): string {
  return t(lang, 'linkInstructions', {
    account: account(),
    code: escapeHtml(linkCode),
    igUrl: IG_PROFILE_URL,
  });
}

/** IGSID ichki identifikator — foydalanuvchiga ko'rsatilmaydi (faqat bazada/loglarda). */
export function alreadyLinked(lang: Lang): string {
  return t(lang, 'alreadyLinked', { account: account() });
}

export const helpText = (lang: Lang): string =>
  t(lang, 'help', { account: account(), bot: escapeHtml(getBotInfo().username) });

/** Attachment turiga qarab aniqroq javob (Instagram va Telegram uchun). */
export function unsupportedReplyKey(attachmentType: string | null): MsgKey {
  switch (attachmentType) {
    case 'image':
      return 'igUnsupportedImage';
    case 'story_mention':
      return 'igUnsupportedStory';
    case 'audio':
    case 'voice':
      return 'igUnsupportedAudio';
    case 'file':
      return 'igUnsupportedFile';
    default:
      return 'igUnsupported';
  }
}
