import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import { getMediaCache, type CachedMedia } from '../db/media-cache.repo.ts';
import { resolvePost, type ResolvedPost } from './resolvers.ts';
import { safeUnlink } from './media.ts';
import type { Platform } from './links.ts';

/**
 * Postni OLDINDAN tayyorlash — havola kelishi bilan, fonda.
 *
 * Nega: havola kelgach job navbatga yoziladi va worker uni band qiladi —
 * Supabase'gacha har biri ~0.5 s, ya'ni resolver ~1 s kechikib boshlanardi.
 * Endi bot/webhook havolani ko'rishi bilan media keshi va resolver ishga
 * tushadi; worker jobni olganda natija tayyor (yoki yarim yo'lda) turadi.
 *
 * Faqat shu jarayon ichida ishlaydi — alohida worker jarayoni o'zi hisoblaydi.
 * Bir kalitga bir vaqtdagi so'rovlar (Meta webhook'ni qayta yuborsa, ikki
 * kishi bir havolani tashlasa) bitta hisoblashni kutadi — RapidAPI tejaladi.
 */
export type Prepared = { cached: CachedMedia[] } | { post: ResolvedPost };

/** Worker olmasa — shundan keyin tashlab yuboriladi (yuklangan fayllari o'chiriladi). */
const TTL_MS = 2 * 60_000;

const pending = new Map<string, { promise: Promise<Prepared>; timer: NodeJS.Timeout }>();

/** Kesh → resolver. Keshdagi post uchun resolver (pullik) chaqirilmaydi. */
export async function prepareNow(
  key: string | null,
  platform: Platform,
  url: string,
  jobId: number,
): Promise<Prepared> {
  if (key) {
    const cached = await getMediaCache(key);
    if (cached) return { cached };
  }
  return { post: await resolvePost(platform, url, jobId) };
}

/** Fonda tayyorlashni boshlaydi (allaqachon boshlangan bo'lsa — hech narsa qilmaydi). */
export function startPreparing(key: string, platform: Platform, url: string): void {
  if (pending.has(key)) return;

  const promise = prepareNow(key, platform, url, 0);
  // Hech kim olmasa ham "unhandled rejection" bo'lmasin — xatoni worker o'zi ko'radi
  promise.catch((e: unknown) => logger.debug({ key, err: errMessage(e) }, 'Oldindan tayyorlash xato berdi'));

  const timer = setTimeout(() => {
    pending.delete(key);
    // Olinmay qolgan YouTube fayllari diskda qolmasin
    void promise.then(
      (p) => Promise.all(('post' in p ? p.post.downloaded ?? [] : []).map((f) => safeUnlink(f.filePath))),
      () => undefined,
    );
  }, TTL_MS);
  timer.unref();
  pending.set(key, { promise, timer });
}

/** Worker uchun: tayyorlangan natijani oladi (bir marta) yoki null. */
export function takePrepared(key: string): Promise<Prepared> | null {
  const entry = pending.get(key);
  if (!entry) return null;
  clearTimeout(entry.timer);
  pending.delete(key);
  return entry.promise;
}
