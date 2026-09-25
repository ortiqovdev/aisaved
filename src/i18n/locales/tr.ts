import type { Messages } from './en.ts';

export const tr: Messages = {
  cmdStart: `Başla / bağlantı kodunu al`,
  cmdStatus: `Durum ve son istekler`,
  cmdUnlink: `Instagram bağlantısını kaldır`,
  cmdLanguage: `Dili değiştir`,
  cmdHelp: `Yardım`,
  botShortDescription: `Reels, TikTok, Shorts ve Pinterest videolarını indir, içindeki şarkıyı bul. Başlamak için bağlantı gönder.`,
  botDescription: `🎵 Bir Reels'te güzel bir şarkı mı duydun? Hangi şarkı olduğunu söyleyeyim.

• Instagram, TikTok, YouTube Shorts veya Pinterest bağlantısı gönder — videoyu geri göndereyim
• Ya da herhangi bir video, sesli mesaj veya ses dosyası at (20 MB'a kadar)
• Ya da Instagram'da Reels'i @{account} ile paylaş

Şarkı adı, sanatçı, 30 saniyelik önizleme ve Spotify, Apple Music, Deezer ve YouTube bağlantılarını alırsın.

Başlat'a dokun 👇`,

  btnOpenInstagram: `📸 @{account} hesabını aç`,
  linkInstructions: `👋 <b>Merhaba!</b>

Instagram Reels'teki müzikleri bulurum.

⚡️ <b>En hızlı yol:</b> bana Reels bağlantısını ya da videonun kendisini gönder — şarkının adını hemen söylerim, hiçbir ayar gerekmez.

📸 <b>Instagram'dan Reels göndermek için</b> hesabını bir kez bağla:

<b>1. adım.</b> Instagram'da <b>@{account}</b> hesabını aç.
<b>2. adım.</b> DM ile şu kodu gönder:

<code>{code}</code>

<b>3. adım.</b> "✅ Bağlandı" yanıtını aldıktan sonra beğendiğin Reels'i o hesaba gönder — videoyu ve şarkı adını buraya gönderirim.

🔗 Doğrudan sohbet: {igUrl}

🌐 Dil: /language`,
  alreadyLinked: `✅ <b>Hesabın zaten bağlı.</b>

Instagram'da <b>@{account}</b> hesabına Reels göndermeye devam et — videoyu ve şarkı adını buraya gönderirim.

Bağlantıyı kaldırmak için: /unlink`,
  help: `<b>Şarkı bulmanın üç yolu</b>

<b>1️⃣ Bağlantı gönder — en kolayı</b>
Instagram, TikTok, YouTube Shorts veya Pinterest'te <b>Paylaş → Bağlantıyı kopyala</b>'ya dokun ve buraya yapıştır — ya da doğrudan bu bota paylaş.
Videoyu, fotoğrafı ya da tüm gönderiyi indiririm — istersen şarkısını da bulurum. Hesap bağlamak gerekmez.

<b>2️⃣ Videoyu doğrudan gönder</b>
Video, GIF, sesli mesaj veya ses dosyası gönder — şarkı adıyla yanıt veririm.
(Dosya 20 MB'a kadar.)

<b>3️⃣ Instagram DM ile</b>
Instagram'da Reels'i @{account} hesabına gönder.
Bunun için hesabını bir kez bağlaman gerekir: /start
<i>Not: Instagram bazı Reels'lerin dosyasını vermiyor — bu durumda senden bağlantıyı isterim (1. yol).</i>

<b>👥 Gruplarda ve her sohbette</b>
Beni bir gruba ekleyin — orada paylaşılan bağlantıları indiririm.
Herhangi bir sohbette <code>@{bot} bağlantı</code> yazın — videoyu sohbetten çıkmadan gönderin.

<b>Komutlar</b>
/start — Instagram bağlantı kodunu al
/status — bağlantı durumu ve son istekler
/unlink — Instagram bağlantısını kaldır
/language — dili değiştir
/round — bir videoya yanıt ver, yuvarlak video yapayım
/help — bu yardım`,
  notRegistered: `Henüz kayıtlı değilsin. /start'a dokun.`,
  statusLinked: `🔗 Durum: <b>bağlı</b> ✅`,
  statusLinkedAt: `📅 Bağlanma tarihi: {date}`,
  statusNotLinked: `🔗 Durum: <b>bağlı değil</b> ⏳`,
  statusYourCode: `🔑 Kodun: <code>{code}</code>`,
  statusSendCodeTo: `Instagram'da @{account} hesabına DM olarak gönder.`,
  statusRecent: `<b>Son istekler:</b>`,
  statusNoSong: `şarkı tanınmadı`,
  stQueued: `sırada`,
  stProcessing: `işleniyor`,
  stFailed: `başarısız`,
  unlinkNotLinked: `Hiçbir Instagram hesabına bağlı değilsin. /start'a dokun.`,
  unlinkDone: `🔓 Bağlantı kaldırıldı.

Yeniden bağlamak için yeni kod:
<code>{code}</code>

Instagram'da @{account} hesabına DM olarak gönder.`,
  languagePrompt: `🌐 Dilini seç:`,
  languageChanged: `✅ Dil: Türkçe.`,

  // ---------- /round ----------
  cmdRound: `Videoyu yuvarlak yap (videoya yanıt olarak)`,
  roundHowTo: `⭕ Bir videoya /round ile yanıt ver — onu yuvarlak görüntülü mesaja çevireyim.

<i>Videoya dokun → Yanıtla → /round yaz</i>`,
  roundNeedVideo: `🤔 Yanıtladığın mesajda video yok. /round komutunu bir videoya yanıt olarak yaz.`,
  roundWorking: `⭕ Yuvarlak yapıyorum...`,
  roundTrimmed: `✂️ Yuvarlak videolar en fazla 60 saniye olabilir — ilk dakikayı kullandım.`,
  roundFailed: `😕 Bu video yuvarlak yapılamadı. Başka bir videoyla dene.`,
  roundForbidden: `🔒 Gizlilik ayarların benden görüntülü mesaj almayı engelliyor. Ayarlar → Gizlilik ve Güvenlik → Sesli Mesajlar bölümünden izin ver.`,
  roundBusy: `⏳ Önceki yuvarlak videon hâlâ hazırlanıyor — bir saniye.`,

  // ---------- Video tagidagi tugmalar ----------
  btnFindSong: `🎵 Şarkıyı bul`,
  btnRound: `⭕ Yuvarlak yap`,
  btnShare: `📤 Paylaş`,
  videoReadyCaption: `✅ Videon hazır. Sırada ne var? 👇`,
  songSearching: `🎵 Dinliyorum… şarkı videonun altında görünecek.`,
  songAlreadyRequested: `⏳ Zaten istendi — sonuç videonun altında.`,
  songServiceDown: `⚙️ Şarkı tanıma geçici olarak kullanılamıyor. Biraz sonra tekrar dene.`,
  shareTitle: `📤 Bu videoyu gönder`,
  shareCaption: `🎵 @{bot} ile bulundu`,
  shareText: `🎵 Reels indir, istediğin şarkıyı bul — bu botu dene`,

  // ---------- Rasm va postlar ----------
  photoReadyCaption: `✅ İşte fotoğrafın.`,
  albumReadyCaption: `✅ İşte gönderinin tamamı — {n} dosya.`,

  // ---------- Platformalar, guruhlar, inline ----------
  groupHello: `👋 Merhaba! Bu sohbete Instagram, TikTok, YouTube Shorts veya Pinterest bağlantısı gönderin — videoyu hemen burada paylaşırım.`,
  groupNeedsAdmin: `ℹ️ Gruptaki bağlantıları görebilmem için beni yönetici yapın — özel yetki gerekmez.`,
  inlineOpenBot: `📥 Botta indir`,
  errPlatformUnavailable: `⚙️ Bu platformdan indirme şu anda kullanılamıyor. Lütfen daha sonra tekrar dene.`,
  errVideoTooLong: `⏱ Bu video çok uzun — 10 dakikaya kadar olan videoları indiriyorum.`,

  mediaNotFound: `🤔 Bu dosyada video veya ses yok. Reels, video ya da sesli mesaj gönder.`,
  fileTooBig20: `📦 Dosya 20 MB'tan büyük — Telegram botları bu boyuttaki dosyaları indiremez.

Daha kısa bir klip gönder ya da Reels'i Instagram üzerinden paylaş.`,
  pendingLimit: `⏳ Sırada hâlâ {n} isteğin var. Bitince yenisini gönder — durumu /status ile görebilirsin.`,
  mediaQueued: `⏳ Alındı — şarkıyı tanıyorum...`,
  photoNotSupported: `🖼 Bu bir fotoğraf. Müziği yalnızca video veya sesten tanıyabilirim.`,
  linkDisabled: `⚙️ Bağlantıyla indirme henüz etkin değil.

Videoyu bana doğrudan gönder — şarkının adını hemen söylerim.`,
  linkQueued: `⏳ Bağlantı alındı — indiriyorum…`,
  unknownCommand: `Böyle bir komut yok. /help'e bak.`,
  textMenu: `Bana şunlardan birini gönder 👇

🔗 <b>Bağlantı</b> — Instagram, TikTok, YouTube Shorts veya Pinterest
🎬 <b>Video veya ses</b> — doğrudan buraya (20 MB'a kadar)

📸 Ya da Instagram'da Reels'i <b>@{account}</b> hesabına gönder.

Yardım: /help · Durum: /status · Dil: /language`,
  unexpectedError: `⚠️ Beklenmeyen bir hata oluştu. Biraz sonra tekrar dene.`,

  songNotDetected: `🎵 Şarkı tanınmadı.
<i>Bazen Reels'te orijinal ses, konuşma ya da çok kısa bir klip olur.</i>`,
  versionsHeader: `<b>Sürümler</b> — dinlemek için bir numaraya dokun:`,
  btnListen: `🔗 Dinle`,
  btnYoutube: `🔍 YouTube'da ara`,
  invalidChoice: `Geçersiz seçim`,
  cantSendHere: `Buraya gönderilemiyor`,
  sending: `⏳ Gönderiliyor...`,
  previewNotFound: `😕 Bu sürüm için önizleme bulunamadı.`,
  previewCaption: `🎧 <b>{title}</b>
👤 {artist}

<i>Bu, 30 saniyelik resmi önizlemedir. Şarkının tamamını yukarıdaki bağlantılardan dinle.</i>`,
  previewFailed: `😕 Önizleme gönderilemedi. Bağlantıdan dinlemeyi dene.`,

  igLinkedTelegram: `✅ <b>Instagram hesabın bağlandı!</b>

Artık Instagram'da <b>@{account}</b> hesabına Reels gönder — videoyu ve şarkı adını buraya gönderirim.`,
  igReelQueued: `⏳ Reels alındı, işleniyor...`,
  igNotDownloadable: `😕 Instagram bu Reels'in video dosyasını vermedi — bu Instagram tarafındaki bir kısıtlama.

Şimdilik videoyu kaydedip buraya gönder — şarkıyı hemen bulurum.`,
  igPendingLimit: `⏳ Sırada hâlâ {n} isteğin var. Bitince Reels'i tekrar gönder.`,

  failTelegramSource: `❌ Dosya işlenirken bir hata oluştu. Lütfen videoyu tekrar gönder.`,
  failInstagramSource: `❌ Video işlenirken bir hata oluştu. Lütfen Reels'i Instagram'da tekrar gönder.`,
  errLinkExpired: `⏳ Bu videonun bağlantısının süresi dolmuş. Lütfen Reels'i Instagram'da tekrar gönder.`,
  errVideoTooBig: `📦 Video çok büyük ({size}). Telegram botu üzerinden {limit} üzerindeki videolar gönderilemez.`,
  errVideoOverLimit: `📦 Video {limit} sınırını aşıyor — Telegram üzerinden gönderilemez.`,
  errImageNotVideo: `🖼 Bu bir Reels değil, fotoğraf. Müziği yalnızca videodan tanıyabilirim.`,
  errBadMediaLink: `⏳ Video bağlantısı çalışmadı — süresi dolmuş olabilir. Reels'i tekrar gönder.`,
  errResolverUnavailable: `⚙️ İndirme hizmetine bağlanılamadı. Biraz sonra tekrar dene.`,
  errResolverCantFetch: `😕 Bu bağlantıdan video alınamadı. Bağlantının doğru ve gönderinin herkese açık olduğunu kontrol et.`,
  errResolverNoVideo: `😕 Bu bağlantıda indirilecek bir şey bulunamadı. Gönderinin var olduğunu ve hesabın herkese açık olduğunu kontrol et.`,
  errCantGetFile: `❌ Bu dosya alınamadı. Lütfen tekrar gönder.`,
  errTooBigForTelegram: `📦 Video, Telegram'ın 50 MB sınırını aştığı için gönderilemedi.`,

  igNotLinked: `❗️ Henüz Telegram botuna bağlı değilsin.

Telegram'da botumuzu açıp /start'a dokun — sana LINK-XXXXXX biçiminde bir kod verecek. O kodu buraya gönder, ardından Reels paylaşabilirsin.`,
  igLinkSuccess: `✅ Bağlandı!

Artık beğendiğin Reels'i buraya gönder — videoyu ve şarkı adını Telegram botuna gönderirim.`,
  igCodeNotFound: `❌ Bu kod bulunamadı ya da daha önce kullanılmış.

Yeni kod almak için Telegram botunda /start'a dokun.`,
  igAlreadyLinked: `✅ Bu hesap zaten bağlı. Kod göndermene gerek yok — doğrudan Reels gönder.`,
  igSendReels: `👋 Bana bir Reels gönder — videoyu ve şarkı adını Telegram botuna gönderirim.`,
  igUnsupported: `🤔 Bu tür mesajları işleyemiyorum. Lütfen Reels veya video gönder.`,
  igUnsupportedImage: `🖼 Bu bir fotoğraf — ben müziği videodan tanırım. Reels veya video gönder.`,
  igUnsupportedStory: `📖 Bahsettiğin için teşekkürler! Şarkıyı bulmak için Reels'i DM ile gönder.`,
  igUnsupportedAudio: `🎤 Sesli mesaj yerine Reels veya video gönder — müziği videodan tanırım.`,
  igUnsupportedFile: `📎 Dosya yerine Reels'i Instagram'daki "Gönder" düğmesiyle paylaş.`,
};
