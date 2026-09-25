import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { PermanentError, TransientError, errMessage, fetchWithTimeout } from '../lib/errors.ts';
import { msg } from '../i18n/index.ts';

/**
 * Instagram havolasidan video faylini topib beruvchi qatlam.
 *
 * NIMA UCHUN ALOHIDA MODUL
 * ------------------------
 * Meta rasmiy API orqali BOSHQA odamning reels'ining video faylini bermaydi
 * (tekshirilgan: Graph API `missing permissions`, CDN imzosiz `404`).
 * Shuning uchun havoladan faylni topish uchun tashqi xizmat kerak bo'ladi.
 *
 * Bu modul HECH QANDAY provayderni o'zida saqlamaydi va Instagram'ni o'zi
 * "tirnamaydi" — u faqat sizning `.env` da ko'rsatgan endpointingizga so'rov
 * yuboradi va javobdan video havolasini ajratib oladi. Provayderni almashtirish
 * uchun kodga tegish shart emas, `.env` ni o'zgartirish kifoya.
 *
 * Sozlanmagan bo'lsa — tushunarli xato qaytaradi, ilova qulamaydi.
 */

export type MediaKind = 'video' | 'photo';

export interface ResolvedItem {
  /** To'g'ridan-to'g'ri yuklab olinadigan fayl havolasi. */
  url: string;
  /**
   * Provayder aytgan tur. null — noma'lum: bunday faylni Telegram'ga URL
   * orqali berib bo'lmaydi, yuklab olib `content-type` bo'yicha aniqlanadi.
   */
  kind: MediaKind | null;
}

/** Havoladan ajratilgan media. */
export interface ResolvedMedia {
  /** Postdagi fayllar, tartibi saqlangan: reels — bitta, karusel — bir nechta. */
  items: ResolvedItem[];
  title: string | null;
  author: string | null;
}

/** Resolver ulanganmi? Bot javob matnini shunga qarab tanlaydi. */
export function isResolverConfigured(): boolean {
  return env.IG_RESOLVER_URL.trim() !== '';
}

// ---------------------------------------------------------------------------
// Havolani tanish va normallashtirish
// ---------------------------------------------------------------------------

/**
 * Instagram post/reels havolasining barcha ko'rinishlari:
 *   instagram.com/reel/ABC123/          instagram.com/reels/ABC123/
 *   instagram.com/p/ABC123/             instagram.com/tv/ABC123/
 *   instagram.com/username/reel/ABC123/ instagram.com/share/reel/ABC123/
 *   ...va ular oldidagi @, http(s)://, www., qavslar
 */
const IG_LINK_RE =
  /https?:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:share\/)?(reel|reels|p|tv|share)\/([A-Za-z0-9_-]+)/i;

export interface ParsedLink {
  /** Tozalangan, kanonik havola — bazaga shu saqlanadi. */
  url: string;
  /** Shortcode — ayni havola qayta yuborilganda keshni ishlatish uchun kalit. */
  shortcode: string;
  kind: string;
}

/**
 * Matn ichidan Instagram havolasini topadi.
 *
 * Foydalanuvchi havolani ko'pincha yolg'iz yubormaydi — "manavi reels nima
 * qo'shiq?" deb yozadi. Shuning uchun butun matnni emas, ichidan qidiramiz.
 */
export function parseInstagramLink(text: string): ParsedLink | null {
  const m = IG_LINK_RE.exec(text);
  if (!m?.[1] || !m[2]) return null;

  const kind = m[1].toLowerCase();
  const shortcode = m[2];
  // `share` havolalari qayta yo'naltiruvchi bo'ladi — o'zini saqlaymiz,
  // qolganlarini kanonik ko'rinishga keltiramiz.
  const url =
    kind === 'share'
      ? `https://www.instagram.com/share/${shortcode}/`
      : `https://www.instagram.com/${kind === 'reels' ? 'reel' : kind}/${shortcode}/`;

  return { url, shortcode, kind };
}

// ---------------------------------------------------------------------------
// Provayderga so'rov
// ---------------------------------------------------------------------------

/**
 * `.env` dagi `IG_RESOLVER_HEADERS` — JSON obyekt ko'rinishidagi qo'shimcha
 * sarlavhalar (masalan API kaliti). Buzuq JSON butun ilovani yiqitmasligi
 * uchun bu yerda ushlanadi.
 */
function extraHeaders(): Record<string, string> {
  const raw = env.IG_RESOLVER_HEADERS.trim();
  if (raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    logger.warn('IG_RESOLVER_HEADERS buzuq JSON — e\'tiborsiz qoldirildi');
    return {};
  }
}

/** `{url}` o'rniga haqiqiy havola qo'yiladi (kodlangan holda). */
function buildEndpoint(link: string): string {
  const template = env.IG_RESOLVER_URL.trim();
  const encoded = encodeURIComponent(link);
  if (template.includes('{url}')) return template.replaceAll('{url}', encoded);
  // Shablon berilmagan bo'lsa — havolani `url` parametri sifatida qo'shamiz
  return `${template}${template.includes('?') ? '&' : '?'}url=${encoded}`;
}

/**
 * Havoladan video faylini topadi.
 *
 * @throws PermanentError  sozlanmagan, havola yaroqsiz, video topilmadi
 * @throws TransientError  tarmoq, 429, 5xx — qayta urinsa bo'ladi
 */
export async function resolveInstagramMedia(link: string): Promise<ResolvedMedia> {
  if (!isResolverConfigured()) {
    throw new PermanentError(
      'IG_RESOLVER_URL sozlanmagan — havoladan video olib bo\'lmaydi',
      msg('linkDisabled'),
    );
  }

  const endpoint = buildEndpoint(link);
  const method = env.IG_RESOLVER_METHOD;

  const init: RequestInit = {
    method,
    headers: {
      Accept: 'application/json',
      ...extraHeaders(),
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify({ url: link }) } : {}),
  };

  const res = await fetchWithTimeout(endpoint, init, env.IG_RESOLVER_TIMEOUT_MS);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const snippet = text.slice(0, 300);

    // 429 / 5xx — provayder band yoki limitda: keyinroq qayta urinamiz
    if (res.status === 429 || res.status >= 500) {
      throw new TransientError(`Resolver ${res.status}: ${snippet}`);
    }
    // 401/403 — kalit noto'g'ri yoki obuna tugagan: retry foydasiz
    if (res.status === 401 || res.status === 403) {
      throw new PermanentError(
        `Resolver ${res.status} (kalit/obuna): ${snippet}`,
        msg('errResolverUnavailable'),
      );
    }
    throw new PermanentError(
      `Resolver ${res.status}: ${snippet}`,
      msg('errResolverCantFetch'),
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    throw new TransientError(`Resolver javobini o'qib bo'lmadi: ${errMessage(e)}`);
  }

  const items = extractMediaItems(json);
  if (items.length === 0) {
    logger.warn(
      { link, sample: JSON.stringify(json).slice(0, 400) },
      'Resolver javobida media havolasi topilmadi',
    );
    throw new PermanentError(
      'Resolver javobida media havolasi yo\'q',
      msg('errResolverNoVideo'),
    );
  }

  return {
    items,
    title: pickString(json, env.IG_RESOLVER_TITLE_PATH, ['title', 'caption', 'description']),
    author: pickString(json, '', ['author', 'username', 'owner', 'author_name']),
  };
}

/** Karuselda Instagram ko'pi bilan 20 ta fayl beradi. */
const MAX_POST_ITEMS = 20;

/** Element obyektidan fayl havolasi olinadigan kalitlar (muhimlik tartibida). */
const ITEM_URL_KEYS = [
  'video_url', 'videoUrl', 'download_url', 'downloadUrl', 'url', 'src', 'link',
  'image_url', 'imageUrl', 'display_url', 'displayUrl',
];

/** Element turi — `image/jpeg`, `video/mp4`, `photo`, `GraphImage` ... */
function itemType(item: Record<string, unknown>): string | null {
  for (const key of ['type', 'media_type', 'mediaType', 'content_type', 'mime', '__typename']) {
    const v = item[key];
    if (typeof v === 'string' && /image|photo|video|jpe?g|png|webp|mp4/i.test(v)) return v;
  }
  return null;
}

function itemUrl(item: Record<string, unknown>): string | null {
  for (const key of ITEM_URL_KEYS) {
    const v = item[key];
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
  }
  return null;
}

/**
 * Javobdan postdagi BARCHA fayllarni oladi.
 *
 * Qiyinchilik: ko'p provayder bitta videoning bir necha SIFATINI ham ro'yxat
 * qilib beradi (hd, sd...) — ularni karusel deb olsak, bitta video bir necha
 * marta yuboriladi. Shuning uchun ro'yxat karusel deb faqat har bir elementida
 * aniq turi (image/video) ko'rsatilgan bo'lsa qabul qilinadi. Aks holda eski,
 * xavfsiz yo'l: bitta video.
 */
function extractMediaItems(root: unknown): ResolvedItem[] {
  // 1) `.env` da aniq yo'l ko'rsatilgan bo'lsa — o'sha (u video yo'li)
  const configured = valueAtPath(root, env.IG_RESOLVER_VIDEO_PATH);
  if (typeof configured === 'string' && /^https?:\/\//i.test(configured)) {
    return [{ url: configured, kind: 'video' }];
  }

  // 2) Turi ko'rsatilgan elementlar ro'yxati (kenglik bo'yicha — eng tashqisi)
  const queue: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  while (queue.length > 0) {
    const { node, depth } = queue.shift()!;
    if (depth > 6 || node === null || typeof node !== 'object') continue;

    if (Array.isArray(node)) {
      const objects = node.filter(
        (x): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x),
      );
      const typed = objects.filter((x) => itemType(x) !== null && itemUrl(x) !== null);
      if (typed.length > 0 && typed.length === objects.length) {
        const seen = new Set<string>();
        const items: ResolvedItem[] = [];
        for (const x of typed) {
          const url = itemUrl(x)!;
          if (seen.has(url)) continue;
          seen.add(url);
          items.push({ url, kind: kindOfType(itemType(x)!) });
        }
        return items.slice(0, MAX_POST_ITEMS);
      }
      for (const item of node) queue.push({ node: item, depth: depth + 1 });
      continue;
    }

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      // Muqova/oldindan ko'rish ro'yxatlari — post fayllari emas
      if (/thumb|cover|preview|avatar|profile/i.test(key)) continue;
      queue.push({ node: value, depth: depth + 1 });
    }
  }

  // 3) Eski yo'l — bitta video
  const video = extractVideoUrl(root);
  return video ? [{ url: video, kind: 'video' }] : [];
}

/** `image/jpeg`, `photo`, `GraphVideo`, `mp4` ... → tur. */
function kindOfType(type: string): MediaKind | null {
  if (/video|mp4/i.test(type)) return 'video';
  if (/image|photo|jpe?g|png|webp/i.test(type)) return 'photo';
  return null;
}

// ---------------------------------------------------------------------------
// Javobdan qiymat ajratish
//
// Provayderlar javob formatini har xil qiladi, shuning uchun ikki bosqich:
//   1) `.env` da aniq yo'l ko'rsatilgan bo'lsa — o'shani olamiz
//   2) bo'lmasa — JSON ichidan video havolasini o'zimiz qidiramiz
// Shu tufayli ko'p provayder hech qanday sozlashsiz ishlab ketadi.
// ---------------------------------------------------------------------------

/** `data.media[0].url` ko'rinishidagi yo'l bo'yicha qiymat oladi. */
function valueAtPath(root: unknown, path: string): unknown {
  if (path.trim() === '') return undefined;
  let node: unknown = root;
  for (const rawKey of path.split('.')) {
    const key = rawKey.trim();
    if (key === '') continue;
    if (node === null || node === undefined) return undefined;

    const idx = /^\[?(\d+)\]?$/.exec(key)?.[1];
    if (idx !== undefined && Array.isArray(node)) {
      node = node[Number(idx)];
      continue;
    }
    if (typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Havola videoga o'xshaydimi (kengaytma yoki CDN belgilariga qarab). */
function looksLikeVideo(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  if (/\.(mp4|m4v|mov|webm)(\?|$)/i.test(value)) return true;
  // Instagram CDN havolalarida kengaytma bo'lmasligi mumkin
  return /cdninstagram|fbcdn\.net|\/video/i.test(value);
}

/**
 * JSON ichidan video havolasini qidiradi.
 *
 * Avval `.env` dagi aniq yo'l, keyin kalit nomiga qarab (video_url, videoUrl,
 * hd_url, play, download_url ...), oxirida — butun daraxtdan videoga o'xshagan
 * birinchi havola. Bir nechta variant bo'lsa eng uzun (odatda eng sifatli)
 * emas, birinchi topilgani olinadi: provayderlar ro'yxatni sifat bo'yicha
 * kamayish tartibida beradi.
 */
function extractVideoUrl(root: unknown): string | null {
  const configured = valueAtPath(root, env.IG_RESOLVER_VIDEO_PATH);
  if (typeof configured === 'string' && /^https?:\/\//i.test(configured)) return configured;
  if (Array.isArray(configured)) {
    const first = configured.find((v) => typeof v === 'string' && /^https?:\/\//i.test(v));
    if (typeof first === 'string') return first;
  }

  const VIDEO_KEY = /^(video(_?url|_?link)?|hd(_?url)?|sd(_?url)?|play(_?url)?|download(_?url)?|url|src|link)$/i;

  let byKey: string | null = null;
  let anyVideo: string | null = null;

  const walk = (node: unknown, depth: number): void => {
    if (byKey !== null || depth > 8 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string' && looksLikeVideo(value)) {
        if (VIDEO_KEY.test(key)) {
          byKey = value;
          return;
        }
        anyVideo ??= value;
      } else {
        walk(value, depth + 1);
        if (byKey !== null) return;
      }
    }
  };

  walk(root, 0);
  return byKey ?? anyVideo;
}

/** Matnli maydonni yo'l bo'yicha yoki taxminiy kalit nomlari bo'yicha oladi. */
function pickString(root: unknown, path: string, candidates: string[]): string | null {
  const direct = valueAtPath(root, path);
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim();

  let found: string | null = null;
  const walk = (node: unknown, depth: number): void => {
    if (found !== null || depth > 6 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim() !== '' && candidates.includes(key.toLowerCase())) {
        found = value.trim();
        return;
      }
      walk(value, depth + 1);
      if (found !== null) return;
    }
  };
  walk(root, 0);
  return found;
}
