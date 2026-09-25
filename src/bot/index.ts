import { Bot, type Context, GrammyError, HttpError, InlineKeyboard, InputFile } from 'grammy';
import { sequentialize } from '@grammyjs/runner';
import type { Message } from 'grammy/types';
import { getTrack } from '../services/deezer.ts';
import { downloadMedia, safeUnlink } from '../services/media.ts';
import { isResolverConfigured } from '../services/ig-resolver.ts';
import {
  LINK_MEDIA_TYPES,
  linkFromStartPayload,
  parseMediaLink,
  type MediaLink,
} from '../services/links.ts';
import {
  PREVIEW_PREFIX,
  YT_AUDIO_DL_PREFIX,
  TOP_DL_PREFIX,
  buildSearchResultsMessage,
  buildTopChartsMessage,
} from './results.ts';
import {
  searchYouTube,
  downloadYouTubeAudio,
  getTopCharts,
  getTrackMetadata,
  getCachedAudioFileId,
  saveAudioFileIdToCache,
  type TrendingTrack,
} from '../services/youtube.ts';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import * as usersRepo from '../db/users.repo.ts';
import * as requestsRepo from '../db/requests.repo.ts';
import type { RequestStatus } from '../db/types.ts';
import { TELEGRAM_MAX_DOWNLOAD_BYTES, TELEGRAM_SOURCE } from '../lib/constants.ts';
import {
  DEFAULT_LANG,
  LANGS,
  LANG_LABELS,
  LANG_LOCALES,
  isLang,
  t,
  type Lang,
  type MsgKey,
  type Vars,
} from '../i18n/index.ts';
import { changeLang, resolveTelegramLang } from '../i18n/user-lang.ts';
import { handleRound } from './round.ts';
import {
  dropStatusCard,
  rememberStatusCard,
  sendStatusCard,
  setStatusCardText,
} from './status-card.ts';
import { deliverMedia, type OutMedia } from './notify.ts';
import { dropMediaCache, peekMediaCache } from '../db/media-cache.repo.ts';
import type { EnqueueInput } from '../db/requests.repo.ts';
import { wakeWorkers } from '../workers/wake.ts';
import { startPreparing } from '../services/prepare.ts';
import {
  ROUND_ACTION,
  SONG_ACTION,
  handleFindSongButton,
  handleRoundButton,
} from './video-actions.ts';
import { handleInlineQuery } from './inline.ts';
import { getBotInfo } from './info.ts';
import {
  IG_PROFILE_URL,
  alreadyLinked,
  escapeHtml,
  helpText,
  linkInstructions,
} from './messages.ts';

/** Har bir update'da foydalanuvchi tili va tarjima funksiyasi tayyor turadi. */
export type BotContext = Context & {
  lang: Lang;
  t: (key: MsgKey, vars?: Vars) => string;
};

export const bot = new Bot<BotContext>(env.TELEGRAM_BOT_TOKEN);

/**
 * Update'lar parallel qayta ishlanadi (@grammyjs/runner, src/index.ts), lekin
 * BITTA chat ichida — tartib bilan: /language dan keyingi xabar yangi tilda
 * chiqsin, bir foydalanuvchining ikki havolasi aralashib ketmasin.
 */
bot.use(sequentialize((ctx: Context) => (ctx.chat?.id ?? ctx.from?.id)?.toString()));

bot.use(async (ctx, next) => {
  ctx.lang = ctx.from
    ? await resolveTelegramLang(ctx.from.id, ctx.from.language_code)
    : DEFAULT_LANG;
  ctx.t = (key, vars) => t(ctx.lang, key, vars);
  await next();
});

/** Instagram akkaunt nomi — HTML'da xavfsiz ko'rinishda. */
const igAccount = (): string => escapeHtml(env.IG_ACCOUNT_USERNAME);

/**
 * Instagram chatiga to'g'ridan-to'g'ri olib boradigan tugma.
 * `success` — yashil: xabardagi asosiy harakat (brendning lime urg'usiga eng yaqin).
 */
const igKeyboard = (ctx: BotContext): InlineKeyboard =>
  new InlineKeyboard()
    .url(ctx.t('btnOpenInstagram', { account: env.IG_ACCOUNT_USERNAME }), IG_PROFILE_URL)
    .success();

// ---------------------------------------------------------------------------
// Buyruqlar
// ---------------------------------------------------------------------------

bot.command('start', async (ctx) => {
  const from = ctx.from;
  if (!from) return;

  // Guruhda /start — faqat qisqa tanishtiruv (bog'lash kodi shaxsiy narsa)
  if (ctx.chat.type !== 'private') {
    await ctx.reply(ctx.t('groupHello'));
    return;
  }

  // Inline rejimdan "📥 Botda yuklab olish": /start dl_<kalit>
  const fromInline = linkFromStartPayload(ctx.match);
  if (fromInline) {
    await handleMediaLink(ctx, fromInline);
    return;
  }

  const user = await usersRepo.getOrCreateByTelegramId({
    telegramId: from.id,
    username: from.username,
    firstName: from.first_name,
    language: ctx.lang,
  });

  if (user.link_status === 'linked') {
    await ctx.reply(alreadyLinked(ctx.lang), { parse_mode: 'HTML' });
    return;
  }

  const code = user.link_code ?? (await usersRepo.ensureLinkCode(user.id)).link_code;
  if (!code) throw new Error('link_code yaratilmadi');

  await ctx.reply(linkInstructions(ctx.lang, code), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: igKeyboard(ctx),
  });
});

const STATUS_KEYS: Record<Exclude<RequestStatus, 'done'>, MsgKey> = {
  queued: 'stQueued',
  processing: 'stProcessing',
  failed: 'stFailed',
};

bot.command('status', async (ctx) => {
  const from = ctx.from;
  if (!from) return;

  const user = await usersRepo.findByTelegramId(from.id);
  if (!user) {
    await ctx.reply(ctx.t('notRegistered'));
    return;
  }

  const lines: string[] = [];
  if (user.link_status === 'linked') {
    lines.push(ctx.t('statusLinked'));
    if (user.linked_at) {
      lines.push(ctx.t('statusLinkedAt', { date: escapeHtml(formatDate(user.linked_at, ctx.lang)) }));
    }
  } else {
    lines.push(ctx.t('statusNotLinked'));
    if (user.link_code) {
      lines.push(ctx.t('statusYourCode', { code: escapeHtml(user.link_code) }));
      lines.push(ctx.t('statusSendCodeTo', { account: igAccount() }));
    }
  }

  const recent = await requestsRepo.recentByUser(user.id, 5);
  if (recent.length > 0) {
    lines.push('', ctx.t('statusRecent'));
    for (const r of recent) {
      const icon =
        r.status === 'done' ? '✅' : r.status === 'failed' ? '❌' : r.status === 'processing' ? '⚙️' : '⏳';
      const song =
        r.song_title && r.song_artist
          ? `${escapeHtml(r.song_title)} — ${escapeHtml(r.song_artist)}`
          : r.status === 'done'
            ? ctx.t('statusNoSong')
            : ctx.t(STATUS_KEYS[r.status]);
      lines.push(`${icon} ${escapeHtml(formatDate(r.created_at, ctx.lang))} · ${song}`);
    }
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
});

bot.command('unlink', async (ctx) => {
  const from = ctx.from;
  if (!from) return;

  const user = await usersRepo.findByTelegramId(from.id);
  if (!user) {
    await ctx.reply(ctx.t('notRegistered'));
    return;
  }
  if (user.link_status !== 'linked') {
    await ctx.reply(ctx.t('unlinkNotLinked'));
    return;
  }

  const updated = await usersRepo.unlinkUser(user.id);
  await ctx.reply(
    ctx.t('unlinkDone', { code: escapeHtml(updated.link_code ?? ''), account: igAccount() }),
    { parse_mode: 'HTML', reply_markup: igKeyboard(ctx) },
  );
});

// Videoga javob qilib yozilsa — o'sha videodan dumaloq video xabar ([round.ts])
bot.command('round', handleRound);

// Yuklab olingan video tagidagi tugmalar va inline ulashish ([video-actions.ts])
bot.callbackQuery(SONG_ACTION, handleFindSongButton);
bot.callbackQuery(ROUND_ACTION, handleRoundButton);
bot.on('inline_query', handleInlineQuery);

bot.command('help', async (ctx) => {
  await ctx.reply(helpText(ctx.lang), { parse_mode: 'HTML' });
});

// ---------------------------------------------------------------------------
// /top — Trenddagi Top 10 qo'shiqlar
// ---------------------------------------------------------------------------

let cachedTopTracks: TrendingTrack[] = [];
let cachedTopAt = 0;

bot.command('top', async (ctx) => {
  await ctx.replyWithChatAction('typing');
  const now = Date.now();
  if (cachedTopTracks.length === 0 || now - cachedTopAt > 10 * 60_000) {
    cachedTopTracks = await getTopCharts(10);
    cachedTopAt = now;
  }

  if (cachedTopTracks.length === 0) {
    await ctx.reply('❌ Hozircha trend qo\'shiqlarni olib bo\'lmadi.');
    return;
  }

  const res = buildTopChartsMessage(cachedTopTracks, ctx.lang);
  await ctx.reply(res.text, {
    parse_mode: 'HTML',
    reply_markup: res.keyboard,
  });
});

// ---------------------------------------------------------------------------
// Til tanlash
// ---------------------------------------------------------------------------

const LANG_PREFIX = 'lang';

function languageKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  LANGS.forEach((lang, i) => {
    kb.text(LANG_LABELS[lang], `${LANG_PREFIX}:${lang}`);
    if (i % 2 === 1) kb.row();
  });
  return kb;
}

bot.command('language', async (ctx) => {
  await ctx.reply(ctx.t('languagePrompt'), { reply_markup: languageKeyboard() });
});

bot.callbackQuery(new RegExp(`^${LANG_PREFIX}:(\\w+)$`), async (ctx) => {
  const lang = ctx.match?.[1];
  if (!isLang(lang)) {
    await ctx.answerCallbackQuery({ text: ctx.t('invalidChoice'), show_alert: true });
    return;
  }

  await changeLang(ctx.from.id, lang);
  ctx.lang = lang;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(ctx.t('languageChanged'));
});

// ---------------------------------------------------------------------------
// Botga to'g'ridan-to'g'ri yuborilgan video/audio — Instagram'siz ishlaydigan yo'l
// ---------------------------------------------------------------------------

interface TelegramMedia {
  fileId: string;
  /** Fayl mazmuniga bog'langan doimiy ID — kesh/dedup kaliti. */
  fileUniqueId: string;
  fileSize: number | undefined;
  kind: string;
}

/** Xabardan qayta ishlanadigan media faylni ajratadi. */
function extractTelegramMedia(message: Message): TelegramMedia | null {
  const pick = (
    file: { file_id: string; file_unique_id: string; file_size?: number } | undefined,
    kind: string,
  ): TelegramMedia | null =>
    file
      ? { fileId: file.file_id, fileUniqueId: file.file_unique_id, fileSize: file.file_size, kind }
      : null;

  if (message.video) return pick(message.video, 'video');
  if (message.animation) return pick(message.animation, 'gif');
  if (message.video_note) return pick(message.video_note, 'video_note');
  if (message.audio) return pick(message.audio, 'audio');
  if (message.voice) return pick(message.voice, 'voice');

  // Fayl sifatida yuborilgan video/audio
  const doc = message.document;
  if (doc?.mime_type && /^(video|audio)\//.test(doc.mime_type)) {
    return pick(doc, 'document');
  }
  return null;
}

bot.on(
  [
    'message:video',
    'message:animation',
    'message:video_note',
    'message:audio',
    'message:voice',
    'message:document',
  ],
  async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    // Guruhda har bir videoning qo'shig'ini aniqlab yurmaymiz — faqat havolalar
    if (ctx.chat.type !== 'private') return;

    const media = extractTelegramMedia(ctx.message);
    if (!media) {
      await ctx.reply(ctx.t('mediaNotFound'));
      return;
    }

    if (media.fileSize !== undefined && media.fileSize > TELEGRAM_MAX_DOWNLOAD_BYTES) {
      await ctx.reply(ctx.t('fileTooBig20'), { reply_markup: igKeyboard(ctx) });
      return;
    }

    const requestId = await queueWithCard(ctx, 'mediaQueued', {
      // Bir xil xabar ikki marta qayta ishlanmasligi uchun (unique constraint)
      igMessageId: `tg:${ctx.chat.id}:${ctx.message.message_id}`,
      // Bazada URL emas, file_id saqlanadi — URL ichida bot tokeni bo'ladi
      mediaUrl: media.fileId,
      mediaType: TELEGRAM_SOURCE,
      fileUniqueId: media.fileUniqueId,
    });
    if (requestId) {
      logger.info({ requestId, telegramId: from.id, kind: media.kind }, 'Telegram\'dan media navbatga qo\'shildi');
    }
  },
);

/**
 * Kartani ko'rsatadi va jobni navbatga qo'yadi — tezlik uchun tartib muhim:
 *
 *   1. "⏳ Qabul qilindi" kartasi — foydalanuvchi uni DARHOL ko'radi
 *      (bazaga murojaatdan oldin; Supabase'gacha bitta so'rov ~0.5 s)
 *   2. user id — xotiradagi keshdan (odatda bazaga bormaydi)
 *   3. limit tekshiruvi + navbat — BITTA so'rov (0005: enqueue_request)
 *   4. worker'ni uyg'otish — 3 soniyalik tekshiruvni kutmaydi
 *
 * @returns job id; limit yoki dublikat bo'lsa null
 */
async function queueWithCard(
  ctx: BotContext,
  key: MsgKey,
  job: Omit<EnqueueInput, 'userId' | 'statusMessageId'>,
): Promise<number | null> {
  const from = ctx.from;
  const chat = ctx.chat;
  if (!from || !chat) return null;

  // Loading xabari va navbatga yozish — PARALLEL (ikkalasi ham tarmoq so'rovi,
  // ketma-ket qilsak foydalanuvchi ~0.3 s ortiqcha kutardi). Xabar ID'si
  // navbatga keyin yoziladi: worker uni ish oxirida o'qiydi.
  // Spam himoyasi (limit) shu yerda: bitta foydalanuvchi navbatni to'ldirib
  // limitlarni (va boshqalarning navbatini) yeb qo'ymasin.
  const enqueue = usersRepo
    .userIdFor({
      telegramId: from.id,
      username: from.username,
      firstName: from.first_name,
      language: ctx.lang,
    })
    .then((userId) => requestsRepo.enqueueWithLimit({ ...job, userId }));

  const [statusResult, enqueueResult] = await Promise.allSettled([openStatusCard(ctx, key), enqueue]);
  const statusId = statusResult.status === 'fulfilled' ? statusResult.value : null;
  if (enqueueResult.status === 'rejected') {
    // Loading "osilib" qolmasin — xato matniga almashtiramiz
    if (statusId) await setStatusCardText(chat.id, statusId, ctx.t('unexpectedError'));
    throw enqueueResult.reason;
  }
  const result = enqueueResult.value;

  if (result.status === 'limit') {
    const text = ctx.t('pendingLimit', { n: result.pending });
    if (statusId) await setStatusCardText(chat.id, statusId, text);
    else await ctx.reply(text);
    return null;
  }
  if (result.status === 'duplicate') {
    await dropStatusCard(chat.id, statusId);
    return null;
  }

  if (statusId) {
    rememberStatusCard(result.row.id, statusId);
    // Bazaga ham (alohida worker jarayoni / qayta ishga tushish uchun) — fonda
    void requestsRepo.setStatusMessageId(result.row.id, statusId).catch((e: unknown) =>
      logger.debug({ err: errMessage(e) }, 'status_message_id saqlanmadi (xotirada bor)'),
    );
  }
  wakeWorkers();
  return result.row.id;
}

/**
 * "⏳ Qabul qilindi" kartasi — natija keyin shu xabarning o'rniga chiqadi.
 * Guruhda ham: karta havola tashlangan xabarga javob bo'lib chiqadi va
 * natija (worker `targetChatOf` orqali) o'sha guruhga boradi.
 */
async function openStatusCard(ctx: BotContext, key: MsgKey): Promise<number | null> {
  if (!ctx.chat || !ctx.message) return null;
  return sendStatusCard(ctx.chat.id, ctx.lang, key, ctx.message.message_id);
}

// Rasm — qayta ishlay olmaymiz (guruhda jim)
bot.on('message:photo', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  await ctx.reply(ctx.t('photoNotSupported'));
});

/**
 * Havola yuborilgan holat — Instagram, TikTok, YouTube Shorts, Pinterest.
 *
 * Fayl havoladan resolver orqali topiladi ([services/resolvers.ts]), keyin
 * video tagida "🎵 · ⭕ · 📤" tugmalari bilan yuboriladi. Shaxsiy chatda ham,
 * guruhda ham bir xil — natija havola tashlangan chatga keladi.
 */
async function handleMediaLink(ctx: BotContext, link: MediaLink): Promise<void> {
  const from = ctx.from;
  const chat = ctx.chat;
  const message = ctx.message;
  if (!from || !chat || !message) return;

  // Instagram resolver ulanmagan bo'lsa navbatni behuda band qilmaymiz
  if (link.platform === 'instagram' && !isResolverConfigured()) {
    if (chat.type === 'private') await ctx.reply(ctx.t('linkDisabled'));
    return;
  }

  // Eng tez yo'l: bu post yaqinda yuborilgan — xotiradagi keshdan, navbat va
  // kartasiz, bazaga ham bormasdan bir zumda. Ishlamasa odatdagi yo'l.
  const cached = peekMediaCache(link.key);
  if (cached) {
    try {
      const items: OutMedia[] = cached.map((c) => ({ kind: c.kind, source: { fileId: c.fileId } }));
      await deliverMedia(chat.id, items, ctx.lang, null, {
        replyTo: message.message_id,
        music: cached[0]?.music,
      });
      logger.info({ telegramId: from.id, key: link.key }, 'Post xotiradagi keshdan yuborildi');
      return;
    } catch (e) {
      logger.warn({ key: link.key, err: errMessage(e) }, 'Keshdagi file_id ishlamadi');
      await dropMediaCache(link.key);
    }
  }

  // Kesh va resolver fonda HOZIROQ boshlanadi — navbatga yozish va worker
  // band qilishi (bazaga ~1 s) bilan parallel; worker natijani tayyor oladi
  startPreparing(link.key, link.platform, link.url);

  const requestId = await queueWithCard(ctx, 'linkQueued', {
    igMessageId: `tg:${chat.id}:${message.message_id}`,
    mediaUrl: link.url,
    mediaType: LINK_MEDIA_TYPES[link.platform],
    // Doimiy kalit (ig:/tt:/yt:/pin:) — media keshi va musiqa keshi shu bo'yicha
    fileUniqueId: link.key,
  });
  if (requestId) {
    logger.info(
      { requestId, telegramId: from.id, platform: link.platform, key: link.key, group: chat.type !== 'private' },
      'Havola navbatga qo\'shildi',
    );
  }
}

// Boshqa har qanday matn
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();
  const isPrivate = ctx.chat.type === 'private';

  // Matn ichida qo'llab-quvvatlanadigan havola bo'lsa — asosiy oqim
  const link = parseMediaLink(text);
  if (link) {
    await handleMediaLink(ctx, link);
    return;
  }

  // Guruhda faqat havolalarga javob beramiz — suhbatga aralashmaymiz
  if (!isPrivate) return;

  if (text.startsWith('/')) {
    await ctx.reply(ctx.t('unknownCommand'));
    return;
  }

  // Qo'shiq nomi qidiruvi (@SongFastBot kabi)
  if (text.length >= 2) {
    await ctx.replyWithChatAction('typing');
    const tracks = await searchYouTube(text, 5);
    if (tracks.length > 0) {
      const res = buildSearchResultsMessage(text, tracks, ctx.lang);
      await ctx.reply(res.text, {
        parse_mode: 'HTML',
        reply_markup: res.keyboard,
      });
      return;
    }
  }

  await ctx.reply(ctx.t('textMenu', { account: igAccount() }), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: igKeyboard(ctx),
  });
});

/**
 * Bot guruhga qo'shilganda — bitta qisqa tanishtiruv. Privacy mode yoqiq
 * bo'lsa (bot faqat buyruqlarni ko'radi), havolalarni ko'rishi uchun admin
 * qilish kerakligini ham aytamiz.
 */
bot.on('my_chat_member', async (ctx) => {
  const { chat, old_chat_member: before, new_chat_member: after } = ctx.myChatMember;
  if (chat.type !== 'group' && chat.type !== 'supergroup') return;

  const wasOut = before.status === 'left' || before.status === 'kicked';
  const isIn = after.status === 'member' || after.status === 'administrator';
  if (!wasOut || !isIn) return;

  const lines = [ctx.t('groupHello')];
  if (after.status !== 'administrator' && !getBotInfo().readsGroupMessages) {
    lines.push('', ctx.t('groupNeedsAdmin'));
  }
  await ctx.api.sendMessage(chat.id, lines.join('\n')).catch((e: unknown) =>
    logger.debug({ chatId: chat.id, err: errMessage(e) }, 'Guruhga salom yuborilmadi'),
  );
  logger.info({ chatId: chat.id, title: chat.title }, 'Bot guruhga qo\'shildi');
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// To'liq musiqani yuklab Telegram'ga yuborish funksiyasi
// ---------------------------------------------------------------------------

async function sendDownloadedAudio(
  chatId: number,
  videoId: string,
  ctx: BotContext,
): Promise<void> {
  // 1) Keshdan tekshiramiz — bir zumda yuborish
  const cachedFileId = await getCachedAudioFileId(videoId);
  if (cachedFileId) {
    try {
      await ctx.api.sendAudio(chatId, cachedFileId, {
        caption: `🎵 @${getBotInfo().username ?? 'bot'} orqali yuklab olindi`,
      });
      return;
    } catch (e) {
      logger.warn({ videoId, err: errMessage(e) }, 'Keshdagi audio file_id ishlamadi');
    }
  }

  // 2) Keshda yo'q — yt-dlp orqali yuklab olamiz
  const meta = getTrackMetadata(videoId);
  const title = meta?.title ?? 'Musiqa';
  const artist = meta?.artist ?? 'YouTube';
  const duration = meta?.durationSec ?? 0;

  let cleanup: (() => Promise<void>) | null = null;
  try {
    await ctx.replyWithChatAction('upload_voice');
    const dl = await downloadYouTubeAudio(videoId);
    cleanup = dl.cleanup;

    const sent = await ctx.api.sendAudio(chatId, new InputFile(dl.filePath), {
      title,
      performer: artist,
      duration: duration > 0 ? duration : undefined,
      caption: `🎵 <b>${escapeHtml(title)}</b>\n👤 ${escapeHtml(artist)}\n\n@${getBotInfo().username ?? 'bot'} orqali yuklab olindi`,
      parse_mode: 'HTML',
    });

    if (sent.audio?.file_id) {
      await saveAudioFileIdToCache(videoId, sent.audio.file_id);
    }
  } catch (e) {
    logger.error({ videoId, err: errMessage(e) }, 'Audio yuklab yuborishda xatolik');
    await ctx.reply('❌ Musiqani yuklab olishda xatolik yuz berdi. Qaytadan urinib ko\'ring.');
  } finally {
    if (cleanup) await cleanup();
  }
}

// ---------------------------------------------------------------------------
// Inline tugmalar: 1..5 musiqani yuklab olish
// ---------------------------------------------------------------------------

bot.callbackQuery(new RegExp(`^${YT_AUDIO_DL_PREFIX}:([a-zA-Z0-9_-]{11})$`), async (ctx) => {
  const videoId = ctx.match?.[1];
  if (!videoId) return;

  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.answerCallbackQuery({ text: ctx.t('cantSendHere'), show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery({ text: '⏳ Musiqa yuklanmoqda...' });
  await sendDownloadedAudio(chatId, videoId, ctx);
});

// /top trendlar ro'yxatidan tanlanganda:
bot.callbackQuery(new RegExp(`^${TOP_DL_PREFIX}:(\\d+)$`), async (ctx) => {
  const idx = Number(ctx.match?.[1]);
  const track = cachedTopTracks[idx];
  if (!track) {
    await ctx.answerCallbackQuery({ text: ctx.t('invalidChoice'), show_alert: true });
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  await ctx.answerCallbackQuery({ text: `⏳ "${track.title}" yuklanmoqda...` });

  const query = `${track.artist} ${track.title}`;
  const ytTracks = await searchYouTube(query, 1);
  const best = ytTracks[0];
  if (!best) {
    await ctx.reply('❌ Kechirasiz, bu qo\'shiqning audio fayli topilmadi.');
    return;
  }

  await sendDownloadedAudio(chatId, best.id, ctx);
});

// ---------------------------------------------------------------------------
// Xatoliklarni markazlashgan boshqarish
// ---------------------------------------------------------------------------

bot.catch(async (err) => {
  const ctx = err.ctx;
  const e = err.error;

  if (e instanceof GrammyError) {
    logger.error({ description: e.description, method: e.method }, 'Telegram API xatosi');
  } else if (e instanceof HttpError) {
    logger.error({ err: errMessage(e) }, 'Telegram bilan aloqada xato');
  } else {
    logger.error({ err: errMessage(e), stack: (e as Error)?.stack }, 'Bot handler xatosi');
  }

  try {
    await ctx.reply(t(ctx.lang ?? DEFAULT_LANG, 'unexpectedError'));
  } catch {
    // javob ham ketmasa — faqat logda qoladi
  }
});

/** Buyruqlar menyusi — har bir til uchun (Telegram ilova tiliga qarab ko'rsatadi). */
export async function setupBotCommands(): Promise<void> {
  const commandsFor = (lang: Lang) => [
    { command: 'start', description: t(lang, 'cmdStart') },
    { command: 'top', description: t(lang, 'cmdTop') },
    { command: 'round', description: t(lang, 'cmdRound') },
    { command: 'status', description: t(lang, 'cmdStatus') },
    { command: 'language', description: t(lang, 'cmdLanguage') },
    { command: 'unlink', description: t(lang, 'cmdUnlink') },
    { command: 'help', description: t(lang, 'cmdHelp') },
  ];

  /**
   * Faqat o'zgargan menyu yoziladi. Har ishga tushishda 7 marta setMyCommands
   * chaqirish (6 til + standart) Telegram'ning flood limitiga tushadi —
   * ayniqsa `--watch` rejimida server tez-tez qayta ishga tushganda.
   */
  const sync = async (lang: Lang, code?: Lang): Promise<void> => {
    const wanted = commandsFor(lang);
    const other = code ? { language_code: code } : {};
    const current = await bot.api.getMyCommands(other);
    if (JSON.stringify(current) === JSON.stringify(wanted)) return;
    await bot.api.setMyCommands(wanted, other);
  };

  // Til kodisiz — standart (til ro'yxatimizda yo'q foydalanuvchilar uchun)
  await sync(DEFAULT_LANG);
  for (const lang of LANGS) await sync(lang, lang);
}

function formatDate(iso: string, lang: Lang): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(LANG_LOCALES[lang], { dateStyle: 'short', timeStyle: 'short' });
}
