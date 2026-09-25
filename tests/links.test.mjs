/**
 * Havolalarni tanish (Instagram, TikTok, YouTube, Pinterest) va inline
 * rejimdagi deep link (/start dl_...) ni tekshiradi.
 *
 *   npm run test:links
 */
import { linkFromStartPayload, parseMediaLink, startPayloadOf } from '../src/services/links.ts';

let pass = 0;
let fail = 0;
const ok = (name, cond, why = '') => {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL ${name}${why ? ` — ${why}` : ''}`);
  }
};

const cases = [
  // [matn, platforma, kalit, url]
  ['https://www.instagram.com/reel/DdWTtLSMC56/?igsh=abc', 'instagram', 'ig:DdWTtLSMC56', 'https://www.instagram.com/reel/DdWTtLSMC56/'],
  ['https://www.tiktok.com/@scout2015/video/6718335390845095173?lang=en', 'tiktok', 'tt:6718335390845095173', 'https://www.tiktok.com/@scout2015/video/6718335390845095173'],
  ['qara https://vm.tiktok.com/ZMabc123/ zo\'r', 'tiktok', 'tt:s:ZMabc123', 'https://vm.tiktok.com/ZMabc123/'],
  ['https://vt.tiktok.com/ZSxyz789/', 'tiktok', 'tt:s:ZSxyz789', 'https://vm.tiktok.com/ZSxyz789/'],
  ['https://www.tiktok.com/t/ZT8abcDEF/', 'tiktok', 'tt:s:ZT8abcDEF', 'https://vm.tiktok.com/ZT8abcDEF/'],
  ['https://m.tiktok.com/@user.name/photo/7300000000000000001', 'tiktok', 'tt:7300000000000000001', 'https://m.tiktok.com/@user.name/photo/7300000000000000001'],
  ['https://youtube.com/shorts/jNQXAC9IVRw?si=xyz', 'youtube', 'yt:jNQXAC9IVRw', 'https://youtu.be/jNQXAC9IVRw'],
  ['https://youtu.be/jNQXAC9IVRw', 'youtube', 'yt:jNQXAC9IVRw', 'https://youtu.be/jNQXAC9IVRw'],
  ['https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5', 'youtube', 'yt:jNQXAC9IVRw', 'https://youtu.be/jNQXAC9IVRw'],
  ['https://m.youtube.com/watch?feature=share&v=jNQXAC9IVRw', 'youtube', 'yt:jNQXAC9IVRw', 'https://youtu.be/jNQXAC9IVRw'],
  ['https://www.pinterest.com/pin/877920521098827309/', 'pinterest', 'pin:877920521098827309', 'https://www.pinterest.com/pin/877920521098827309/'],
  ['https://in.pinterest.com/pin/video-recipes--856246947935444536/', 'pinterest', 'pin:856246947935444536', 'https://www.pinterest.com/pin/856246947935444536/'],
  ['https://www.pinterest.co.uk/pin/dinner-ideas-2024--877920521098827309/', 'pinterest', 'pin:877920521098827309', 'https://www.pinterest.com/pin/877920521098827309/'],
  ['https://pin.it/2QWxGtM', 'pinterest', 'pin:s:2QWxGtM', 'https://pin.it/2QWxGtM'],
];

for (const [text, platform, key, url] of cases) {
  const r = parseMediaLink(text);
  ok(`${platform}: ${text.slice(0, 60)}`, r?.platform === platform && r.key === key && r.url === url, JSON.stringify(r));
}

for (const bad of ['oddiy matn', 'https://tiktok.com/', 'https://youtube.com/@channel', 'https://www.pinterest.com/ideas/', 'https://example.com/pin/123456789']) {
  ok(`rad etildi: ${bad}`, parseMediaLink(bad) === null, JSON.stringify(parseMediaLink(bad)));
}

// Deep link: kalit → start parametri → havola → o'sha kalit
for (const [text, , key] of cases) {
  const payload = startPayloadOf(key);
  const back = payload ? linkFromStartPayload(payload) : null;
  ok(`deep link: ${key}`, payload !== null && /^[\w-]{1,64}$/.test(payload) && back?.key === key, `${payload} → ${JSON.stringify(back)}`);
}
ok('begona start parametri', linkFromStartPayload('ref_123') === null && linkFromStartPayload('dl_xx_1') === null);

console.log(`\n=== NATIJA: ${pass} o'tdi, ${fail} yiqildi ===`);
process.exit(fail === 0 ? 0 : 1);
