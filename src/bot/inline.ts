import type {
  InlineQueryResultCachedPhoto,
  InlineQueryResultCachedVideo,
  InlineQueryResultPhoto,
  InlineQueryResultVideo,
} from 'grammy/types';
import type { BotContext } from './index.ts';
import { getBotInfo } from './info.ts';
import { handleShareInlineQuery } from './video-actions.ts';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import { getMediaCache } from '../db/media-cache.repo.ts';
import { isResolverConfigured } from '../services/ig-resolver.ts';
import { parseMediaLink, startPayloadOf, type MediaLink } from '../services/links.ts';
import { formatMusic, resolvePost, resolvesToUrls, type ResolvedPost } from '../services/resolvers.ts';

/**
 * Inline rejim: istalgan chatda `@bot <havola>` — video chatdan chiqmasdan
 * yuboriladi (Telegram'da "via @bot" belgisi bilan — bot o'zi tarqaladi).
 *
 *   1. Post keshda (avval yuklangan) → Telegram file_id orqali, bir zumda
 *   2. Keshda yo'q → resolver faylning havolasini beradi, Telegram uni o'zi
 *      oladi (TikTok, Pinterest, Instagram). YouTube havolalari IP'ga
 *      bog'langan — ular uchun faqat "📥 Botda yuklab olish" tugmasi.
 *
 * Havola bo'lmagan so'rov — video tagidagi "📤 Ulashish" tugmasi
 * ([video-actions.ts]) yuborgan file_id.
 *
 * @BotFather → /setinline yoqilgan bo'lishi kerak.
 */
export async function handleInlineQuery(ctx: BotContext): Promise<void> {
  const query = ctx.inlineQuery?.query.trim() ?? '';
  const link = parseMediaLink(query);
  if (!link) {
    await handleShareInlineQuery(ctx);
    return;
  }

  const caption = ctx.t('shareCaption', { bot: getBotInfo().username });
  const withMusic = (music: string | null | undefined): string =>
    music ? `${caption}\n♬ ${music}` : caption;

  const payload = startPayloadOf(link.key);
  const button = payload ? { text: ctx.t('inlineOpenBot'), start_parameter: payload } : undefined;

  // 1) Kesh
  const cached = await getMediaCache(link.key);
  if (cached) {
    const music = cached[0]?.music;
    const results = cached.map((c, i): InlineQueryResultCachedVideo | InlineQueryResultCachedPhoto =>
      c.kind === 'video'
        ? { type: 'video', id: `c${i}`, video_file_id: c.fileId, title: ctx.t('shareTitle'), caption: withMusic(music) }
        : { type: 'photo', id: `c${i}`, photo_file_id: c.fileId, title: ctx.t('shareTitle'), caption: withMusic(music) },
    );
    await answer(ctx, results, 3600, button);
    return;
  }

  // 2) Havola orqali (Telegram faylni o'zi oladi)
  const results: Array<InlineQueryResultVideo | InlineQueryResultPhoto> = [];
  if (canResolveInline(link)) {
    try {
      const post = await resolveForInline(link);
      post.items.forEach((item, i) => {
        if (item.kind === 'photo') {
          results.push({
            type: 'photo',
            id: `r${i}`,
            photo_url: item.url,
            thumbnail_url: item.thumb ?? item.url,
            caption: withMusic(formatMusic(post.music)),
          });
        } else if (item.kind === 'video' && item.thumb) {
          results.push({
            type: 'video',
            id: `r${i}`,
            video_url: item.url,
            mime_type: 'video/mp4',
            thumbnail_url: item.thumb,
            title: ctx.t('shareTitle'),
            caption: withMusic(formatMusic(post.music)),
          });
        }
      });
    } catch (e) {
      logger.debug({ key: link.key, err: errMessage(e) }, 'Inline: havola ochilmadi');
    }
  }

  // Natija bo'lmasa ham tugma bor — bot orqali yuklab olinadi va keshga tushadi
  await answer(ctx, results, results.length > 0 ? 300 : 10, button);
}

async function answer(
  ctx: BotContext,
  results: Array<
    InlineQueryResultCachedVideo | InlineQueryResultCachedPhoto | InlineQueryResultVideo | InlineQueryResultPhoto
  >,
  cacheTime: number,
  button: { text: string; start_parameter: string } | undefined,
): Promise<void> {
  try {
    await ctx.answerInlineQuery(results.slice(0, 50), {
      cache_time: cacheTime,
      is_personal: false,
      ...(button ? { button } : {}),
    });
  } catch (e) {
    // Muddati o'tgan so'rov yoki Telegram URL'ni qabul qilmadi — jim
    logger.debug({ err: errMessage(e) }, 'Inline javob yuborilmadi');
  }
}

const canResolveInline = (link: MediaLink): boolean =>
  resolvesToUrls(link.platform) && (link.platform !== 'instagram' || isResolverConfigured());

// ---------------------------------------------------------------------------
// Inline so'rovlar har bir tugma bosilishida keladi — resolver (RapidAPI
// limiti!) har safar chaqirilmasin: natija 10 daqiqa xotirada, bir vaqtdagi
// bir xil so'rovlar bitta chaqiruvga birlashadi.
// ---------------------------------------------------------------------------

const INLINE_TTL_MS = 10 * 60_000;
/** Telegram inline javobni uzoq kutmaydi. */
const INLINE_TIMEOUT_MS = 8_000;
const resolved = new Map<string, { post: ResolvedPost; at: number }>();
const inFlight = new Map<string, Promise<ResolvedPost>>();

async function resolveForInline(link: MediaLink): Promise<ResolvedPost> {
  const hit = resolved.get(link.key);
  if (hit && Date.now() - hit.at < INLINE_TTL_MS) return hit.post;

  let pending = inFlight.get(link.key);
  if (!pending) {
    pending = resolvePost(link.platform, link.url, 0)
      .then((post) => {
        resolved.set(link.key, { post, at: Date.now() });
        if (resolved.size > 1000) resolved.delete(resolved.keys().next().value!);
        return post;
      })
      .finally(() => inFlight.delete(link.key));
    inFlight.set(link.key, pending);
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('inline resolver timeout')), INLINE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
