# Botni Render'ga joylash (bepul, kartasiz)

Render — Docker konteynerini bepul ishlatadigan hosting. Karta so'ramaydi,
doimiy HTTPS manzil beradi (`https://aisaved-bot.onrender.com`), serverlari
Frankfurtda — Telegram va Supabase'ga yaqin.

| | Bepul tarif |
|---|---|
| Resurs | 512 MB RAM, 0.1 vCPU |
| Vaqt | oyiga 750 soat — bitta servis uchun butun oy yetadi |
| Uxlash | 15 daqiqa kirish so'rovi bo'lmasa uxlaydi → **bot o'zini o'zi ping qiladi** (`KEEPALIVE_URL`, avtomatik) |
| Qayta ishga tushish | Render istalgan payt qayta ishga tushirishi mumkin — ma'lumot Supabase'da, hech narsa yo'qolmaydi |

> **Kuchsiz CPU:** reels, 🎵 va havolalar asosan tarmoqni kutadi — ular tez
> ishlaydi. Dumaloq video (⭕, ffmpeg bilan qayta kodlash) esa sekinroq bo'ladi.

---

## 1. Git o'rnatish (bir marta)

```bash
winget install --id Git.Git -e
```

O'rnatilgach **terminalni yoping va qayta oching**.

## 2. GitHub'da yopiq (private) repozitoriy

1. https://github.com → ro'yxatdan o'ting (karta kerak emas).
2. **New repository** → nom: `aisaved-bot` → **Private** → *Create repository*.
   README/.gitignore qo'shmang.

## 3. Kodni GitHub'ga yuklash

Loyiha papkasida:

```bash
git init -b main
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/<login>/aisaved-bot.git
git push -u origin main
```

Birinchi `push` da brauzer ochiladi — GitHub'ga kiring.

> `.env` (kalitlar) `.gitignore` da — GitHub'ga **tushmaydi**. Tekshirish:
> `git status` ro'yxatida `.env` bo'lmasligi kerak.

## 4. Render

1. https://render.com → **Get Started** → **GitHub bilan kiring**.
2. **New → Blueprint** → `aisaved-bot` repozitoriysini tanlang.
   Render `render.yaml` ni o'qiydi va kalitlarni so'raydi.
3. Kalitlarni `.env` faylingizdan nusxalab kiriting:

   | Kalit | Qayerdan |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | `.env` |
   | `IG_ACCOUNT_USERNAME` | `aisavedbot` |
   | `IG_APP_SECRET` | `.env` |
   | `IG_ACCESS_TOKEN` | `.env` |
   | `IG_WEBHOOK_VERIFY_TOKEN` | `.env` |
   | `SUPABASE_URL` | `.env` |
   | `SUPABASE_SERVICE_ROLE_KEY` | `.env` |

4. **Apply** → build boshlanadi (~3–5 daqiqa). *Logs* bo'limida:
   `Supabase ulanishi OK` → `Telegram bot ulandi` → `Keep-alive yoqildi` → `Worker ishga tushdi`.

## 5. ⚠️ Kompyuterdagi botni to'xtatish

Bitta token bilan ikki nusxa ishlay olmaydi (Telegram `409 Conflict`).
`npm run win` oynasida **Ctrl+C**. Render'dagi build tugashi bilan qiling.

## 6. Meta callback

Render panelidagi manzilingiz (masalan `https://aisaved-bot.onrender.com`):

| Maydon | Qiymat |
|---|---|
| Callback URL | `https://aisaved-bot.onrender.com/webhook/instagram` |
| Verify token | `IG_WEBHOOK_VERIFY_TOKEN` |
| Privacy Policy URL (Live rejim uchun) | `https://aisaved-bot.onrender.com/privacy` |

Bu manzil **o'zgarmaydi**.

## 6b. Instagram cookies (majburiy)

Instagram server IP'laridan **login'siz** so'rovlarni bloklaydi — logda
`You have exceeded the rate-limit for accessing posts anonymously`. Yechim:
bot reels'ni alohida Instagram akkaunt nomidan oladi.

> ⚠️ **Asosiy akkauntingizni ishlatmang.** Instagram avtomatlashtirilgan
> so'rovlar uchun akkauntni vaqtincha cheklashi yoki bloklashi mumkin.
> Cookies fayli — parol bilan teng: hech kimga bermang, GitHub'ga qo'ymang.

1. **Yangi Instagram akkaunt oching** (alohida email bilan). Profil rasmi qo'ying,
   bir nechta sahifaga obuna bo'ling va bir kun oddiy ishlating — "yangi, bo'sh"
   akkaunt tezroq shubha uyg'otadi.
2. **Chrome'da alohida profil oching** (o'ng yuqoridagi profil belgisi → *Add*) —
   asosiy akkauntingiz cookies'i aralashmasin.
3. Shu profilga **"Get cookies.txt LOCALLY"** kengaytmasini o'rnating
   (Chrome Web Store). Boshqa "cookies.txt" kengaytmalarini emas — ularning
   ba'zilari cookies'ni o'g'irlagani aniqlangan; bu kengaytma ochiq kodli va
   faylni faqat kompyuteringizga saqlaydi.
4. Shu profilda **instagram.com** ga yangi akkaunt bilan kiring.
5. instagram.com sahifasida kengaytma belgisini bosing → format **Netscape** →
   **Export** → `instagram.com_cookies.txt` fayli yuklanadi.
6. **Akkauntdan chiqmang (Log out qilmang)** — chiqsangiz cookies bekor bo'ladi.
   Oynani shunchaki yoping.
7. Render → **aisaved-bot** → **Environment** → **Secret Files** →
   **+ Add Secret File**:
   - **Filename:** `instagram_cookies.txt`
   - **Contents:** faylni Notepad'da oching, hammasini nusxalab qo'ying
8. **Save changes** → servis qayta ishga tushadi. Logda:
   `Instagram cookies yuklandi (akkauntga kirilgan)`.

| Logdagi xabar | Ma'nosi |
|---|---|
| `cookies yuklandi (akkauntga kirilgan)` | ✅ Hammasi joyida |
| `"sessionid" yo'q` | Akkauntga kirmasdan eksport qilingan — 4–5-qadamni qaytaring |
| `Netscape formatida emas` | Noto'g'ri fayl yoki format — 5-qadamda **Netscape** ni tanlang |
| `cookies bilan ham blokladi` | Cookies eskirgan yoki akkaunt cheklangan — yangidan eksport qiling |

Instagram yangi akkauntga "Germaniyadan kirish urinishi" haqida xabar
yuborishi mumkin — telefonda o'sha akkauntni ochib, **"Bu men edim"** ni bosing.

## 6c. Monitoring va token

Bot muammolar haqida `ADMIN_TELEGRAM_IDS` dagi Telegram akkauntga o'zi xabar
beradi (`render.yaml` da o'rnatilgan; Render → Environment'da borligini tekshiring):

| Xabar | Qachon |
|---|---|
| 🟢 Bot ishga tushdi | Har deploy / qayta ishga tushishda (versiya, cookies holati) |
| 🔴 Instagram cookies ishlamayapti / yo'q | Instagram bloklasa — cookies'ni yangilash vaqti |
| 🔴 Instagram token yaroqsiz / ⚠️ yangilanmadi | Token muddati — yangisini generatsiya qilish kerak |
| 🔴 Xatolar ko'paydi | 30 daqiqada yarmidan ko'p so'rov xato |
| 🟡 Navbat tiqilib qoldi | So'rovlar 10+ daqiqa kutyapti |
| 🟡 Qo'shiq aniqlash ishlamayapti | Shazam bloklagan |
| 🔴 Telegram xabarlarni qabul qilish to'xtab qolyapti | Masalan bot boshqa joyda ham ishlayapti (409) |
| 📈 N foydalanuvchi | Har 500 foydalanuvchida — limit va xarajatlarni qayta ko'rish vaqti |

Bir xil xabar soatiga ko'pi bilan bir marta keladi.

**Instagram token** (~60 kun amal qiladi) bot tomonidan haftada bir avtomatik
yangilanadi va Supabase'da saqlanadi — buning uchun
[`0008_app_kv.sql`](supabase/migrations/0008_app_kv.sql) ni SQL Editor'da bir
marta ishga tushiring. Busiz yangilangan token faqat xotirada turadi.

**Bot butunlay o'chsa** (server tushsa), u o'zi xabar bera olmaydi — buning
uchun tashqi kuzatuvchi: https://uptimerobot.com (bepul) → *New monitor* →
HTTP(s) → `https://aisaved-bot.onrender.com/health`, har 5 daqiqa, ogohlantirish
— email yoki Telegram.

## 7. Tekshirish

- [ ] `https://aisaved-bot.onrender.com/health` → `"ok":true`
- [ ] Telegram'da `/start`
- [ ] Instagram'dan reels → Telegram'ga video. **Muhim:** Instagram server
      IP'laridan so'rovlarni uy internetiga qaraganda tezroq cheklaydi —
      logda `login required` / `empty media response` ko'p chiqsa, ayting.
- [ ] 🎵 → qo'shiq topiladi

---

## Kundalik

| Vazifa | Qanday |
|---|---|
| Kodni yangilash | `git add . && git commit -m "..." && git push` → Render o'zi qayta quradi |
| Loglar | Render → servis → **Logs** |
| Kalitni o'zgartirish | Render → servis → **Environment** → saqlash (qayta ishga tushadi) |
| yt-dlp'ni yangilash | Render → **Manual Deploy → Clear build cache & deploy** (haftada bir) |

## Bepul tarif yetmay qolsa

Render **Starter** ($7/oy): uxlamaydi, 0.5 vCPU — kod o'zgarmaydi, faqat
`render.yaml` da `plan: starter`. Yoki oddiy VPS — [`VPS.md`](VPS.md).
