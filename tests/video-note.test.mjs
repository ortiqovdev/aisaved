/**
 * /round uchun: makeVideoNote() haqiqiy ffmpeg bilan to'g'ri video note
 * yasayotganini tekshiradi (kvadrat 640×640, H.264, ≤60s, ovoz ixtiyoriy).
 *
 *   npm run test:round        (ffmpeg o'rnatilgan bo'lishi kerak)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeVideoNote, VIDEO_NOTE_SIZE } from '../src/services/media.ts';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisaved-round-'));

let pass = 0;
let fail = 0;
const ok = (name, cond, why = '') => {
  if (cond) pass += 1;
  else fail += 1;
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}${!cond && why ? ` — ${why}` : ''}`);
};

/** Sinov videosini yasaydi. */
function makeSource(name, { w, h, seconds, audio }) {
  const out = path.join(dir, name);
  const args = ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=30:duration=${seconds}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac', '-shortest'] : []), out);
  const r = spawnSync(ffmpeg, args);
  if (r.status !== 0) throw new Error(`manba yasalmadi: ${r.stderr}`);
  return out;
}

/** ffmpeg -i chiqishidan asosiy parametrlar. */
function inspect(file) {
  const { stderr } = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const video = /Video: (\w+).*?, (\d+)x(\d+)/.exec(stderr);
  const dur = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(stderr);
  return {
    codec: video?.[1],
    width: Number(video?.[2]),
    height: Number(video?.[3]),
    seconds: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : NaN,
    hasAudio: /Audio: aac/.test(stderr),
  };
}

const cases = [
  { name: 'reels 9:16, 70s, ovozli', src: { w: 720, h: 1280, seconds: 70, audio: true }, trimmed: true, audio: true },
  { name: 'qisqa, ovozsiz', src: { w: 480, h: 854, seconds: 8, audio: false }, trimmed: false, audio: false },
  { name: 'gorizontal 16:9', src: { w: 1280, h: 720, seconds: 5, audio: true }, trimmed: false, audio: true },
];

for (const c of cases) {
  console.log(`\n${c.name}`);
  const src = makeSource(`${c.name.replace(/\W+/g, '_')}.mp4`, c.src);
  const note = await makeVideoNote(src);
  const info = inspect(note.filePath);
  ok('kvadrat 640×640', info.width === VIDEO_NOTE_SIZE && info.height === VIDEO_NOTE_SIZE, `${info.width}x${info.height}`);
  ok('H.264', info.codec === 'h264', info.codec);
  ok('≤ 60 soniya', info.seconds <= 60.5, `${info.seconds}s`);
  ok(`trimmed = ${c.trimmed}`, note.trimmed === c.trimmed);
  ok(`duration ≈ ${Math.min(c.src.seconds, 60)}`, Math.abs(note.duration - Math.min(c.src.seconds, 60)) <= 1, `${note.duration}`);
  ok(`ovoz ${c.audio ? 'bor' : 'yo\'q'}`, info.hasAudio === c.audio);
  ok('hajmi Telegram limitida', fs.statSync(note.filePath).size < 50 * 1024 * 1024);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n=== NATIJA: ${pass} o'tdi, ${fail} yiqildi ===`);
process.exit(fail === 0 ? 0 : 1);
