/**
 * Lug'atlar tekshiruvi: har bir tilda hamma kalit bor, `{o'zgaruvchi}`lar
 * inglizchadagi bilan bir xil, HTML teglar juft, Telegram limitlari buzilmagan.
 *
 *   npm run test:i18n
 */
import { en } from '../src/i18n/locales/en.ts';
import { LANGS, detectLang, t } from '../src/i18n/index.ts';

const locales = {
  en,
  uz: (await import('../src/i18n/locales/uz.ts')).uz,
  ru: (await import('../src/i18n/locales/ru.ts')).ru,
  ar: (await import('../src/i18n/locales/ar.ts')).ar,
  kk: (await import('../src/i18n/locales/kk.ts')).kk,
  tr: (await import('../src/i18n/locales/tr.ts')).tr,
};

let pass = 0;
let fail = 0;
const ok = (name, cond, why = '') => {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL ${name}${why ? ` — ${why}` : ''}`);
  }
};

const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const tags = (s) => {
  const stack = [];
  for (const m of s.matchAll(/<(\/?)(b|i|code)>/g)) {
    if (!m[1]) stack.push(m[2]);
    else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0;
};

// Telegram Bot API limitlari
const LIMITS = { botShortDescription: 120, botDescription: 512 };
const TOAST_KEYS = ['songSearching', 'songAlreadyRequested', 'pendingLimit', 'roundNeedVideo', 'invalidChoice', 'cantSendHere', 'sending'];
const COMMAND_KEYS = ['cmdStart', 'cmdRound', 'cmdStatus', 'cmdUnlink', 'cmdLanguage', 'cmdHelp'];

ok('LANGS ro\'yxati lug\'atlarga mos', LANGS.every((l) => l in locales));

for (const [lang, dict] of Object.entries(locales)) {
  for (const key of Object.keys(en)) {
    const s = dict[key];
    ok(`${lang}.${key} bor`, typeof s === 'string' && s.trim() !== '');
    if (typeof s !== 'string') continue;
    ok(`${lang}.${key} o'zgaruvchilari`, vars(s) === vars(en[key]), `${vars(s)} ≠ ${vars(en[key])}`);
    ok(`${lang}.${key} HTML teglari`, tags(s));
    if (key.startsWith('ig') && !key.startsWith('igLinkedTelegram') && !key.startsWith('igReel') &&
        !key.startsWith('igNotDownloadable') && !key.startsWith('igPending')) {
      ok(`${lang}.${key} Instagram uchun HTML'siz`, !/<\/?(b|i|code)>/.test(s));
    }
  }
  const account = 'aisavedbot';
  for (const [key, max] of Object.entries(LIMITS)) {
    const len = [...t(lang, key, { account })].length;
    ok(`${lang}.${key} ≤ ${max}`, len <= max, `${len} belgi`);
  }
  // answerCallbackQuery matni (toast/alert) ≤ 200 belgi
  for (const key of TOAST_KEYS) {
    const len = [...t(lang, key, { n: 10 })].length;
    ok(`${lang}.${key} toast ≤ 200`, len <= 200, `${len} belgi`);
  }
  for (const key of COMMAND_KEYS) {
    const len = [...dict[key]].length;
    ok(`${lang}.${key} 3..256`, len >= 3 && len <= 256, `${len} belgi`);
  }
}

// Tilni aniqlash
for (const [code, want] of [
  ['uz', 'uz'], ['ru-RU', 'ru'], ['pt-br', 'en'], ['uk', 'ru'], ['ky', 'kk'],
  ['az', 'tr'], [undefined, 'en'], ['ar', 'ar'], ['TR', 'tr'],
]) {
  ok(`detectLang(${code}) = ${want}`, detectLang(code) === want, detectLang(code));
}

ok('t() o\'zgaruvchini almashtiradi', t('en', 'pendingLimit', { n: 3 }).includes('3 requests'));

console.log(`\n=== NATIJA: ${pass} o'tdi, ${fail} yiqildi ===`);
process.exit(fail === 0 ? 0 : 1);
