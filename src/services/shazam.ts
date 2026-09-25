import fsp from 'node:fs/promises';
import path from 'node:path';
import { Shazam, s16LEToSamplesArray } from 'shazam-api';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { TransientError, errMessage } from '../lib/errors.ts';
import { runCommand, safeUnlink } from './media.ts';
import type { SongInfo } from './audd.ts';

/**
 * Qo'shiq aniqlash — norasmiy Shazam (amp.shazam.com, `shazam-api` paketi).
 *
 * Bepul va tez (o'lchangan: 0.7–0.9 s), katalogi katta, ISRC va muqova beradi.
 * Kamchiligi: rasmiy API emas — Shazam qoidalariga zid, bitta IP'dan juda ko'p
 * so'rov bo'lsa bloklaydi (429) va istalgan payt o'zgarib qolishi mumkin.
 * Shuning uchun u asosiy bo'g'in, lekin yagona emas: kesh va (yoqilgan
 * bo'lsa) AudD zaxirasi bilan birga ishlaydi.
 *
 * Kirish: 16 kHz, mono, 16-bit PCM (s16le). Shazam ~12 s dan ortig'ini
 * ishlatmaydi — bizning parcha (AUDD_SNIPPET_SECONDS) shunga mos.
 */
const client = new Shazam('Asia/Tashkent');

/** Shazam javobining bizga kerakli qismi. */
interface ShazamTrack {
  title?: string;
  subtitle?: string;
  url?: string;
  isrc?: string;
  images?: { coverart?: string; coverarthq?: string };
  sections?: Array<{ type?: string; metadata?: Array<{ title?: string; text?: string }> }>;
  hub?: {
    options?: Array<{ actions?: Array<{ type?: string; uri?: string }> }>;
    providers?: Array<{ type?: string; actions?: Array<{ uri?: string }> }>;
  };
}

const TIMEOUT_MS = 15_000;

export async function identifyWithShazam(audioPath: string): Promise<SongInfo | null> {
  const pcmPath = path.join(
    path.dirname(audioPath),
    `${path.basename(audioPath, path.extname(audioPath))}.pcm`,
  );
  try {
    await runCommand(
      env.FFMPEG_PATH,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', audioPath, '-ar', '16000', '-ac', '1', '-f', 's16le', pcmPath],
      30_000,
    );
    const pcm = await fsp.readFile(pcmPath);
    if (pcm.length < 16_000 * 2 * 2) return null; // 2 s dan qisqa — barmoq izi chiqmaydi

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Shazam ${TIMEOUT_MS}ms ichida javob bermadi`)), TIMEOUT_MS);
    });
    let result: { track?: ShazamTrack } | null;
    try {
      result = (await Promise.race([
        client.fullRecognizeSong(s16LEToSamplesArray(pcm)),
        timeout,
      ])) as { track?: ShazamTrack } | null;
    } finally {
      clearTimeout(timer);
    }

    const track = result?.track;
    if (!track?.title) {
      logger.debug({ audioPath }, 'Shazam: bu parchada musiqa topilmadi');
      return null;
    }
    return toSongInfo(track);
  } catch (e) {
    // Tarmoq, 429 (IP bloklangan — javob JSON emas), format o'zgargan...
    throw new TransientError(`Shazam: ${errMessage(e)}`);
  } finally {
    await safeUnlink(pcmPath);
  }
}

/** Shazam kuzatuv parametrlarisiz: faqat trek (`?i=`) qoladi. */
function cleanAppleUrl(intent: string): string | null {
  try {
    const url = new URL(`https://${intent.slice('intent://'.length).split('#')[0]}`);
    const track = url.searchParams.get('i');
    url.search = track ? `?i=${track}` : '';
    return url.toString();
  } catch {
    return null;
  }
}

function toSongInfo(track: ShazamTrack): SongInfo {
  const album = track.sections
    ?.find((s) => s.type === 'SONG')
    ?.metadata?.find((m) => m.title === 'Album')?.text;

  // Apple Music: "intent://music.apple.com/...#Intent;..." → https havola
  const appleIntent = track.hub?.options
    ?.flatMap((o) => o.actions ?? [])
    .find((a) => a.uri?.startsWith('intent://music.apple.com'))?.uri;
  const appleUrl = appleIntent ? cleanAppleUrl(appleIntent) : null;

  // Spotify: "spotify:search:<so'rov>" → veb qidiruv sahifasi
  const spotifyUri = track.hub?.providers
    ?.find((p) => p.type === 'SPOTIFY')
    ?.actions?.[0]?.uri;
  const spotifyUrl = spotifyUri?.startsWith('spotify:search:')
    ? `https://open.spotify.com/search/${spotifyUri.slice('spotify:search:'.length)}`
    : null;

  return {
    title: track.title?.trim() || 'Noma\'lum nom',
    artist: track.subtitle?.trim() || 'Noma\'lum ijrochi',
    album: album?.trim() || null,
    link: track.url ?? null,
    spotifyUrl,
    appleUrl,
    coverUrl: track.images?.coverarthq ?? track.images?.coverart ?? null,
  };
}
