import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import { safeUnlink } from './media.ts';

export interface MusicTrack {
  id: string; // YouTube Video ID
  title: string;
  artist: string;
  durationText: string;
  durationSec: number;
  thumbnail: string | null;
}

export interface TrendingTrack {
  id: string;
  title: string;
  artist: string;
  durationText: string;
  durationSec: number;
  coverUrl: string | null;
}

const metadataCache = new Map<string, { title: string; artist: string; durationSec: number }>();

export function rememberTrackMetadata(id: string, meta: { title: string; artist: string; durationSec: number }): void {
  metadataCache.set(id, meta);
}

export function getTrackMetadata(id: string): { title: string; artist: string; durationSec: number } | undefined {
  return metadataCache.get(id);
}

import { getMediaCache, putMediaCache } from '../db/media-cache.repo.ts';

export async function getCachedAudioFileId(videoId: string): Promise<string | null> {
  const cached = await getMediaCache(`yt_audio:${videoId}`);
  return cached?.[0]?.fileId ?? null;
}

export async function saveAudioFileIdToCache(videoId: string, fileId: string): Promise<void> {
  await putMediaCache(`yt_audio:${videoId}`, [{ kind: 'audio', fileId }]);
}

/**
 * YouTube'dan tezkor va bepul qidiruv (youtubei ichki API orqali, kalitsiz).
 */
export async function searchYouTube(query: string, limit = 5): Promise<MusicTrack[]> {
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20240101.00.00',
            hl: 'en',
            gl: 'US',
          },
        },
        query,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, 'YouTube qidiruv javob bermadi');
      return [];
    }

    const data = (await res.json()) as any;
    const sections =
      data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];

    const tracks: MusicTrack[] = [];
    for (const section of sections) {
      const items = section.itemSectionRenderer?.contents || [];
      for (const item of items) {
        const vr = item.videoRenderer;
        if (!vr || !vr.videoId) continue;

        const title = vr.title?.runs?.map((r: any) => r.text).join('') || '';
        if (!title) continue;

        const durationText = vr.lengthText?.simpleText || '0:00';
        const durationSec = parseDurationText(durationText);
        // 20 daqiqadan uzun videolarni musiqa deb hisoblamaymiz (stream/podcast)
        if (durationSec > 20 * 60) continue;

        const artist = vr.ownerText?.runs?.[0]?.text || '';
        const thumbnail = vr.thumbnail?.thumbnails?.[0]?.url || null;

        rememberTrackMetadata(vr.videoId, { title, artist, durationSec });

        tracks.push({
          id: vr.videoId,
          title,
          artist,
          durationText,
          durationSec,
          thumbnail,
        });

        if (tracks.length >= limit) break;
      }
      if (tracks.length >= limit) break;
    }

    return tracks;
  } catch (e) {
    logger.warn({ err: errMessage(e), query }, 'YouTube qidiruv xatosi');
    return [];
  }
}

/**
 * MM:SS yoki HH:MM:SS formatidagi matnni sekundga aylantiradi.
 */
function parseDurationText(str: string): number {
  const parts = str.split(':').map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 2) return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  if (parts.length === 3) return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  return 0;
}

/**
 * YouTube videosining audio oqimini yt-dlp orqali to'liq MP3 formatida yuklaydi.
 */
export async function downloadYouTubeAudio(
  videoId: string,
  timeoutMs = 60_000,
): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const tmpDir = os.tmpdir();
  const filename = `yt_audio_${videoId}_${randomUUID().slice(0, 8)}.mp3`;
  const filePath = path.join(tmpDir, filename);

  const cleanup = async (): Promise<void> => {
    await safeUnlink(filePath);
  };

  const args = [
    '-x',
    '--audio-format',
    'mp3',
    '--audio-quality',
    '128K',
    '--no-playlist',
    '--no-warnings',
    '-o',
    filePath,
    `https://www.youtube.com/watch?v=${videoId}`,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args);

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      cleanup().catch(() => {});
      reject(new Error('Audio yuklab olish vaqti tugadi (timeout)'));
    }, timeoutMs);

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', async (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          const stat = await fsp.stat(filePath);
          if (stat.size > 0) {
            resolve({ filePath, cleanup });
            return;
          }
        } catch {}
      }
      await cleanup();
      reject(new Error(`yt-dlp xatosi (kod ${code}): ${stderr.slice(-300)}`));
    });

    proc.on('error', async (err) => {
      clearTimeout(timer);
      await cleanup();
      reject(err);
    });
  });
}

/**
 * Deezer Chart API orqali Top trend qo'shiqlarni oladi (100% bepul, kalitsiz).
 */
export async function getTopCharts(limit = 10): Promise<TrendingTrack[]> {
  try {
    const res = await fetch(`https://api.deezer.com/chart/0/tracks?limit=${limit}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];

    const json = (await res.json()) as any;
    if (!Array.isArray(json.data)) return [];

    return json.data.slice(0, limit).map((t: any) => {
      const durSec = t.duration || 0;
      const m = Math.floor(durSec / 60);
      const s = durSec % 60;
      return {
        id: String(t.id),
        title: t.title || 'Noma\'lum nom',
        artist: t.artist?.name || 'Noma\'lum ijrochi',
        durationText: `${m}:${String(s).padStart(2, '0')}`,
        durationSec: durSec,
        coverUrl: t.album?.cover_big || t.album?.cover_medium || null,
      };
    });
  } catch (e) {
    logger.warn({ err: errMessage(e) }, 'Top charts olishda xatolik');
    return [];
  }
}
