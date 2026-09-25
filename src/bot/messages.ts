import { env } from '../config/env.ts';
import { t, type Lang, type MsgKey } from '../i18n/index.ts';
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

export function alreadyLinked(lang: Lang, igScopedId: string | null): string {
  const text = t(lang, 'alreadyLinked', { account: account() });
  return igScopedId ? `${text}\n\n<i>IGSID: <code>${escapeHtml(igScopedId)}</code></i>` : text;
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
