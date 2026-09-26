import { Router, type Request, type Response } from 'express';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import * as usersRepo from '../db/users.repo.ts';
import { mergePending, takePendingForIgsid, type PendingMedia } from '../db/link-tokens.repo.ts';
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
import { enqueueInstagramMedia, offerTelegramConnect, unlinkFromInstagram } from '../services/ig-connect.ts';
import { trySendText } from '../bot/notify.ts';
import { escapeHtml, formatDate, igAccountLabel, unsupportedReplyKey } from '../bot/messages.ts';
import { t, type Lang } from '../i18n/index.ts';
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
  if (user?.link_status !== 'linked') {
    // Bog'lanmagan — avval ulanish kerak (rasm baribir ishlanmaydi)
    await startConnect(igScopedId, langOfUser(user), false, []);
    return;
  }
  const key = unsupportedReplyKey(firstAttachmentType(event));
  await failInInstagram(igScopedId, event, t(langOfUser(user), key));
}

/** "✅ Obuna bo'ldim" tugmasining payload'i: `FOLLOW_CHECK:` (+ kod, eski yo'lda). */
const FOLLOW_CHECK_PREFIX = 'FOLLOW_CHECK:';

/**
 * Obuna bo'lishi kutilayotgan akkauntlar: IGSID → yuborgan kodi (eski yo'l)
 * va shu paytgacha tashlagan reels'lari. Foydalanuvchi tugmani bosmay,
 * "obuna bo'ldim" deb o'zi yozsa ham shu yerdan topiladi. Xotirada: server
 * qayta ishga tushsa, istalgan xabar yuborish kifoya.
 */
interface AwaitingFollow {
  code: string | null;
  pending: PendingMedia[];
  at: number;
}
const awaitingFollow = new Map<string, AwaitingFollow>();
const AWAITING_FOLLOW_TTL_MS = 24 * 60 * 60_000;
/** Obuna kutilayotganda har bir reels'ga obuna so'rovi qayta yuborilmasin. */
const FOLLOW_REASK_MS = 60_000;

function awaitingOf(igScopedId: string): AwaitingFollow | null {
  const hit = awaitingFollow.get(igScopedId);
  if (!hit) return null;
  if (Date.now() - hit.at > AWAITING_FOLLOW_TTL_MS) {
    awaitingFollow.delete(igScopedId);
    return null;
  }
  return hit;
}

/** Instagram event'idagi media → bog'langach yetkaziladigan yozuv. */
const toPending = (event: IgMessagingEvent, media: ExtractedMedia): PendingMedia => ({
  url: media.url,
  type: media.type,
  downloadable: media.downloadable,
  mid: event.message?.mid ?? null,
});

/**
 * Bog'lanmagan foydalanuvchi — kodsiz ulanish: obuna tekshiruvi, keyin
 * "📲 Telegram'da ulash" havolasi. Shu paytgacha yuborgan reels'lari saqlanadi.
 */
async function startConnect(
  igScopedId: string,
  lang: Lang,
  isRecheck: boolean,
  pending: PendingMedia[],
): Promise<void> {
  const prev = awaitingOf(igScopedId);
  const allPending = mergePending(prev?.pending ?? [], pending);

  const profile = await getInstagramProfile(igScopedId);
  if (profile.followsUs === false) {
    awaitingFollow.set(igScopedId, { code: prev?.code ?? null, pending: allPending, at: Date.now() });
    // Ketma-ket bir nechta reels — obuna so'rovi har biriga emas, bir marta
    if (!isRecheck && prev && Date.now() - prev.at < FOLLOW_REASK_MS) return;
    logger.info({ igScopedId, username: profile.username, isRecheck }, 'Ulanish: obuna kutilmoqda');
    await trySendInstagramText(
      igScopedId,
      t(lang, isRecheck ? 'igFollowNotYet' : 'igFollowFirst', { account: env.IG_ACCOUNT_USERNAME }),
      [{ title: t(lang, 'igFollowButton'), payload: FOLLOW_CHECK_PREFIX }],
    );
    return;
  }
  if (profile.followsUs === null) {
    // Meta javob bermadi — foydalanuvchini shu sababli ulanmasdan qoldirmaymiz
    logger.warn({ igScopedId }, 'Obuna holatini aniqlab bo\'lmadi — ulanishga ruxsat berildi');
  }

  awaitingFollow.delete(igScopedId);
  await offerTelegramConnect(igScopedId, lang, allPending);
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
  const awaiting = awaitingOf(igScopedId);
  // Yangi yozilgan kod (matnda yoki eski tugma payload'ida)
  const typedCode =
    usersRepo.normalizeLinkCode(text) ??
    (fromFollowButton ? usersRepo.normalizeLinkCode(payload.slice(FOLLOW_CHECK_PREFIX.length)) : null);
  const code = typedCode ?? awaiting?.code ?? null;
  // Tugma bosildi yoki obuna kutilayotganda boshqa narsa yozildi — qayta tekshiruv
  const isRecheck = fromFollowButton || (awaiting !== null && typedCode === null);

  const existing = await usersRepo.findByIgScopedId(igScopedId);
  // Qator topilishining o'zi yetarli emas — holati ham 'linked' bo'lishi kerak
  const isLinked = existing?.link_status === 'linked';
  const lang = langOfUser(existing);

  if (isLinked && existing) {
    awaitingFollow.delete(igScopedId);
    // Instagram egasi begona Telegram ulanganini ko'rsa — shu yerdan uzadi
    if (/^\s*\/?unlink\s*$/i.test(text)) {
      await unlinkFromInstagram(existing, igScopedId, lang);
      return;
    }
    // Allaqachon bog'langan akkaunt kod yuborsa, "kod topilmadi" degan chalkash javob bermaymiz
    await trySendInstagramText(igScopedId, t(lang, typedCode ? 'igAlreadyLinked' : 'igSendReels'));
    return;
  }

  if (!code) {
    // Kodsiz ulanish: obuna → "📲 Telegram'da ulash" havolasi
    await startConnect(igScopedId, lang, isRecheck, []);
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
    awaitingFollow.set(igScopedId, { code, pending: awaiting?.pending ?? [], at: Date.now() });
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
  const pendingBefore = awaiting?.pending ?? [];
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

  // 🔗 — fonda: Meta reaksiyani rad etsa qayta urinishlar ~1 daqiqa davom etadi,
  // "aloqa mavjud" xabari esa shuni kutib qolmasin (ilgari 65 s kechikkan)
  void react(igScopedId, event, IG_REACTION.linked);
  await Promise.all([
    trySendInstagramText(igScopedId, t(userLang, 'igLinkSuccess')),
    trySendText(
      user.telegram_id,
      t(userLang, 'igLinkedTelegram', {
        account: escapeHtml(env.IG_ACCOUNT_USERNAME),
        igUser: igAccountLabel(profile.username, profile.name),
        time: escapeHtml(formatDate(user.linked_at ?? new Date().toISOString(), userLang)),
      }),
    ),
  ]);

  // Bog'lanishdan oldin tashlangan reels'lar — obuna kutilgan paytdagilar va
  // "📲 Telegram'da ulash" havolasi kalitiga yozilganlar (foydalanuvchi tugma
  // o'rniga eski kodni yozgan bo'lsa ham yo'qolmasin); kalit yopiladi
  const fromToken = await takePendingForIgsid(igScopedId).catch((e: unknown) => {
    logger.warn({ err: errMessage(e), igScopedId }, 'Kalitdagi reels\'larni olib bo\'lmadi');
    return [] as PendingMedia[];
  });
  for (const media of mergePending(pendingBefore, fromToken)) {
    await enqueueInstagramMedia(user, igScopedId, media, userLang).catch((e: unknown) =>
      logger.error({ err: errMessage(e), igScopedId }, 'Kutib turgan reels navbatga qo\'yilmadi'),
    );
  }
}

/**
 * Media (reels/video).
 *
 * Bog'lanmagan foydalanuvchi — reels saqlanadi va kodsiz ulanish taklif
 * qilinadi; bog'langach shu reels ham yetkaziladi.
 *
 * Bog'langan — navbatga. Instagram'da matn yozilmaydi: natija ham, xato sababi
 * ham Telegram'ga boradi. Instagram'dagi holat — reelsdagi reaksiya: muammo
 * bo'lsa shu yerda ❌, hammasi joyida bo'lsa worker oxirida ✅ qo'yadi.
 */
async function handleMedia(
  igScopedId: string,
  event: IgMessagingEvent,
  media: ExtractedMedia,
): Promise<void> {
  const user = await usersRepo.findByIgScopedIdCached(igScopedId);

  if (!user || user.link_status !== 'linked') {
    logger.info({ igScopedId }, 'Bog\'lanmagan foydalanuvchidan media keldi — ulanish taklif qilinadi');
    await startConnect(igScopedId, langOfUser(user), false, [toPending(event, media)]);
    return;
  }
  const lang = langOfUser(user);

  const outcome = await enqueueInstagramMedia(user, igScopedId, toPending(event, media), lang);
  if (outcome.status === 'not-downloadable') {
    await Promise.all([
      failInInstagram(igScopedId, event, t(lang, 'failInstagramSource')),
      // Telegram'da — sababi va ishlaydigan muqobil yo'l (videoni o'zi tashlashi)
      trySendText(user.telegram_id, t(lang, 'igNotDownloadable')),
    ]);
  } else if (outcome.status === 'limit') {
    const text = t(lang, 'igPendingLimit', { n: outcome.pending });
    await Promise.all([failInInstagram(igScopedId, event, text), trySendText(user.telegram_id, text)]);
  }
  // queued — natija va ✅ worker'dan; duplicate — Meta webhook'ni qayta yubordi, javob takrorlanmaydi
}
