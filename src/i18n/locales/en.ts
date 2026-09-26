/**
 * Asosiy (manba) lug'at. Boshqa tillar aynan shu kalitlarni to'ldirishi
 * shart — `Messages` tipi buni kompilyatsiya vaqtida tekshiradi.
 *
 * `{name}` — o'zgaruvchi joyi (`t()` almashtiradi). HTML kontekstida
 * o'zgaruvchi qiymatini chaqiruvchi o'zi escape qiladi.
 * `ig*` kalitlari Instagram DM uchun — oddiy matn, HTML teglarsiz.
 */
export const en = {
  // ---------- Telegram profili ----------
  cmdStart: `Start / get your link code`,
  cmdStatus: `Status and recent requests`,
  cmdUnlink: `Unlink Instagram`,
  cmdLanguage: `Change language`,
  cmdHelp: `Help`,
  botShortDescription: `Download Reels, TikTok, Shorts & Pinterest videos and find the song in them. Send a link to start.`,
  botDescription: `🎵 Heard a great song in a Reel? I'll tell you what it is.

• Send a link from Instagram, TikTok, YouTube Shorts or Pinterest — I'll send back the video
• Or drop any video, voice note or audio file (up to 20 MB)
• Or share Reels to @{account} on Instagram

You get the title, artist, a 30-second preview and links to Spotify, Apple Music, Deezer and YouTube.

Tap Start 👇`,

  // ---------- Buyruqlar ----------
  btnOpenInstagram: `📸 Open @{account}`,
  linkInstructions: `👋 <b>Hi!</b>

I find the music in Instagram Reels.

⚡️ <b>Fastest way:</b> send me a Reel link or the video itself — I'll name the song right away, no setup needed.

📸 <b>To send Reels from Instagram</b>, link your account once:

<b>Step 1.</b> Open <b>@{account}</b> on Instagram.
<b>Step 2.</b> Send this code in a DM:

<code>{code}</code>

<b>Step 3.</b> Once you get "✅ Linked", share any Reel to that account — I'll send the video and the song name here.

🔗 Direct chat: {igUrl}

🌐 Language: /language`,
  alreadyLinked: `✅ <b>You're already linked.</b>

Share Reels to <b>@{account}</b> on Instagram — I'll send the video and the song name here.

To unlink: /unlink`,
  help: `<b>Three ways to find a song</b>

<b>1️⃣ Send a link — the easiest</b>
Tap <b>Share → Copy link</b> on Instagram, TikTok, YouTube Shorts or Pinterest and paste it here — or share straight to this bot.
I'll download the video, photo or the whole post — and find the song on request. No linking needed.

<b>2️⃣ Send the video directly</b>
Send a video, GIF, voice note or audio — I'll reply with the song name.
(Files up to 20 MB.)

<b>3️⃣ Via Instagram DM</b>
Share a Reel to @{account} on Instagram.
You need to link your account once: /start
<i>Note: Instagram doesn't provide the file for some Reels — in that case I'll ask you for the link (way 1).</i>

<b>👥 In groups and any chat</b>
Add me to a group — I'll download links posted there.
In any chat, type <code>@{bot} link</code> to send the video without leaving it.

<b>Commands</b>
/start — get your Instagram link code
/status — link status and recent requests
/unlink — unlink Instagram
/language — change language
/round — reply to a video to make it a round video
/help — this help`,
  notRegistered: `You're not registered yet. Tap /start.`,
  statusLinked: `🔗 Status: <b>linked</b> ✅`,
  statusLinkedAt: `📅 Linked on: {date}`,
  statusIgAccount: `📸 Instagram: {igUser}`,
  statusNotLinked: `🔗 Status: <b>not linked</b> ⏳`,
  statusYourCode: `🔑 Your code: <code>{code}</code>`,
  statusSendCodeTo: `Send it to @{account} in an Instagram DM.`,
  statusRecent: `<b>Recent requests:</b>`,
  statusNoSong: `song not recognized`,
  stQueued: `queued`,
  stProcessing: `processing`,
  stFailed: `failed`,
  unlinkNotLinked: `You're not linked to any Instagram account. Tap /start.`,
  unlinkDone: `🔓 Unlinked.

New code to link again:
<code>{code}</code>

Send it to @{account} in an Instagram DM.`,
  languagePrompt: `🌐 Choose your language:`,
  languageChanged: `✅ Language: English.`,

  // ---------- Kiruvchi xabarlar ----------
  // ---------- /round ----------
  cmdRound: `Make a video round (reply to a video)`,
  cmdTop: `Top trending songs`,
  roundHowTo: `⭕ Reply to a video with /round — I'll turn it into a round video message.

<i>Tap the video → Reply → type /round</i>`,
  roundNeedVideo: `🤔 There's no video in the message you replied to. Reply to a video with /round.`,
  roundWorking: `⭕ Making it round...`,
  roundTrimmed: `✂️ Round videos can be up to 60 seconds, so I used the first minute.`,
  roundFailed: `😕 Couldn't make this video round. Please try another video.`,
  roundForbidden: `🔒 Your privacy settings block video messages from me. Allow them in Settings → Privacy and Security → Voice Messages.`,
  roundBusy: `⏳ Still working on your previous round video — one moment.`,

  // ---------- Video tagidagi tugmalar ----------
  btnFindSong: `🎵 Find the song`,
  btnRound: `⭕ Make it round`,
  btnShare: `📤 Share`,
  videoReadyCaption: `✅ Your video is ready. What's next? 👇`,
  songSearching: `🎵 Listening… the song will appear under the video.`,
  songAlreadyRequested: `⏳ Already requested — the result is under the video.`,
  songServiceDown: `⚙️ Song recognition is temporarily unavailable. Please try again a bit later.`,
  shareTitle: `📤 Send this video`,
  shareCaption: `🎵 Found with @{bot}`,
  shareText: `🎵 Download Reels and find any song — try this bot`,

  // ---------- Rasm va postlar ----------
  photoReadyCaption: `✅ Here's your photo.`,
  albumReadyCaption: `✅ Here's the whole post — {n} files.`,

  // ---------- Platformalar, guruhlar, inline ----------
  groupHello: `👋 Hi! Send Instagram, TikTok, YouTube Shorts or Pinterest links in this chat — I'll post the video right here.`,
  groupNeedsAdmin: `ℹ️ Make me an admin so I can see links in this group — no special permissions needed.`,
  inlineOpenBot: `📥 Download in the bot`,
  errPlatformUnavailable: `⚙️ Downloading from this platform isn't available right now. Please try again later.`,
  errVideoTooLong: `⏱ This video is too long — I download videos up to 10 minutes.`,

  mediaNotFound: `🤔 This file has no video or audio. Send a Reel, a video or a voice note.`,
  fileTooBig20: `📦 The file is larger than 20 MB — Telegram bots can't download files that big.

Send a shorter clip or share the Reel via Instagram.`,
  pendingLimit: `⏳ You still have {n} requests in the queue. Send a new one when they're done — check progress with /status.`,
  mediaQueued: `⏳ Got it — recognizing the song...`,
  photoNotSupported: `🖼 That's a photo. I can only recognize music from video or audio.`,
  linkDisabled: `⚙️ Downloading by link isn't enabled yet.

Send me the video directly — I'll name the song right away.`,
  linkQueued: `⏳ Link received — downloading…`,
  unknownCommand: `Unknown command. See /help.`,
  textMenu: `Send me one of these 👇

🔗 <b>Link</b> — Instagram, TikTok, YouTube Shorts or Pinterest
🎬 <b>Video or audio</b> — right here (up to 20 MB)

📸 Or share a Reel to <b>@{account}</b> on Instagram.

Help: /help · Status: /status · Language: /language`,
  unexpectedError: `⚠️ Something went wrong. Please try again in a moment.`,

  // ---------- Natija ----------
  songNotDetected: `🎵 Song not recognized.
<i>Sometimes a Reel has original audio, speech or a very short clip.</i>`,
  versionsHeader: `<b>Versions</b> — tap a number to listen:`,
  btnListen: `🔗 Listen`,
  btnYoutube: `🔍 Search on YouTube`,
  invalidChoice: `Invalid choice`,
  cantSendHere: `Can't send here`,
  sending: `⏳ Sending...`,
  previewNotFound: `😕 No preview available for this version.`,
  previewCaption: `🎧 <b>{title}</b>
👤 {artist}

<i>This is the official 30-second preview. Listen to the full song via the links above.</i>`,
  previewFailed: `😕 Couldn't send the preview. Try listening via the link.`,

  // ---------- Instagram oqimi (Telegram'ga) ----------
  igLinkedTelegram: `✅ <b>Your Instagram account is linked!</b>

👤 Account: {igUser}
🕒 Linked at: {time}

Now share Reels and posts to <b>@{account}</b> on Instagram — I'll send the video and the song name here.`,
  igReelQueued: `⏳ Reel received, processing...`,
  igNotDownloadable: `😕 Instagram didn't provide the video file for this Reel — this is an Instagram limitation.

For now, save the video and send it here — I'll find the song right away.`,
  igPendingLimit: `⏳ You still have {n} requests in the queue. Share the Reel again once they're done.`,

  // ---------- Xatolar ----------
  failTelegramSource: `❌ Something went wrong while processing the file. Please send the video again.`,
  failInstagramSource: `❌ Something went wrong while processing the video. Please share the Reel on Instagram again.`,
  errLinkExpired: `⏳ This video link has expired. Please share the Reel on Instagram again.`,
  errVideoTooBig: `📦 The video is too large ({size}). Videos over {limit} can't be sent via a Telegram bot.`,
  errVideoOverLimit: `📦 The video is larger than {limit} — it can't be sent via Telegram.`,
  errImageNotVideo: `🖼 This isn't a Reel, it's a photo. I can only recognize music from video.`,
  errBadMediaLink: `⏳ The video link didn't work — it may have expired. Please share the Reel again.`,
  errResolverUnavailable: `⚙️ Couldn't reach the download service. Please try again in a moment.`,
  errResolverCantFetch: `😕 Couldn't get the video from this link. Check that the link is correct and the post is public.`,
  errResolverNoVideo: `😕 Nothing to download at this link. Make sure the post exists and the account is public.`,
  errCantGetFile: `❌ Couldn't get this file. Please send it again.`,
  errTooBigForTelegram: `📦 The video exceeds Telegram's 50 MB limit, so it couldn't be sent.`,

  // ---------- Instagram DM (oddiy matn) ----------
  igNotLinked: `❗️ You're not linked to the Telegram bot yet.

Open our bot in Telegram and tap /start — it will give you a code like LINK-XXXXXX. Send that code here, and then you can share Reels.`,
  igLinkSuccess: `🔗 Connected to the bot!

You can now send Reels and posts here — I'll deliver the video and the song name to your Telegram bot.`,
  igFollowFirst: `👋 One step left: follow @{account} first.

Open instagram.com/{account}, tap "Follow", then press "✅ I followed" below — and I'll link your account.`,
  igFollowNotYet: `🙁 I don't see your follow yet.

Follow @{account} (instagram.com/{account}) and press "✅ I followed" again.`,
  igFollowButton: `✅ I followed`,
  igConnectPrompt: `🔗 Last step: connect the Telegram bot.

Tap the button below — Telegram will open, press START there. After that, videos from the Reels you send here will arrive in Telegram.`,
  igConnectButton: `📲 Connect Telegram`,
  subRequired: `📢 To use the bot, please subscribe to the channel(s) below, then tap <b>✅ Check</b>.`,
  subCheckButton: `✅ Check`,
  subNotYet: `You haven't subscribed to all channels yet.`,
  subThanks: `✅ Thank you! You can use the bot now.`,
  igSubRequired: `📢 First subscribe to our channel(s) in the Telegram bot — I've sent the buttons there. Then send the Reel again.`,
  igLinkSuccessTg: `🔗 Connected to the bot! Telegram: {tg}

You can now send Reels and posts here — I'll deliver the video and the song name to Telegram.

Not you? Send UNLINK here.`,
  igUnlinked: `🔓 Your Instagram is disconnected from the Telegram bot. Send any message to connect again.`,
  connectExpired: `⌛ This link has expired or was already used.

Send any message to @{account} on Instagram — I'll send you a new one.`,
  linkMovedAway: `⚠️ Your Instagram account was connected to another Telegram account, so it was disconnected here.

If that wasn't you, send UNLINK to @{account} on Instagram.`,
  unlinkedFromInstagram: `🔓 Instagram disconnected this bot (UNLINK was sent from Instagram). To connect again, send any message to @{account} on Instagram.`,
  igCodeNotFound: `❌ This code wasn't found or has already been used.

Tap /start in the Telegram bot to get a new code.`,
  igAlreadyLinked: `✅ This account is already linked. No code needed — just share Reels.`,
  igSendReels: `👋 Share a Reel with me — I'll send the video and the song name to your Telegram bot.`,
  igUnsupported: `🤔 I can't process this type of message. Please send a Reel or a video.`,
  igUnsupportedImage: `🖼 That's a photo — I recognize music from video. Send a Reel or a video.`,
  igUnsupportedStory: `📖 Thanks for the mention! To find a song, share the Reel via DM.`,
  igUnsupportedAudio: `🎤 Please send a Reel or a video instead of a voice message — I recognize music from video.`,
  igUnsupportedFile: `📎 Instead of a file, share the Reel using Instagram's "Send" button.`,
};

export type Messages = Record<keyof typeof en, string>;
export type MsgKey = keyof Messages;
