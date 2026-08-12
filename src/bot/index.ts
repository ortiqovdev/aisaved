import { Bot, GrammyError, HttpError } from 'grammy';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import * as usersRepo from '../db/users.repo.ts';
import * as requestsRepo from '../db/requests.repo.ts';
import {
  HELP_TEXT,
  alreadyLinked,
  escapeHtml,
  linkInstructions,
} from './messages.ts';

export const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

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
    { parse_mode: 'HTML' },
  );
});

bot.command('help', async (ctx) => {
  await ctx.reply(HELP_TEXT, { parse_mode: 'HTML' });
});

// Boshqa har qanday matn
bot.on('message:text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) {
    await ctx.reply('Bunday buyruq yo\'q. /help ni ko\'ring.');
    return;
  }
  await ctx.reply(
    'Reels\'ni menga emas, Instagram\'da @' +
      env.IG_ACCOUNT_USERNAME +
      ' akkauntiga yuboring 🙂\n\nHolatni ko\'rish: /status',
  );
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
