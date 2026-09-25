import http from 'node:http';

/**
 * Soxta provayder. `env` moduli bir marta yuklanadigani uchun endpoint
 * o'zgarmas bo'ladi — javob shaklini so'ralgan HAVOLA shortcode'iga qarab
 * tanlaymiz.
 */
const SHAPES = {
  A: { data: { video_url: 'https://cdn.example.com/reel-a.mp4' } },
  B: { media: [{ url: 'https://cdn.example.com/reel-b.mp4', type: 'video' }] },
  C: { result: { formats: [{ url: 'https://x/cover.jpg' }, { url: 'https://x/reel-c.mp4' }] } },
  D: { links: [{ link: 'https://scontent.cdninstagram.com/v/t50.2886-16/abc123' }] },
  E: { status: 'ok', data: { thumbnail: 'https://x/t.jpg', title: 'Salom' } }, // video yo'q
  F: { data: { medias: [{ url: 'https://cdn.example.com/deep-f.mp4', quality: 'hd' }] } },
  G: { data: { video_url: 'https://cdn.example.com/g.mp4', title: 'Sarlavha', username: 'ortqv7' } },
  // Haqiqiy provayder shakli (instagram-post-reels-stories-downloader-api): karusel
  H: { status: true, result: [
    { url: 'https://cdn.example.com/1.jpg', type: 'image/jpeg', thumb: 'https://t/1' },
    { url: 'https://cdn.example.com/2.mp4', type: 'video/mp4', thumb: 'https://t/2' },
    { url: 'https://cdn.example.com/3.jpg', type: 'image/jpeg', thumb: 'https://t/3' },
  ] },
  // Bitta videoning sifat variantlari (turi ko'rsatilmagan) — karusel EMAS
  I: { data: { medias: [
    { url: 'https://cdn.example.com/hd.mp4', quality: 'hd' },
    { url: 'https://cdn.example.com/sd.mp4', quality: 'sd' },
  ] } },
  J: { status: true, result: [{ url: 'https://cdn.example.com/photo.jpg', type: 'image/jpeg', thumb: 'https://cdn.example.com/t.jpg' }] },
};

const server = http.createServer((req, res) => {
  const q = new URL(req.url, 'http://x').searchParams.get('url') ?? '';
  const code = /\/reel\/([A-Za-z0-9_-]+)/.exec(q)?.[1] ?? '';

  if (code === 'ERR500') { res.writeHead(500); res.end('provayder band'); return; }
  if (code === 'ERR403') { res.writeHead(403); res.end('kalit yaroqsiz'); return; }
  if (code === 'ERRJSON') { res.writeHead(200, {'content-type':'application/json'}); res.end('{buzuq'); return; }

  const body = SHAPES[code];
  res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body ?? { error: 'topilmadi' }));
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// env.ts import qilinishidan OLDIN
process.env.IG_RESOLVER_URL = `http://127.0.0.1:${port}/api?url={url}`;

const { parseInstagramLink, resolveInstagramMedia, isResolverConfigured } =
  await import('../src/services/ig-resolver.ts');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

console.log('\n=== 1) Havolani tanish ===');
for (const [input, code] of [
  ['https://www.instagram.com/reel/DbgbcSioLhg/', 'DbgbcSioLhg'],
  ['https://instagram.com/reels/ABC-123_x/', 'ABC-123_x'],
  ['https://www.instagram.com/p/XyZ9/', 'XyZ9'],
  ['https://www.instagram.com/tv/Qwe123/', 'Qwe123'],
  ['https://www.instagram.com/ortqv7/reel/Dc_FP07Nrwm/', 'Dc_FP07Nrwm'],
  ["manavi nima qo'shiq? https://www.instagram.com/reel/AAA111/?igsh=xyz rahmat", 'AAA111'],
  ['https://www.instagram.com/share/reel/BBB222/', 'BBB222'],
  ['http://instagram.com/reel/CCC333', 'CCC333'],
]) {
  const r = parseInstagramLink(input);
  ok(`shortcode = ${code}`, r?.shortcode === code, `-> ${JSON.stringify(r)}`);
}
for (const bad of ['oddiy matn', 'https://tiktok.com/@a/video/123', 'https://youtube.com/watch?v=x']) {
  ok(`rad etildi: ${bad.slice(0, 30)}`, parseInstagramLink(bad) === null);
}
const norm = parseInstagramLink('https://instagram.com/reels/ABC/?igsh=1');
ok('kanonik shaklga keltirildi', norm?.url === 'https://www.instagram.com/reel/ABC/', `-> ${norm?.url}`);

console.log('\n=== 2) Provayder javobidan video ajratish ===');
ok('resolver sozlangan', isResolverConfigured() === true);
const R = (c) => resolveInstagramMedia(`https://www.instagram.com/reel/${c}/`);
for (const [code, want, desc] of [
  ['A', 'https://cdn.example.com/reel-a.mp4', 'data.video_url'],
  ['B', 'https://cdn.example.com/reel-b.mp4', 'media[].url'],
  ['C', 'https://x/reel-c.mp4', 'rasmni tashlab, .mp4 ni tanladi'],
  ['D', 'https://scontent.cdninstagram.com/v/...', 'kengaytmasiz CDN havolasi'],
  ['F', 'https://cdn.example.com/deep-f.mp4', 'chuqur joylashgan'],
]) {
  try {
    const r = await R(code);
    const got = r.items[0]?.url ?? '';
    ok(`${code}: ${desc}`, r.items.length === 1 && r.items[0].kind === 'video' && (code === 'D' ? got.includes('cdninstagram') : got === want), `oldi: ${JSON.stringify(r.items)}`);
  } catch (e) { ok(`${code}: ${desc}`, false, `xato: ${e.message}`); }
}

console.log('\n=== 2b) Rasm va karusel postlar ===');
for (const [code, want, desc] of [
  ['H', ['photo https://cdn.example.com/1.jpg', 'video https://cdn.example.com/2.mp4', 'photo https://cdn.example.com/3.jpg'], 'karusel: 3 ta fayl, tartib va turlar saqlangan'],
  ['I', ['video https://cdn.example.com/hd.mp4'], 'sifat variantlari — bitta video (dublikat yo\'q)'],
  ['J', ['photo https://cdn.example.com/photo.jpg'], 'bitta rasm, muqova (thumb) emas'],
]) {
  try {
    const r = await R(code);
    const got = r.items.map((i) => `${i.kind} ${i.url}`);
    ok(`${code}: ${desc}`, JSON.stringify(got) === JSON.stringify(want), `oldi: ${JSON.stringify(got)}`);
  } catch (e) { ok(`${code}: ${desc}`, false, `xato: ${e.message}`); }
}
try {
  const g = await R('G');
  ok('sarlavha va muallif ham olindi', g.title === 'Sarlavha' && g.author === 'ortqv7', JSON.stringify(g));
} catch (e) { ok('sarlavha va muallif', false, e.message); }

console.log('\n=== 3) Xato holatlari ===');
for (const [code, kind, wantType] of [
  ['E', 'javobda video yo\'q', 'PermanentError'],
  ['ERR500', 'provayder 5xx', 'TransientError'],
  ['ERR403', 'kalit yaroqsiz', 'PermanentError'],
  ['ERRJSON', 'buzuq JSON', 'TransientError'],
  ['ZZZ', 'provayder 404', 'PermanentError'],
]) {
  try {
    await R(code);
    ok(`${kind}`, false, 'xato bermadi!');
  } catch (e) {
    ok(`${kind} -> ${e.constructor.name}`, e.constructor.name === wantType, `kutilgan ${wantType}`);
    if (e.userMessage) console.log(`         user: ${e.userMessage.key}`);
  }
}

server.close();
console.log(`\n=== NATIJA: ${pass} o'tdi, ${fail} yiqildi ===`);
process.exit(fail === 0 ? 0 : 1);
