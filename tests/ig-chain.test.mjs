/**
 * Instagram yo'llari zanjiri (ig-chain.ts) va jarayonlar semafori:
 * blok → keyingi yo'l + sovitish, post xatosi → darhol to'xtash,
 * hammasi bloklansa → keyinroq qayta urinish.
 *
 *   npm run test:chain
 */
process.env.LOG_LEVEL = 'silent';
const { Chain, COOLDOWN_MS } = await import('../src/services/ig-chain.ts');
const { BlockedError, PermanentError, TransientError } = await import('../src/lib/errors.ts');
const { Semaphore } = await import('../src/lib/semaphore.ts');

let pass = 0;
let fail = 0;
const ok = (name, cond, why = '') => {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL ${name}${why ? ` — ${why}` : ''}`);
  }
};
const rejectsWith = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
};

let clock = 1_000_000;
const now = () => clock;
const calls = [];
const s = (name, behaviour) => ({
  name,
  run: async () => {
    calls.push(name);
    if (behaviour instanceof Error) throw behaviour;
    return behaviour;
  },
});

// 1) Birinchi yo'l ishlaydi — keyingilari chaqirilmaydi
{
  const chain = new Chain('t1', now);
  calls.length = 0;
  const r = await chain.run([s('api', 'A'), s('ytdlp', 'B')]);
  ok('birinchisi ishlasa — natija', r === 'A');
  ok('birinchisi ishlasa — keyingisi chaqirilmaydi', calls.join() === 'api');
}

// 2) Blok → keyingi yo'l; bloklangani sovitiladi va keyingi safar o'tkazib yuboriladi
{
  const chain = new Chain('t2', now);
  calls.length = 0;
  const r = await chain.run([s('cookies', new BlockedError('rate-limit')), s('anon', 'B')]);
  ok('blokdan keyin keyingi yo\'l', r === 'B', `natija: ${r}`);
  ok('sovitilayotganlar ro\'yxati', chain.cooling().map((c) => c.name).join() === 'cookies');
  calls.length = 0;
  await chain.run([s('cookies', 'A'), s('anon', 'B')]);
  ok('sovitilgan yo\'l chaqirilmaydi', calls.join() === 'anon', calls.join());
  clock += COOLDOWN_MS + 1;
  calls.length = 0;
  const r2 = await chain.run([s('cookies', 'A'), s('anon', 'B')]);
  ok('sovish tugagach yana sinaladi', r2 === 'A' && calls.join() === 'cookies', calls.join());
}

// 3) Post xatosi (PermanentError) — zanjir darhol to'xtaydi
{
  const chain = new Chain('t3', now);
  calls.length = 0;
  const e = await rejectsWith(chain.run([s('api', new PermanentError('post yopiq')), s('ytdlp', 'B')]));
  ok('post xatosi — o\'sha xato', e instanceof PermanentError && e.message === 'post yopiq');
  ok('post xatosi — keyingi yo\'l sinalmaydi', calls.join() === 'api');
  ok('post xatosi — yo\'l sovitilmaydi', chain.cooling().length === 0);
}

// 4) Hammasi bloklangan — BlockedError, 2–10 daqiqada qayta urinish
{
  const chain = new Chain('t4', now);
  const e = await rejectsWith(chain.run([s('a', new BlockedError('x')), s('b', new BlockedError('y'))]));
  ok('hammasi bloklansa — BlockedError', e instanceof BlockedError);
  ok('BlockedError — TransientError ham (worker qayta urinadi)', e instanceof TransientError);
  ok('qayta urinish oralig\'i 2–10 daqiqa', e.retryAfterMs >= 2 * 60_000 && e.retryAfterMs <= COOLDOWN_MS, String(e.retryAfterMs));
  // Hammasi sovitilayotgan paytda — hech narsa chaqirilmaydi, darhol BlockedError
  calls.length = 0;
  const e2 = await rejectsWith(chain.run([s('a', 'A'), s('b', 'B')]));
  ok('hammasi sovitilayotganda — chaqiruvsiz BlockedError', e2 instanceof BlockedError && calls.length === 0);
}

// 5) Vaqtincha xato + blok — oddiy vaqtincha xato (tezroq qayta urinish)
{
  const chain = new Chain('t5', now);
  const e = await rejectsWith(chain.run([s('a', new TransientError('503')), s('b', new BlockedError('rl'))]));
  ok('vaqtincha + blok — TransientError', e instanceof TransientError && !(e instanceof BlockedError), e?.name);
}

// 6) Yo'l sozlanmagan
{
  const e = await rejectsWith(new Chain('t6', now).run([]));
  ok('yo\'l yo\'q — PermanentError', e instanceof PermanentError);
}

// 7) Semafor: limitdan oshmaydi, navbat tartibi saqlanadi
{
  const sem = new Semaphore(2);
  let active = 0;
  let peak = 0;
  const order = [];
  const job = (i) => sem.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    order.push(i);
    active -= 1;
    if (i === 3) throw new Error('xato');
    return i;
  });
  const results = await Promise.allSettled([0, 1, 2, 3, 4, 5].map(job));
  ok('semafor — bir vaqtda ko\'pi bilan 2', peak === 2, `peak=${peak}`);
  ok('semafor — xato joyni bo\'shatadi', results.filter((r) => r.status === 'fulfilled').length === 5);
  ok('semafor — oxirida bo\'sh', sem.stats.active === 0 && sem.stats.waiting === 0, JSON.stringify(sem.stats));
  ok('semafor — navbat tartibi', order.slice(0, 2).sort().join() === '0,1' && order.at(-1) >= 4, order.join());
}

console.log(`ig-chain: ${pass} o'tdi, ${fail} yiqildi`);
process.exit(fail ? 1 : 0);
