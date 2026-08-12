# Loyiha: InstaReel-to-Telegram Bot (video + musiqa aniqlash)

## Loyiha maqsadi

Foydalanuvchi Instagram'da yoqqan reels'ni bizning **Instagram Professional (Business/Creator) akkauntimizga** to'g'ridan-to'g'ri "Yuborish" (Send) tugmasi orqali DM qiladi. Tizim (agent) shu videoni avtomatik yuklab oladi, ichidagi musiqani aniqlaydi va natijani (video fayl + qo'shiq nomi/ijrochisi) foydalanuvchining **Telegram** botiga yuboradi.

Asosiy texnik muammo: bitta Instagram akkauntga ko'plab userlar DM yozadi — har bir kelgan xabarni **to'g'ri Telegram foydalanuvchisiga** yo'naltirish kerak. Bu **IGSID (Instagram-Scoped ID) ↔ Telegram user_id** bog'lash mexanizmi orqali hal qilinadi (quyida batafsil).

---

## Texnologik stack

- **Backend:** Node.js (TypeScript) — Express yoki Fastify
- **Ma'lumotlar bazasi:** PostgreSQL (Supabase bo'lishi ham mumkin)
- **Queue:** BullMQ + Redis (video yuklab olish/musiqa aniqlash og'ir ishlarni navbatga qo'yish uchun)
- **Telegram:** `grammy` yoki `telegraf` kutubxonasi
- **Instagram:** Meta Graph API (Instagram Messaging API), webhook orqali
- **Video yuklab olish:** webhookdan kelgan media CDN URL orqali to'g'ridan-to'g'ri fetch (uchinchi tomon scraper shart emas, chunki bu — rasmiy DM orqali kelayotgan media)
- **Musiqa aniqlash:** ACRCloud yoki AudD.io API (audio fingerprinting)
- **Deploy:** Docker Compose (local/VPS) — webhook uchun HTTPS + doim ishlab turuvchi server kerak (masalan Railway, Render yoki VPS + nginx + Let's Encrypt)

---

## Ma'lumotlar bazasi sxemasi (minimal)

```sql
-- Foydalanuvchilar
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  telegram_username TEXT,
  ig_scoped_id TEXT UNIQUE, -- bog'langandan keyin to'ldiriladi
  link_code TEXT UNIQUE,     -- vaqtinchalik bog'lash kodi
  link_status TEXT DEFAULT 'pending', -- pending | linked
  created_at TIMESTAMP DEFAULT now(),
  linked_at TIMESTAMP
);

-- Kelgan so'rovlar (har bir yuborilgan reels)
CREATE TABLE requests (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  ig_message_id TEXT,
  media_url TEXT,
  status TEXT DEFAULT 'received', -- received | downloading | identifying | done | failed
  video_file_path TEXT,
  song_title TEXT,
  song_artist TEXT,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT now(),
  completed_at TIMESTAMP
);
```

---

## Funksional talablar (MVP doirasi)

### 1. Telegram bot — onboarding

- `/start` komandasi:
  - Agar user bazada yo'q bo'lsa — yangi yozuv yaratiladi, noyob `link_code` generatsiya qilinadi (masalan 6 xonali random string)
  - Agar user allaqachon bog'langan bo'lsa (`link_status = linked`) — "Siz allaqachon bog'langansiz, reels yuborishingiz mumkin" xabari
  - Agar bog'lanmagan bo'lsa — kod va Instagram akkauntga havola yuboriladi:
    ```
    Instagram'da @bizning_akkaunt'ga o'ting va shu kodni DM orqali yuboring:
    LINK-XXXXXX
    ```
- `/status` komandasi — bog'lanish holatini ko'rsatadi
- `/unlink` komandasi — bog'lanishni bekor qiladi (IGSID'ni tozalaydi, yangi kod beradi)

### 2. Instagram webhook — xabarlarni qabul qilish

- `GET /webhook/instagram` — Meta webhook verification (hub.challenge)
- `POST /webhook/instagram` — kiruvchi eventlarni qabul qilish:
  - **Matnli xabar** (bog'lash kodi bo'lishi mumkin): agar xabar matni bazadagi `link_code` bilan mos kelsa → o'sha user yozuvida `ig_scoped_id` to'ldiriladi, `link_status = linked` qilinadi, ham Instagram'ga ("✅ Bog'landi!"), ham Telegram'ga tasdiq yuboriladi
  - **Media/share xabar** (reels yuborilgan): `ig_scoped_id` orqali bazadan tegishli userni topadi → agar topilmasa, "Avval botga /start bering va bog'laning" degan javob Instagram'ga qaytariladi → agar topilsa, `requests` jadvaliga yozuv qo'shiladi va **queue'ga** ishlov berish uchun joylanadi

### 3. Worker — video yuklab olish va musiqa aniqlash

- Queue'dan job oladi
- Webhookdan kelgan media URL orqali videoni yuklab oladi (**diqqat: bu URL faqat ~7 kun amal qiladi, shuning uchun darhol yuklash kerak**)
- Video/audio faylni ACRCloud yoki AudD API'ga yuboradi, javobni kutadi
- Natijani `requests` jadvaliga yozadi
- Telegram bot orqali foydalanuvchiga video fayl + "🎵 {qo'shiq nomi} — {ijrochi}" xabarini yuboradi
- Xatolik bo'lsa (masalan musiqa aniqlanmasa) — videoni baribir yuboradi, faqat "musiqa aniqlanmadi" deb yozadi

### 4. Xatoliklarni boshqarish

- Rate limit (Meta: 200 chaqiruv/user/soat) — agar limitdan oshsa, joblarni kechiktirish
- Media URL muddati o'tgan bo'lsa — foydalanuvchiga qayta yuborishni so'rash
- Musiqa aniqlash API xatoligi — retry logika (2-3 marta qayta urinish)

---

## Muhit o'zgaruvchilari (.env)

```
TELEGRAM_BOT_TOKEN=
IG_APP_ID=
IG_APP_SECRET=
IG_PAGE_ACCESS_TOKEN=
IG_WEBHOOK_VERIFY_TOKEN=
ACRCLOUD_ACCESS_KEY=
ACRCLOUD_ACCESS_SECRET=
DATABASE_URL=
REDIS_URL=
```

---

## Loyiha tuzilishi (taxminiy)

```
/src
  /bot          → Telegram bot logikasi (start, status, unlink)
  /webhook      → Instagram webhook handler (verify + receive)
  /workers      → video download + song identification worker
  /db           → schema, migrations, queries
  /services     → instagram-api.ts, acrcloud.ts, telegram-api.ts
  /queue        → BullMQ setup
  index.ts      → server entry point
docker-compose.yml
.env.example
README.md
```

---

## Claude Code'dan kutilayotgan ish

1. Yuqoridagi tuzilma asosida loyihani `git init` qilib boshlab ber
2. Avval **oddiy skeleton**: Express server + Telegram bot `/start` + PostgreSQL migration ishlab tur
3. Keyin Instagram webhook endpoint (verify + receive, hozircha faqat console.log qiladigan)
4. Keyin bog'lash logikasi (link_code tekshirish)
5. Keyin BullMQ queue + worker skeleton (hozircha stub funksiyalar bilan)
6. Har bir bosqichdan keyin to'xta va menga natijani ko'rsat, keyingisiga o'tishdan oldin tasdiq so'ra
7. TypeScript strict mode yoqilgan bo'lsin, xato handling har joyda bo'lsin
8. README.md'da local development uchun setup qadamlari (Meta App yaratish, webhook URL sozlash uchun ngrok/localtunnel bilan) yozilgan bo'lsin

**Eslatma:** Meta App Review va Instagram Business akkaunt ulash — bu qo'lda bajariladigan bosqich, kod bilan avtomatlashtirilmaydi. Shu sababli birinchi navbatda webhook va bot logikasini **mock/test rejimida** ishlaydigan qilib qurish kerak, keyin haqiqiy Instagram akkaunt bilan ulanadi.
