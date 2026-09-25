# AI Saved — brend to'plami

Uslub: **minimalizm, qora + oq + bitta urg'u rang.** Katta kampaniyalardagidek
qisqa va lo'nda: bitta belgi, bitta sarlavha, bitta urg'u.

Telegram description / about matnlari kodda: `src/i18n/locales/*.ts`
(`botDescription`, `botShortDescription`) — `npm run bot:profile` bilan 6 tilda
o'rnatiladi. Quyida — qo'lda to'ldiriladigan qismlar va tayyor rasmlar.

---

## 1. Belgi (logo)

**Bookmark + nota.** Bookmark — *saved* (saqlangan), ichidagi kesilgan nota —
*music*. Ma'nosi bir qarashda o'qiladi: "qo'shiqni saqlab qo'ydim".
Hech qanday matn yo'q — 40px avatarda ham tanib olinadi.

| Fayl | Nima uchun |
|---|---|
| [`logo.svg`](logo.svg) | Vektor manba (istalgan o'lchamga, bosma uchun) |
| [`avatar-telegram-1024.png`](avatar-telegram-1024.png) | BotFather → `/setuserpic` |
| [`avatar-instagram-1080.png`](avatar-instagram-1080.png) | Instagram → Edit profile → Change photo |
| [`telegram-description-640x360.png`](telegram-description-640x360.png) | BotFather → `/mybots` → Edit Bot → Edit Description Picture |
| [`mark-light-1080.png`](mark-light-1080.png) | Oq fonli variant (postlar, highlights) |
| [`avatar-lime-white-1080.png`](avatar-lime-white-1080.png) | Muqobil avatar: lime fon, oq bookmark, nota lime |
| [`avatar-lime-ink-1080.png`](avatar-lime-ink-1080.png) | Muqobil avatar: lime fon, qora bookmark, nota lime |
| [`source.html`](source.html) | Hammasining manbasi — o'zgartirib, PNG'ni qayta eksport qilish mumkin |

Ikkala avatar **bir xil** — odamlar bot va Instagram sahifasini bitta brend deb taniydi.

PNG'ni qayta eksport qilish (Windows, Edge):
```
msedge --headless=new --hide-scrollbars --window-size=1024,1024 --virtual-time-budget=20000 --screenshot=avatar.png "file:///D:/coding/aisaved/branding/source.html#avatar"
```
`#avatar` o'rniga: `avatarIg` (1080), `cover` (640×360), `light` (1080).

---

## 2. Palitra — 3 rang

| | Nomi | HEX | Qayerda |
|---|---|---|---|
| ⬛ | Ink | `#0B0B0B` | Asosiy fon |
| ⬜ | Paper | `#FFFFFF` | Matn, oq fonli postlar |
| 🟩 | Signal Lime | `#C6FF3D` | **Faqat urg'u**: belgi, sarlavhaning bitta so'zi, tugma. Bot ichida — Telegram'ning yashil (`success`) tugmalari |

**Qoidalar:**
- Lime — kadrning ~10–20% idan oshmasin. Bitta kadrda bitta urg'u.
- Lime **faqat qora fonda**. Oq fonda u ko'rinmaydi — oq fonli postda belgi qora.
- Gradient, soya, ikkinchi urg'u rang yo'q.

**Shriftlar** (Google Fonts, bepul):
- Sarlavha: **Anton** — KATTA HARFLAR, 2 qator, 2–3 so'z
- Matn: **Inter** Medium / ExtraBold

---

## 3. Telegram bot (BotFather)

| Maydon | Qiymat |
|---|---|
| Name (≤64) | `AI Saved · Reels Song Finder` |
| Botpic | `avatar-telegram-1024.png` |
| Description picture | `telegram-description-640x360.png` |
| About / Description | ✅ avtomatik (`npm run bot:profile`, 6 tilda) |
| Commands | ✅ avtomatik (server ishga tushganda, 6 tilda) |

Description picture'dagi sarlavha: **HEAR IT. / SAVE IT.** — ostida
*Send a Reel — get the song.* Rasm barcha tillarda bir xil ko'rinadi, shuning
uchun matni inglizcha va juda qisqa.

---

## 4. Instagram profili (@aisavedbot)

Instagram API bio'ni o'zgartirishga ruxsat bermaydi — ilovada
**Edit profile** orqali qo'lda kiritiladi.

**Name** (≤30, qidiruvda ishtirok etadi):
```
AI Saved · Reels Song Finder
```

**Bio** (146/150):
```
🎵 Find the song in any Reel
📩 Share a Reel to our DM → get the track in Telegram
⚡ Free · Instant · 30s preview + Spotify links
👇 Start the bot
```

**Links → Add external link:** `https://t.me/aisavedinstabot` — Title: `Telegram bot`

**Category:** `App Page`

**Story Highlights** — qopqoqlar: qora fon, markazda oq chiziqli ikonka
(pastdagi 5b prompt). Nomlari: `How to` · `Link` · `Results` · `FAQ`.

**Pinned post matni:**
```
How it works 👇

1️⃣ Open our Telegram bot (link in bio) and tap Start
2️⃣ Send the LINK-XXXXXX code to this account in DM
3️⃣ Share any Reel here — the video and the song name land in your Telegram

No link? Just paste the Reel URL into the bot. 🎵
```

---

## 5. Keyingi postlar uchun shablon

Har bir post bir xil tuzilishda — lenta bir butun bo'lib ko'rinadi:

```
┌──────────────────────────┐
│ [belgi]            aisaved│  ← yuqorida kichik belgi, 48px chet
│                           │
│ HEAR IT.                  │  ← Anton, oq, 2 qator
│ SAVE IT.                  │  ← ikkinchi qator LIME
│ Send a Reel — get the song│  ← Inter, oq 70%
│                           │
│        [ vizual ]         │  ← qora-oq foto / 3D obyekt, bitta lime detal
│                  [ → ]    │  ← lime doira-tugma
└──────────────────────────┘
   1080×1350 (4:5), fon #0B0B0B
```

Sarlavha g'oyalari (2–3 so'z, nuqta bilan): `HEAR IT. SAVE IT.` ·
`SONG STUCK? FOUND.` · `ONE LINK. ONE SONG.` · `NO MORE GUESSING.` ·
`SHARE. TAP. LISTEN.`

### 5a. Post vizuali uchun prompt (AI generator)

Matnni rasmga yozdirmang — generatorlar harflarni buzadi. Vizualni
generatsiya qiling, sarlavhani Canva/Figma'da Anton shriftida qo'ying.

```
Minimal high-contrast editorial image, 4:5, deep black background (#0B0B0B).
Subject: [SUBJECT], shot in black and white, dramatic soft studio light,
sharp detail, lots of empty negative space in the top half for a headline.
Exactly ONE small accent element in neon lime (#C6FF3D): [ACCENT].
No other colors, no gradients, no text, no letters, no logos, no watermark.
Style: premium tech campaign, clean, modern, Apple/Nike-level minimalism.
```

`[SUBJECT]` / `[ACCENT]` misollari:
- `a hand holding a smartphone playing a vertical video` / `the sound waves coming out of the phone`
- `studio headphones resting on a black cube` / `the headphone cable`
- `a vinyl record half out of its sleeve` / `the record label`
- `a person with eyes closed, listening to music` / `one earbud`

### 5b. Highlights qopqog'i uchun prompt

```
Instagram highlight cover, 1080x1920, solid black background (#0B0B0B),
a single thin-line icon in pure white centered in the middle 400x400 area:
[ICON]. Thick rounded strokes, flat, minimal. No text, no other colors.
```
`[ICON]`: `a question mark` (How to) · `a chain link` (Link) ·
`a music note with a check mark` (Results) · `an "i" in a circle` (FAQ).
