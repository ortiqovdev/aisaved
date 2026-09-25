import type { Messages } from './en.ts';

export const uz: Messages = {
  cmdStart: `Bog'lanishni boshlash / kodni olish`,
  cmdStatus: `Holat va oxirgi so'rovlar`,
  cmdUnlink: `Bog'lanishni bekor qilish`,
  cmdLanguage: `Tilni o'zgartirish`,
  cmdHelp: `Yordam`,
  botShortDescription: `Instagram Reels'dagi qo'shiqni topaman. Havola yoki video yuboring — nomi, video va tinglash havolalari.`,
  botDescription: `🎵 Reels'da yoqqan qo'shiqni eshitdingizmi? Nomini aytib beraman.

• Instagram Reels havolasini yuboring — video va qo'shiqni qaytaraman
• Yoki istalgan video, ovozli xabar yoki audio tashlang (20 MB gacha)
• Yoki Instagram'da @{account} ga Reels ulashing

Qo'shiq nomi, ijrochi, 30 soniyalik parcha hamda Spotify, Apple Music, Deezer va YouTube havolalarini olasiz.

Start tugmasini bosing 👇`,

  btnOpenInstagram: `📸 @{account} ni ochish`,
  linkInstructions: `👋 <b>Salom!</b>

Instagram'dagi reels musiqasini topib beraman.

⚡️ <b>Tez yo'l:</b> reels havolasini yoki videoning o'zini shu yerga tashlang — musiqa nomini darhol aytaman, hech narsa sozlash shart emas.

📸 <b>Instagram'dan reels yuborish uchun</b> esa bir marta bog'lanish kerak:

<b>1-qadam.</b> Instagram'da <b>@{account}</b> akkauntiga o'ting.
<b>2-qadam.</b> Unga DM orqali quyidagi kodni yuboring:

<code>{code}</code>

<b>3-qadam.</b> "✅ Bog'landi" javobini olganingizdan so'ng, yoqqan reels'ni o'sha akkauntga "Yuborish" (Send) qiling — men videoni va musiqa nomini shu yerga tashlayman.

🔗 To'g'ridan-to'g'ri chat: {igUrl}

🌐 Til: /language`,
  alreadyLinked: `✅ <b>Siz allaqachon bog'langansiz.</b>

Instagram'da <b>@{account}</b> akkauntiga reels yuboravering — men videoni va musiqa nomini shu yerga tashlayman.

Bog'lanishni bekor qilish: /unlink`,
  help: `<b>Musiqani topishning uch yo'li bor</b>

<b>1️⃣ Havola yuboring — eng qulayi</b>
Instagram'da reels ostidagi <b>Share → Copy link</b> ni bosing va havolani shu yerga tashlang.
Video, rasm yoki butun postni yuklab beraman, xohlasangiz qo'shig'ini ham topaman. Bog'lanish shart emas.

<b>2️⃣ Videoni to'g'ridan-to'g'ri tashlang</b>
Video, GIF, ovozli xabar yoki audio yuboring — musiqa nomini javob qilaman.
(Fayl 20MB gacha bo'lsin.)

<b>3️⃣ Instagram DM orqali</b>
Instagram'da @{account} ga reels'ni "Yuborish" qilasiz.
Buning uchun bir marta bog'lanish kerak: /start
<i>Eslatma: Instagram ba'zi reels'larning faylini bermaydi — bunday holatda sizdan havolani so'rayman (1-yo'l).</i>

<b>Buyruqlar</b>
/start — Instagram bilan bog'lanish kodini olish
/status — bog'lanish holati va oxirgi so'rovlar
/unlink — bog'lanishni bekor qilish
/language — tilni o'zgartirish
/round — videoga javob qilib yozing, dumaloq video qilib beraman
/help — shu yordam`,
  notRegistered: `Siz hali ro'yxatdan o'tmagansiz. /start bosing.`,
  statusLinked: `🔗 Holat: <b>bog'langan</b> ✅`,
  statusLinkedAt: `📅 Bog'langan sana: {date}`,
  statusNotLinked: `🔗 Holat: <b>bog'lanmagan</b> ⏳`,
  statusYourCode: `🔑 Kodingiz: <code>{code}</code>`,
  statusSendCodeTo: `Uni Instagram'da @{account} ga DM qiling.`,
  statusRecent: `<b>Oxirgi so'rovlar:</b>`,
  statusNoSong: `musiqa aniqlanmadi`,
  stQueued: `navbatda`,
  stProcessing: `ishlanmoqda`,
  stFailed: `xato`,
  unlinkNotLinked: `Siz hozir hech qanday Instagram akkauntga bog'lanmagansiz. /start bosing.`,
  unlinkDone: `🔓 Bog'lanish bekor qilindi.

Qayta bog'lash uchun yangi kod:
<code>{code}</code>

Uni Instagram'da @{account} ga DM qiling.`,
  languagePrompt: `🌐 Tilni tanlang:`,
  languageChanged: `✅ Til: o'zbekcha.`,

  // ---------- /round ----------
  cmdRound: `Videoni dumaloq qilish (videoga javob)`,
  roundHowTo: `⭕ Videoga javob tariqasida /round yozing — uni dumaloq video xabarga aylantiraman.

<i>Videoni bosing → Javob berish (Reply) → /round yozing</i>`,
  roundNeedVideo: `🤔 Siz javob bergan xabarda video yo'q. /round ni videoga javob qilib yozing.`,
  roundWorking: `⭕ Dumaloq qilyapman...`,
  roundTrimmed: `✂️ Dumaloq video 60 soniyagacha bo'ladi — birinchi daqiqasini oldim.`,
  roundFailed: `😕 Bu videoni dumaloq qilib bo'lmadi. Boshqa video bilan urinib ko'ring.`,
  roundForbidden: `🔒 Maxfiylik sozlamalaringiz mendan video xabar olishni taqiqlaydi. Sozlamalar → Maxfiylik va xavfsizlik → Ovozli xabarlar bo'limida ruxsat bering.`,
  roundBusy: `⏳ Oldingi dumaloq videongiz hali tayyorlanyapti — bir daqiqa.`,

  // ---------- Video tagidagi tugmalar ----------
  btnFindSong: `🎵 Qo'shiqni topish`,
  btnRound: `⭕ Dumaloq qilish`,
  btnShare: `📤 Ulashish`,
  videoReadyCaption: `✅ Videongiz tayyor. Keyingi qadam 👇`,
  songSearching: `🎵 Tinglayapman… qo'shiq video ostida chiqadi.`,
  songAlreadyRequested: `⏳ Allaqachon so'ralgan — natija video ostida.`,
  songServiceDown: `⚙️ Qo'shiqni aniqlash vaqtincha ishlamayapti. Birozdan so'ng qayta urinib ko'ring.`,
  shareTitle: `📤 Shu videoni yuborish`,
  shareCaption: `🎵 @{bot} orqali topildi`,
  shareText: `🎵 Reels yuklab oling va istalgan qo'shiqni toping — shu botni sinab ko'ring`,

  // ---------- Rasm va postlar ----------
  photoReadyCaption: `✅ Mana rasmingiz.`,
  albumReadyCaption: `✅ Mana butun post — {n} ta fayl.`,

  mediaNotFound: `🤔 Bu faylda video yoki audio yo'q. Reels, video yoki ovozli xabar yuboring.`,
  fileTooBig20: `📦 Fayl 20MB dan katta — Telegram botlari bunday faylni yuklab ola olmaydi.

Qisqaroq parcha yuboring yoki reels'ni Instagram orqali tashlang.`,
  pendingLimit: `⏳ Sizning {n} ta so'rovingiz hali navbatda. Ular tugagach yangisini yuboring — /status orqali holatni ko'rishingiz mumkin.`,
  mediaQueued: `⏳ Qabul qilindi — musiqasini aniqlayapman...`,
  photoNotSupported: `🖼 Bu rasm. Musiqani faqat video yoki audiodan aniqlay olaman.`,
  linkDisabled: `⚙️ Havola orqali yuklash hozircha yoqilmagan.

Videoni menga to'g'ridan-to'g'ri tashlang — musiqasini darhol aytaman.`,
  linkQueued: `⏳ Havola qabul qilindi — yuklab olyapman…`,
  unknownCommand: `Bunday buyruq yo'q. /help ni ko'ring.`,
  textMenu: `Menga quyidagilardan birini yuboring 👇

🔗 <b>Instagram havolasi</b> — reels yoki video post havolasini tashlang
🎬 <b>Video yoki audio</b> — to'g'ridan-to'g'ri shu yerga (20MB gacha)

📸 Yoki Instagram'da <b>@{account}</b> ga reels yuboring.

Yordam: /help · Holat: /status · Til: /language`,
  unexpectedError: `⚠️ Kutilmagan xatolik yuz berdi. Birozdan so'ng qayta urinib ko'ring.`,

  songNotDetected: `🎵 Musiqa aniqlanmadi.
<i>Ba'zan reels'da original ovoz, gapirish yoki juda qisqa parcha bo'ladi.</i>`,
  versionsHeader: `<b>Versiyalar</b> — tinglash uchun raqamni bosing:`,
  btnListen: `🔗 Tinglash`,
  btnYoutube: `🔍 YouTube'da qidirish`,
  invalidChoice: `Noto'g'ri tanlov`,
  cantSendHere: `Bu yerda yuborib bo'lmaydi`,
  sending: `⏳ Yuborilmoqda...`,
  previewNotFound: `😕 Bu versiya uchun tinglash parchasi topilmadi.`,
  previewCaption: `🎧 <b>{title}</b>
👤 {artist}

<i>Bu — 30 soniyalik rasmiy parcha. To'liq qo'shiqni yuqoridagi havolalar orqali tinglang.</i>`,
  previewFailed: `😕 Parchani yuborib bo'lmadi. Havola orqali tinglab ko'ring.`,

  igLinkedTelegram: `✅ <b>Instagram akkauntingiz bog'landi!</b>

Endi Instagram'da <b>@{account}</b> ga reels yuboring — videoni va musiqa nomini shu yerga tashlayman.`,
  igReelQueued: `⏳ Reels qabul qilindi, ishlov berilmoqda...`,
  igNotDownloadable: `😕 Instagram bu reels'ning video faylini bermadi — bu Instagram tomonidagi cheklov.

Hozircha videoni o'zingiz saqlab shu yerga tashlang — musiqa nomini darhol topaman.`,
  igPendingLimit: `⏳ Sizning {n} ta so'rovingiz hali navbatda. Ular tugagach reels'ni qaytadan yuboring.`,

  failTelegramSource: `❌ Faylni qayta ishlashda xatolik yuz berdi. Iltimos, videoni qaytadan yuboring.`,
  failInstagramSource: `❌ Videoni qayta ishlashda xatolik yuz berdi. Iltimos, reels'ni Instagram'da qaytadan yuboring.`,
  errLinkExpired: `⏳ Bu videoning havolasi eskirgan. Iltimos, reels'ni Instagram'da qaytadan yuboring.`,
  errVideoTooBig: `📦 Video hajmi juda katta ({size}). Telegram bot orqali {limit} dan kattasini yuborib bo'lmaydi.`,
  errVideoOverLimit: `📦 Video hajmi {limit} dan katta — Telegram orqali yuborib bo'lmaydi.`,
  errImageNotVideo: `🖼 Bu reels emas, rasm ekan. Musiqani faqat videodan aniqlay olaman.`,
  errBadMediaLink: `⏳ Video havolasi ishlamadi — ehtimol muddati o'tgan. Reels'ni qaytadan yuboring.`,
  errResolverUnavailable: `⚙️ Yuklash xizmatiga ulanib bo'lmadi. Birozdan so'ng qayta urinib ko'ring.`,
  errResolverCantFetch: `😕 Bu havoladan videoni ololmadim. Havola to'g'ri va post ochiq (public) ekanini tekshiring.`,
  errResolverNoVideo: `😕 Bu havolada yuklab olinadigan narsa topilmadi. Post mavjud va akkaunt ochiq (public) ekanini tekshiring.`,
  errCantGetFile: `❌ Bu faylni ola olmadim. Iltimos, qaytadan yuboring.`,
  errTooBigForTelegram: `📦 Video Telegram limitidan (50MB) katta bo'lgani uchun yuborib bo'lmadi.`,

  igNotLinked: `❗️ Siz hali Telegram botiga bog'lanmagansiz.

Telegram'da botimizga /start bering, u sizga LINK-XXXXXX ko'rinishidagi kod beradi. O'sha kodni shu yerga yuboring — shundan keyin reels tashlashingiz mumkin.`,
  igLinkSuccess: `✅ Bog'landi!

Endi yoqqan reels'ingizni shu yerga "Yuborish" qiling — videoni va musiqa nomini Telegram botingizga yuboraman.`,
  igCodeNotFound: `❌ Bunday kod topilmadi yoki u allaqachon ishlatilgan.

Telegram botida /start bosib yangi kod oling.`,
  igAlreadyLinked: `✅ Bu akkaunt allaqachon bog'langan. Kod yuborish shart emas — to'g'ridan-to'g'ri reels tashlang.`,
  igSendReels: `👋 Menga reels yuboring — videoni va musiqa nomini Telegram botingizga tashlayman.`,
  igUnsupported: `🤔 Bu turdagi xabarni qayta ishlay olmayman. Iltimos, reels yoki video yuboring.`,
  igUnsupportedImage: `🖼 Bu rasm — men esa musiqani videodan aniqlayman. Reels yoki video yuboring.`,
  igUnsupportedStory: `📖 Story'da eslatganingiz uchun rahmat! Musiqani topish uchun reels'ni DM orqali "Yuborish" qiling.`,
  igUnsupportedAudio: `🎤 Ovozli xabarni emas, reels/video yuboring — musiqani videodan aniqlayman.`,
  igUnsupportedFile: `📎 Faylni emas, Instagram'dagi reels'ni "Yuborish" tugmasi orqali yuboring.`,
};
