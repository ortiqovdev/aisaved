import { Composer, GrammyError, InlineKeyboard, type Api } from 'grammy';
import type { Message } from 'grammy/types';
import type { BotContext } from './index.ts';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { errMessage, sleep } from '../lib/errors.ts';
import {
  addChannel,
  adminDbReady,
  adminStats,
  allRecipientIds,
  countRecipients,
  countUserRequests,
  findUser,
  isAdmin,
  isOwner,
  listAdmins,
  listChannels,
  removeAdmin,
  removeChannel,
  setBanned,
  setBlocked,
  upsertAdmin,
} from '../db/admin.repo.ts';
import * as requestsRepo from '../db/requests.repo.ts';
import { getKv } from '../db/kv.repo.ts';
import { escapeHtml, formatDate } from './messages.ts';
import { getInstagramProfile } from '../services/instagram.ts';
import { hasInstagramCookies } from '../services/ig-cookies.ts';
import { workerStatus } from '../workers/index.ts';

/**
 * Admin panel — /qimmat (faqat adminlar; boshqalarga bot hech narsa demaydi).
 *
 *   📊 Statistika        — foydalanuvchilar: kunlik / haftalik / oylik / yillik
 *   📣 Xabar yuborish    — istalgan turdagi xabar barcha foydalanuvchilarga
 *   📢 Majburiy kanallar — qo'shish / o'chirish
 *   👮 Adminlar          — yordamchi admin qo'shish / o'chirish (faqat asosiy admin)
 *   🔎 Foydalanuvchi     — id yoki @username bo'yicha; ban / unban
 *   ⚙️ Tizim holati      — navbat, worker, cookies, token, versiya
 *
 * Panel faqat o'zbekcha — uni faqat adminlar ko'radi.
 */
export const ADMIN_COMMAND = 'qimmat';
const P = 'adm';

export const adminComposer = new Composer<BotContext>();

// ---------------------------------------------------------------------------
// Admin kiritishini kutish holati (xotirada, 15 daqiqa)
// ---------------------------------------------------------------------------

type State =
  | { kind: 'bc_wait' }
  | { kind: 'bc_confirm'; fromChatId: number; messageId: number }
  | { kind: 'ch_add' }
  | { kind: 'ad_add' }
  | { kind: 'user_find' };

const states = new Map<number, State & { until: number }>();
const STATE_TTL_MS = 15 * 60_000;

const setState = (id: number, s: State): void => {
  states.set(id, { ...s, until: Date.now() + STATE_TTL_MS });
};
const getState = (id: number): State | null => {
  const s = states.get(id);
  if (!s) return null;
  if (s.until < Date.now()) {
    states.delete(id);
    return null;
  }
  return s;
};

// ---------------------------------------------------------------------------
// Klaviaturalar
// ---------------------------------------------------------------------------

const back = (kb = new InlineKeyboard()): InlineKeyboard => kb.row().text('⬅️ Orqaga', `${P}:home`);

function homeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('📊 Statistika', `${P}:stats`)
    .text('⚙️ Tizim holati', `${P}:sys`)
    .row()
    .text('📣 Xabar yuborish', `${P}:bc`)
    .row()
    .text('📢 Majburiy kanallar', `${P}:ch`)
    .text('👮 Adminlar', `${P}:ad`)
    .row()
    .text('🔎 Foydalanuvchi', `${P}:user`)
    .row()
    .text('❌ Yopish', `${P}:close`);
}

const HOME_TEXT = '🛠 <b>Admin panel</b>\n\nKerakli bo\'limni tanlang:';

/** Xabarni tahrirlaydi (tugmadan) yoki yangi yuboradi (buyruq/matndan). */
async function show(ctx: BotContext, text: string, kb: InlineKeyboard): Promise<void> {
  const opts = { parse_mode: 'HTML' as const, reply_markup: kb, link_preview_options: { is_disabled: true } };
  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, opts);
      return;
    } catch (e) {
      // "message is not modified" — shu holatda qoldiramiz
      if (e instanceof GrammyError && /not modified/i.test(e.description)) return;
    }
  }
  await ctx.reply(text, opts);
}

const MIGRATION_HINT =
  '⚠️ Admin panel uchun <code>supabase/migrations/0009_admin.sql</code> ni Supabase SQL Editor\'da ishga tushiring.';

// ---------------------------------------------------------------------------
// Kirish
// ---------------------------------------------------------------------------

adminComposer.command(ADMIN_COMMAND, async (ctx) => {
  if (ctx.chat.type !== 'private' || !ctx.from || !(await isAdmin(ctx.from.id))) return; // begonaga — jimlik
  states.delete(ctx.from.id);
  if (!adminDbReady()) {
    await ctx.reply(MIGRATION_HINT, { parse_mode: 'HTML' });
    return;
  }
  await ctx.reply(HOME_TEXT, { parse_mode: 'HTML', reply_markup: homeKeyboard() });
});

adminComposer.command('cancel', async (ctx, next) => {
  if (!ctx.from || !states.has(ctx.from.id)) return next();
  states.delete(ctx.from.id);
  await ctx.reply('❌ Bekor qilindi. Panel: /' + ADMIN_COMMAND);
});

// Barcha admin tugmalari — har safar huquq tekshiriladi
adminComposer.callbackQuery(new RegExp(`^${P}:`), async (ctx, next) => {
  if (!(await isAdmin(ctx.from.id))) {
    await ctx.answerCallbackQuery();
    return;
  }
  await next();
});

adminComposer.callbackQuery(`${P}:home`, async (ctx) => {
  states.delete(ctx.from.id);
  await ctx.answerCallbackQuery();
  await show(ctx, HOME_TEXT, homeKeyboard());
});

adminComposer.callbackQuery(`${P}:close`, async (ctx) => {
  states.delete(ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => undefined);
});

// ---------------------------------------------------------------------------
// 📊 Statistika
// ---------------------------------------------------------------------------

adminComposer.callbackQuery(`${P}:stats`, async (ctx) => {
  await ctx.answerCallbackQuery();
  try {
    const s = await adminStats();
    const n = (x: number): string => x.toLocaleString('ru-RU');
    const text = [
      '📊 <b>Statistika</b>',
      '',
      `👥 Jami foydalanuvchilar: <b>${n(s.total)}</b>`,
      `🔗 Instagram bog'langan: ${n(s.linked)}`,
      `🚫 Botni bloklagan: ${n(s.blocked)} · ⛔ Ban: ${n(s.banned)}`,
      '',
      '🆕 <b>Yangi foydalanuvchilar</b>',
      `• Kunlik (24 soat): ${n(s.new_day)}`,
      `• Haftalik (7 kun): ${n(s.new_week)}`,
      `• Oylik (30 kun): ${n(s.new_month)}`,
      `• Yillik (365 kun): ${n(s.new_year)}`,
      '',
      '🔥 <b>Faol foydalanuvchilar</b>',
      `• Kunlik: ${n(s.active_day)}`,
      `• Haftalik: ${n(s.active_week)}`,
      `• Oylik: ${n(s.active_month)}`,
      `• Yillik: ${n(s.active_year)}`,
      '',
      '📥 <b>So\'rovlar</b>',
      `• 24 soat: ${n(s.req_day)} (xato: ${n(s.failed_day)})`,
      `• 7 kun: ${n(s.req_week)} · 30 kun: ${n(s.req_month)}`,
      `• Hozir navbatda: ${n(s.queued)}`,
      '',
      `<i>Yangilandi: ${escapeHtml(formatDate(new Date().toISOString(), 'uz'))}</i>`,
    ].join('\n');
    await show(ctx, text, back(new InlineKeyboard().text('🔄 Yangilash', `${P}:stats`)));
  } catch (e) {
    await show(ctx, `❌ Statistikani olib bo'lmadi: ${escapeHtml(errMessage(e))}\n\n${MIGRATION_HINT}`, back());
  }
});

// ---------------------------------------------------------------------------
// ⚙️ Tizim holati
// ---------------------------------------------------------------------------

adminComposer.callbackQuery(`${P}:sys`, async (ctx) => {
  await ctx.answerCallbackQuery();
  const lines: string[] = ['⚙️ <b>Tizim holati</b>', ''];
  const up = process.uptime();
  lines.push(`🟢 Ishlayapti: ${Math.floor(up / 3600)} soat ${Math.floor((up % 3600) / 60)} daqiqa`);
  lines.push(`🏷 Versiya: <code>${escapeHtml((process.env['RENDER_GIT_COMMIT'] ?? 'lokal').slice(0, 7))}</code>`);
  lines.push(`💾 Xotira: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`);
  const w = workerStatus();
  lines.push(`⚙️ Worker: ${w.running ? 'ishlayapti' : 'TO\'XTAGAN'}, faol ishlar: ${w.activeJobs}`);
  try {
    const q = await requestsRepo.queueStats();
    lines.push(`📥 Navbat: kutmoqda ${q.queued}, ishlanmoqda ${q.processing}, tayyor ${q.done}, xato ${q.failed}`);
  } catch (e) {
    lines.push(`📥 Navbat: ❌ ${escapeHtml(errMessage(e))}`);
  }
  lines.push(`🍪 Instagram cookies: ${hasInstagramCookies() ? 'bor ✅' : 'YO\'Q ❌ — reels yuklanmaydi'}`);
  const token = await getKv<{ refreshedAt: string; expiresAt: string | null }>('ig_token').catch(() => null);
  lines.push(
    token
      ? `🔑 Instagram token: yangilangan ${escapeHtml(formatDate(token.refreshedAt, 'uz'))}` +
          (token.expiresAt ? `, amal qiladi ${escapeHtml(formatDate(token.expiresAt, 'uz'))} gacha` : '')
      : '🔑 Instagram token: env\'dagisi (hali avtomatik yangilanmagan)',
  );
  await show(ctx, lines.join('\n'), back(new InlineKeyboard().text('🔄 Yangilash', `${P}:sys`)));
});

// ---------------------------------------------------------------------------
// 📣 Xabar yuborish (barcha foydalanuvchilarga)
// ---------------------------------------------------------------------------

interface Broadcast {
  stop: boolean;
  sent: number;
  failed: number;
  blocked: number;
  total: number;
  startedBy: number;
}
let broadcast: Broadcast | null = null;

adminComposer.callbackQuery(`${P}:bc`, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (broadcast) {
    await show(
      ctx,
      `📣 Tarqatish davom etyapti: ${broadcast.sent + broadcast.failed + broadcast.blocked} / ${broadcast.total}`,
      back(new InlineKeyboard().text('⏹ To\'xtatish', `${P}:bc:stop`)),
    );
    return;
  }
  setState(ctx.from.id, { kind: 'bc_wait' });
  await show(
    ctx,
    '📣 <b>Xabar yuborish</b>\n\n' +
      'Barcha foydalanuvchilarga yuboriladigan xabarni shu yerga yuboring — ' +
      'matn, rasm, video, GIF, ovozli xabar, audio, fayl, stiker (izoh va tugmalari bilan birga).\n\n' +
      'Yuborishdan oldin ko\'rib tasdiqlaysiz. Bekor qilish: /cancel',
    back(),
  );
});

adminComposer.callbackQuery(`${P}:bc:go`, async (ctx) => {
  const s = getState(ctx.from.id);
  if (s?.kind !== 'bc_confirm') {
    await ctx.answerCallbackQuery({ text: 'Xabar topilmadi — qaytadan boshlang.', show_alert: true });
    return;
  }
  if (broadcast) {
    await ctx.answerCallbackQuery({ text: 'Boshqa tarqatish davom etyapti.', show_alert: true });
    return;
  }
  states.delete(ctx.from.id);
  await ctx.answerCallbackQuery({ text: 'Boshlandi' });
  await ctx.editMessageReplyMarkup().catch(() => undefined);
  void runBroadcast(ctx.api, ctx.from.id, s.fromChatId, s.messageId).catch((e: unknown) => {
    logger.error({ err: errMessage(e) }, 'Tarqatish yiqildi');
    broadcast = null;
  });
});

adminComposer.callbackQuery(`${P}:bc:no`, async (ctx) => {
  states.delete(ctx.from.id);
  await ctx.answerCallbackQuery({ text: 'Bekor qilindi' });
  await show(ctx, HOME_TEXT, homeKeyboard());
});

adminComposer.callbackQuery(`${P}:bc:stop`, async (ctx) => {
  if (broadcast) broadcast.stop = true;
  await ctx.answerCallbackQuery({ text: 'To\'xtatilmoqda…' });
});

/** Telegram limiti ~30 xabar/soniya — zaxira bilan ~25. */
const SEND_GAP_MS = 40;
const PROGRESS_EVERY_MS = 3_000;

async function runBroadcast(api: Api, adminId: number, fromChatId: number, messageId: number): Promise<void> {
  const b: Broadcast = { stop: false, sent: 0, failed: 0, blocked: 0, total: await countRecipients(), startedBy: adminId };
  broadcast = b;
  const stopKb = new InlineKeyboard().text('⏹ To\'xtatish', `${P}:bc:stop`);
  const progress = await api.sendMessage(adminId, `📣 Yuborilmoqda: 0 / ${b.total}`, { reply_markup: stopKb });
  const startedAt = Date.now();
  let lastProgress = Date.now();
  logger.info({ adminId, total: b.total }, 'Tarqatish boshlandi');

  const report = (final: boolean): string => {
    const done = b.sent + b.failed + b.blocked;
    return [
      final ? (b.stop ? '⏹ <b>Tarqatish to\'xtatildi</b>' : '✅ <b>Tarqatish tugadi</b>') : `📣 Yuborilmoqda: ${done} / ${b.total}`,
      '',
      `✅ Yetkazildi: ${b.sent}`,
      `🚫 Botni bloklagan: ${b.blocked}`,
      `⚠️ Xato: ${b.failed}`,
      final ? `⏱ ${Math.round((Date.now() - startedAt) / 1000)} soniya` : '',
    ]
      .filter(Boolean)
      .join('\n');
  };

  try {
    for await (const userId of allRecipientIds()) {
      if (b.stop) break;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await api.copyMessage(userId, fromChatId, messageId);
          b.sent += 1;
          break;
        } catch (e) {
          if (e instanceof GrammyError && e.error_code === 429) {
            await sleep(((e.parameters?.retry_after ?? 5) + 1) * 1000);
            continue; // flood — kutib, qayta
          }
          if (e instanceof GrammyError && e.error_code === 403) {
            b.blocked += 1;
            void setBlocked(userId, true);
          } else {
            b.failed += 1;
            logger.debug({ userId, err: errMessage(e) }, 'Tarqatish: yuborilmadi');
          }
          break;
        }
      }
      await sleep(SEND_GAP_MS);
      if (Date.now() - lastProgress > PROGRESS_EVERY_MS) {
        lastProgress = Date.now();
        await api
          .editMessageText(adminId, progress.message_id, report(false), { parse_mode: 'HTML', reply_markup: stopKb })
          .catch(() => undefined);
      }
    }
  } finally {
    broadcast = null;
    logger.info({ sent: b.sent, blocked: b.blocked, failed: b.failed, stopped: b.stop }, 'Tarqatish tugadi');
    await api
      .editMessageText(adminId, progress.message_id, report(true), { parse_mode: 'HTML' })
      .catch(() => api.sendMessage(adminId, report(true), { parse_mode: 'HTML' }));
  }
}

// ---------------------------------------------------------------------------
// 📢 Majburiy kanallar
// ---------------------------------------------------------------------------

async function showChannels(ctx: BotContext): Promise<void> {
  const channels = await listChannels();
  const kb = new InlineKeyboard();
  for (const ch of channels) kb.text(`🗑 ${ch.title}`.slice(0, 60), `${P}:chdel:${ch.chat_id}`).row();
  kb.text('➕ Kanal qo\'shish', `${P}:chadd`);
  const list = channels.length
    ? channels
        .map((ch, i) => `${i + 1}. ${escapeHtml(ch.title)}${ch.username ? ` (@${escapeHtml(ch.username)})` : ''}`)
        .join('\n')
    : '<i>Hozircha yo\'q — bot hammaga ochiq.</i>';
  await show(
    ctx,
    `📢 <b>Majburiy kanallar</b>\n\n${list}\n\nFoydalanuvchi shu kanallarga obuna bo'lmaguncha bot ishlamaydi (adminlardan tashqari). O'chirish uchun kanal tugmasini bosing.`,
    back(kb),
  );
}

adminComposer.callbackQuery(`${P}:ch`, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showChannels(ctx);
});

adminComposer.callbackQuery(`${P}:chadd`, async (ctx) => {
  await ctx.answerCallbackQuery();
  setState(ctx.from.id, { kind: 'ch_add' });
  await show(
    ctx,
    '➕ <b>Kanal qo\'shish</b>\n\n' +
      '1. Botni kanalga <b>admin</b> qilib qo\'shing (a\'zolarni ko\'rish uchun kerak).\n' +
      '2. Shu yerga yuboring: kanal <code>@username</code>, yoki kanaldan istalgan postni <b>forward</b> qiling, yoki kanal ID\'si (<code>-100…</code>).\n\n' +
      'Bekor qilish: /cancel',
    back(),
  );
});

adminComposer.callbackQuery(new RegExp(`^${P}:chdel:(-?\\d+)$`), async (ctx) => {
  const chatId = Number(ctx.match[1]);
  await removeChannel(chatId);
  logger.info({ chatId, by: ctx.from.id }, 'Majburiy kanal o\'chirildi');
  await ctx.answerCallbackQuery({ text: 'O\'chirildi' });
  await showChannels(ctx);
});

/** Admin yuborgan narsadan kanal: forward, @username, t.me havola yoki -100… ID. */
function channelRefOf(msg: Message): string | number | null {
  const origin = msg.forward_origin;
  if (origin?.type === 'channel') return origin.chat.id;
  const text = msg.text?.trim() ?? '';
  const id = /^-100\d{5,}$/.exec(text)?.[0];
  if (id) return Number(id);
  const username = /^(?:@|(?:https?:\/\/)?t\.me\/)([A-Za-z][A-Za-z0-9_]{3,})$/.exec(text)?.[1];
  return username ? `@${username}` : null;
}

async function addChannelFromMessage(ctx: BotContext, msg: Message): Promise<void> {
  const ref = channelRefOf(msg);
  if (ref === null) {
    await ctx.reply('❓ Kanalni tanib bo\'lmadi. @username yuboring yoki kanaldan postni forward qiling. Bekor: /cancel');
    return;
  }
  try {
    const chat = await ctx.api.getChat(ref);
    if (chat.type !== 'channel' && chat.type !== 'supergroup') {
      await ctx.reply('❌ Bu kanal yoki guruh emas.');
      return;
    }
    const me = await ctx.api.getChatMember(chat.id, ctx.me.id);
    if (me.status !== 'administrator') {
      await ctx.reply('❌ Bot bu kanalda admin emas. Avval botni kanalga admin qilib qo\'shing, so\'ng qayta yuboring.');
      return;
    }
    const username = 'username' in chat && chat.username ? chat.username : null;
    let invite = username ? `https://t.me/${username}` : ('invite_link' in chat ? chat.invite_link ?? null : null);
    if (!invite) invite = await ctx.api.exportChatInviteLink(chat.id).catch(() => null);
    if (!invite) {
      await ctx.reply('❌ Kanal havolasini olib bo\'lmadi — botga "Invite users via link" huquqini bering.');
      return;
    }
    const title = 'title' in chat && chat.title ? chat.title : String(chat.id);
    await addChannel({ chat_id: chat.id, title, username, invite_link: invite, added_by: ctx.from!.id });
    states.delete(ctx.from!.id);
    logger.info({ chatId: chat.id, title, by: ctx.from!.id }, 'Majburiy kanal qo\'shildi');
    await ctx.reply(`✅ Qo'shildi: <b>${escapeHtml(title)}</b>`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('📢 Kanallar', `${P}:ch`).text('🏠 Panel', `${P}:home`),
    });
  } catch (e) {
    await ctx.reply(`❌ Kanalni tekshirib bo'lmadi: ${escapeHtml(errMessage(e))}\nBot kanalda admin ekanini tekshiring.`, {
      parse_mode: 'HTML',
    });
  }
}

// ---------------------------------------------------------------------------
// 👮 Adminlar
// ---------------------------------------------------------------------------

async function showAdmins(ctx: BotContext): Promise<void> {
  const owner = isOwner(ctx.from!.id);
  const admins = await listAdmins();
  const fmt = (a: { telegram_id: number; username: string | null; phone: string | null }): string =>
    `<code>${a.telegram_id}</code>${a.username ? ` @${escapeHtml(a.username)}` : ''}${a.phone ? ` · ${escapeHtml(a.phone)}` : ''}`;
  const list = admins.length ? admins.map((a, i) => `${i + 1}. ${fmt(a)}`).join('\n') : '<i>Yordamchi adminlar yo\'q.</i>';
  const kb = new InlineKeyboard();
  if (owner) {
    for (const a of admins) kb.text(`🗑 ${a.username ? '@' + a.username : a.telegram_id}`, `${P}:addel:${a.telegram_id}`).row();
    kb.text('➕ Admin qo\'shish', `${P}:adadd`);
  }
  await show(
    ctx,
    `👮 <b>Adminlar</b>\n\n👑 Asosiy admin: <code>${env.ADMIN_TELEGRAM_IDS.join('</code>, <code>')}</code>\n\n<b>Yordamchi adminlar:</b>\n${list}` +
      (owner ? '' : '\n\n<i>Adminlarni faqat asosiy admin boshqaradi.</i>'),
    back(kb),
  );
}

adminComposer.callbackQuery(`${P}:ad`, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showAdmins(ctx);
});

adminComposer.callbackQuery(`${P}:adadd`, async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: 'Faqat asosiy admin.', show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  setState(ctx.from.id, { kind: 'ad_add' });
  await show(
    ctx,
    '➕ <b>Admin qo\'shish</b>\n\n' +
      'Bitta xabarda yuboring:\n' +
      '• <b>majburiy</b>: Telegram ID (raqam)\n' +
      '• ixtiyoriy: telefon raqami va @username\n\n' +
      'Masalan: <code>123456789 +998901234567 @username</code>\n' +
      'Yoki shunchaki: <code>123456789</code>\n\n' +
      'ID\'ni o\'sha odam @userinfobot dan bilib oladi. Yoki uning xabarini shu yerga forward qiling (profili yashirin bo\'lmasa).\n\n' +
      'Bekor qilish: /cancel',
    back(),
  );
});

adminComposer.callbackQuery(new RegExp(`^${P}:addel:(\\d+)$`), async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: 'Faqat asosiy admin.', show_alert: true });
    return;
  }
  const id = Number(ctx.match[1]);
  await removeAdmin(id);
  logger.info({ adminId: id, by: ctx.from.id }, 'Yordamchi admin o\'chirildi');
  await ctx.answerCallbackQuery({ text: 'O\'chirildi' });
  await showAdmins(ctx);
});

/** "ID [telefon] [@username]" yoki forward qilingan xabar. */
function parseAdminInput(msg: Message): { id: number; phone: string | null; username: string | null } | null {
  const origin = msg.forward_origin;
  if (origin?.type === 'user') {
    return { id: origin.sender_user.id, phone: null, username: origin.sender_user.username ?? null };
  }
  const parts = (msg.text ?? '').trim().split(/\s+/).filter(Boolean);
  const idPart = parts.find((p) => /^\d{5,15}$/.test(p));
  if (!idPart) return null;
  const phone = parts.find((p) => p !== idPart && /^\+?\d[\d-]{7,16}$/.test(p)) ?? null;
  const username = parts.find((p) => /^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(p))?.slice(1) ?? null;
  return { id: Number(idPart), phone, username };
}

// ---------------------------------------------------------------------------
// 🔎 Foydalanuvchi
// ---------------------------------------------------------------------------

adminComposer.callbackQuery(`${P}:user`, async (ctx) => {
  await ctx.answerCallbackQuery();
  setState(ctx.from.id, { kind: 'user_find' });
  await show(ctx, '🔎 Foydalanuvchining Telegram ID\'si yoki @username\'ini yuboring.\n\nBekor qilish: /cancel', back());
});

async function showUser(ctx: BotContext, query: string): Promise<void> {
  const u = await findUser(query);
  if (!u) {
    await ctx.reply('❓ Topilmadi. ID yoki @username\'ni tekshiring. Bekor: /cancel');
    return;
  }
  const ig = u.ig_scoped_id ? await getInstagramProfile(u.ig_scoped_id) : null;
  const requests = await countUserRequests(u.id);
  const d = (iso: string | null): string => (iso ? escapeHtml(formatDate(iso, 'uz')) : '—');
  const text = [
    '👤 <b>Foydalanuvchi</b>',
    '',
    `ID: <code>${u.telegram_id}</code>`,
    `Ism: ${escapeHtml(u.telegram_first_name ?? '—')}${u.telegram_username ? ` · @${escapeHtml(u.telegram_username)}` : ''}`,
    `Qo'shilgan: ${d(u.created_at)}`,
    `Oxirgi faollik: ${d(u.last_active_at)}`,
    `Instagram: ${u.link_status === 'linked' ? (ig?.username ? '@' + escapeHtml(ig.username) : 'bog\'langan') : 'bog\'lanmagan'}`,
    `So'rovlar: ${requests}`,
    `Holat: ${u.banned_at ? '⛔ ban' : u.blocked_at ? '🚫 botni bloklagan' : '✅ faol'}`,
  ].join('\n');
  const kb = new InlineKeyboard()
    .text(u.banned_at ? '✅ Bandan chiqarish' : '⛔ Ban qilish', `${P}:${u.banned_at ? 'unban' : 'ban'}:${u.telegram_id}`)
    .row()
    .text('🔎 Boshqasini qidirish', `${P}:user`);
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: back(kb) });
}

adminComposer.callbackQuery(new RegExp(`^${P}:(ban|unban):(\\d+)$`), async (ctx) => {
  const ban = ctx.match[1] === 'ban';
  const id = Number(ctx.match[2]);
  if (ban && (await isAdmin(id))) {
    await ctx.answerCallbackQuery({ text: 'Adminni ban qilib bo\'lmaydi.', show_alert: true });
    return;
  }
  await setBanned(id, ban);
  logger.info({ telegramId: id, ban, by: ctx.from.id }, 'Ban holati o\'zgardi');
  await ctx.answerCallbackQuery({ text: ban ? '⛔ Ban qilindi' : '✅ Bandan chiqarildi' });
  await ctx.deleteMessage().catch(() => undefined);
  await showUser(ctx, String(id));
});

// ---------------------------------------------------------------------------
// Admin kiritishi (holatga qarab) — boshqa handlerlardan OLDIN
// ---------------------------------------------------------------------------

adminComposer.on('message', async (ctx, next) => {
  const from = ctx.from;
  const state = from && ctx.chat.type === 'private' ? getState(from.id) : null;
  if (!from || !state) return next();
  if (!(await isAdmin(from.id))) {
    states.delete(from.id);
    return next();
  }
  const msg = ctx.message;

  switch (state.kind) {
    case 'bc_wait': {
      if (msg.media_group_id) {
        await ctx.reply('⚠️ Albom (bir nechta rasm/video bitta xabarda) qo\'llanmaydi — bitta xabar yuboring. Bekor: /cancel');
        return;
      }
      setState(from.id, { kind: 'bc_confirm', fromChatId: ctx.chat.id, messageId: msg.message_id });
      const total = await countRecipients().catch(() => 0);
      await ctx.reply('👆 Oldindan ko\'rish — foydalanuvchilar aynan shunday ko\'radi:');
      await ctx.api.copyMessage(ctx.chat.id, ctx.chat.id, msg.message_id).catch(() => undefined);
      await ctx.reply(`Shu xabarni <b>${total}</b> ta foydalanuvchiga yuboraymi?`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('✅ Ha, yuborish', `${P}:bc:go`).text('❌ Bekor', `${P}:bc:no`),
      });
      return;
    }
    case 'bc_confirm':
      await ctx.reply('Yuqoridagi xabarni tasdiqlang (✅ / ❌) yoki /cancel.');
      return;
    case 'ch_add':
      await addChannelFromMessage(ctx, msg);
      return;
    case 'ad_add': {
      if (!isOwner(from.id)) {
        states.delete(from.id);
        return;
      }
      const parsed = parseAdminInput(msg);
      if (!parsed) {
        await ctx.reply('❓ Telegram ID topilmadi. Masalan: <code>123456789 +998901234567 @username</code>. Bekor: /cancel', {
          parse_mode: 'HTML',
        });
        return;
      }
      await upsertAdmin({ telegram_id: parsed.id, phone: parsed.phone, username: parsed.username, added_by: from.id });
      states.delete(from.id);
      logger.info({ adminId: parsed.id, by: from.id }, 'Yordamchi admin qo\'shildi');
      await ctx.reply(
        `✅ Admin qo'shildi: <code>${parsed.id}</code>${parsed.username ? ` @${escapeHtml(parsed.username)}` : ''}${parsed.phone ? ` · ${escapeHtml(parsed.phone)}` : ''}\n\n` +
          `U botga /${ADMIN_COMMAND} yozib panelga kira oladi.`,
        { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('👮 Adminlar', `${P}:ad`).text('🏠 Panel', `${P}:home`) },
      );
      return;
    }
    case 'user_find':
      if (!msg.text) {
        await ctx.reply('ID yoki @username yuboring. Bekor: /cancel');
        return;
      }
      await showUser(ctx, msg.text);
      return;
  }
});
