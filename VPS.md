# Botni VPS'ga ko'chirish

Hozir bot uy kompyuterida ishlayapti: kompyuter o'chsa bot ham to'xtaydi, har
qayta ishga tushganda tunnel URL'i o'zgaradi (Meta'da callback'ni yangilash
kerak), Telegram va Supabase'gacha har bir so'rov ~190 ms, Telegram fayl
serveri esa juda sekin (3 MB — 48 s). Yevropadagi VPS bularning hammasini
hal qiladi va doimiy HTTPS manzil beradi.

Taxminiy vaqt: 30–40 daqiqa. Narx: **bepul** (Oracle Cloud Always Free, pastda)
yoki oddiy VPS — oyiga ~€4–6.

---

## 0. Nima kerak

| Narsa | Tavsiya | Izoh |
|---|---|---|
| VPS | Hetzner Cloud (yoki DigitalOcean, Vultr), **Ubuntu 24.04**, 2 vCPU, 2–4 GB RAM | Joylashuvni pastdagi qoidaga qarab tanlang |
| Domen | ixtiyoriy (`bot.sizningdomen.uz`) | Bo'lmasa — bepul `sslip.io` (5-bosqich) |
| Kompyuterdagi | PowerShell (Windows 11 da `ssh`, `scp`, `tar` bor) | |

**Joylashuv:** Supabase qaysi mintaqada ekanini tekshiring — Supabase panel →
*Project Settings → General → Region*. VPS'ni o'sha joyga yaqin oling
(masalan Supabase `eu-central-1` bo'lsa — Hetzner **Falkenstein/Nuremberg**
yoki Frankfurt). Telegram serverlari ham Yevropada (Amsterdam), shuning uchun
Germaniya/Niderlandiya eng yaxshi tanlov.

### Bepul variant: Oracle Cloud Always Free

Oracle Cloud'ning doimiy bepul tarifi: **ARM (Ampere A1) — 2 vCPU, 12 GB RAM**
(2026-yil iyunidan buyon; ilgari 4/24 edi). Uy kompyuteridan va €4 lik
VPS'dan ham kuchliroq. Bot ARM'da o'zgarishsiz ishlaydi — Docker image'dagi
Node, ffmpeg va yt-dlp ARM uchun ham bor.

1. https://cloud.oracle.com → **Sign up**. Karta so'raladi (faqat tasdiqlash
   uchun, bepul resurslardan pul yechilmaydi). **Home region** ni keyin
   o'zgartirib bo'lmaydi — **Germany Central (Frankfurt)** yoki
   **Netherlands (Amsterdam)** ni tanlang (Telegram va Supabase'ga yaqin).
2. *Compute → Instances → Create instance*:
   - **Image:** Canonical Ubuntu 24.04
   - **Shape:** Ampere → `VM.Standard.A1.Flex`, **2 OCPU, 12 GB**
     (belgisida "Always Free-eligible" bo'lishi kerak)
   - **SSH keys:** "Generate a key pair" → ikkala kalitni yuklab oling
   - "Out of capacity" xatosi chiqsa — boshqa *Availability domain* ni tanlang
     yoki bir necha soatdan keyin qayta urining (bepul ARM'ga talab katta)
3. **Tarmoq (1-qavat):** *Instance → Subnet → Default Security List →
   Add Ingress Rules*: Source `0.0.0.0/0`, TCP, Destination port **80**;
   xuddi shunday **443**.
4. Kirish (foydalanuvchi `root` emas, `ubuntu`):
   ```powershell
   ssh -i .\ssh-key.key ubuntu@<IP>
   ```
   Keyingi barcha buyruqlarni `sudo -i` dan keyin bajaring.
5. **Tarmoq (2-qavat):** Oracle'ning Ubuntu image'ida `iptables` 22-portdan
   boshqasini yopadi — `ufw` o'rniga (1-bosqichdagi `ufw` qatorini **bajarmang**):
   ```bash
   iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   netfilter-persistent save
   ```
6. Keyin 2-bosqichdan (Docker) davom eting. Buyruqlardagi `root@<IP>`
   o'rniga `ubuntu@<IP>` va `-i .\ssh-key.key` ishlating; `/opt/` ga yozish
   uchun faylni avval `/tmp/` ga yuklab, serverda `sudo mv` qiling.

> **Diqqat — bo'sh turgan server qaytarib olinishi mumkin.** Oracle bepul
> akkauntdagi instance'ni 7 kun davomida CPU, tarmoq va xotira 20% dan kam
> ishlatilsa "idle" deb o'chirishi mumkin — kam foydalanuvchili bot aynan
> shunday. Himoya: akkauntni **Pay As You Go** ga o'tkazing (*Billing →
> Upgrade*). Bepul limitlar saqlanadi, pul faqat limitdan oshsa yechiladi,
> idle-o'chirish esa qo'llanmaydi. Oracle'dan biror narsa to'lab qo'ymaslik
> uchun *Billing → Budgets* da $1 lik byudjet ogohlantirishi qo'ying.

> **Instagram va server IP'lari.** Instagram data-markaz IP'laridan
> login'siz so'rovlarni uy internetiga qaraganda ancha tezroq cheklaydi.
> Ko'chirgandan keyin **birinchi ish** — bir nechta reels yuborib tekshiring.
> Logda `login required` / `empty media response` ko'p chiqsa — pullik
> resolver (`IG_RESOLVER_URL`) kerak bo'ladi.

---

## 1. Serverga kirish va xavfsizlik

VPS yaratilgach, sizga IP manzil beriladi (masalan `203.0.113.10`).

```bash
ssh root@203.0.113.10
```

Tizimni yangilash va faqat kerakli portlarni ochish (SSH, HTTP, HTTPS):

```bash
apt update && apt upgrade -y
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

> 3000-port ochilmaydi: ilova faqat serverning ichida tinglaydi
> (`docker-compose.yml` → `127.0.0.1:3000`), tashqaridan kirish — Caddy orqali HTTPS.

---

## 2. Docker o'rnatish

```bash
curl -fsSL https://get.docker.com | sh
docker compose version
```

---

## 3. Kodni serverga yuklash

**Kompyuterda** (PowerShell, loyiha papkasida) — `node_modules` va `dist`siz arxiv:

```powershell
tar --exclude=node_modules --exclude=dist --exclude=*.log -czf ..\aisaved.tgz .
scp ..\aisaved.tgz root@203.0.113.10:/opt/
```

**Serverda:**

```bash
mkdir -p /opt/aisaved && cd /opt/aisaved
tar -xzf /opt/aisaved.tgz && rm /opt/aisaved.tgz
chmod 600 .env
```

---

## 4. `.env` ni production uchun sozlash

```bash
nano /opt/aisaved/.env
```

O'zgartiriladiganlar:

```ini
NODE_ENV=production
MOCK_INSTAGRAM=false
# Windows yo'llari bo'lsa — tozalang (Docker ichida o'zi topadi)
FFMPEG_PATH=ffmpeg
YTDLP_PATH=yt-dlp
TMP_DIR=
```

Qolganlari (Telegram, Instagram, Supabase kalitlari) — o'zgarishsiz.

---

## 5. HTTPS (Caddy) — doimiy manzil

Caddy sertifikatni (Let's Encrypt) o'zi oladi va yangilaydi.

```bash
apt install -y caddy
```

**Domen bo'lsa:** domen DNS'ida `A` yozuvini VPS IP'siga yo'naltiring
(`bot.sizningdomen.uz → 203.0.113.10`).

**Domen bo'lmasa:** IP'dan bepul domen — nuqtalarni chiziqcha bilan
almashtiring: `203-0-113-10.sslip.io` (sozlash shart emas, darhol ishlaydi).

```bash
cat > /etc/caddy/Caddyfile <<'EOF'
203-0-113-10.sslip.io {
    reverse_proxy 127.0.0.1:3000
}
EOF
systemctl reload caddy
```

(Birinchi qatorga o'z domeningizni yoki sslip.io manzilingizni yozing.)

---

## 6. ⚠️ Kompyuterdagi botni to'xtatish

Bitta bot tokeni bilan **ikki nusxa bir vaqtda ishlay olmaydi**: Telegram
`409 Conflict` beradi va xabarlar ikkalasiga bo'linib ketadi. Kompyuterdagi
`npm run win` oynasida **Ctrl+C** bosing.

---

## 7. Botni ishga tushirish

```bash
cd /opt/aisaved
docker compose up -d --build
docker compose logs -f
```

Logda quyidagilar chiqishi kerak (JSON ko'rinishida):
`Supabase ulanishi OK` → `Telegram bot ulandi` → `HTTP server tayyor` → `Worker ishga tushdi`.
Chiqish: **Ctrl+C** (bot fonda ishlashda davom etadi).

Tekshirish:

```bash
curl https://203-0-113-10.sslip.io/health
```

Javob: `{"ok":true,...}`

---

## 8. Meta'ni yangi manzilga ulash

Meta Developer → App → Instagram → **Webhooks**:

| Maydon | Qiymat |
|---|---|
| Callback URL | `https://<manzilingiz>/webhook/instagram` |
| Verify token | `.env` dagi `IG_WEBHOOK_VERIFY_TOKEN` |

**Verify and save** → server logida `Instagram webhook verification muvaffaqiyatli`.

Bu URL endi **o'zgarmaydi** — qayta ishga tushirishda ham.

**Live rejim (tavsiya):** *App settings → Basic → Privacy Policy URL* ga
`https://<manzilingiz>/privacy` yozing, so'ng app'ni **Live** ga o'tkazing.
Development rejimida faqat app'ga qo'shilgan (tester) akkauntlarning DM'lari
keladi.

---

## 9. Yakuniy tekshiruv

- [ ] `https://<manzilingiz>/health` → `"ok":true`
- [ ] Telegram'da `/start` — javob keladi
- [ ] Instagram'dan reels yuborish → Telegram'ga video keladi
- [ ] 🎵 bosish → qo'shiq topiladi
- [ ] Serverni qayta yuklash (`reboot`) → bot o'zi qayta turadi (`restart: unless-stopped`)
- [ ] **Kalitlarni yangilash:** Instagram App Secret va Telegram bot tokeni chatda
      ochiq yozilgan edi — Meta panelida *App Secret → Reset*, @BotFather'da
      `/revoke`, yangilarini serverdagi `.env` ga yozing va
      `docker compose up -d` qiling.

---

## Kundalik ishlar

| Vazifa | Buyruq (`/opt/aisaved` da) |
|---|---|
| Loglarni ko'rish | `docker compose logs -f --tail 200` |
| Qayta ishga tushirish | `docker compose restart` |
| To'xtatish | `docker compose down` |
| Holat | `docker compose ps` |
| `.env` o'zgargach | `docker compose up -d` |

### Kodni yangilash

Kompyuterda 3-bosqichdagi arxivni qayta yuklang, serverda:

```bash
cd /opt/aisaved && tar -xzf /opt/aisaved.tgz && rm /opt/aisaved.tgz
docker compose up -d --build
```

> Arxiv ichidagi `.env` serverdagining ustidan yozadi. Serverda `.env` ni
> o'zgartirgan bo'lsangiz, arxivdan chiqarib tashlang:
> `tar --exclude=.env ...`

### yt-dlp'ni yangilash (muhim)

Instagram va YouTube tez-tez o'zgaradi — eski yt-dlp videolarni ololmay qoladi.
Image har qurilganda yt-dlp'ning eng oxirgi versiyasi olinadi, shuning uchun
**haftada bir marta** (yoki Instagram havolalari ishlamay qolsa):

```bash
docker compose build --no-cache && docker compose up -d
```

---

## Yuk oshganda

- **Parallel ishlar:** `.env` da `WORKER_CONCURRENCY` ni oshiring (8 → 16).
- **Alohida worker:** `docker-compose.yml` dagi `worker` bo'limini oching va
  `docker compose up -d --scale worker=2`.
- **Supabase:** panelda *Usage* sahifasini kuzating — baza 500 MB ga, trafik
  5 GB ga yaqinlashsa Pro ($25/oy). Eski yozuvlar o'zi tozalanadi
  (`REQUESTS_RETENTION_DAYS`, `CACHE_RETENTION_DAYS`).
