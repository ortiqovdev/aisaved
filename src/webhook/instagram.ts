import { Router, type Request, type Response } from 'express';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import * as usersRepo from '../db/users.repo.ts';
import * as requestsRepo from '../db/requests.repo.ts';
import {
  extractVideoAttachment,
  firstAttachmentType,
  flattenEvents,
  trySendInstagramAction,
  trySendInstagramText,
  verifyWebhookSignature,
  type ExtractedMedia,
  type IgMessagingEvent,
  type IgWebhookBody,
} from '../services/instagram.ts';
import { isResolverConfigured, parseInstagramLink } from '../services/ig-resolver.ts';
import { IG_LINK_SOURCE } from '../lib/constants.ts';
import { trySendText } from '../bot/notify.ts';
import { getBotUsername } from '../bot/index.ts';
import {
  IG_ALREADY_LINKED,
  IG_CODE_NOT_FOUND,
  IG_LINK_SUCCESS,
  IG_NOT_LINKED_REPLY,
  IG_QUEUED,
  escapeHtml,
  igReelNotDownloadable,
  igUnsupportedReply,
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

export async function handleWebhookBody(body: IgWebhookBody): Promise<void> {
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

  // "Ko'rildi" — foydalanuvchi xabari yetib borganini darhol biladi
  await trySendInstagramAction(senderId, 'mark_seen');

  // VAQTINCHALIK DIAGNOSTIKA: Meta reels uchun qanday payload yuborayotganini
  // ko'rish uchun. Media havolasi muammosi hal bo'lgach olib tashlanadi.
  if ((message.attachments?.length ?? 0) > 0) {
    logger.info(
      { attachments: JSON.stringify(message.attachments) },
      '🔍 Instagram attachment payload (diagnostika)',
    );
  }

  const media = extractVideoAttachment(event);
  if (media) {
    await trySendInstagramAction(senderId, 'typing_on');
    await handleMedia(senderId, event, media);
    return;
  }

  if (typeof message.text === 'string' && message.text.trim() !== '') {
    await handleText(senderId, message.text);
    return;
  }

  // Rasm, stiker, ovozli xabar va h.k.
  if ((message.attachments?.length ?? 0) > 0 || message.is_unsupported) {
    await trySendInstagramText(senderId, igUnsupportedReply(firstAttachmentType(event)));
  }
}

/** Matnli xabar — bog'lash kodi bo'lishi mumkin. */
async function handleText(igScopedId: string, text: string): Promise<void> {
  const code = usersRepo.normalizeLinkCode(text);
  const existing = await usersRepo.findByIgScopedId(igScopedId);
  // Qator topilishining o'zi yetarli emas — holati ham 'linked' bo'lishi kerak
  const isLinked = existing?.link_status === 'linked';

  if (!code) {
    await trySendInstagramText(
      igScopedId,
      isLinked
        ? '👋 Menga reels yuboring — videoni va musiqa nomini Telegram botingizga tashlayman.'
        : IG_NOT_LINKED_REPLY,
    );
    return;
  }

  // Allaqachon bog'langan akkaunt kod yuborsa, "kod topilmadi" degan
  // chalkash javob bermaymiz.
  if (isLinked) {
    await trySendInstagramText(igScopedId, IG_ALREADY_LINKED);
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
  media: ExtractedMedia,
): Promise<void> {
  const user = await usersRepo.findByIgScopedId(igScopedId);

  if (!user || user.link_status !== 'linked') {
    logger.info({ igScopedId }, 'Bog\'lanmagan foydalanuvchidan media keldi');
    await trySendInstagramText(igScopedId, IG_NOT_LINKED_REPLY);
    return;
  }

  /**
   * Meta ba'zi reels uchun video fayl o'rniga reels SAHIFASINING havolasini
   * yuboradi (`instagram.com/reel/XXX/`). U `text/html` qaytaradi, ya'ni
   * to'g'ridan-to'g'ri yuklab bo'lmaydi.
   *
   * Bunday havolani foydalanuvchiga qaytarib "o'zingiz tashlang" deyish shart
   * emas — bu aynan resolver hal qiladigan ish. Shuning uchun jobni HAVOLA
   * turida navbatga qo'yamiz: worker uni yechadi, videoni yuklaydi va natija
   * baribir Telegram'ga VIDEO bo'lib boradi — foydalanuvchi uchun farqi yo'q.
   */
  const link = media.downloadable ? null : parseInstagramLink(media.url);
  const viaResolver = link !== null && isResolverConfigured();

  if (!media.downloadable && !viaResolver) {
    // Resolver ulanmagan (yoki havola tanilmadi) — bu yagona holat, bunda
    // foydalanuvchiga ishlaydigan muqobil yo'lni ko'rsatamiz.
    logger.warn(
      { igScopedId, type: media.type, url: media.url, resolver: isResolverConfigured() },
      'Meta media o\'rniga sahifa havolasini yubordi, resolver esa yo\'q',
    );
    await trySendInstagramText(igScopedId, igReelNotDownloadable(getBotUsername()));
    await trySendText(
      user.telegram_id,
      '😕 Instagram bu reels\'ning video faylini bermadi.\n\n' +
        'Reels havolasini nusxalab (Share → Copy link) shu yerga tashlang — ' +
        'videoni ham, musiqa nomini ham yuboraman.',
    );
    return;
  }

  // Spam himoyasi — bitta akkaunt navbatni va AudD limitini yeb qo'ymasin
  const pending = await requestsRepo.pendingCountForUser(user.id);
  if (pending >= env.MAX_PENDING_PER_USER) {
    logger.info({ userId: user.id, pending }, 'Foydalanuvchi navbat limitiga yetdi');
    await trySendInstagramText(
      igScopedId,
      `⏳ Sizning ${pending} ta so'rovingiz hali navbatda. Ular tugagach yangisini yuboring.`,
    );
    return;
  }

  const row = await requestsRepo.enqueue({
    userId: user.id,
    igMessageId: event.message?.mid ?? null,
    // Havola bo'lsa kanonik ko'rinishini saqlaymiz — worker uni resolver
    // orqali yechadi; CDN havolasi bo'lsa o'zini (u darhol yuklanadi).
    mediaUrl: link ? link.url : media.url,
    mediaType: link ? IG_LINK_SOURCE : media.type,
    // Shortcode doimiy: ayni reels qayta yuborilsa musiqa keshdan olinadi
    ...(link ? { fileUniqueId: `ig:${link.shortcode}` } : {}),
  });

  if (!row) return; // dublikat webhook — javob ham takrorlanmasin

  logger.info(
    { requestId: row.id, userId: user.id, mediaType: media.type, viaResolver },
    'Navbatga qo\'shildi',
  );
  await trySendInstagramText(igScopedId, IG_QUEUED);
  await trySendText(user.telegram_id, '⏳ Reels qabul qilindi, ishlov berilmoqda...');
}
