import { InlineKeyboard } from 'grammy';
import type { SongInfo } from '../services/audd.ts';
import { escapeHtml } from './messages.ts';
import { t, type Lang } from '../i18n/index.ts';
import {
  searchYouTube,
  type MusicTrack,
  type TrendingTrack,
} from '../services/youtube.ts';

/** Inline tugma callback prefikslari */
export const YT_AUDIO_DL_PREFIX = 'yd';
export const TOP_DL_PREFIX = 'tp';
export const PREVIEW_PREFIX = 'pv'; // Eski qisqa parcha bilan moslik uchun

export interface SongMessage {
  text: string;
  keyboard: InlineKeyboard | undefined;
  coverUrl: string | null;
}

const CAPTION_LIMIT = 1024;
const FIELD_LIMIT = 100;

function clip(value: string, limit = FIELD_LIMIT): string {
  const v = value.trim();
  return v.length <= limit ? v : `${v.slice(0, limit - 1)}…`;
}

/**
 * Aniqlangan qo'shiq uchun to'liq javob (SongFastBot uslubida):
 * Qo'shiq nomi + YouTube'dagi 5 ta eng yaxshi versiya + 1..5 yuklab olish tugmalari.
 */
export async function buildSongMessage(song: SongInfo | null, lang: Lang): Promise<SongMessage> {
  if (!song) {
    return {
      text: t(lang, 'songNotDetected'),
      keyboard: undefined,
      coverUrl: null,
    };
  }

  const query = `${song.artist} ${song.title}`.trim();
  const ytTracks = await searchYouTube(query, 5);

  const lines: string[] = [
    `🎵 <b>${escapeHtml(clip(song.title))}</b> — <i>${escapeHtml(clip(song.artist))}</i>`,
  ];
  if (song.album) lines.push(`💿 <i>${escapeHtml(clip(song.album))}</i>`);

  if (ytTracks.length > 0) {
    lines.push('');
    ytTracks.forEach((t, i) => {
      lines.push(`${i + 1}. ${escapeHtml(clip(t.title, 70))} <b>${t.durationText}</b>`);
    });
  }

  // Caption limitidan oshmasligini ta'minlash
  while (lines.join('\n').length > CAPTION_LIMIT && lines.length > 2) {
    lines.pop();
  }

  const kb = new InlineKeyboard();
  let hasAny = false;

  // 1-qator: 1..5 yuklash tugmalari
  if (ytTracks.length > 0) {
    ytTracks.forEach((t, i) => {
      kb.text(String(i + 1), `${YT_AUDIO_DL_PREFIX}:${t.id}`).success();
    });
    kb.row();
    hasAny = true;
  }

  // YouTube qidiruv havolasi (Spotify/Apple Music tugmalari olib tashlangan)
  kb.url(
    t(lang, 'btnYoutube'),
    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
  );
  hasAny = true;

  return {
    text: lines.join('\n'),
    keyboard: hasAny ? kb : undefined,
    coverUrl: song.coverUrl ?? ytTracks[0]?.thumbnail ?? null,
  };
}

/**
 * Matn orqali qidiruv natijalari xabari (@SongFastBot kabi)
 */
export function buildSearchResultsMessage(
  query: string,
  tracks: MusicTrack[],
  lang: Lang,
): { text: string; keyboard: InlineKeyboard } {
  const lines: string[] = [
    `🎵 <b>Natijalar:</b> <i>"${escapeHtml(clip(query, 50))}"</i>`,
    '',
  ];

  tracks.forEach((t, i) => {
    lines.push(`${i + 1}. ${escapeHtml(clip(t.title, 70))} <b>${t.durationText}</b>`);
  });

  const kb = new InlineKeyboard();
  tracks.forEach((t, i) => {
    kb.text(String(i + 1), `${YT_AUDIO_DL_PREFIX}:${t.id}`).success();
  });

  return {
    text: lines.join('\n'),
    keyboard: kb,
  };
}

/**
 * /top Trend qo'shiqlar xabari
 */
export function buildTopChartsMessage(
  tracks: TrendingTrack[],
  lang: Lang,
): { text: string; keyboard: InlineKeyboard } {
  const lines: string[] = [
    `🔥 <b>Top Trend qo'shiqlar:</b>`,
    '',
  ];

  tracks.forEach((t, i) => {
    lines.push(`${i + 1}. ${escapeHtml(clip(t.artist, 35))} — ${escapeHtml(clip(t.title, 35))} <b>${t.durationText}</b>`);
  });

  const kb = new InlineKeyboard();
  tracks.slice(0, 5).forEach((t, i) => {
    kb.text(String(i + 1), `${TOP_DL_PREFIX}:${i}`).success();
  });
  if (tracks.length > 5) {
    kb.row();
    tracks.slice(5, 10).forEach((t, i) => {
      kb.text(String(i + 6), `${TOP_DL_PREFIX}:${i + 5}`).success();
    });
  }

  return {
    text: lines.join('\n'),
    keyboard: kb,
  };
}
