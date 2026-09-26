import { Composer, InlineKeyboard, type Api } from 'grammy';
import type { BotContext } from './index.ts';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import {
  adminDbReady,
  isAdmin,
  isBanned,
  listChannels,
  setBlocked,
  touchActive,
  type ChannelRow,
} from '../db/admin.repo.ts';
import { alertAdminLater } from '../services/alerts.ts';
import { t, type Lang } from '../i18n/index.ts';

/**
 * Foydalanuvchiga kirish qoidalari (shaxsiy chatda, har bir update'da):
 *   - admin ban qilgan — bot javob bermaydi
 *   - oxirgi faollik (statistika uchun)
 *   - majburiy a'zolik: /qimmat → 📢 Majburiy kanallar
 * Adminlar tekshiruvdan o'tmaydi. 0009 qo'llanmagan bo'lsa — hech narsa qilmaydi.
 */
export const SUB_CHECK = 'sub:check';

/** Faqat "a'zo" natijasi keshlanadi — obuna bo'lib "Tekshirish" bosilganda darhol o'tsin. */
const memberUntil = new Map<string, number>();
const MEMBER_TTL_MS = 10 * 60_000;

/** Foydalanuvchi obuna bo'lmagan majburiy kanallar (bo'sh — hammasiga obuna). */
export async function missingChannels(api: Api, userId: number): Promise<ChannelRow[]> {
  const channels = await listChannels().catch((e: unknown) => {
    logger.warn({ err: errMessage(e) }, 'Majburiy kanallarni o\'qib bo\'lmadi');
    return [] as ChannelRow[];
  });
  const missing: ChannelRow[] = [];
  for (const ch of channels) {
    const key = `${ch.chat_id}:${userId}`;
    if ((memberUntil.get(key) ?? 0) > Date.now()) continue;
    try {
      const m = await api.getChatMember(ch.chat_id, userId);
      const isMember =
        m.status === 'creator' ||
        m.status === 'administrator' ||
        m.status === 'member' ||
        (m.status === 'restricted' && m.is_member);
      if (isMember) memberUntil.set(key, Date.now() + MEMBER_TTL_MS);
      else missing.push(ch);
    } catch (e) {
      // Bot kanalda admin emas yoki kanal o'chirilgan — foydalanuvchini bu sababli to'smaymiz
      alertAdminLater(`sub-check:${ch.chat_id}`, '🟡 Majburiy kanalni tekshirib bo\'lmadi', [
        ch.title,
        errMessage(e).slice(0, 200),
        'Bot o\'sha kanalda admin ekanini tekshiring (yoki /qimmat → 📢 Majburiy kanallar dan o\'chiring).',
      ]);
    }
  }
  if (memberUntil.size > 50_000) memberUntil.clear();
  return missing;
}

export function subscribeKeyboard(channels: ChannelRow[], lang: Lang): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const ch of channels) {
    const url = ch.invite_link ?? (ch.username ? `https://t.me/${ch.username}` : null);
    if (url) kb.url(`📢 ${ch.title}`, url).row();
  }
  return kb.text(t(lang, 'subCheckButton'), SUB_CHECK);
}

/** Instagram orqali kelgan so'rovda — obuna tugmalarini Telegram'ga yuborish. */
export async function sendSubscribePrompt(
  api: Api,
  chatId: number,
  lang: Lang,
  missing: ChannelRow[],
): Promise<void> {
  await api
    .sendMessage(chatId, t(lang, 'subRequired'), {
      parse_mode: 'HTML',
      reply_markup: subscribeKeyboard(missing, lang),
    })
    .catch((e: unknown) => logger.debug({ err: errMessage(e), chatId }, 'Obuna so\'rovi yuborilmadi'));
}

export const accessComposer = new Composer<BotContext>();

// Shaxsiy chatda botni bloklash / qayta ochish — tarqatishda hisobga olinadi
accessComposer.on('my_chat_member', async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  const status = ctx.myChatMember.new_chat_member.status;
  await setBlocked(ctx.myChatMember.from.id, status === 'kicked');
});

accessComposer.use(async (ctx, next) => {
  const from = ctx.from;
  if (!from || ctx.chat?.type !== 'private' || !adminDbReady()) return next();
  if (await isAdmin(from.id)) return next();
  if (await isBanned(from.id)) return; // ban qilingan — jimgina e'tiborsiz

  touchActive(from.id);

  // Bir bosishda bog'lash kaliti 30 daqiqa amal qiladi — obunadan oldin ham o'tsin;
  // Instagram'dan kelgan reels'lar baribir obunadan keyin yetkaziladi
  if (ctx.message?.text?.startsWith('/start ig_')) return next();
  if (ctx.callbackQuery?.data === SUB_CHECK) return next();

  const missing = await missingChannels(ctx.api, from.id);
  if (missing.length === 0) return next();

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: ctx.t('subNotYet'), show_alert: true }).catch(() => undefined);
  }
  await ctx.reply(ctx.t('subRequired'), {
    parse_mode: 'HTML',
    reply_markup: subscribeKeyboard(missing, ctx.lang),
  });
});

accessComposer.callbackQuery(SUB_CHECK, async (ctx) => {
  const missing = await missingChannels(ctx.api, ctx.from.id);
  if (missing.length > 0) {
    await ctx.answerCallbackQuery({ text: ctx.t('subNotYet'), show_alert: true });
    await ctx.editMessageReplyMarkup({ reply_markup: subscribeKeyboard(missing, ctx.lang) }).catch(() => undefined);
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(ctx.t('subThanks')).catch(() => ctx.reply(ctx.t('subThanks')));
});
