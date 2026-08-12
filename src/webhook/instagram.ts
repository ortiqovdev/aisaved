import { Router, type Request, type Response } from 'express';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import * as usersRepo from '../db/users.repo.ts';
import * as requestsRepo from '../db/requests.repo.ts';
import {
  extractVideoAttachment,
  flattenEvents,
  trySendInstagramText,
  verifyWebhookSignature,
  type IgMessagingEvent,
  type IgWebhookBody,
} from '../services/instagram.ts';
import { trySendText } from '../bot/notify.ts';
import {
  IG_CODE_NOT_FOUND,
  IG_LINK_SUCCESS,
  IG_NOT_LINKED_REPLY,
  IG_QUEUED,
  IG_UNSUPPORTED_ATTACHMENT,
  escapeHtml,
} from '../bot/messages.ts';

export const instagramWebhookRouter = Router();

/** Express so'roviga qo'shilgan xom body (imzo tekshirish uchun). */
type RequestWithRawBody = Request & { rawBody?: Buffer };

// ---------------------------------------------------------------------------
// GET — Meta webhook verification (hub.challenge)
// ---------------------------------------------------------------------------
instagramWebhookRouter.get('/', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === env.IG_WEBHOOK_VERIFY_TOKEN && typeof challenge === 'string') {
    logger.info('Instagram webhook verification muvaffaqiyatli');
    res.status(200).type('text/plain').send(challenge);
    return;
  }

  logger.warn({ mode, tokenMatches: token === env.IG_WEBHOOK_VERIFY_TOKEN }, 'Webhook verification rad etildi');
  res.sendStatus(403);
});

// ---------------------------------------------------------------------------
// POST — kiruvchi eventlar
//
// Meta 20 soniya ichida 200 kutadi, aks holda webhookni qayta yuboradi va
// ko'p urinishdan keyin obunani o'chirib qo'yishi mumkin. Shuning uchun
// darhol 200 qaytarib, ishlov berishni fon rejimida bajaramiz.
// ---------------------------------------------------------------------------
instagramWebhookRouter.post('/', (req: Request, res: Response) => {
  const rawBody = (req as RequestWithRawBody).rawBody;

  if (!rawBody || !verifyWebhookSignature(rawBody, req.header('x-hub-signature-256'))) {
    logger.warn('Webhook imzosi noto\'g\'ri — so\'rov rad etildi');
    res.sendStatus(403);
    return;
  }

  res.sendStatus(200);

  const body = req.body as IgWebhookBody;
  void handleWebhookBody(body).catch((e) => {
    logger.error({ err: errMessage(e) }, 'Webhook ishlov berishda kutilmagan xato');
  });
});

// ---------------------------------------------------------------------------
// Ishlov berish
// ---------------------------------------------------------------------------

async function handleWebhookBody(body: IgWebhookBody): Promise<void> {
  if (body.object !== 'instagram') {
    logger.debug({ object: body.object }, 'Instagram bo\'lmagan webhook — e\'tiborsiz qoldirildi');
    return;
  }

  for (const event of flattenEvents(body)) {
    try {
      await handleEvent(event);
    } catch (e) {
      logger.error({ err: errMessage(e), mid: event.message?.mid }, 'Event ishlov berishda xato');
    }
  }
}

async function handleEvent(event: IgMessagingEvent): Promise<void> {
  const senderId = event.sender?.id;
  const message = event.message;

  // O'zimiz yuborgan xabarlarning aks-sadosi, o'chirilgan xabarlar,
  // read/reaction/postback eventlari — bizga kerak emas.
  if (!senderId || !message || message.is_echo || message.is_deleted) return;

  // Bizning akkauntimizdan kelgan bo'lsa — o'tkazib yuboramiz
  if (senderId === event.recipient?.id) return;

  const media = extractVideoAttachment(event);
  if (media) {
    await handleMedia(senderId, event, media.url, media.type);
    return;
  }

  if (typeof message.text === 'string' && message.text.trim() !== '') {
    await handleText(senderId, message.text);
    return;
  }

  // Rasm, stiker, ovozli xabar va h.k.
  if ((message.attachments?.length ?? 0) > 0 || message.is_unsupported) {
    await trySendInstagramText(senderId, IG_UNSUPPORTED_ATTACHMENT);
  }
}

/** Matnli xabar — bog'lash kodi bo'lishi mumkin. */
async function handleText(igScopedId: string, text: string): Promise<void> {
  const code = usersRepo.normalizeLinkCode(text);

  if (!code) {
    const linked = await usersRepo.findByIgScopedId(igScopedId);
    await trySendInstagramText(
      igScopedId,
      linked
        ? '👋 Menga reels yuboring — videoni va musiqa nomini Telegram botingizga tashlayman.'
        : IG_NOT_LINKED_REPLY,
    );
    return;
  }

  const user = await usersRepo.linkUserByCode(code, igScopedId);
  if (!user) {
    logger.info({ igScopedId, code }, 'Bog\'lash kodi topilmadi');
    await trySendInstagramText(igScopedId, IG_CODE_NOT_FOUND);
    return;
  }

  logger.info({ userId: user.id, telegramId: user.telegram_id, igScopedId }, 'Akkaunt bog\'landi');

  await trySendInstagramText(igScopedId, IG_LINK_SUCCESS);
  await trySendText(
    user.telegram_id,
    [
      '✅ <b>Instagram akkauntingiz bog\'landi!</b>',
      '',
      `Endi Instagram'da <b>@${escapeHtml(env.IG_ACCOUNT_USERNAME)}</b> ga reels yuboring — `,
      'videoni va musiqa nomini shu yerga tashlayman.',
    ].join('\n'),
  );
}

/** Media (reels/video) — navbatga qo'yiladi. */
async function handleMedia(
  igScopedId: string,
  event: IgMessagingEvent,
  mediaUrl: string,
  mediaType: string,
): Promise<void> {
  const user = await usersRepo.findByIgScopedId(igScopedId);

  if (!user || user.link_status !== 'linked') {
    logger.info({ igScopedId }, 'Bog\'lanmagan foydalanuvchidan media keldi');
    await trySendInstagramText(igScopedId, IG_NOT_LINKED_REPLY);
    return;
  }

  const row = await requestsRepo.enqueue({
    userId: user.id,
    igMessageId: event.message?.mid ?? null,
    mediaUrl,
    mediaType,
  });

  if (!row) return; // dublikat webhook — javob ham takrorlanmasin

  logger.info({ requestId: row.id, userId: user.id, mediaType }, 'Navbatga qo\'shildi');
  await trySendInstagramText(igScopedId, IG_QUEUED);
  await trySendText(user.telegram_id, '⏳ Reels qabul qilindi, ishlov berilmoqda...');
}
