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
  getInstagramProfile,
  trySendInstagramAction,
  toPlainText,
  trySendInstagramReaction,
  trySendInstagramText,
  verifyWebhookSignature,
  type ExtractedMedia,
  type IgMessagingEvent,
  type IgWebhookBody,
  type IgReaction,
} from '../services/instagram.ts';
import { canResolveInstagram, parseInstagramLink } from '../services/ig-resolver.ts';
import { IG_LINK_SOURCE } from '../lib/constants.ts';
import { trySendText } from '../bot/notify.ts';
import { rememberStatusCard, sendStatusCard } from '../bot/status-card.ts';
import { wakeWorkers } from '../workers/wake.ts';
import { startPreparing } from '../services/prepare.ts';
import { escapeHtml, formatDate, igAccountLabel, unsupportedReplyKey } from '../bot/messages.ts';
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
  // Webhook umuman kelyaptimi — Meta sozlamalarini tekshirishda birinchi savol
  logger.info({ object: body.object, events: flattenEvents(body).length }, 'Instagram webhook keldi');
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

  // "Ko'rildi" — foydalanuvchi xabari yetib borganini darhol biladi.
  // Kutmaymiz: Instagram API ~0.3 s, qolgan ish (⌛, navbat) unga bog'liq emas.
  void trySendInstagramAction(senderId, 'mark_seen');

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
    // ⌛ — bazaga murojaatdan OLDIN: foydalanuvchi reels qabul qilinganini darhol ko'radi
    markWaiting(senderId, event);
    await handleMedia(senderId, event, media);
    return;
  }

  if (typeof message.text === 'string' && message.text.trim() !== '') {
    await handleText(senderId, event, message.text);
    return;
  }

  // Rasm, stiker, ovozli xabar va h.k.
  if ((message.attachments?.length ?? 0) > 0 || message.is_unsupported) {
    await handleUnsupported(senderId, event);
  }
}

/**
 * Xabarga reaksiya qo'yadi.
 * @returns false — qo'yib bo'lmadi (`mid` yo'q yoki Meta qayta urinishlardan keyin ham rad etdi)
 */
async function react(igScopedId: string, event: IgMessagingEvent, reaction: IgReaction): Promise<boolean> {
  const mid = event.message?.mid;
  if (!mid) return false;
  return trySendInstagramReaction(igScopedId, mid, reaction);
}

/**
 * ⌛ reaksiyasi — har bir xabarga BIR MARTA. Meta webhook'ni qayta yuborsa,
 * ⌛ allaqachon qo'yilgan ✅ ning ustidan yozib yubormasin.
 */
const waitingSent = new Map<string, number>();
const WAITING_TTL_MS = 10 * 60_000;

function markWaiting(igScopedId: string, event: IgMessagingEvent): void {
  const mid = event.message?.mid;
  if (!mid || waitingSent.has(mid)) return;
  const now = Date.now();
  waitingSent.set(mid, now);
  if (waitingSent.size > 5000) {
    for (const [k, at] of waitingSent) if (now - at > WAITING_TTL_MS) waitingSent.delete(k);
  }
  // Kutmaymiz: Meta xato bersa qayta urinishlar ~1 daqiqa davom etadi. Keyingi
  // ✅/❌ uning o'rnini oladi — tartibni trySendInstagramReaction saqlaydi.
  void react(igScopedId, event, IG_REACTION.wait);
}

/**
 * Xato: xabarga ❌. Instagram chati matn bilan to'lib ketmasligi uchun sababi
 * yozilmaydi (bog'langan foydalanuvchi uni Telegram'da ko'radi) — faqat:
 *   - `alwaysText` — bog'lanmagan foydalanuvchi: unga yo'l-yo'riq shu yerda kerak
 *   - ❌ qo'yib bo'lmasa — aks holda foydalanuvchi hech narsa ko'rmay qolardi
 */
async function failInInstagram(
  igScopedId: string,
  event: IgMessagingEvent,
  text: string,
  { alwaysText = false }: { alwaysText?: boolean } = {},
): Promise<void> {
  const reacted = await react(igScopedId, event, IG_REACTION.fail);
  if (alwaysText || !reacted) await trySendInstagramText(igScopedId, toPlainText(text));
}

/** Qayta ishlab bo'lmaydigan attachment (rasm, stiker, ovozli xabar...) — ❌ (va sababi). */
async function handleUnsupported(igScopedId: string, event: IgMessagingEvent): Promise<void> {
  const user = await usersRepo.findByIgScopedIdCached(igScopedId);
  const key = unsupportedReplyKey(firstAttachmentType(event));
  await failInInstagram(igScopedId, event, t(langOfUser(user), key), {
    alwaysText: user?.link_status !== 'linked',
  });
}

/** "✅ Obuna bo'ldim" tugmasining payload'i: `FOLLOW_CHECK:LINK-XXXXXX`. */
const FOLLOW_CHECK_PREFIX = 'FOLLOW_CHECK:';

/**
 * Obuna bo'lishi kutilayotgan akkauntlar: IGSID → yuborgan kodi. Foydalanuvchi
 * tugmani bosmay, "obuna bo'ldim" deb o'zi yozsa ham kod shu yerdan topiladi.
 * Xotirada: server qayta ishga tushsa, kodni qayta yuborish kifoya.
 */
const awaitingFollow = new Map<string, { code: string; at: number }>();
const AWAITING_FOLLOW_TTL_MS = 24 * 60 * 60_000;

function awaitingCodeOf(igScopedId: string): string | null {
  const hit = awaitingFollow.get(igScopedId);
  if (!hit) return null;
  if (Date.now() - hit.at > AWAITING_FOLLOW_TTL_MS) {
    awaitingFollow.delete(igScopedId);
    return null;
  }
  return hit.code;
}

/**
 * Matnli xabar — bog'lash kodi, "✅ Obuna bo'ldim" tugmasi yoki oddiy matn.
 *
 * Bog'lash tartibi:
 *   1. kod bazada bormi (yo'q bo'lsa — obunani so'rab o'tirmaymiz)
 *   2. foydalanuvchi @akkauntimizga obuna bo'lganmi — bo'lmasa obunani so'raymiz
 *      va "✅ Obuna bo'ldim" tugmasini beramiz; bosilganda qayta tekshiramiz
 *   3. bog'laymiz: kod xabariga 🔗, Instagram'ga "aloqa mavjud", Telegram'ga
 *      qaysi akkaunt va qachon ulangani
 */
async function handleText(igScopedId: string, event: IgMessagingEvent, text: string): Promise<void> {
  const payload = event.message?.quick_reply?.payload ?? '';
  const fromFollowButton = payload.startsWith(FOLLOW_CHECK_PREFIX);
  const awaitingCode = awaitingCodeOf(igScopedId);
  const code =
    (fromFollowButton ? usersRepo.normalizeLinkCode(payload.slice(FOLLOW_CHECK_PREFIX.length)) : null) ??
    usersRepo.normalizeLinkCode(text) ??
    awaitingCode;
  // Kod yangi yuborilgan bo'lsa — birinchi so'rov; aks holda qayta tekshiruv
  const isRecheck = fromFollowButton || (awaitingCode !== null && code === awaitingCode);

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
    awaitingFollow.delete(igScopedId);
    await trySendInstagramText(igScopedId, t(lang, 'igAlreadyLinked'));
    return;
  }

  const owner = await usersRepo.findByLinkCode(code);
  if (!owner) {
    awaitingFollow.delete(igScopedId);
    logger.info({ igScopedId, code }, 'Bog\'lash kodi topilmadi');
    await trySendInstagramText(igScopedId, t(lang, 'igCodeNotFound'));
    return;
  }
  // Kod egasi topildi — endi uning tili ma'lum
  const userLang = langOfUser(owner);

  const profile = await getInstagramProfile(igScopedId);
  if (profile.followsUs === false) {
    awaitingFollow.set(igScopedId, { code, at: Date.now() });
    logger.info({ igScopedId, username: profile.username, isRecheck }, 'Bog\'lash: obuna kutilmoqda');
    await trySendInstagramText(
      igScopedId,
      t(userLang, isRecheck ? 'igFollowNotYet' : 'igFollowFirst', { account: env.IG_ACCOUNT_USERNAME }),
      [{ title: t(userLang, 'igFollowButton'), payload: `${FOLLOW_CHECK_PREFIX}${code}` }],
    );
    return;
  }
  if (profile.followsUs === null) {
    // Meta javob bermadi — foydalanuvchini shu sababli bog'lamasdan qoldirmaymiz
    logger.warn({ igScopedId }, 'Obuna holatini aniqlab bo\'lmadi — bog\'lashga ruxsat berildi');
  }

  const user = await usersRepo.linkUserByCode(code, igScopedId);
  awaitingFollow.delete(igScopedId);
  if (!user) {
    logger.info({ igScopedId, code }, 'Bog\'lash kodi topilmadi');
    await trySendInstagramText(igScopedId, t(userLang, 'igCodeNotFound'));
    return;
  }

  logger.info(
    { userId: user.id, telegramId: user.telegram_id, igScopedId, username: profile.username },
    'Akkaunt bog\'landi',
  );

  await Promise.all([
    // 🔗 reaksiya, keyin "aloqa mavjud" — foydalanuvchi ikkalasini ketma-ket ko'radi
    react(igScopedId, event, IG_REACTION.linked).then(() =>
      trySendInstagramText(igScopedId, t(userLang, 'igLinkSuccess')),
    ),
    trySendText(
      user.telegram_id,
      t(userLang, 'igLinkedTelegram', {
        account: escapeHtml(env.IG_ACCOUNT_USERNAME),
        igUser: igAccountLabel(profile.username, profile.name),
        time: escapeHtml(formatDate(user.linked_at ?? new Date().toISOString(), userLang)),
      }),
    ),
  ]);
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
  const user = await usersRepo.findByIgScopedIdCached(igScopedId);

  if (!user || user.link_status !== 'linked') {
    logger.info({ igScopedId }, 'Bog\'lanmagan foydalanuvchidan media keldi');
    // Telegram'i hali noma'lum — qanday bog'lanishni faqat shu yerda aytish mumkin
    await failInInstagram(igScopedId, event, t(langOfUser(user), 'igNotLinked'), { alwaysText: true });
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
  const viaResolver = link !== null && canResolveInstagram();

  if (!media.downloadable && !viaResolver) {
    // Resolver ulanmagan (yoki havola tanilmadi) — bu yagona holat, bunda
    // foydalanuvchiga ishlaydigan muqobil yo'lni ko'rsatamiz.
    logger.warn(
      { igScopedId, type: media.type, url: media.url, resolver: canResolveInstagram() },
      'Meta media o\'rniga sahifa havolasini yubordi, resolver esa yo\'q',
    );
    await Promise.all([
      failInInstagram(igScopedId, event, t(lang, 'failInstagramSource')),
      // Telegram'da — sababi va ishlaydigan muqobil yo'l (videoni o'zi tashlashi)
      trySendText(user.telegram_id, t(lang, 'igNotDownloadable')),
    ]);
    return;
  }

  // Resolver navbatga yozish bilan PARALLEL boshlanadi — worker jobni olganda
  // post tayyor turadi (Supabase'ning ~1 s kechikishi yashiriladi)
  if (link && viaResolver) startPreparing(`ig:${link.shortcode}`, 'instagram', link.url);

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
    const text = t(lang, 'igPendingLimit', { n: result.pending });
    await Promise.all([failInInstagram(igScopedId, event, text), trySendText(user.telegram_id, text)]);
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
