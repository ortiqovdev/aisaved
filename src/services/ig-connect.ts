import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import { IG_LINK_SOURCE } from '../lib/constants.ts';
import type { UserRow } from '../db/types.ts';
import * as usersRepo from '../db/users.repo.ts';
import * as requestsRepo from '../db/requests.repo.ts';
import { consumeLinkToken, issueLinkToken, type PendingMedia } from '../db/link-tokens.repo.ts';
import { canResolveInstagram, parseInstagramLink } from './ig-resolver.ts';
import { startPreparing } from './prepare.ts';
import { getInstagramProfile, trySendInstagramLinkButton, trySendInstagramText } from './instagram.ts';
import { getBotInfo } from '../bot/info.ts';
import { trySendText } from '../bot/notify.ts';
import { rememberStatusCard, sendStatusCard } from '../bot/status-card.ts';
import { escapeHtml, formatDate, igAccountLabel } from '../bot/messages.ts';
import { wakeWorkers } from '../workers/wake.ts';
import { bot } from '../bot/index.ts';
import { missingChannels, sendSubscribePrompt } from '../bot/access.ts';
import { isAdmin, isBanned, touchActive } from '../db/admin.repo.ts';
import { t, type Lang } from '../i18n/index.ts';

/**
 * Bir bosishda bog'lash: Instagram → Telegram, kod ko'chirmasdan.
 *
 *   1. Bog'lanmagan foydalanuvchi Instagram'da yozadi (obunasi tekshirilgan)
 *   2. `offerTelegramConnect` — bir martalik kalit bilan havola tugmasi:
 *      t.me/<bot>?start=ig_<token>
 *   3. Telegram'da START → `completeTelegramConnect` — IGSID shu Telegram
 *      foydalanuvchisiga bog'lanadi, ikkala tomonga xabar, bog'lanishdan oldin
 *      yuborilgan reels'lar yetkaziladi.
 *
 * Bot ↔ webhook aylanma importini oldini olish uchun umumiy qism shu yerda.
 */
export const IG_CONNECT_PREFIX = 'ig_';

/** /start payload'idan kalit: `ig_<token>` → token (bo'lmasa null). */
export function connectTokenFromStart(payload: string | undefined): string | null {
  return payload?.startsWith(IG_CONNECT_PREFIX) ? payload.slice(IG_CONNECT_PREFIX.length) : null;
}

/** Faol kalitga yangi reels qo'shilganda havola qayta yuborilmaydigan oraliq. */
const REOFFER_AFTER_MS = 60_000;
const lastOffer = new Map<string, number>();

/**
 * Instagram'ga "📲 Telegram'da ulash" havolasini yuboradi.
 * Foydalanuvchi ketma-ket bir nechta reels tashlasa — bitta kalit, bitta
 * xabar (reels'lar kalitga qo'shiladi va bog'langach hammasi yetkaziladi).
 */
export async function offerTelegramConnect(igsid: string, lang: Lang, pending: PendingMedia[]): Promise<void> {
  const { token, reused } = await issueLinkToken(igsid, pending);
  const now = Date.now();
  if (reused && now - (lastOffer.get(igsid) ?? 0) < REOFFER_AFTER_MS) {
    logger.info({ igsid, pending: pending.length }, 'Bog\'lash havolasi yaqinda yuborilgan — reels kalitga qo\'shildi');
    return;
  }
  lastOffer.set(igsid, now);
  if (lastOffer.size > 5000) {
    for (const [k, at] of lastOffer) if (now - at > REOFFER_AFTER_MS) lastOffer.delete(k);
  }

  const url = `https://t.me/${getBotInfo().username}?start=${IG_CONNECT_PREFIX}${token}`;
  logger.info({ igsid, reused, pending: pending.length }, 'Bog\'lash havolasi yuborildi');
  await trySendInstagramLinkButton(igsid, t(lang, 'igConnectPrompt'), t(lang, 'igConnectButton'), url);
}

export interface TelegramFrom {
  id: number;
  username?: string | undefined;
  first_name?: string | undefined;
}

/**
 * Telegram'da `/start ig_<token>` — bog'lashni yakunlaydi.
 * @returns false — kalit yaroqsiz (eskirgan / ishlatilgan / yo'q)
 */
export async function completeTelegramConnect(from: TelegramFrom, lang: Lang, token: string): Promise<boolean> {
  const consumed = await consumeLinkToken(token);
  if (!consumed) {
    await trySendText(from.id, t(lang, 'connectExpired', { account: escapeHtml(env.IG_ACCOUNT_USERNAME) }));
    return false;
  }
  const { igScopedId, pending } = consumed;

  // Shu Instagram avval BOSHQA Telegram'ga ulangan bo'lsa — o'sha odamni ogohlantiramiz
  const previous = await usersRepo.findByIgScopedId(igScopedId);

  const user = await usersRepo.getOrCreateByTelegramId({
    telegramId: from.id,
    username: from.username,
    firstName: from.first_name,
    language: lang,
  });
  const linked = await usersRepo.linkUserToIg(user.id, igScopedId);
  const profile = await getInstagramProfile(igScopedId);

  logger.info(
    { userId: linked.id, telegramId: from.id, igScopedId, username: profile.username, pending: pending.length },
    'Akkaunt bir bosishda bog\'landi',
  );

  const tg = from.username ? `@${from.username}` : (from.first_name ?? String(from.id));
  await Promise.all([
    trySendText(
      from.id,
      t(lang, 'igLinkedTelegram', {
        account: escapeHtml(env.IG_ACCOUNT_USERNAME),
        igUser: igAccountLabel(profile.username, profile.name),
        time: escapeHtml(formatDate(linked.linked_at ?? new Date().toISOString(), lang)),
      }),
    ),
    // Instagram egasi kim ulanganini ko'radi — begona bo'lsa UNLINK qiladi
    trySendInstagramText(igScopedId, t(lang, 'igLinkSuccessTg', { tg })),
    previous && previous.telegram_id !== from.id && previous.link_status === 'linked'
      ? trySendText(
          previous.telegram_id,
          t(lang, 'linkMovedAway', { account: escapeHtml(env.IG_ACCOUNT_USERNAME) }),
        )
      : Promise.resolve(),
  ]);

  // Bog'lanishdan oldin yuborilgan reels'lar — endi yetkazamiz
  for (const media of pending) {
    try {
      const outcome = await enqueueInstagramMedia(linked, igScopedId, media, lang);
      if (outcome.status === 'not-downloadable') {
        await trySendText(from.id, t(lang, 'igNotDownloadable'));
      } else if (outcome.status === 'limit') {
        await trySendText(from.id, t(lang, 'igPendingLimit', { n: outcome.pending }));
        break;
      } else if (outcome.status === 'not-subscribed' || outcome.status === 'banned') {
        break; // obuna tugmalari yuborildi / ban — qolganlari ham xuddi shunday bo'ladi
      }
    } catch (e) {
      logger.error({ err: errMessage(e), igScopedId }, 'Kutib turgan reels navbatga qo\'yilmadi');
    }
  }
  return true;
}

export type EnqueueOutcome =
  | { status: 'queued'; requestId: number }
  | { status: 'duplicate' }
  | { status: 'limit'; pending: number }
  | { status: 'not-downloadable' }
  /** Majburiy kanallarga obuna bo'lmagan — Telegram'ga obuna tugmalari yuborildi. */
  | { status: 'not-subscribed' }
  /** Admin ban qilgan — hech narsa qilinmaydi. */
  | { status: 'banned' };

/**
 * Bog'langan foydalanuvchining Instagram media'sini navbatga qo'yadi va
 * Telegram'da "⏳ Reels qabul qilindi" kartasini ko'rsatadi.
 * Xabarlar (limit, yuklab bo'lmaydi) — chaqiruvchida: webhook ❌ qo'yadi,
 * Telegram'dan bog'lash esa matn yozadi.
 */
export async function enqueueInstagramMedia(
  user: UserRow,
  igsid: string,
  media: PendingMedia,
  lang: Lang,
): Promise<EnqueueOutcome> {
  // Telegram'dagi qoidalar Instagram orqali kelganda ham amal qilsin
  if (await isBanned(user.telegram_id)) return { status: 'banned' };
  if (!(await isAdmin(user.telegram_id))) {
    const missing = await missingChannels(bot.api, user.telegram_id);
    if (missing.length > 0) {
      await sendSubscribePrompt(bot.api, user.telegram_id, lang, missing);
      return { status: 'not-subscribed' };
    }
  }
  touchActive(user.telegram_id);

  /**
   * Meta ba'zi reels uchun video fayl o'rniga reels SAHIFASINING havolasini
   * yuboradi (`instagram.com/reel/XXX/`) — to'g'ridan-to'g'ri yuklab bo'lmaydi.
   * Bunday jobni HAVOLA turida navbatga qo'yamiz: worker uni resolver/yt-dlp
   * bilan yechadi va natija baribir Telegram'ga VIDEO bo'lib boradi.
   */
  const link = media.downloadable ? null : parseInstagramLink(media.url);
  const viaResolver = link !== null && canResolveInstagram();

  if (!media.downloadable && !viaResolver) {
    logger.warn(
      { igsid, type: media.type, url: media.url, resolver: canResolveInstagram() },
      'Meta media o\'rniga sahifa havolasini yubordi, resolver esa yo\'q',
    );
    return { status: 'not-downloadable' };
  }

  // Resolver navbatga yozish bilan PARALLEL boshlanadi — worker jobni olganda
  // post tayyor turadi (Supabase'ning ~1 s kechikishi yashiriladi)
  if (link && viaResolver) startPreparing(`ig:${link.shortcode}`, 'instagram', link.url);

  // Spam himoyasi + navbat — bitta so'rovda (0005). Meta webhook'ni qayta
  // yuborsa, dublikatni `ig_message_id` (mid) ushlaydi.
  const result = await requestsRepo.enqueueWithLimit({
    userId: user.id,
    igMessageId: media.mid,
    mediaUrl: link ? link.url : media.url,
    mediaType: link ? IG_LINK_SOURCE : media.type,
    // Shortcode doimiy — media keshi va musiqa keshining kaliti
    ...(link ? { fileUniqueId: `ig:${link.shortcode}` } : {}),
  });

  if (result.status === 'limit') {
    logger.info({ userId: user.id, pending: result.pending }, 'Foydalanuvchi navbat limitiga yetdi');
    return { status: 'limit', pending: result.pending };
  }
  if (result.status === 'duplicate') return { status: 'duplicate' };
  const row = result.row;

  logger.info({ requestId: row.id, userId: user.id, mediaType: media.type, viaResolver }, 'Navbatga qo\'shildi');

  // "⏳ Reels qabul qilindi" kartasi — natija shu xabarning o'rniga chiqadi.
  // Navbatdan KEYIN: dublikat webhook'ga karta chiqib-o'chib bildirishnoma bermasin.
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
  return { status: 'queued', requestId: row.id };
}

/** Instagram'dan UNLINK — bog'lanishni uzadi va Telegram egasini ogohlantiradi. */
export async function unlinkFromInstagram(user: UserRow, igsid: string, lang: Lang): Promise<void> {
  await usersRepo.unlinkUser(user.id);
  logger.info({ userId: user.id, igsid }, 'Instagram\'dan UNLINK — bog\'lanish uzildi');
  await Promise.all([
    trySendInstagramText(igsid, t(lang, 'igUnlinked')),
    trySendText(user.telegram_id, t(lang, 'unlinkedFromInstagram', { account: escapeHtml(env.IG_ACCOUNT_USERNAME) })),
  ]);
}
