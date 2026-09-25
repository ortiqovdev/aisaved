import { parseInstagramLink } from './ig-resolver.ts';

/**
 * Qo'llab-quvvatlanadigan platformalar havolalarini taniydi.
 *
 * `key` — postning doimiy kaliti: media keshi va musiqa keshi shu bo'yicha,
 * `requests.file_unique_id` ga ham shu yoziladi. Prefiks platformani bildiradi:
 *   ig:<shortcode>   tt:<video id>   yt:<video id>   pin:<pin id>
 * Qisqa havolalarda haqiqiy ID redirect'dan keyin ma'lum bo'ladi — ularning
 * kaliti qisqa kod bo'yicha: tt:s:<kod>, pin:s:<kod>.
 */
export type Platform = 'instagram' | 'tiktok' | 'youtube' | 'pinterest';

export interface MediaLink {
  platform: Platform;
  /** Tozalangan havola — resolver'ga va bazaga shu beriladi. */
  url: string;
  key: string;
}

/** `requests.media_type` — havola turidagi job'lar (worker resolver'ni chaqiradi). */
export const LINK_MEDIA_TYPES: Record<Platform, string> = {
  instagram: 'ig_link',
  tiktok: 'tt_link',
  youtube: 'yt_link',
  pinterest: 'pin_link',
};

export function platformOfMediaType(mediaType: string | null): Platform | null {
  const entry = Object.entries(LINK_MEDIA_TYPES).find(([, v]) => v === mediaType);
  return entry ? (entry[0] as Platform) : null;
}

const TIKTOK_VIDEO_RE =
  /https?:\/\/(?:www\.|m\.)?tiktok\.com\/@[\w.-]+\/(?:video|photo)\/(\d{8,25})/i;
const TIKTOK_SHORT_RE = /https?:\/\/(?:vm|vt)\.tiktok\.com\/([A-Za-z0-9]{5,20})/i;
const TIKTOK_T_RE = /https?:\/\/(?:www\.)?tiktok\.com\/t\/([A-Za-z0-9]{5,20})/i;

const YOUTUBE_RE =
  /https?:\/\/(?:(?:www\.|m\.)?youtube\.com\/(?:shorts\/|watch\?(?:[^\s#]*&)?v=|live\/)|youtu\.be\/)([\w-]{11})/i;

// Slug'li pin: /pin/dinner-recipe-ideas--877920521098827309/ → ID "--" dan keyin
const PINTEREST_RE =
  /https?:\/\/(?:[a-z]{2,3}\.)?(?:www\.)?pinterest\.[a-z.]{2,6}\/pin\/(?:[^/\s?#]*--)?(\d{6,25})/i;
const PINTEREST_SHORT_RE = /https?:\/\/pin\.it\/([A-Za-z0-9]{4,20})/i;

/**
 * Matn ichidan birinchi qo'llab-quvvatlanadigan havolani topadi.
 * Foydalanuvchi havolani ko'pincha izoh bilan yuboradi ("manavi nima qo'shiq?").
 */
export function parseMediaLink(text: string): MediaLink | null {
  const ig = parseInstagramLink(text);
  if (ig) return { platform: 'instagram', url: ig.url, key: `ig:${ig.shortcode}` };

  let m = TIKTOK_VIDEO_RE.exec(text);
  if (m?.[1]) {
    return { platform: 'tiktok', url: m[0].split(/[?#]/)[0]!, key: `tt:${m[1]}` };
  }
  m = TIKTOK_SHORT_RE.exec(text) ?? TIKTOK_T_RE.exec(text);
  if (m?.[1]) {
    return { platform: 'tiktok', url: `https://vm.tiktok.com/${m[1]}/`, key: `tt:s:${m[1]}` };
  }

  m = YOUTUBE_RE.exec(text);
  if (m?.[1]) {
    return { platform: 'youtube', url: `https://youtu.be/${m[1]}`, key: `yt:${m[1]}` };
  }

  m = PINTEREST_RE.exec(text);
  if (m?.[1]) {
    return {
      platform: 'pinterest',
      url: `https://www.pinterest.com/pin/${m[1]}/`,
      key: `pin:${m[1]}`,
    };
  }
  m = PINTEREST_SHORT_RE.exec(text);
  if (m?.[1]) {
    return { platform: 'pinterest', url: `https://pin.it/${m[1]}`, key: `pin:s:${m[1]}` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deep link: t.me/bot?start=dl_<kalit> — inline rejimda hali yuklanmagan post
// uchun "Botda yuklab olish" tugmasi. start parametri faqat [A-Za-z0-9_-],
// ≤64 belgi bo'lishi mumkin, shuning uchun ":" o'rniga "_".
// ---------------------------------------------------------------------------

const START_PREFIX = 'dl_';

export function startPayloadOf(key: string): string | null {
  const payload = START_PREFIX + key.replaceAll(':', '_');
  return /^[\w-]{1,64}$/.test(payload) ? payload : null;
}

/** start parametridan havolani tiklaydi (bilinmasa — null). */
export function linkFromStartPayload(payload: string): MediaLink | null {
  if (!payload.startsWith(START_PREFIX)) return null;
  const rest = payload.slice(START_PREFIX.length);
  const [prefix, ...tail] = rest.split('_');
  const id = tail.join('_');
  if (!id) return null;

  const short = id.startsWith('s_') ? id.slice(2) : null;
  switch (prefix) {
    case 'ig':
      return parseMediaLink(`https://www.instagram.com/p/${id}/`);
    case 'tt':
      return parseMediaLink(
        short ? `https://vm.tiktok.com/${short}/` : `https://www.tiktok.com/@_/video/${id}`,
      );
    case 'yt':
      return parseMediaLink(`https://youtu.be/${id}`);
    case 'pin':
      return parseMediaLink(short ? `https://pin.it/${short}` : `https://www.pinterest.com/pin/${id}/`);
    default:
      return null;
  }
}
