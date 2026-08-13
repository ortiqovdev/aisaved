import { Bot, GrammyError, HttpError, InlineKeyboard, InputFile } from 'grammy';
import type { Message } from 'grammy/types';
import { getTrack } from '../services/deezer.ts';
import { downloadMedia, safeUnlink } from '../services/media.ts';
import { PREVIEW_PREFIX } from './results.ts';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import * as usersRepo from '../db/users.repo.ts';
import * as requestsRepo from '../db/requests.repo.ts';
import { TELEGRAM_MAX_DOWNLOAD_BYTES, TELEGRAM_SOURCE } from '../lib/constants.ts';
import {
  HELP_TEXT,
  IG_PROFILE_URL,
  alreadyLinked,
  escapeHtml,
  linkInstructions,
} from './messages.ts';

export const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

/** Instagram chatiga to'g'ridan-to'g'ri olib boradigan tugma. */
const igKeyboard = (): InlineKeyboard =>
  new InlineKeyboard().url(`📸 @${env.IG_ACCOUNT_USERNAME} ni ochish`, IG_PROFILE_URL);

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
  });

  if (user.link_status === 'linked') {
    await ctx.reply(alreadyLinked(user.ig_scoped_id), { parse_mode: 'HTML' });
    return;
  }

  const code = user.link_code ?? (await usersRepo.ensureLinkCode(user.id)).link_code;
  if (!code) throw new Error('link_code yaratilmadi');

  await ctx.reply(linkInstructions(code), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: igKeyboard(),
  });
});

bot.command('status', async (ctx) => {
  const from = ctx.from;
  if (!from) return;

  const user = await usersRepo.findByTelegramId(from.id);
  if (!user) {
    await ctx.reply('Siz hali ro\'yxatdan o\'tmagansiz. /start bosing.');
    return;
  }

  const lines: string[] = [];
  if (user.link_status === 'linked') {
    lines.push('🔗 Holat: <b>bog\'langan</b> ✅');
    if (user.linked_at) {
      lines.push(`📅 Bog\'langan sana: ${escapeHtml(formatDate(user.linked_at))}`);
    }
  } else {
    lines.push('🔗 Holat: <b>bog\'lanmagan</b> ⏳');
    if (user.link_code) {
      lines.push(`🔑 Kodingiz: <code>${escapeHtml(user.link_code)}</code>`);
      lines.push(`Uni Instagram'da @${escapeHtml(env.IG_ACCOUNT_USERNAME)} ga DM qiling.`);
    }
  }

  const recent = await requestsRepo.recentByUser(user.id, 5);
  if (recent.length > 0) {
    lines.push('', '<b>Oxirgi so\'rovlar:</b>');
    for (const r of recent) {
      const icon =
        r.status === 'done' ? '✅' : r.status === 'failed' ? '❌' : r.status === 'processing' ? '⚙️' : '⏳';
      const song =
        r.song_title && r.song_artist
          ? `${escapeHtml(r.song_title)} — ${escapeHtml(r.song_artist)}`
          : r.status === 'done'
            ? 'musiqa aniqlanmadi'
            : r.status;
      lines.push(`${icon} ${escapeHtml(formatDate(r.created_at))} · ${song}`);
    }
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
});

bot.command('unlink', async (ctx) => {
  const from = ctx.from;
  if (!from) return;

  const user = await usersRepo.findByTelegramId(from.id);
  if (!user) {
    await ctx.reply('Siz hali ro\'yxatdan o\'tmagansiz. /start bosing.');
    return;
  }
  if (user.link_status !== 'linked') {
    await ctx.reply('Siz hozir hech qanday Instagram akkauntga bog\'lanmagansiz. /start bosing.');
    return;
  }

  const updated = await usersRepo.unlinkUser(user.id);
  await ctx.reply(
    [
      '🔓 Bog\'lanish bekor qilindi.',
      '',
      'Qayta bog\'lash uchun yangi kod:',
      `<code>${escapeHtml(updated.link_code ?? '')}</code>`,
      '',
      `Uni Instagram'da @${escapeHtml(env.IG_ACCOUNT_USERNAME)} ga DM qiling.`,
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: igKeyboard() },
  );
});

bot.command('help', async (ctx) => {
  await ctx.reply(HELP_TEXT, { parse_mode: 'HTML' });
});

// ---------------------------------------------------------------------------
// Botga to'g'ridan-to'g'ri yuborilgan video/audio — Instagram'siz ishlaydigan yo'l
// ---------------------------------------------------------------------------

interface TelegramMedia {
  fileId: string;
  fileSize: number | undefined;
  kind: string;
}

/** Xabardan qayta ishlanadigan media faylni ajratadi. */
function extractTelegramMedia(message: Message): TelegramMedia | null {
  const pick = (
    file: { file_id: string; file_size?: number } | undefined,
    kind: string,
  ): TelegramMedia | null => (file ? { fileId: file.file_id, fileSize: file.file_size, kind } : null);

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
      await ctx.reply(
        '🤔 Bu faylda video yoki audio yo\'q. Reels, video yoki ovozli xabar yuboring.',
      );
      return;
    }

    if (media.fileSize !== undefined && media.fileSize > TELEGRAM_MAX_DOWNLOAD_BYTES) {
      await ctx.reply(
        '📦 Fayl 20MB dan katta — Telegram botlari bunday faylni yuklab ola olmaydi.\n\n' +
          'Qisqaroq parcha yuboring yoki reels\'ni Instagram orqali tashlang.',
        { reply_markup: igKeyboard() },
      );
      return;
    }

    const user = await usersRepo.getOrCreateByTelegramId({
      telegramId: from.id,
      username: from.username,
      firstName: from.first_name,
    });

    const row = await requestsRepo.enqueue({
      userId: user.id,
      // Bir xil xabar ikki marta qayta ishlanmasligi uchun (unique constraint)
      igMessageId: `tg:${ctx.chat.id}:${ctx.message.message_id}`,
      // Bazada URL emas, file_id saqlanadi — URL ichida bot tokeni bo'ladi
      mediaUrl: media.fileId,
      mediaType: TELEGRAM_SOURCE,
    });

    if (!row) return; // dublikat

    logger.info(
      { requestId: row.id, telegramId: from.id, kind: media.kind },
      'Telegram\'dan media navbatga qo\'shildi',
    );
    await ctx.reply('⏳ Qabul qilindi — musiqasini aniqlayapman...');
  },
);

// Rasm — qayta ishlay olmaymiz
bot.on('message:photo', async (ctx) => {
  await ctx.reply('🖼 Bu rasm. Musiqani faqat video yoki audiodan aniqlay olaman.');
});

// Boshqa har qanday matn
bot.on('message:text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) {
    await ctx.reply('Bunday buyruq yo\'q. /help ni ko\'ring.');
    return;
  }
  await ctx.reply(
    `Reels'ni menga emas, Instagram'da <b>@${escapeHtml(env.IG_ACCOUNT_USERNAME)}</b> akkauntiga ` +
      'yuboring 🙂\n\nHolatni ko\'rish: /status',
    { parse_mode: 'HTML', reply_markup: igKeyboard() },
  );
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
    await ctx.answerCallbackQuery({ text: 'Noto\'g\'ri tanlov', show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery({ text: '⏳ Yuborilmoqda...' });

  const track = await getTrack(id);
  if (!track?.previewUrl) {
    await ctx.reply('😕 Bu versiya uchun tinglash parchasi topilmadi.');
    return;
  }

  const caption =
    `🎧 <b>${escapeHtml(track.title)}</b>\n👤 ${escapeHtml(track.artist)}\n\n` +
    '<i>Bu — 30 soniyalik rasmiy parcha. To\'liq qo\'shiqni yuqoridagi havolalar orqali tinglang.</i>';

  const options = {
    caption,
    parse_mode: 'HTML' as const,
    title: track.title,
    performer: track.artist,
    duration: 30,
  };

  try {
    // Telegram preview'ni URL orqali o'zi olib beradi — bizga yuklash shart emas
    await ctx.api.sendAudio(ctx.chat!.id, track.previewUrl, options);
  } catch (e) {
    // CDN Telegram'ga ruxsat bermasa — o'zimiz yuklab yuboramiz
    logger.debug({ err: errMessage(e) }, 'URL orqali audio ketmadi, yuklab ko\'ramiz');
    let tmp: string | null = null;
    try {
      const file = await downloadMedia(track.previewUrl, id, { allowAudio: true });
      tmp = file.filePath;
      await ctx.api.sendAudio(ctx.chat!.id, new InputFile(tmp), options);
    } catch (e2) {
      logger.warn({ err: errMessage(e2) }, 'Preview yuborilmadi');
      await ctx.reply('😕 Parchani yuborib bo\'lmadi. Havola orqali tinglab ko\'ring.');
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
    await ctx.reply('⚠️ Kutilmagan xatolik yuz berdi. Birozdan so\'ng qayta urinib ko\'ring.');
  } catch {
    // javob ham ketmasa — faqat logda qoladi
  }
});

export async function setupBotCommands(): Promise<void> {
  await bot.api.setMyCommands([
    { command: 'start', description: 'Bog\'lanishni boshlash / kodni olish' },
    { command: 'status', description: 'Holat va oxirgi so\'rovlar' },
    { command: 'unlink', description: 'Bog\'lanishni bekor qilish' },
    { command: 'help', description: 'Yordam' },
  ]);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('uz-UZ', { dateStyle: 'short', timeStyle: 'short' });
}
