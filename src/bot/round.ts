import { GrammyError, InputFile } from 'grammy';
import type { Message } from 'grammy/types';
import type { BotContext } from './index.ts';
import { logger } from '../lib/logger.ts';
import { PermanentError, errMessage } from '../lib/errors.ts';
import { TELEGRAM_MAX_DOWNLOAD_BYTES } from '../lib/constants.ts';
import { resolveTelegramFileUrl } from '../services/telegram-files.ts';
import { VIDEO_NOTE_SIZE, downloadMedia, makeVideoNote, safeUnlink } from '../services/media.ts';

/**
 * /round — videoga javob qilib yozilsa, o'sha videoni dumaloq video xabar
 * (video note) qilib qaytaradi. Bot yuborgan natija videosi uchun ham,
 * foydalanuvchi o'zi tashlagan video uchun ham ishlaydi.
 *
 * ffmpeg bir necha soniya ishlaydi, grammY esa update'larni KETMA-KET
 * qayta ishlaydi — handler ichida kutsak, shu vaqt davomida bot hech kimga
 * javob bermay qoladi. Shuning uchun o'girish fonda bajariladi.
 */

/** Bir vaqtda nechta ffmpeg ishlashi mumkin (CPU'ni band qilib qo'ymaslik uchun). */
const MAX_PARALLEL = 2;
let freeSlots = MAX_PARALLEL;
const waiting: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (freeSlots > 0) {
    freeSlots -= 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next();
  else freeSlots += 1;
}

/** Bitta foydalanuvchi bir vaqtda bittadan ko'p so'rov yubormasin. */
const busyUsers = new Set<number>();

export interface SourceVideo {
  fileId: string;
  /** Fayl mazmuniga bog'langan doimiy ID — musiqa keshi kaliti. */
  fileUniqueId: string;
  fileSize: number | undefined;
  /** Telegram bergan davomiylik (sekund) — bo'lsa ffprobe chaqirilmaydi. */
  duration?: number | undefined;
}

/** Xabardan videoni oladi (dumaloq bo'lmagan har qanday video). */
export function pickVideo(message: Message): SourceVideo | null {
  const media = message.video ?? message.animation;
  if (media) {
    return {
      fileId: media.file_id,
      fileUniqueId: media.file_unique_id,
      fileSize: media.file_size,
      duration: media.duration,
    };
  }
  const doc = message.document?.mime_type?.startsWith('video/') ? message.document : undefined;
  return doc ? { fileId: doc.file_id, fileUniqueId: doc.file_unique_id, fileSize: doc.file_size } : null;
}

/** /round buyrug'i — videoga javob qilib yozilgan bo'lishi kerak. */
export async function handleRound(ctx: BotContext): Promise<void> {
  const replied = ctx.message?.reply_to_message;
  if (!ctx.chat) return;

  if (!replied) {
    await ctx.reply(ctx.t('roundHowTo'), { parse_mode: 'HTML' });
    return;
  }

  const video = pickVideo(replied);
  if (!video) {
    await ctx.reply(ctx.t('roundNeedVideo'));
    return;
  }
  await startRound(ctx, ctx.chat.id, replied.message_id, video);
}

/**
 * Tekshiruvlar, "Dumaloq qilyapman..." xabari va fonda o'girish.
 * /round buyrug'i ham, video tagidagi "⭕" tugmasi ham shu yerga keladi.
 */
export async function startRound(
  ctx: BotContext,
  chatId: number,
  videoMessageId: number,
  video: SourceVideo,
): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  if (video.fileSize !== undefined && video.fileSize > TELEGRAM_MAX_DOWNLOAD_BYTES) {
    await ctx.reply(ctx.t('fileTooBig20'));
    return;
  }
  if (busyUsers.has(from.id)) {
    await ctx.reply(ctx.t('roundBusy'));
    return;
  }

  busyUsers.add(from.id);
  // Yuklab olish "Dumaloq qilyapman..." xabari bilan PARALLEL boshlanadi —
  // Telegram'ga har bir so'rov ~0.2–0.5 s, ularni ketma-ket kutish shart emas
  const status = ctx.api
    .sendMessage(chatId, ctx.t('roundWorking'), {
      reply_parameters: { message_id: videoMessageId, allow_sending_without_reply: true },
    })
    .then((m) => m.message_id);
  // Xabar yuborilmasa ham (masalan, huquq yo'q) handler xatosi bo'lmasin —
  // convertAndSend buni o'zi hal qiladi
  status.catch(() => undefined);
  void convertAndSend(ctx, chatId, videoMessageId, status, video).finally(() =>
    busyUsers.delete(from.id),
  );
}

async function convertAndSend(
  ctx: BotContext,
  chatId: number,
  replyToId: number,
  status: Promise<number>,
  video: SourceVideo,
): Promise<void> {
  const started = Date.now();
  let sourcePath: string | null = null;
  let notePath: string | null = null;
  let holdsSlot = false;

  try {
    void ctx.api.sendChatAction(chatId, 'upload_video_note').catch(() => undefined);

    // Yuklash CPU talab qilmaydi — slot faqat ffmpeg uchun olinadi
    const url = await resolveTelegramFileUrl(video.fileId);
    const downloaded = await downloadMedia(url, replyToId);
    sourcePath = downloaded.filePath;
    const downloadMs = Date.now() - started;

    await acquireSlot();
    holdsSlot = true;
    const note = await makeVideoNote(sourcePath, video.duration);
    releaseSlot();
    holdsSlot = false;
    notePath = note.filePath;

    await ctx.api.sendVideoNote(chatId, new InputFile(note.filePath), {
      length: VIDEO_NOTE_SIZE,
      duration: note.duration,
      reply_parameters: { message_id: replyToId, allow_sending_without_reply: true },
    });

    // "Dumaloq qilyapman..." xabari o'z vazifasini bajardi. Kesilgan bo'lsa —
    // o'rniga sababini yozib qo'yamiz, aks holda shunchaki o'chiramiz (kutmasdan).
    const statusId = await status.catch(() => null);
    if (statusId !== null) {
      void (note.trimmed
        ? ctx.api.editMessageText(chatId, statusId, ctx.t('roundTrimmed'))
        : ctx.api.deleteMessage(chatId, statusId)
      ).catch(() => undefined);
    }
    logger.info(
      { chatId, duration: note.duration, trimmed: note.trimmed, downloadMs, ms: Date.now() - started },
      'Dumaloq video yuborildi',
    );
  } catch (e) {
    logger.warn({ chatId, err: errMessage(e) }, 'Dumaloq video yasab bo\'lmadi');
    const text = failureText(ctx, e);
    const statusId = await status.catch(() => null);
    await (statusId !== null
      ? ctx.api.editMessageText(chatId, statusId, text)
      : Promise.reject(new Error('status yo\'q'))
    ).catch(() => ctx.api.sendMessage(chatId, text).catch(() => undefined));
  } finally {
    if (holdsSlot) releaseSlot();
    await safeUnlink(notePath);
    await safeUnlink(sourcePath);
  }
}

function failureText(ctx: BotContext, e: unknown): string {
  // Foydalanuvchi maxfiylik sozlamasida ovozli/video xabarlarni yopib qo'ygan
  if (e instanceof GrammyError && /VOICE_MESSAGES_FORBIDDEN/i.test(e.description)) {
    return ctx.t('roundForbidden');
  }
  if (e instanceof PermanentError && e.userMessage) {
    return ctx.t(e.userMessage.key, e.userMessage.vars);
  }
  return ctx.t('roundFailed');
}
