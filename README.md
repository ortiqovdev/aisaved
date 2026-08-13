# InstaReel-to-Telegram Bot

Foydalanuvchi Instagram'da yoqqan reels'ni bizning Instagram Professional akkauntimizga **"Yuborish" (Send)** qiladi → tizim videoni yuklab oladi, ichidagi **musiqani aniqlaydi** va natijani (video + qo'shiq nomi/ijrochisi) foydalanuvchining **Telegram** botiga yuboradi.

Asosiy muammo — bitta Instagram akkauntga ko'plab userlar yozadi, har birini to'g'ri Telegram foydalanuvchisiga yo'naltirish kerak. Bu **IGSID (Instagram-Scoped ID) ↔ telegram_id** bog'lash orqali hal qilinadi.

---

## Texnologiyalar

| Qism | Yechim |
|---|---|
| Backend | Node.js 22.18+ / TypeScript (strict) / Express |
| Baza | **Supabase** (PostgreSQL) — `@supabase/supabase-js`, service_role kalit |
| Navbat | **Supabase jadvali** (`requests`) + `FOR UPDATE SKIP LOCKED` — Redis kerak emas |
| Telegram | `grammy` (long polling) |
| Instagram | Meta Graph API — Instagram Messaging + webhook |
| Musiqa | **AudD.io** (audio fingerprinting) |
| Media | webhookdan kelgan CDN URL orqali to'g'ridan-to'g'ri `fetch` |

> **n8n ishlatilmaydi.** Butun oqim shu Node.js jarayonining ichida.

---

## Oqim (arxitektura)

Botga **ikki xil kirish nuqtasi** bor. Ikkalasi ham bitta navbat va bitta worker'ga tushadi.

```
① Instagram reels (bog'lanish talab qiladi, Meta App kerak)

Telegram user  ──/start──►  Bot  ──►  users (link_code = LINK-AB12CD)
                                          │
Instagram DM: "LINK-AB12CD" ──webhook──►  link_status = linked, ig_scoped_id saqlanadi
                                          │
Instagram DM: reels ────────webhook──►  requests (media_type = ig_reel)
                                          │
                          natija: 📹 video + 🎵 qo'shiq nomi

② To'g'ridan-to'g'ri Telegram (bog'lanish shart emas, Meta ham kerak emas)

Telegram user ──video/audio yuboradi──►  requests (media_type = telegram_file)
                                          │
                          natija: 🎵 faqat qo'shiq nomi
                                  (video foydalanuvchida allaqachon bor)

                     ▼ ikkalasi uchun umumiy ▼
                                     Worker (polling)
                                          │
                        media yuklash → ffmpeg audio parcha → AudD
                                          │
                                   Telegram javobi
```

**②-yo'l bugundan ishlaydi** — Meta App, webhook, ngrok yoki bog'lash kodi kerak emas.
Foydalanuvchi botga video, GIF, ovozli xabar yoki audio tashlaydi (20MB gacha —
Telegram botlarining yuklab olish limiti), bot musiqa nomini qaytaradi.

> Bazada Telegram media uchun URL emas, **`file_id`** saqlanadi: URL ichida bot tokeni
> bo'ladi va u ~1 soatda eskiradi, `file_id` esa doimiy va xavfsiz.

---

## 0. Talablar

- **Node.js 22.18+** — bu mashinada `D:\tools\nodejs` ga o'rnatilgan (v24.19.0) va foydalanuvchi PATH'iga qo'shilgan.

  > MSI o'rnatuvchisi bu tizimda Error 1723 (`SetInstallScope` custom action ishlamaydi) bilan yiqilgani uchun,
  > fayllar `msiexec /a` orqali ajratib olindi. Bu to'liq, ishlaydigan Node — faqat "Programs and Features"
  > ro'yxatida ko'rinmaydi. Yangi terminalda `node -v` ishlashi kerak.

  Node **24** TypeScript'ni o'zi tushunadi, shuning uchun `tsx`/`ts-node` kerak emas —
  `npm run dev` to'g'ridan-to'g'ri `node --watch src/index.ts` ni ishga tushiradi.

- **ffmpeg** (ixtiyoriy, lekin tavsiya etiladi — musiqa aniqlash tezlashadi va AudD limitini tejaydi):
  ```bash
  winget install Gyan.FFmpeg
  ```
  Hozircha o'rnatilmagan — bu **muammo emas**: `extractAudioSnippet` null qaytaradi va video faylning
  o'zi AudD'ga yuboriladi. Umuman o'chirish uchun `.env` da `USE_FFMPEG=false`.

- **ngrok** (lokal test uchun HTTPS webhook URL): https://ngrok.com/download

---

## 1. O'rnatish

```bash
npm install
```

```bash
cp .env.example .env
```

> ⚠️ Haqiqiy kalitlar **faqat `.env`** ga yoziladi (u `.gitignore` da). `.env.example` — git'ga tushadigan shablon,
> unga hech qachon haqiqiy token yozmang.

Manba kodida importlar `.ts` kengaytmasi bilan yozilgan (`allowImportingTsExtensions` +
`rewriteRelativeImportExtensions`). Node ularni to'g'ridan-to'g'ri ishga tushiradi,
`tsc` esa build paytida avtomatik `.js` ga qayta yozadi — qo'lda hech narsa o'zgartirish kerak emas.

---

## 2. Supabase sozlash

1. https://supabase.com → **New project** yarating.
2. **SQL Editor → New query** → [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) faylining butun mazmunini qo'ying va **Run** bosing.
3. **Project Settings → API** dan oling:
   - `Project URL` → `.env` dagi `SUPABASE_URL`
   - `service_role` **secret** kalit → `SUPABASE_SERVICE_ROLE_KEY`

> ⚠️ `service_role` kaliti RLS'ni chetlab o'tadi — uni faqat serverda saqlang, hech qachon frontendga yoki gitga qo'ymang (`.env` allaqachon `.gitignore` da).

Migratsiya nima yaratadi:
- `users` — telegram_id ↔ ig_scoped_id bog'lanishi, `link_code`, `link_status`
- `requests` — har bir reels so'rovi **va ayni paytda navbat** (status, attempts, next_attempt_at, lock)
- `claim_next_request()` — jobni atomik band qiluvchi SQL funksiya (bir nechta worker parallel ishlashi xavfsiz)
- RLS yoqilgan, policy'siz → tashqaridan (anon kalit bilan) hech kim o'qiy olmaydi

---

## 3. Telegram bot

1. Telegram'da [@BotFather](https://t.me/BotFather) → `/newbot` → nom va username bering.
2. Berilgan tokenni `.env` dagi `TELEGRAM_BOT_TOKEN` ga yozing.

---

## 4. AudD.io (musiqa aniqlash)

1. https://dashboard.audd.io/ da ro'yxatdan o'ting (bepul sinov mavjud).
2. API token'ni `.env` dagi `AUDD_API_TOKEN` ga yozing.

---

## 5. Meta App va Instagram (qo'lda bajariladigan qism)

> Bu bosqich kod bilan avtomatlashtirilmaydi — Meta paneli orqali qilinadi.

1. **Instagram akkauntni Professional qiling** — Instagram ilovasi → Settings → Account type → *Business* yoki *Creator*.
2. Instagram ilovasida: **Settings → Messages and story replies → Connected tools → Allow access to messages** — YOQING. Busiz DM webhooklari kelmaydi.
3. https://developers.facebook.com/apps → **Create app** → use case: **Other** → type: **Business**.
4. App'ga **Instagram** mahsulotini qo'shing → *API setup with Instagram login*.
5. **Generate access token** → Instagram akkauntingiz bilan kiring. Olingan long-lived tokenni `.env` dagi `IG_ACCESS_TOKEN` ga yozing.
   - Kerakli ruxsatlar: `instagram_business_basic`, `instagram_business_manage_messages`
6. **App settings → Basic → App secret** → `IG_APP_SECRET`.
7. `.env` da `IG_WEBHOOK_VERIFY_TOKEN` ga o'zingiz xohlagan maxfiy satrni yozing (masalan `my-secret-verify-123`).
8. `IG_ACCOUNT_USERNAME` ga Instagram akkauntingiz username'ini yozing (`@` siz).

### Webhook URL sozlash

Serverni ishga tushiring va ngrok'ni oching:

```bash
ngrok http 3000
```

ngrok bergan HTTPS manzilni oling (masalan `https://ab12-34-56.ngrok-free.app`), keyin Meta panelida:

**Instagram → Configure webhooks:**
- **Callback URL:** `https://ab12-34-56.ngrok-free.app/webhook/instagram`
- **Verify token:** `.env` dagi `IG_WEBHOOK_VERIFY_TOKEN` bilan **bir xil**
- **Verify and save** bosing → server logida `Instagram webhook verification muvaffaqiyatli` chiqishi kerak
- Keyin **Subscribe** qiling: `messages` (va xohlasangiz `messaging_postbacks`)

> ⚠️ ngrok bepul rejimda har qayta ishga tushganda URL o'zgaradi — bunda Meta'da Callback URL'ni yangilash kerak.

---

## 6. Ishga tushirish

```bash
npm run dev
```

Ishlab chiqarish uchun:

```bash
npm run build && npm start
```

Docker bilan:

```bash
docker compose up -d --build
```

Tekshirish:

```bash
curl http://localhost:3000/health
```

Javob: `{"ok":true,"worker":{...},"queue":{"queued":0,"processing":0,"done":0,"failed":0}}`

---

## 6b. Mock rejim — Meta App'siz sinash

Meta App Review va Instagram Business ulash qo'lda bajariladigan bosqich. Uni kutmasdan
butun oqimni sinash uchun `.env` da:

```
MOCK_INSTAGRAM=true
```

Bunda:
- Webhook imzosi tekshirilmaydi, Instagram'ga DM yuborilmaydi (log'ga yoziladi)
- `IG_APP_SECRET` / `IG_ACCESS_TOKEN` bo'sh bo'lsa ham ilova ishga tushadi
- **Telegram va Supabase haqiqiy bo'lib qoladi** — ya'ni bog'lash va video yuborish chinakam ishlaydi

Instagram'dan xabar kelganini taqlid qilish (server ishlab turganda, boshqa terminalda):

```bash
node src/dev/mock-cli.ts text IGSID_TEST "LINK-AB12CD"
```

```bash
node src/dev/mock-cli.ts reel IGSID_TEST
```

Birinchisi — "Instagram'dan bog'lash kodi keldi", ikkinchisi — "reels yuborildi"
(namuna video `MOCK_SAMPLE_VIDEO_URL` dan olinadi).

`MOCK_AUDD=true` esa musiqa aniqlashni soxta natija bilan almashtiradi — AudD limitini
sarflamasdan sinash uchun.

---

## 7. To'liq oqimni sinash

1. Telegram'da botingizga **/start** → `LINK-XXXXXX` kodini olasiz.
2. Instagram'da o'z akkauntingizdan (test uchun **boshqa** akkaunt kerak — o'zingizga DM yozib bo'lmaydi) `@sizning_akkaunt` ga o'sha kodni DM qiling.
3. `✅ Bog'landi!` javobini olasiz, Telegram'ga ham tasdiq keladi.
4. Istalgan reels → **Send → sizning akkaunt**.
5. Telegram'ga video + `🎵 Nom — Ijrochi` keladi.

Bog'lanish holatini ko'rish: **/status** · bekor qilish: **/unlink**

---

## Buyruqlar (bot)

Buyruqdan tashqari: botga **video, GIF, ovozli xabar yoki audio** yuborsangiz —
musiqa nomini qaytaradi (bog'lanish shart emas). Rasm yuborilsa rad etadi.

### Natija xabari

Musiqa topilganda javob quyidagilardan iborat:

- 🖼 albom muqovasi (Spotify/Apple/Deezer'dan)
- 🎵 nomi, ijrochisi, albomi
- 1️⃣–5️⃣ **shu qo'shiqning versiyalari** (asl ijro, kaverlar, karaoke) — Deezer qidiruvidan,
  nomi mos kelganlari filtrlanadi va takrorlari tashlanadi
- Tugma bosilganda o'sha versiyaning **30 soniyalik rasmiy preview**'i audio fayl bo'lib keladi
- 🎧 Spotify · 🍎 Apple Music · 💜 Deezer · 🔍 YouTube — to'liq qo'shiqni tinglash uchun

> **To'liq qo'shiq yuklab berilmaydi.** Tijoriy trekni yuklab tarqatish mualliflik huquqini
> buzadi. Bot faqat platformalar tinglatish uchun ochiq beradigan 30 soniyalik parchani
> yuboradi va to'liq qo'shiqqa havola qiladi. Deezer qidiruvi kalit talab qilmaydi.

| Buyruq | Vazifasi |
|---|---|
| `/start` | Ro'yxatdan o'tish, bog'lash kodini olish |
| `/status` | Bog'lanish holati + oxirgi 5 ta so'rov |
| `/unlink` | Bog'lanishni uzish, yangi kod berish |
| `/help` | Yordam |

---

## Loyiha tuzilishi

```
src/
  config/env.ts            → .env ni zod bilan tekshiradi (xato bo'lsa darhol to'xtaydi)
  lib/logger.ts            → pino logger
  lib/errors.ts            → PermanentError / TransientError, backoff, fetch timeout
  db/supabase.ts           → service_role klient + ulanish tekshiruvi
  db/types.ts              → UserRow / RequestRow
  db/users.repo.ts         → link_code generatsiyasi, bog'lash/uzish
  db/requests.repo.ts      → navbat: enqueue / claimNext / markDone / requeue
  bot/index.ts             → grammy: /start /status /unlink /help
  bot/messages.ts          → barcha matnlar (HTML escape bilan)
  bot/notify.ts            → videoni caption bilan yuborish
  webhook/instagram.ts     → GET verify + POST receive (imzo tekshiruvi bilan)
  services/instagram.ts    → DM yuborish, webhook imzosi, payload parsing
  services/audd.ts         → musiqa aniqlash
  services/media.ts        → video yuklash, ffmpeg audio parcha, tozalash
  workers/index.ts         → polling loop, retry qarorlari
  workers/processor.ts     → bitta jobning to'liq bajarilishi
  index.ts                 → server + bot + worker
  worker-standalone.ts     → faqat worker (alohida masshtablash uchun)
supabase/migrations/0001_init.sql
```

---

## Xatoliklarni boshqarish

| Holat | Xatti-harakat |
|---|---|
| Media URL muddati o'tgan (403/410) | Retry qilinmaydi → userga "reels'ni qaytadan yuboring" |
| Video > 50MB | Retry qilinmaydi → userga hajm haqida xabar |
| AudD 429 / limit tugagan | Retry (eksponensial backoff, `MAX_ATTEMPTS` gacha) |
| Musiqa topilmadi | **Xato emas** — video baribir yuboriladi, "musiqa aniqlanmadi" deb yoziladi |
| Telegram 429 (flood) | `retry_after` ga qarab kechiktiriladi |
| User botni bloklagan (403) | Retry qilinmaydi → `failed` |
| Worker qulab tushdi | Job `WORKER_STALE_LOCK_SECONDS` dan keyin avtomatik qayta olinadi |
| Meta webhookni takror yubordi | `ig_message_id` unique → dublikat yaratilmaydi |

Retry orasidagi kutish: `15s → 30s → 60s ...` (jitter bilan, maksimum 15 daqiqa).

---

## Muhim eslatmalar

- **Media URL ~7 kun amal qiladi** — shuning uchun job kelishi bilanoq yuklab olinadi.
- **24 soatlik oyna:** Meta qoidasiga ko'ra foydalanuvchi yozgandan keyin 24 soat ichida javob berish mumkin. Biz webhook kelgan zahoti javob berganimiz uchun bu shart bajariladi.
- **Rate limit:** Meta Messaging — soatiga ~200 chaqiruv/user. Har bir reels uchun biz atigi 1-2 ta DM yuboramiz, shuning uchun oddiy foydalanishda limitga yetilmaydi; 429 kelsa job kechiktiriladi.
- **Telegram bot API** orqali maksimum **50MB** fayl yuborish mumkin (`MAX_VIDEO_BYTES`).
- **App Review:** boshqa (test bo'lmagan) foydalanuvchilarning DM'lari kelishi uchun Meta App Review'dan `instagram_business_manage_messages` ruxsatini olish kerak. Ishlab chiqishda faqat app'ga qo'shilgan test foydalanuvchilar/rollar ishlaydi.

---

## Masshtablash

`WORKER_CONCURRENCY` bitta jarayondagi parallel joblar soni. Undan ko'proq kerak bo'lsa alohida worker jarayonlarini ko'taring:

```bash
npm run worker
```

Bunday holda asosiy ilovada `WORKER_ENABLED=false` qilib qo'ying. Joblar Postgres darajasida band qilingani uchun bir nechta nusxa bir-biriga xalaqit bermaydi.
