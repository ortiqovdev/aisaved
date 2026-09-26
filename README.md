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

- **ffmpeg** — **o'rnatilgan** (v9.0, Gyan build). Musiqa aniqlash uchun **muhim**: videodan qisqa
  audio parcha ajratadi, davomiyligini o'lchaydi va jim parchani AudD'ga yubormaydi.
  ```bash
  winget install Gyan.FFmpeg
  ```
  Bo'lmasa ham ilova ishlaydi: `extractAudioSnippet` null qaytaradi va video faylning o'zi
  AudD'ga yuboriladi — lekin sekinroq, qimmatroq va **aniqlash sifati pastroq** bo'ladi
  (parchani videoning o'rtasidan olish imkoni yo'qoladi). Umuman o'chirish: `USE_FFMPEG=false`.

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
3. **Xuddi shu joyda** [`supabase/migrations/0002_fixes.sql`](supabase/migrations/0002_fixes.sql) ni ham ishga tushiring.
   Uni o'tkazib yuborsangiz ilova baribir ishlaydi, lekin ishga tushishda ogohlantirish beradi va
   quyidagilar **o'chirilgan** bo'ladi: natija keshi, takror-yuborishdan himoya, tezroq `/health`.
   Migratsiyalar idempotent — bir necha marta ishga tushirish xavfsiz.
   So'ng [`supabase/migrations/0003_user_language.sql`](supabase/migrations/0003_user_language.sql) —
   foydalanuvchi tanlagan til bazada saqlanadi (busiz til faqat xotirada turadi va
   server qayta ishga tushganda Telegram interfeys tiliga qaytadi).
   Va [`supabase/migrations/0004_status_message.sql`](supabase/migrations/0004_status_message.sql) —
   "⏳ Qabul qilindi" kartasi natijaga aylanishi server qayta ishga tushganda ham ishlaydi.
   Va [`supabase/migrations/0005_speed.sql`](supabase/migrations/0005_speed.sql) — navbatga qo'yish
   bitta so'rovda va media keshi (bir marta yuborilgan reels keyingi safar RapidAPI'siz, bir zumda).
   Va [`supabase/migrations/0006_song_cache.sql`](supabase/migrations/0006_song_cache.sql) — qo'shiq natijasi
   keshi: bitta videoni ko'p odam so'rasa ham AudD (pullik) faqat bir marta chaqiriladi.
   Va [`supabase/migrations/0007_ig_link_tokens.sql`](supabase/migrations/0007_ig_link_tokens.sql) — bir bosishda
   bog'lash: Instagram'da "📲 Telegram'da ulash" tugmasi, kod ko'chirish shart emas.
4. **Project Settings → API** dan oling:
   - `Project URL` → `.env` dagi `SUPABASE_URL`
   - `service_role` **secret** kalit → `SUPABASE_SERVICE_ROLE_KEY`

> ⚠️ `service_role` kaliti RLS'ni chetlab o'tadi — uni faqat serverda saqlang, hech qachon frontendga yoki gitga qo'ymang (`.env` allaqachon `.gitignore` da).

Migratsiyalar nima yaratadi:
- `users` — telegram_id ↔ ig_scoped_id bog'lanishi, `link_code`, `link_status`
- `requests` — har bir reels so'rovi **va ayni paytda navbat** (status, attempts, next_attempt_at, lock)
- `claim_next_request()` — jobni atomik band qiluvchi SQL funksiya (bir nechta worker parallel ishlashi xavfsiz)
- RLS yoqilgan, policy'siz → tashqaridan (anon kalit bilan) hech kim o'qiy olmaydi
- `sent_at` — natija yuborilganini belgilaydi (ayni javob ikki marta ketmasligi uchun)
- `file_unique_id` + `queue_stats()` + `user_pending_count()` — kesh, statistika, spam himoyasi

---

## 3. Telegram bot

1. Telegram'da [@BotFather](https://t.me/BotFather) → `/newbot` → nom va username bering.
2. Berilgan tokenni `.env` dagi `TELEGRAM_BOT_TOKEN` ga yozing.
3. Bot profili (description va "About" matni, 6 tilda): `npm run bot:profile`.
   Buyruqlar menyusi server ishga tushganda o'zi o'rnatiladi.
   Avatar, rasm va Instagram bio matnlari — [`branding/BRAND_KIT.md`](branding/BRAND_KIT.md).

### Tillar

Bot 6 tilda: English (standart), O'zbekcha, Русский, العربية, Қазақша, Türkçe.
Til foydalanuvchining Telegram interfeys tilidan aniqlanadi va `/language` bilan
o'zgartiriladi. Matnlar — `src/i18n/locales/*.ts`; yangi kalit qo'shilsa
`npm run test:i18n` barcha tillarda borligini tekshiradi.

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

Serverga (VPS) doimiy HTTPS manzil bilan joylash — bosqichma-bosqich: [`VPS.md`](VPS.md).

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
npm run mock:text -- IGSID_TEST "LINK-AB12CD"
```

```bash
npm run mock:reel -- IGSID_TEST
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

## Admin panel — `/qimmat`

Faqat adminlar uchun (boshqalarga bot javob bermaydi; buyruqlar menyusida ko'rinmaydi).
Kerak: [`0009_admin.sql`](supabase/migrations/0009_admin.sql) migratsiyasi.

| Bo'lim | Vazifasi |
|---|---|
| 📊 Statistika | Foydalanuvchilar: jami, yangi va faol — kunlik / haftalik / oylik / yillik; so'rovlar |
| 📣 Xabar yuborish | Istalgan xabar (matn, rasm, video, GIF, ovoz, audio, fayl, stiker — izoh va tugmalari bilan) barcha foydalanuvchilarga; oldindan ko'rish, tasdiq, jarayon, to'xtatish, hisobot |
| 📢 Majburiy kanallar | Qo'shish (@username, forward yoki ID) / o'chirish. Bot kanalda admin bo'lishi shart |
| 👮 Adminlar | Yordamchi admin: Telegram ID (majburiy), telefon va @username (ixtiyoriy). Faqat asosiy admin boshqaradi |
| 🔎 Foydalanuvchi | ID yoki @username bo'yicha ma'lumot; ⛔ ban / ✅ unban |
| ⚙️ Tizim holati | Uptime, versiya, xotira, worker, navbat, Instagram cookies va token holati |

Asosiy admin — `ADMIN_TELEGRAM_IDS` (env); monitoring ogohlantirishlari faqat unga yuboriladi.
`/health` ichki holatni oshkor qilmaydi — faqat `{"ok":true}`.

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
| `/language` | Tilni tanlash |
| `/round` | Videoga **javob** qilib yozilsa — o'sha videodan dumaloq video xabar (video note) yasaydi: markazdan kvadrat, 640×640, ko'pi bilan 60 soniya. Bot yuborgan natija videosi uchun ham ishlaydi |
| `/help` | Yordam |


### Platformalar, guruhlar, inline

| Qayerda | Nima qiladi |
|---|---|
| Shaxsiy chat | Instagram, TikTok, YouTube Shorts, Pinterest havolasi → video/rasm/karusel, tagida 🎵 ⭕ 📤 |
| Guruh | Guruhga tashlangan havolaga javob qilib videoni o'sha guruhga qo'yadi. Boshqa xabarlarga aralashmaydi. Havolalarni ko'rishi uchun bot admin bo'lishi yoki @BotFather → `/setprivacy` → Disable kerak |
| Istalgan chat | `@bot <havola>` — inline rejim (@BotFather → `/setinline`). Keshdagi post darhol, TikTok/Pinterest/Instagram havola orqali; YouTube uchun "📥 Botda yuklab olish" |

Manbalar: TikTok — tikwm-mos API (qo'shiq nomini ham beradi), Pinterest — ochiq widget API, YouTube — yt-dlp + ffmpeg.

**Qo'shiq aniqlash (🎵)** — eng arzonidan boshlab: kesh (0006) → platforma aytgan qo'shiq (TikTok) →
**Shazam** (norasmiy, bepul; `SHAZAM_ENABLED`) → **AudD** (pullik zaxira, sukut bo'yicha o'chiq: `AUDD_ENABLED`,
kunlik chegara `AUDD_DAILY_LIMIT`). Shazam ishlayotganini tekshirish: `npm run test:shazam`.

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
  lib/constants.ts         → aylanma importsiz umumiy konstantalar
  bot/index.ts             → grammy: /start /status /language /unlink /help + media qabul qilish
  bot/messages.ts          → o'zgaruvchili xabarlar yig'ish, HTML escape
  bot/round.ts             → /round: videodan dumaloq video (fonda, ffmpeg)
  i18n/index.ts            → tillar ro'yxati, t(), tilni aniqlash
  i18n/locales/*.ts        → barcha matnlar (en — manba, qolganlari tarjima)
  i18n/user-lang.ts        → foydalanuvchi tili: kesh + baza
  scripts/sync-bot-profile.ts → bot description'larini 6 tilda o'rnatish
  bot/notify.ts            → videoni caption bilan yuborish
  bot/results.ts           → natija xabari: versiyalar, muqova, inline tugmalar
  webhook/instagram.ts     → GET verify + POST receive (imzo tekshiruvi bilan)
  webhook/dev-mock.ts      → MOCK_INSTAGRAM=true da webhook taqlidi
  services/instagram.ts    → DM yuborish, webhook imzosi, payload parsing
  services/audd.ts         → musiqa aniqlash
  services/deezer.ts       → versiyalar, muqova, 30s rasmiy preview (kalitsiz API)
  services/telegram-files.ts → file_id → vaqtinchalik yuklash URL'i
  services/media.ts        → yuklash, ffmpeg parcha, davomiylik, jimlik, tozalash
  workers/index.ts         → polling loop, retry qarorlari
  workers/processor.ts     → bitta jobning to'liq bajarilishi
  dev/mock-cli.ts          → terminaldan mock xabar yuborish
  index.ts                 → server + bot + worker
  worker-standalone.ts     → faqat worker (alohida masshtablash uchun)
supabase/migrations/0001_init.sql
supabase/migrations/0002_fixes.sql
supabase/migrations/0003_user_language.sql
supabase/migrations/0004_status_message.sql
supabase/migrations/0005_speed.sql
supabase/migrations/0006_song_cache.sql
supabase/migrations/0007_ig_link_tokens.sql
supabase/migrations/0008_app_kv.sql
supabase/migrations/0009_admin.sql
```

---

## Musiqa aniqlash sifati

Reels'ning ilk sekundlari ko'pincha gap, intro yoki sukunat bo'ladi. Faqat 0-sekunddan
parcha olish shu sababli ko'p hollarda hech narsa topmaydi. Shuning uchun:

1. `ffmpeg` bilan video **davomiyligi** o'lchanadi;
2. parcha **avval o'rtadan**, keyin boshidan, keyin oxiridan olinadi (`AUDD_MULTI_PASS`);
3. har parchaning **eng baland nuqtasi** tekshiriladi — jim parcha AudD'ga umuman
   yuborilmaydi (limit tejaladi);
4. birinchi topilgan natija qaytariladi.

O'lchangan haqiqiy qiymatlar (chegara nima uchun -60 dB): tanilgan qo'shiq `max -35.7 dB`,
shovqin `max -26.0 dB`, raqamli sukunat `max -91.0 dB`.

| Sozlama | Vazifasi |
|---|---|
| `AUDD_SNIPPET_SECONDS` | Parcha uzunligi. AudD 2–12s tavsiya qiladi; default **12** |
| `AUDD_MULTI_PASS` | Topilmasa boshqa joydan urinish. AudD so'rovlarini ko'paytiradi |
| `RESULT_CACHE_ENABLED` | Ayni fayl qayta kelsa avvalgi natijani ishlatish |
| `MAX_PENDING_PER_USER` | Bitta foydalanuvchi navbatdagi so'rovlari chegarasi |

> `AUDD_SNIPPET_SECONDS` ni 12 dan oshirmang — uzunroq parchada AudD
> "barmoq izi yasab bo'lmadi" (xato **300**) qaytarishi ko'payadi.

---

## Xatoliklarni boshqarish

| Holat | Xatti-harakat |
|---|---|
| Media URL muddati o'tgan (403/410) | Retry qilinmaydi → userga "reels'ni qaytadan yuboring" |
| Video > `MAX_VIDEO_BYTES` (default 48MB) | Retry qilinmaydi → userga hajm haqida xabar |
| AudD 429 / limit tugagan (901) | Retry (eksponensial backoff, `MAX_ATTEMPTS` gacha) |
| AudD tokeni yaroqsiz (900) | Retry qilinmaydi → `failed` |
| AudD barmoq izi yasay olmadi (300) | **Xato emas** — shu parchada musiqa yo'q, keyingi parcha sinaladi |
| Musiqa topilmadi | **Xato emas** — video baribir yuboriladi, "musiqa aniqlanmadi" deb yoziladi |
| Natija yuborilgan, lekin baza yozilmagan | `sent_at` tufayli qayta olinganda IKKINCHI marta yuborilmaydi |
| Foydalanuvchi navbatni to'ldirdi | `MAX_PENDING_PER_USER` dan oshsa yangi so'rov qabul qilinmaydi |
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
- **Telegram bot API** orqali maksimum **50MB** fayl yuborish mumkin. `MAX_VIDEO_BYTES` default
  **48MB** — aynan 50MB'lik fayl bizning tekshiruvdan o'tib Telegram'da rad etilmasligi uchun zaxira.
- **App Review:** boshqa (test bo'lmagan) foydalanuvchilarning DM'lari kelishi uchun Meta App Review'dan `instagram_business_manage_messages` ruxsatini olish kerak. Ishlab chiqishda faqat app'ga qo'shilgan test foydalanuvchilar/rollar ishlaydi.

---

## Masshtablash

`WORKER_CONCURRENCY` bitta jarayondagi parallel joblar soni. Undan ko'proq kerak bo'lsa alohida worker jarayonlarini ko'taring:

```bash
npm run worker
```

Bunday holda asosiy ilovada `WORKER_ENABLED=false` qilib qo'ying. Joblar Postgres darajasida band qilingani uchun bir nechta nusxa bir-biriga xalaqit bermaydi.
