import crypto from 'node:crypto';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { PermanentError, TransientError, fetchWithTimeout, errMessage } from '../lib/errors.ts';
import { igAccessToken, reportIfTokenError } from './ig-token.ts';

/**
 * Meta webhook imzosini tekshiradi (X-Hub-Signature-256).
 * Imzo XOM (raw) body ustidan hisoblanadi — JSON.parse dan keyingi obyekt emas!
 */
export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  // Mock rejimda haqiqiy IG_APP_SECRET yo'q — imzoni tekshirib bo'lmaydi.
  if (env.MOCK_INSTAGRAM) {
    logger.warn('MOCK_MODE: webhook imzosi TEKSHIRILMADI');
    return true;
  }

  if (!signatureHeader) {
    logger.warn('Webhook imzosi yo\'q (x-hub-signature-256)');
    return false;
  }
  const [algo, provided] = signatureHeader.split('=');
  if (algo !== 'sha256' || !provided) {
    logger.warn({ signatureHeader }, 'Webhook imzo formati noto\'g\'ri');
    return false;
  }

  const expected = crypto.createHmac('sha256', env.IG_APP_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Instagram DM orqali matnli javob yuboradi.
 * DIQQAT: Meta "24 soatlik oyna" qoidasi — foydalanuvchi yozgandan keyin
 * 24 soat ichida javob berish mumkin. Biz webhook kelgan zahoti javob
 * berayotganimiz uchun bu shart bajariladi.
 */
/** Xabar ostidagi tugma: bosilganda `title` matni `payload` bilan qaytib keladi. */
export interface IgQuickReply {
  /** Instagram limiti — 20 belgi. */
  title: string;
  payload: string;
}

export async function sendInstagramText(
  igScopedId: string,
  text: string,
  quickReplies: IgQuickReply[] = [],
): Promise<void> {
  if (env.MOCK_INSTAGRAM) {
    logger.info({ igScopedId, text, quickReplies }, '📨 [MOCK] Instagram DM (haqiqatda yuborilmadi)');
    return;
  }

  const url = `${env.IG_GRAPH_BASE_URL}/me/messages`;

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${igAccessToken()}`,
      },
      body: JSON.stringify({
        recipient: { id: igScopedId },
        message: {
          text,
          ...(quickReplies.length > 0
            ? {
                quick_replies: quickReplies.map((q) => ({
                  content_type: 'text',
                  title: q.title,
                  payload: q.payload,
                })),
              }
            : {}),
        },
      }),
    },
    20_000,
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    reportIfTokenError(res.status, body);
    // 429 / 5xx — vaqtinchalik, qolganlari doimiy (token, ruxsat, 24-soat oynasi)
    if (res.status === 429 || res.status >= 500) {
      throw new TransientError(`Instagram send ${res.status}: ${body.slice(0, 400)}`);
    }
    throw new PermanentError(`Instagram send ${res.status}: ${body.slice(0, 400)}`);
  }

  logger.debug({ igScopedId }, 'Instagram DM yuborildi');
}

/** Xato bo'lsa ham asosiy oqimni to'xtatmaydigan variant. */
export async function trySendInstagramText(
  igScopedId: string,
  text: string,
  quickReplies: IgQuickReply[] = [],
): Promise<void> {
  try {
    await sendInstagramText(igScopedId, text, quickReplies);
  } catch (e) {
    logger.warn({ igScopedId, err: errMessage(e) }, 'Instagram DM yuborilmadi');
  }
}

/**
 * Havola tugmali xabar (button template, `web_url`). Instagram shablonni
 * qabul qilmasa — matn va oxirida havola (DM'da havola bosiladigan bo'ladi).
 */
export async function trySendInstagramLinkButton(
  igScopedId: string,
  text: string,
  buttonTitle: string,
  url: string,
): Promise<void> {
  if (env.MOCK_INSTAGRAM) {
    logger.info({ igScopedId, text, url }, '📨 [MOCK] Instagram havola tugmasi (haqiqatda yuborilmadi)');
    return;
  }
  try {
    const res = await postMessagesApi({
      recipient: { id: igScopedId },
      message: {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            // Instagram limitlari: matn 640, tugma nomi 20 belgi
            text: text.slice(0, 640),
            buttons: [{ type: 'web_url', url, title: buttonTitle.slice(0, 20) }],
          },
        },
      },
    });
    if (res.ok) return;
    logger.warn({ igScopedId, status: res.status, body: res.body.slice(0, 300) }, 'Tugmali shablon o\'tmadi — oddiy havola yuboriladi');
  } catch (e) {
    logger.warn({ igScopedId, err: errMessage(e) }, 'Tugmali shablon yuborilmadi — oddiy havola yuboriladi');
  }
  await trySendInstagramText(igScopedId, `${text}\n\n👉 ${url}`);
}

export interface IgProfile {
  username: string | null;
  name: string | null;
  /** Foydalanuvchi bizning akkauntga obuna bo'lganmi; null — aniqlab bo'lmadi. */
  followsUs: boolean | null;
}

/**
 * Bizga yozgan foydalanuvchining profili (Instagram User Profile API).
 * Faqat bizga DM yozgan foydalanuvchi uchun ishlaydi. Xato bo'lsa — maydonlar
 * null: bog'lanish Meta'dagi nosozlik tufayli to'xtab qolmasin.
 */
export async function getInstagramProfile(igScopedId: string): Promise<IgProfile> {
  if (env.MOCK_INSTAGRAM) return { username: `mock_${igScopedId}`, name: null, followsUs: true };

  try {
    const res = await fetchWithTimeout(
      `${env.IG_GRAPH_BASE_URL}/${encodeURIComponent(igScopedId)}?fields=username,name,is_user_follow_business`,
      { headers: { Authorization: `Bearer ${igAccessToken()}` } },
      10_000,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      reportIfTokenError(res.status, body);
      logger.warn({ igScopedId, status: res.status, body: body.slice(0, 300) }, 'Instagram profilini olib bo\'lmadi');
      return { username: null, name: null, followsUs: null };
    }
    const j = (await res.json()) as { username?: string; name?: string; is_user_follow_business?: boolean };
    return {
      username: j.username ?? null,
      name: j.name ?? null,
      followsUs: typeof j.is_user_follow_business === 'boolean' ? j.is_user_follow_business : null,
    };
  } catch (e) {
    logger.warn({ igScopedId, err: errMessage(e) }, 'Instagram profilini olib bo\'lmadi');
    return { username: null, name: null, followsUs: null };
  }
}

export type SenderAction = 'mark_seen' | 'typing_on' | 'typing_off';

/** `/me/messages` ga POST — natijasi (ok, status, body) chaqiruvchiga qaytadi. */
async function postMessagesApi(
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetchWithTimeout(
    `${env.IG_GRAPH_BASE_URL}/me/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${igAccessToken()}`,
      },
      body: JSON.stringify(payload),
    },
    10_000,
  );
  const body = res.ok ? '' : await res.text().catch(() => '');
  if (!res.ok) reportIfTokenError(res.status, body);
  return { ok: res.ok, status: res.status, body };
}

/**
 * "Ko'rildi" belgisi va "yozmoqda..." indikatori.
 * Foydalanuvchi javob kutayotganini bilib turadi — bu yerda xato bo'lsa
 * asosiy oqim to'xtamaydi, shuning uchun faqat log qilamiz.
 */
export async function trySendInstagramAction(
  igScopedId: string,
  action: SenderAction,
): Promise<void> {
  if (env.MOCK_INSTAGRAM) {
    logger.debug({ igScopedId, action }, '👀 [MOCK] Instagram sender_action');
    return;
  }

  try {
    const res = await postMessagesApi({ recipient: { id: igScopedId }, sender_action: action });
    if (!res.ok) {
      logger.debug({ igScopedId, action, status: res.status }, 'sender_action qabul qilinmadi');
    }
  } catch (e) {
    logger.debug({ igScopedId, action, err: errMessage(e) }, 'sender_action yuborilmadi');
  }
}

/**
 * Foydalanuvchi yuborgan xabarga qo'yiladigan reaksiya — Instagram chatini
 * matnli xabarlar bilan to'ldirmaslik uchun holat SHU bilan bildiriladi
 * (bitta xabarda bitta reaksiya — yangisi eskisining o'rnini oladi):
 *   ⌛ qabul qilindi, ishlanmoqda → ✅ natija Telegram'ga yuborildi
 *                                 → ❌ xato (sababi Telegram'ga yoziladi)
 *   🔗 bog'lash kodi qabul qilindi
 * (API emoji'ni to'g'ridan-to'g'ri qabul qiladi.)
 */
export const IG_REACTION = { wait: '⌛', ok: '✅', fail: '❌', linked: '🔗' } as const;
export type IgReaction = (typeof IG_REACTION)[keyof typeof IG_REACTION];

/**
 * Meta "react" so'rovini shu app/akkaunt uchun doim "code 2, is_transient"
 * xatosi bilan rad etadi — Meta'ning o'z tavsiyasiga ko'ra qayta urinish
 * (3s/15s/45s) ham yordam bermadi: loglardagi 75/75 urinish (⌛/✅/❌/🔗,
 * hammasi baravar) muvaffaqiyatsiz. Shuning uchun o'chirilgan — 63 soniyalik
 * kutish va log shovqinidan boshqa foyda bermasdi.
 *
 * @returns doim `false` — chaqiruvchilar (masalan `failInInstagram`) matnli
 *          zaxiraga o'tadi, xuddi hozirgi (har doim rad etiladigan) holatdagidek.
 */
export async function trySendInstagramReaction(
  igScopedId: string,
  _messageId: string,
  reaction: IgReaction,
): Promise<boolean> {
  if (env.MOCK_INSTAGRAM) {
    logger.info({ igScopedId, reaction }, '💬 [MOCK] Instagram reaksiya (haqiqatda qo\'yilmadi)');
    return true;
  }
  return false;
}

/**
 * Telegram HTML matnini Instagram uchun oddiy matnga aylantiradi
 * (Instagram DM teglarni ko'rsatmaydi — `<b>` harfma-harf chiqib qolardi).
 */
export function toPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * `requests.ig_message_id` Instagram DM'ning `mid` i bo'lsagina reaksiya
 * qo'yish mumkin. Telegram'dan kelgan so'rovlarda u `tg:` bilan boshlanadi.
 */
export function instagramMessageIdOf(igMessageId: string | null): string | null {
  if (!igMessageId || igMessageId.startsWith('tg:')) return null;
  return igMessageId;
}

// ---------------------------------------------------------------------------
// Webhook payload tiplari (Meta Instagram Messaging)
// ---------------------------------------------------------------------------

export interface IgAttachment {
  type: string; // ig_reel | video | image | share | story_mention | audio ...
  payload?: {
    url?: string;
    title?: string;
    reel_video_id?: string;
  };
}

export interface IgMessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    is_deleted?: boolean;
    is_unsupported?: boolean;
    attachments?: IgAttachment[];
    /** Quick reply tugmasi bosilganda — biz bergan payload. */
    quick_reply?: { payload?: string };
  };
  read?: unknown;
  reaction?: unknown;
  postback?: unknown;
}

export interface IgWebhookBody {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    messaging?: IgMessagingEvent[];
  }>;
}

/**
 * Media deb hisoblanadigan attachment turlari.
 *
 * `ig_post` ham shu ro'yxatda: Meta ulashilgan post uchun HAQIQIY CDN
 * havolasini beradi (lookaside.fbsbx.com/...&signature=...) va u yuklab
 * olinadi — ilgari bu tur ro'yxatda yo'q edi, shuning uchun bunday xabar
 * jimgina tashlab yuborilar, foydalanuvchi esa umuman javob olmasdi.
 */
const VIDEO_ATTACHMENT_TYPES = new Set(['ig_reel', 'reel', 'video', 'share', 'ig_post']);

/**
 * Havola yuklab olinadigan MEDIA faylimi yoki shunchaki sahifa havolasimi?
 *
 * Meta `ig_reel` uchun ko'pincha video o'rniga reels SAHIFASINI yuboradi
 * (`instagram.com/reel/XXX/`) — u `text/html` qaytaradi va undan video
 * ajratib bo'lmaydi. Buni oldindan aniqlab, foydalanuvchiga haqiqiy sababni
 * aytamiz; aks holda u "havola eskirgan" degan chalg'ituvchi xabar oladi.
 */
export function isDownloadableMediaUrl(url: string): boolean {
  return !/^https?:\/\/(?:www\.)?instagram\.com\//i.test(url);
}

export interface ExtractedMedia {
  url: string;
  type: string;
  /** false — bu sahifa havolasi, video fayl emas. */
  downloadable: boolean;
}

/** Eventdan media havolasini ajratadi (bo'lmasa null). */
export function extractVideoAttachment(event: IgMessagingEvent): ExtractedMedia | null {
  const attachments = event.message?.attachments ?? [];

  // Yuklab olinadigani ustunroq: bitta xabarda ham sahifa havolasi, ham CDN
  // havolasi kelishi mumkin — bunda albatta CDN'nikini tanlaymiz.
  let fallback: ExtractedMedia | null = null;

  for (const att of attachments) {
    const url = att.payload?.url;
    if (!url || !VIDEO_ATTACHMENT_TYPES.has(att.type)) continue;

    const media: ExtractedMedia = { url, type: att.type, downloadable: isDownloadableMediaUrl(url) };
    if (media.downloadable) return media;
    fallback ??= media;
  }
  return fallback;
}

/** Birinchi attachment turi — mos javob matnini tanlash uchun. */
export function firstAttachmentType(event: IgMessagingEvent): string | null {
  return event.message?.attachments?.[0]?.type ?? null;
}

/** Barcha entry'lardagi messaging eventlarni bitta ro'yxatga yig'adi. */
export function flattenEvents(body: IgWebhookBody): IgMessagingEvent[] {
  const out: IgMessagingEvent[] = [];
  for (const entry of body.entry ?? []) {
    for (const ev of entry.messaging ?? []) out.push(ev);
  }
  return out;
}
