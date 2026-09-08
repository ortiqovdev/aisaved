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
    'Instagram\'dagi reels musiqasini topib beraman.',
    '',
    '⚡️ <b>Tez yo\'l:</b> videoni shu yerga tashlang — musiqa nomini darhol aytaman, hech narsa sozlash shart emas.',
    '',
    '📸 <b>Instagram reels uchun</b> esa bir marta bog\'lanish kerak:',
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
  '<b>Musiqani topishning uch yo\'li bor</b>',
  '',
  '<b>1️⃣ Havola yuboring — eng qulayi</b>',
  'Instagram\'da reels ostidagi <b>Share → Copy link</b> ni bosing va havolani shu yerga tashlang.',
  'Men videoni ham, musiqa nomini ham qaytaraman. Bog\'lanish shart emas.',
  '',
  '<b>2️⃣ Videoni to\'g\'ridan-to\'g\'ri tashlang</b>',
  'Video, GIF, ovozli xabar yoki audio yuboring — musiqa nomini javob qilaman.',
  '(Fayl 20MB gacha bo\'lsin.)',
  '',
  `<b>3️⃣ Instagram DM orqali</b>`,
  `Instagram'da @${escapeHtml(env.IG_ACCOUNT_USERNAME)} ga reels'ni "Yuborish" qilasiz.`,
  'Buning uchun bir marta bog\'lanish kerak: /start',
  '<i>Eslatma: Instagram ba\'zi reels\'larning faylini bermaydi — bunday holatda',
  'sizdan havolani so\'rayman (1-yo\'l).</i>',
  '',
  '<b>Buyruqlar</b>',
  '/start — Instagram bilan bog\'lanish kodini olish',
  '/status — bog\'lanish holati va oxirgi so\'rovlar',
  '/unlink — bog\'lanishni bekor qilish',
  '/help — shu yordam',
].join('\n');


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

export const IG_ALREADY_LINKED =
  '✅ Bu akkaunt allaqachon bog\'langan. Kod yuborish shart emas — to\'g\'ridan-to\'g\'ri reels tashlang.';

/** Attachment turiga qarab aniqroq javob. */
export function igUnsupportedReply(attachmentType: string | null): string {
  switch (attachmentType) {
    case 'image':
      return '🖼 Bu rasm — men esa musiqani videodan aniqlayman. Reels yoki video yuboring.';
    case 'story_mention':
      return '📖 Story\'da eslatganingiz uchun rahmat! Musiqani topish uchun reels\'ni DM orqali "Yuborish" qiling.';
    case 'audio':
    case 'voice':
      return '🎤 Ovozli xabarni emas, reels/video yuboring — musiqani videodan aniqlayman.';
    case 'file':
      return '📎 Faylni emas, Instagram\'dagi reels\'ni "Yuborish" tugmasi orqali yuboring.';
    default:
      return IG_UNSUPPORTED_ATTACHMENT;
  }
}

/**
 * Meta reels uchun video faylini emas, sahifa havolasini yuborgan holat.
 *
 * Bu Meta tomonidagi cheklov: rasmiy API begona reels'ning faylini bermaydi
 * (Graph API "missing permissions", CDN imzosiz 404). Shuning uchun
 * foydalanuvchini ishlaydigan yo'lga — havolani Telegram botiga tashlashga —
 * yo'naltiramiz.
 */
export function igReelNotDownloadable(botUsername: string): string {
  // DIQQAT: bu xabar faqat resolver ULANMAGAN holatda chiqadi. Shuning uchun
  // "havolani Telegram'ga tashlang" deb aytib bo'lmaydi — havola oqimi ham
  // o'sha resolverga tayanadi, ya'ni foydalanuvchini ishlamaydigan yo'lga
  // yuborgan bo'lardik. Faqat HOZIR ishlaydigan yo'lni ko'rsatamiz: faylni
  // to'g'ridan-to'g'ri Telegram'ga tashlash.
  const lines = [
    '😕 Instagram bu reels\'ning video faylini bermadi — bu Instagram tomonidagi cheklov.',
    '',
    'Hozircha videoni o\'zingiz saqlab, Telegram botimizga tashlang —',
    'musiqa nomini darhol topib beraman.',
  ];
  if (botUsername !== '') lines.push('', `👉 https://t.me/${botUsername}`);
  return lines.join('\n');
}

export const IG_QUEUED =
  '⏳ Qabul qilindi! Videoni yuklab, musiqasini aniqlayapman — natijani Telegram\'ga yuboraman.';
