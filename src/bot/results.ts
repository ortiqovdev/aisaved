import { InlineKeyboard } from 'grammy';
import type { SongInfo } from '../services/audd.ts';
import { buildQuery, searchTracks, type DeezerTrack } from '../services/deezer.ts';
import { escapeHtml } from './messages.ts';

/** Inline tugma callback prefiksi: preview yuborish. */
export const PREVIEW_PREFIX = 'pv';
const MAX_VERSIONS = 5;
/** Filtrdan keyin 5 ta qolishi uchun kengroq qidiramiz. */
const SEARCH_LIMIT = 25;

/**
 * Taqqoslash uchun nomni soddalashtiradi:
 *   "Mambo Italiano (2005 Remaster)" -> "mambo italiano"
 */
function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ') // qavs ichidagi izohlar
    .replace(/[^\p{L}\p{N}]+/gu, ' ') // tinish belgilari
    .replace(/\s+/g, ' ')
    .trim();
}

function titlesMatch(a: string, b: string): boolean {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // Qisqa nomlarda "ichida bor" tekshiruvi tasodifiy mos kelib qolishi mumkin
  const shorter = x.length <= y.length ? x : y;
  if (shorter.length < 5) return false;
  return x.includes(y) || y.includes(x);
}

/**
 * Qidiruv natijasidan HAQIQATAN shu qo'shiqning versiyalarini ajratadi.
 *
 * Deezer bitta albomdagi boshqa treklarni ham qaytaradi — ularni ko'rsatish
 * chalkash bo'lardi ("Versiyalar" deb yozib, butunlay boshqa qo'shiq berish).
 * Shuning uchun nomi mos kelganlarini olamiz, o'sha ijrochinikini yuqoriga
 * qo'yamiz va takrorlarni tashlaymiz.
 */
function pickVersions(tracks: DeezerTrack[], song: SongInfo): DeezerTrack[] {
  const sameTitle = tracks.filter((t) => t.previewUrl && titlesMatch(t.title, song.title));

  const artistKey = normalizeTitle(song.artist);
  sameTitle.sort((a, b) => {
    const aSame = normalizeTitle(a.artist) === artistKey ? 0 : 1;
    const bSame = normalizeTitle(b.artist) === artistKey ? 0 : 1;
    return aSame - bSame;
  });

  const seen = new Set<string>();
  const out: DeezerTrack[] = [];
  for (const t of sameTitle) {
    const key = `${normalizeTitle(t.artist)}|${normalizeTitle(t.title)}|${t.durationSec}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_VERSIONS) break;
  }
  return out;
}

export interface SongMessage {
  text: string;
  keyboard: InlineKeyboard | undefined;
  coverUrl: string | null;
}

const NUMBER_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Aniqlangan qo'shiq uchun to'liq javob: matn + muqova + inline tugmalar.
 *
 * Tugmalar:
 *   1️⃣..5️⃣  — Deezer'dagi versiyalar; bosilganda RASMIY 30 soniyalik
 *              preview audio fayl sifatida yuboriladi
 *   🎧/🍎/🔗 — to'liq qo'shiqni tinglash uchun platforma havolalari
 */
export async function buildSongMessage(song: SongInfo | null): Promise<SongMessage> {
  if (!song) {
    return {
      text:
        '🎵 Musiqa aniqlanmadi.\n' +
        '<i>Ba\'zan reels\'da original ovoz, gapirish yoki juda qisqa parcha bo\'ladi.</i>',
      keyboard: undefined,
      coverUrl: null,
    };
  }

  const found = await searchTracks(buildQuery(song.artist, song.title), SEARCH_LIMIT);
  const versions = pickVersions(found, song);

  const lines = [
    `🎵 <b>${escapeHtml(song.title)}</b>`,
    `👤 ${escapeHtml(song.artist)}`,
  ];
  if (song.album) lines.push(`💿 ${escapeHtml(song.album)}`);

  if (versions.length > 0) {
    lines.push('', '<b>Versiyalar</b> — tinglash uchun raqamni bosing:');
    versions.forEach((t, i) => {
      const num = NUMBER_EMOJI[i] ?? `${i + 1}.`;
      const album = t.album ? ` · <i>${escapeHtml(t.album)}</i>` : '';
      lines.push(
        `${num} ${escapeHtml(t.artist)} — ${escapeHtml(t.title)}${album} <b>${formatDuration(t.durationSec)}</b>`,
      );
    });
  }

  return {
    text: lines.join('\n'),
    keyboard: buildKeyboard(song, versions),
    coverUrl: song.coverUrl ?? versions[0]?.coverUrl ?? null,
  };
}

function buildKeyboard(song: SongInfo, versions: DeezerTrack[]): InlineKeyboard | undefined {
  const kb = new InlineKeyboard();
  let hasAny = false;

  // 1-qator: versiya raqamlari
  if (versions.length > 0) {
    versions.forEach((t, i) => {
      kb.text(NUMBER_EMOJI[i] ?? String(i + 1), `${PREVIEW_PREFIX}:${t.id}`);
    });
    kb.row();
    hasAny = true;
  }

  // 2-qator: platforma havolalari (to'liq qo'shiq o'sha yerda tinglanadi)
  const links: Array<[string, string]> = [];
  if (song.spotifyUrl) links.push(['🎧 Spotify', song.spotifyUrl]);
  if (song.appleUrl) links.push(['🍎 Apple Music', song.appleUrl]);
  if (versions[0]?.link) links.push(['💜 Deezer', versions[0].link]);
  if (links.length === 0 && song.link) links.push(['🔗 Tinglash', song.link]);

  for (const [label, url] of links) kb.url(label, url);
  if (links.length > 0) {
    kb.row();
    hasAny = true;
  }

  // 3-qator: YouTube'da qidirish
  kb.url(
    '🔍 YouTube\'da qidirish',
    `https://www.youtube.com/results?search_query=${encodeURIComponent(buildQuery(song.artist, song.title))}`,
  );
  hasAny = true;

  return hasAny ? kb : undefined;
}
