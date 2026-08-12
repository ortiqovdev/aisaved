import { env } from '../config/env.ts';

/** parse_mode: 'HTML' uchun xavfsiz qilish. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const IG_PROFILE_URL = `https://ig.me/m/${env.IG_ACCOUNT_USERNAME}`;

export function linkInstructions(linkCode: string): string {
  return [
    '👋 <b>Salom!</b>',
    '',
    'Instagram\'dagi reels musiqasini topib beraman. Buning uchun avval akkauntlaringizni bog\'lash kerak — bu bir marta qilinadi.',
    '',
    '<b>1-qadam.</b> Instagram\'da <b>@' + escapeHtml(env.IG_ACCOUNT_USERNAME) + '</b> akkauntiga o\'ting.',
    '<b>2-qadam.</b> Unga DM orqali quyidagi kodni yuboring:',
    '',
    `<code>${escapeHtml(linkCode)}</code>`,
    '',
    '<b>3-qadam.</b> "✅ Bog\'landi" javobini olganingizdan so\'ng, yoqqan reels\'ni o\'sha akkauntga "Yuborish" (Send) qiling — men videoni va musiqa nomini shu yerga tashlayman.',
    '',
    `🔗 To'g'ridan-to'g'ri chat: ${IG_PROFILE_URL}`,
  ].join('\n');
}

export function alreadyLinked(igScopedId: string | null): string {
  return [
    '✅ <b>Siz allaqachon bog\'langansiz.</b>',
    '',
    `Instagram'da <b>@${escapeHtml(env.IG_ACCOUNT_USERNAME)}</b> akkauntiga reels yuboravering — men videoni va musiqa nomini shu yerga tashlayman.`,
    '',
    igScopedId ? `<i>IGSID: <code>${escapeHtml(igScopedId)}</code></i>` : '',
    '',
    'Bog\'lanishni bekor qilish: /unlink',
  ]
    .filter(Boolean)
    .join('\n');
}

export const HELP_TEXT = [
  '<b>Buyruqlar</b>',
  '',
  '/start — bog\'lanishni boshlash yoki kodni qayta olish',
  '/status — bog\'lanish holati va oxirgi so\'rovlar',
  '/unlink — bog\'lanishni bekor qilish (yangi kod beriladi)',
  '/help — shu yordam',
  '',
  `<b>Qanday ishlaydi:</b> Instagram'da @${escapeHtml(env.IG_ACCOUNT_USERNAME)} ga reels yuborasiz → men uni yuklab olaman → musiqasini aniqlayman → video + qo'shiq nomini shu yerga yuboraman.`,
].join('\n');

export const NOT_LINKED_HINT =
  '❗️ Siz hali bog\'lanmagansiz. /start bosing va Instagram\'ga kodni yuboring.';

export const IG_NOT_LINKED_REPLY =
  '❗️ Siz hali Telegram botiga bog\'lanmagansiz.\n\n' +
  'Telegram\'da botimizga /start bering, u sizga LINK-XXXXXX ko\'rinishidagi kod beradi. ' +
  'O\'sha kodni shu yerga yuboring — shundan keyin reels tashlashingiz mumkin.';

export const IG_LINK_SUCCESS =
  '✅ Bog\'landi!\n\nEndi yoqqan reels\'ingizni shu yerga "Yuborish" qiling — videoni va musiqa nomini Telegram botingizga yuboraman.';

export const IG_CODE_NOT_FOUND =
  '❌ Bunday kod topilmadi yoki u allaqachon ishlatilgan.\n\n' +
  'Telegram botida /start bosib yangi kod oling.';

export const IG_UNSUPPORTED_ATTACHMENT =
  '🤔 Bu turdagi xabarni qayta ishlay olmayman. Iltimos, reels yoki video yuboring.';

export const IG_QUEUED =
  '⏳ Qabul qilindi! Videoni yuklab, musiqasini aniqlayapman — natijani Telegram\'ga yuboraman.';
