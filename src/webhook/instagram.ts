import { Router, type Request, type Response } from 'express';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import * as usersRepo from '../db/users.repo.ts';
import * as requestsRepo from '../db/requests.repo.ts';
import {
  IG_REACTION,
  extractVideoAttachment,
  firstAttachmentType,
  flattenEvents,
  trySendInstagramAction,
  trySendInstagramReaction,
  trySendInstagramText,
  verifyWebhookSignature,
  type ExtractedMedia,
  type IgMessagingEvent,
  type IgWebhookBody,
} from '../services/instagram.ts';
import { isResolverConfigured, parseInstagramLink } from '../services/ig-resolver.ts';
import { IG_LINK_SOURCE } from '../lib/constants.ts';
import { trySendText } from '../bot/notify.ts';
import { rememberStatusCard, sendStatusCard } from '../bot/status-card.ts';
import { wakeWorkers } from '../workers/wake.ts';
import { escapeHtml, unsupportedReplyKey } from '../bot/messages.ts';
import { t } from '../i18n/index.ts';
import { langOfUser } from '../i18n/user-lang.ts';

/**
 * Tillar haqida: Instagram webhook'ida foydalanuvchi tili kelmaydi. Bog'langan
 * (yoki kod orqali topilgan) foydalanuvchiga uning Telegram'dagi tilida
 * yoziladi, notanish akkauntga esa standart tilda (DEFAULT_LANG).
 */

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

  /**
   * Attachment payloadining xom ko'rinishi — Meta formatni o'zgartirganda
   * yoki yangi tur paydo bo'lganda tekshirish uchun asqotadi.
   *
   * `debug` darajasida: payload ichida foydalanuvchining post matni (caption)
   * bo'ladi, uni odatiy logga yozib yurishning hojati yo'q. Kerak bo'lganda
   * `LOG_LEVEL=debug` bilan yoqiladi.
   */
  if ((message.attachments?.length ?? 0) > 0) {
    logger.debug(
      { attachments: JSON.stringify(message.attachments) },
      'Instagram attachment payload',
    );
  }

  const media = extractVideoAttachment(event);
  if (media) {
    await handleMedia(senderId, event, media);
    return;
  }

  if (typeof message.text === 'string' && message.text.trim() !== '') {
    await handleText(senderId, message.text);
    return;
  }

  // Rasm, stiker, ovozli xabar va h.k.
  if ((message.attachments?.length ?? 0) > 0 || message.is_unsupported) {
    await handleUnsupported(senderId, event);
  }
}

/** Xabarga reaksiya qo'yadi (`mid` bo'lmasa — jim o'tadi). */
async function react(igScopedId: string, event: IgMessagingEvent, ok: boolean): Promise<void> {
  const mid = event.message?.mid;
  if (!mid) return;
  await trySendInstagramReaction(igScopedId, mid, ok ? IG_REACTION.ok : IG_REACTION.fail);
}

/**
 * Qayta ishlab bo'lmaydigan attachment (rasm, stiker, ovozli xabar...).
 * Instagram'da faqat ❌ reaksiya; sababi bog'langan foydalanuvchiga
 * Telegram'da aytiladi. Bog'lanmagan foydalanuvchining esa Telegram'i
 * noma'lum — unga Instagram'ning o'zida yozishdan boshqa yo'l yo'q.
 */
async function handleUnsupported(igScopedId: string, event: IgMessagingEvent): Promise<void> {
  await react(igScopedId, event, false);

  const key = unsupportedReplyKey(firstAttachmentType(event));
  const user = await usersRepo.findByIgScopedId(igScopedId);
  const reply = t(langOfUser(user), key);
  if (user?.link_status === 'linked') {
    await trySendText(user.telegram_id, reply);
  } else {
    await trySendInstagramText(igScopedId, reply);
  }
}

/** Matnli xabar — bog'lash kodi bo'lishi mumkin. */
async function handleText(igScopedId: string, text: string): Promise<void> {
  const code = usersRepo.normalizeLinkCode(text);
  const existing = await usersRepo.findByIgScopedId(igScopedId);
  // Qator topilishining o'zi yetarli emas — holati ham 'linked' bo'lishi kerak
  const isLinked = existing?.link_status === 'linked';
  const lang = langOfUser(existing);

  if (!code) {
    await trySendInstagramText(igScopedId, t(lang, isLinked ? 'igSendReels' : 'igNotLinked'));
    return;
  }

  // Allaqachon bog'langan akkaunt kod yuborsa, "kod topilmadi" degan
  // chalkash javob bermaymiz.
  if (isLinked) {
    await trySendInstagramText(igScopedId, t(lang, 'igAlreadyLinked'));
    return;
  }

  const user = await usersRepo.linkUserByCode(code, igScopedId);
  if (!user) {
    logger.info({ igScopedId, code }, 'Bog\'lash kodi topilmadi');
    await trySendInstagramText(igScopedId, t(lang, 'igCodeNotFound'));
    return;
  }

  logger.info({ userId: user.id, telegramId: user.telegram_id, igScopedId }, 'Akkaunt bog\'landi');

  // Kod egasi topildi — endi uning tili ma'lum
  const userLang = langOfUser(user);
  await trySendInstagramText(igScopedId, t(userLang, 'igLinkSuccess'));
  await trySendText(
    user.telegram_id,
    t(userLang, 'igLinkedTelegram', { account: escapeHtml(env.IG_ACCOUNT_USERNAME) }),
  );
}

/**
 * Media (reels/video) — navbatga qo'yiladi.
 *
 * Instagram'da foydalanuvchiga matn yozilmaydi: natija ham, xato sababi ham
 * Telegram'ga boradi. Instagram'dagi holat — reelsdagi reaksiya: muammo
 * bo'lsa shu yerda ❌, hammasi joyida bo'lsa worker oxirida ✅ qo'yadi.
 */
async function handleMedia(
  igScopedId: string,
  event: IgMessagingEvent,
  media: ExtractedMedia,
): Promise<void> {
  const user = await usersRepo.findByIgScopedId(igScopedId);

  if (!user || user.link_status !== 'linked') {
    logger.info({ igScopedId }, 'Bog\'lanmagan foydalanuvchidan media keldi');
    await react(igScopedId, event, false);
    // Istisno: bog'lanmagan foydalanuvchining Telegram'i noma'lum — bog'lanish
    // yo'lini faqat shu yerda aytish mumkin, aks holda u nima qilishni bilmaydi.
    await trySendInstagramText(igScopedId, t(langOfUser(user), 'igNotLinked'));
    return;
  }
  const lang = langOfUser(user);

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
    await react(igScopedId, event, false);
    await trySendText(user.telegram_id, t(lang, 'igNotDownloadable'));
    return;
  }

  // Spam himoyasi + navbat — bitta so'rovda (0005). Media keshi shu yerda
  // emas, worker'da tekshiriladi: Meta webhook'ni qayta yuborsa, dublikatni
  // faqat navbat ushlaydi — keshdan to'g'ridan-to'g'ri yuborsak ikki marta ketardi.
  const result = await requestsRepo.enqueueWithLimit({
    userId: user.id,
    igMessageId: event.message?.mid ?? null,
    // Havola bo'lsa kanonik ko'rinishini saqlaymiz — worker uni resolver
    // orqali yechadi; CDN havolasi bo'lsa o'zini (u darhol yuklanadi).
    mediaUrl: link ? link.url : media.url,
    mediaType: link ? IG_LINK_SOURCE : media.type,
    // Shortcode doimiy — media keshi va musiqa keshining kaliti
    ...(link ? { fileUniqueId: `ig:${link.shortcode}` } : {}),
  });

  if (result.status === 'limit') {
    logger.info({ userId: user.id, pending: result.pending }, 'Foydalanuvchi navbat limitiga yetdi');
    await react(igScopedId, event, false);
    await trySendText(user.telegram_id, t(lang, 'igPendingLimit', { n: result.pending }));
    return;
  }
  if (result.status === 'duplicate') return; // dublikat webhook — javob ham takrorlanmasin
  const row = result.row;

  logger.info(
    { requestId: row.id, userId: user.id, mediaType: media.type, viaResolver },
    'Navbatga qo\'shildi',
  );

  // Telegram'da "⏳ Reels qabul qilindi" kartasi — natija shu xabarning o'rniga
  // chiqadi. Bu yerda karta navbatdan KEYIN: Meta webhook'ni tez-tez qayta
  // yuboradi, dublikatga karta chiqib-o'chib bildirishnoma bermasin.
  const statusId = await sendStatusCard(user.telegram_id, lang, 'igReelQueued');
  if (statusId) {
    rememberStatusCard(row.id, statusId);
    await requestsRepo.setStatusMessageId(row.id, statusId).catch((e: unknown) =>
      logger.debug({ err: errMessage(e) }, 'status_message_id saqlanmadi (xotirada bor)'),
    );
  }
  // Karta saqlangandan KEYIN uyg'otamiz — aks holda tez worker kartani
  // topmay natijani yangi xabar qilib yuborardi
  wakeWorkers();
}
