import crypto from 'node:crypto';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { PermanentError, TransientError, fetchWithTimeout, errMessage } from '../lib/errors.ts';

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
export async function sendInstagramText(igScopedId: string, text: string): Promise<void> {
  if (env.MOCK_INSTAGRAM) {
    logger.info({ igScopedId, text }, '📨 [MOCK] Instagram DM (haqiqatda yuborilmadi)');
    return;
  }

  const url = `${env.IG_GRAPH_BASE_URL}/me/messages`;

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.IG_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        recipient: { id: igScopedId },
        message: { text },
      }),
    },
    20_000,
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // 429 / 5xx — vaqtinchalik, qolganlari doimiy (token, ruxsat, 24-soat oynasi)
    if (res.status === 429 || res.status >= 500) {
      throw new TransientError(`Instagram send ${res.status}: ${body.slice(0, 400)}`);
    }
    throw new PermanentError(`Instagram send ${res.status}: ${body.slice(0, 400)}`);
  }

  logger.debug({ igScopedId }, 'Instagram DM yuborildi');
}

/** Xato bo'lsa ham asosiy oqimni to'xtatmaydigan variant. */
export async function trySendInstagramText(igScopedId: string, text: string): Promise<void> {
  try {
    await sendInstagramText(igScopedId, text);
  } catch (e) {
    logger.warn({ igScopedId, err: errMessage(e) }, 'Instagram DM yuborilmadi');
  }
}

export type SenderAction = 'mark_seen' | 'typing_on' | 'typing_off';

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
    const res = await fetchWithTimeout(
      `${env.IG_GRAPH_BASE_URL}/me/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.IG_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({ recipient: { id: igScopedId }, sender_action: action }),
      },
      10_000,
    );
    if (!res.ok) {
      logger.debug({ igScopedId, action, status: res.status }, 'sender_action qabul qilinmadi');
    }
  } catch (e) {
    logger.debug({ igScopedId, action, err: errMessage(e) }, 'sender_action yuborilmadi');
  }
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

/** Reels/video deb hisoblanadigan attachment turlari. */
const VIDEO_ATTACHMENT_TYPES = new Set(['ig_reel', 'reel', 'video', 'share']);

export interface ExtractedMedia {
  url: string;
  type: string;
}

/** Eventdan yuklab olinadigan video havolasini ajratadi (bo'lmasa null). */
export function extractVideoAttachment(event: IgMessagingEvent): ExtractedMedia | null {
  const attachments = event.message?.attachments ?? [];
  for (const att of attachments) {
    const url = att.payload?.url;
    if (!url) continue;
    if (VIDEO_ATTACHMENT_TYPES.has(att.type)) {
      return { url, type: att.type };
    }
  }
  return null;
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
