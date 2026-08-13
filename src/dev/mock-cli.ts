/**
 * Mock Instagram xabarlarini terminaldan yuborish uchun kichik yordamchi.
 * Server ISHLAB TURGAN paytda ishlating (boshqa terminalda).
 *
 *   node src/dev/mock-cli.ts text  IGSID_TEST "LINK-AB12CD"
 *   node src/dev/mock-cli.ts reel  IGSID_TEST
 *   node src/dev/mock-cli.ts reel  IGSID_TEST https://example.com/video.mp4
 */
import { env } from '../config/env.ts';

const [, , command, igsid = 'IGSID_TEST', arg] = process.argv;
const base = `http://localhost:${env.PORT}/dev/mock`;

function usage(): never {
  console.log(`
Foydalanish:
  node src/dev/mock-cli.ts text <IGSID> "<matn>"
  node src/dev/mock-cli.ts reel <IGSID> [video-url]

Misollar:
  node src/dev/mock-cli.ts text IGSID_TEST "LINK-AB12CD"
  node src/dev/mock-cli.ts reel IGSID_TEST
`);
  process.exit(1);
}

async function post(path: string, body: Record<string, unknown>): Promise<void> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    console.error(`❌ ${base}${path} ga ulanib bo'lmadi — server ishlayaptimi? (npm run dev)`);
    process.exit(1);
  }

  const text = await res.text();
  console.log(`${res.ok ? '✅' : '❌'} ${res.status} ${text}`);
  if (!res.ok) process.exit(1);
}

if (command === 'text') {
  if (!arg) usage();
  await post('/text', { igsid, text: arg });
} else if (command === 'reel') {
  await post('/reel', arg ? { igsid, url: arg } : { igsid });
} else {
  usage();
}
