import { Bot, type Context, GrammyError, HttpError, InlineKeyboard, InputFile } from 'grammy';
import type { Message } from 'grammy/types';
import { getTrack } from '../services/deezer.ts';
import { downloadMedia, safeUnlink } from '../services/media.ts';
import {
  isResolverConfigured,
  parseInstagramLink,
  type ParsedLink,
} from '../services/ig-resolver.ts';
import { PREVIEW_PREFIX } from './results.ts';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import * as usersRepo from '../db/users.repo.ts';
import * as requestsRepo from '../db/requests.repo.ts';
import type { RequestStatus } from '../db/types.ts';
import { IG_LINK_SOURCE, TELEGRAM_MAX_DOWNLOAD_BYTES, TELEGRAM_SOURCE } from '../lib/constants.ts';
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
import { dropStatusCard, rememberStatusCard, sendStatusCard } from './status-card.ts';
import {
  ROUND_ACTION,
  SONG_ACTION,
  handleFindSongButton,
  handleRoundButton,
  handleShareInlineQuery,
} from './video-actions.ts';
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

  const user = await usersRepo.getOrCreateByTelegramId({
    telegramId: from.id,
    username: from.username,
    firstName: from.first_name,
    language: ctx.lang,
  });

  if (user.link_status === 'linked') {
    await ctx.reply(alreadyLinked(ctx.lang, user.ig_scoped_id), { parse_mode: 'HTML' });
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
bot.on('inline_query', handleShareInlineQuery);

bot.command('help', async (ctx) => {
  await ctx.reply(helpText(ctx.lang), { parse_mode: 'HTML' });
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

    const media = extractTelegramMedia(ctx.message);
    if (!media) {
      await ctx.reply(ctx.t('mediaNotFound'));
      return;
    }

    if (media.fileSize !== undefined && media.fileSize > TELEGRAM_MAX_DOWNLOAD_BYTES) {
      await ctx.reply(ctx.t('fileTooBig20'), { reply_markup: igKeyboard(ctx) });
      return;
    }

    const user = await usersRepo.getOrCreateByTelegramId({
      telegramId: from.id,
      username: from.username,
      firstName: from.first_name,
      language: ctx.lang,
    });

    // Spam himoyasi: bitta foydalanuvchi navbatni to'ldirib, AudD limitini
    // (va boshqalarning navbatini) yeb qo'ymasligi uchun.
    const pending = await requestsRepo.pendingCountForUser(user.id);
    if (pending >= env.MAX_PENDING_PER_USER) {
      await ctx.reply(ctx.t('pendingLimit', { n: pending }));
      return;
    }

    const statusId = await openStatusCard(ctx, 'mediaQueued');
    const row = await requestsRepo.enqueue({
      userId: user.id,
      // Bir xil xabar ikki marta qayta ishlanmasligi uchun (unique constraint)
      igMessageId: `tg:${ctx.chat.id}:${ctx.message.message_id}`,
      // Bazada URL emas, file_id saqlanadi — URL ichida bot tokeni bo'ladi
      mediaUrl: media.fileId,
      mediaType: TELEGRAM_SOURCE,
      fileUniqueId: media.fileUniqueId,
      statusMessageId: statusId,
    });

    if (!row) {
      await dropStatusCard(ctx.chat.id, statusId); // dublikat
      return;
    }
    if (statusId) rememberStatusCard(row.id, statusId);

    logger.info(
      { requestId: row.id, telegramId: from.id, kind: media.kind },
      'Telegram\'dan media navbatga qo\'shildi',
    );
  },
);

/**
 * "⏳ Qabul qilindi" kartasi — natija keyin shu xabarning o'rniga chiqadi.
 * Faqat shaxsiy chatda: natijalar foydalanuvchining shaxsiy chatiga boradi,
 * guruhda karta boshqa chatda qolib ketardi — u yerda oddiy matn.
 */
async function openStatusCard(ctx: BotContext, key: MsgKey): Promise<number | null> {
  if (!ctx.chat || !ctx.message) return null;
  if (ctx.chat.type !== 'private') {
    await ctx.reply(ctx.t(key));
    return null;
  }
  return sendStatusCard(ctx.chat.id, ctx.lang, key, ctx.message.message_id);
}

// Rasm — qayta ishlay olmaymiz
bot.on('message:photo', async (ctx) => {
  await ctx.reply(ctx.t('photoNotSupported'));
});

/**
 * Instagram HAVOLASI yuborilgan holat.
 *
 * Meta rasmiy API orqali begona reels'ning faylini bermaydi, shuning uchun
 * havoladan videoni tashqi resolver topadi ([services/ig-resolver.ts]).
 * Undan keyin oqim media bilan bir xil: yuklash → audio parcha → AudD → Deezer.
 */
async function handleInstagramLink(ctx: BotContext, link: ParsedLink): Promise<void> {
  const from = ctx.from;
  const chat = ctx.chat;
  const message = ctx.message;
  if (!from || !chat || !message) return;

  // Resolver ulanmagan bo'lsa navbatni behuda band qilmaymiz — darhol aytamiz
  if (!isResolverConfigured()) {
    await ctx.reply(ctx.t('linkDisabled'));
    return;
  }

  const user = await usersRepo.getOrCreateByTelegramId({
    telegramId: from.id,
    username: from.username,
    firstName: from.first_name,
    language: ctx.lang,
  });

  const pending = await requestsRepo.pendingCountForUser(user.id);
  if (pending >= env.MAX_PENDING_PER_USER) {
    await ctx.reply(ctx.t('pendingLimit', { n: pending }));
    return;
  }

  const statusId = await openStatusCard(ctx, 'linkQueued');
  const row = await requestsRepo.enqueue({
    userId: user.id,
    igMessageId: `tg:${chat.id}:${message.message_id}`,
    mediaUrl: link.url,
    mediaType: IG_LINK_SOURCE,
    // Shortcode doimiy — ayni havola qayta yuborilsa natija keshdan olinadi
    // va resolver ham, AudD ham bezovta qilinmaydi.
    fileUniqueId: `ig:${link.shortcode}`,
    statusMessageId: statusId,
  });

  if (!row) {
    await dropStatusCard(chat.id, statusId); // dublikat
    return;
  }
  if (statusId) rememberStatusCard(row.id, statusId);

  logger.info(
    { requestId: row.id, telegramId: from.id, shortcode: link.shortcode, kind: link.kind },
    'Instagram havolasi navbatga qo\'shildi',
  );
}

// Boshqa har qanday matn
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text;

  if (text.startsWith('/')) {
    await ctx.reply(ctx.t('unknownCommand'));
    return;
  }

  // Matn ichida Instagram havolasi bo'lsa — asosiy oqim
  const link = parseInstagramLink(text);
  if (link) {
    await handleInstagramLink(ctx, link);
    return;
  }

  await ctx.reply(ctx.t('textMenu', { account: igAccount() }), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: igKeyboard(ctx),
  });
});

// ---------------------------------------------------------------------------
// Inline tugma: tanlangan versiyaning 30 soniyalik RASMIY preview'i
//
// Bu — platformalar tinglatish uchun ochiq beradigan qisqa parcha.
// To'liq tijoriy trek yuklanmaydi va tarqatilmaydi; to'liq qo'shiq uchun
// xabardagi Spotify / Apple Music / Deezer havolalari bor.
// ---------------------------------------------------------------------------

bot.callbackQuery(new RegExp(`^${PREVIEW_PREFIX}:(\\d+)$`), async (ctx) => {
  const id = Number(ctx.match?.[1]);
  if (!Number.isFinite(id)) {
    await ctx.answerCallbackQuery({ text: ctx.t('invalidChoice'), show_alert: true });
    return;
  }

  // Inline rejimdagi xabarda chat bo'lmaydi — u holda yuborishga joy yo'q
  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    await ctx.answerCallbackQuery({ text: ctx.t('cantSendHere'), show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery({ text: ctx.t('sending') });

  const track = await getTrack(id);
  if (!track?.previewUrl) {
    await ctx.reply(ctx.t('previewNotFound'));
    return;
  }

  const options = {
    caption: ctx.t('previewCaption', {
      title: escapeHtml(track.title),
      artist: escapeHtml(track.artist),
    }),
    parse_mode: 'HTML' as const,
    title: track.title,
    performer: track.artist,
    duration: 30,
  };

  try {
    // Telegram preview'ni URL orqali o'zi olib beradi — bizga yuklash shart emas
    await ctx.api.sendAudio(chatId, track.previewUrl, options);
  } catch (e) {
    // CDN Telegram'ga ruxsat bermasa — o'zimiz yuklab yuboramiz
    logger.debug({ err: errMessage(e) }, 'URL orqali audio ketmadi, yuklab ko\'ramiz');
    let tmp: string | null = null;
    try {
      const file = await downloadMedia(track.previewUrl, id, { allowAudio: true });
      tmp = file.filePath;
      await ctx.api.sendAudio(chatId, new InputFile(tmp), options);
    } catch (e2) {
      logger.warn({ err: errMessage(e2) }, 'Preview yuborilmadi');
      await ctx.reply(ctx.t('previewFailed'));
    } finally {
      await safeUnlink(tmp);
    }
  }
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
