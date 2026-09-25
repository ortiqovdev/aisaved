/**
 * Shazam hali ishlayaptimi — jonli tekshiruv (internet kerak).
 * Norasmiy API istalgan payt o'zgarishi mumkin: shu test birinchi bo'lib aytadi.
 *
 *   npm run test:shazam
 *
 * Namuna — AudD'ning ochiq namunaviy fayli (5 s, Tears for Fears). Oldiga
 * 8 s jimlik qo'shiladi — reels boshidagi gapni taqlid qiladi.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LOG_LEVEL = 'silent';
const { identifyWithShazam } = await import('../src/services/shazam.ts');
const { extractAudioSnippet, safeUnlink } = await import('../src/services/media.ts');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisaved-shazam-'));
const sample = path.join(dir, 'sample.mp3');
const withSilence = path.join(dir, 'with-silence.mp3');

const res = await fetch('https://audd.tech/example.mp3');
fs.writeFileSync(sample, Buffer.from(await res.arrayBuffer()));
spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=8', '-i', sample,
  '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]', '-map', '[a]', withSilence,
]);

const snippet = await extractAudioSnippet(withSilence, 0, 12);
const t0 = performance.now();
let song = null;
let error = null;
try {
  song = await identifyWithShazam(snippet);
} catch (e) {
  error = e;
}
const ms = Math.round(performance.now() - t0);
await safeUnlink(snippet);
fs.rmSync(dir, { recursive: true, force: true });

const ok = song && /rule the world/i.test(song.title) && /tears for fears/i.test(song.artist);
console.log(ok ? 'OK  ' : 'FAIL', `${ms}ms`, error ? `xato: ${error.message}` : JSON.stringify({
  title: song?.title, artist: song?.artist, apple: !!song?.appleUrl, spotify: !!song?.spotifyUrl, cover: !!song?.coverUrl,
}));
process.exit(ok ? 0 : 1);
