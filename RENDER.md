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
