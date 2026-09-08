import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { PermanentError, TransientError, errMessage, fetchWithTimeout } from '../lib/errors.ts';

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

/** Havoladan ajratilgan media. */
export interface ResolvedMedia {
  /** To'g'ridan-to'g'ri yuklab olinadigan video havolasi. */
  videoUrl: string;
  title: string | null;
  author: string | null;
  thumbnailUrl: string | null;
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
      '⚙️ Havola orqali yuklash hozircha yoqilmagan.\n\n' +
        'Videoni menga to\'g\'ridan-to\'g\'ri tashlasangiz, musiqasini darhol aytaman.',
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
        '⚙️ Yuklash xizmatiga ulanib bo\'lmadi. Birozdan so\'ng qayta urinib ko\'ring.',
      );
    }
    throw new PermanentError(
      `Resolver ${res.status}: ${snippet}`,
      '😕 Bu havoladan videoni ololmadim. Havola to\'g\'ri va post ochiq (public) ekanini tekshiring.',
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    throw new TransientError(`Resolver javobini o'qib bo'lmadi: ${errMessage(e)}`);
  }

  const videoUrl = extractVideoUrl(json);
  if (!videoUrl) {
    logger.warn(
      { link, sample: JSON.stringify(json).slice(0, 400) },
      'Resolver javobida video havolasi topilmadi',
    );
    throw new PermanentError(
      'Resolver javobida video havolasi yo\'q',
      '😕 Bu havolada video topilmadi. Reels yoki video post havolasini yuboring — ' +
        'rasm postlari va yopiq (private) akkauntlar ishlamaydi.',
    );
  }

  return {
    videoUrl,
    title: pickString(json, env.IG_RESOLVER_TITLE_PATH, ['title', 'caption', 'description']),
    author: pickString(json, '', ['author', 'username', 'owner', 'author_name']),
    thumbnailUrl: pickString(json, '', ['thumbnail', 'thumbnail_url', 'thumb', 'cover']),
  };
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
