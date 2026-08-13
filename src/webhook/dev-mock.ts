import { Router, type Request, type Response } from 'express';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { errMessage } from '../lib/errors.ts';
import { handleWebhookBody } from './instagram.ts';
import type { IgWebhookBody } from '../services/instagram.ts';

/**
 * FAQAT MOCK_MODE=true bo'lganda ulanadi.
 *
 * Instagram'dan kelayotgan webhook'ni taqlid qiladi — Meta App, ngrok yoki
 * haqiqiy token bo'lmasa ham butun oqimni sinash mumkin.
 * Telegram tomoni HAQIQIY bo'lib qoladi.
 */
export const devMockRouter = Router();

const PAGE_ID = 'MOCK_PAGE_ID';

function buildBody(senderId: string, message: Record<string, unknown>): IgWebhookBody {
  return {
    object: 'instagram',
    entry: [
      {
        id: PAGE_ID,
        time: Date.now(),
        messaging: [
          {
            sender: { id: senderId },
            recipient: { id: PAGE_ID },
            timestamp: Date.now(),
            message: {
              mid: `mock.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
              ...message,
            },
          },
        ],
      },
    ],
  };
}

/** Qisqacha yordam. */
devMockRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    mode: 'MOCK',
    endpoints: {
      'POST /dev/mock/text': { igsid: 'IGSID_TEST', text: 'LINK-AB12CD' },
      'POST /dev/mock/reel': { igsid: 'IGSID_TEST', url: '(ixtiyoriy, default sample video)' },
    },
    defaultSampleVideo: env.MOCK_SAMPLE_VIDEO_URL,
  });
});

/** Instagram'dan matnli DM kelganini taqlid qiladi (bog'lash kodi uchun). */
devMockRouter.post('/text', async (req: Request, res: Response) => {
  const igsid = String(req.body?.igsid ?? 'IGSID_TEST');
  const text = String(req.body?.text ?? '');

  if (!text) {
    res.status(400).json({ error: '`text` maydoni kerak' });
    return;
  }

  logger.info({ igsid, text }, '🧪 [MOCK] Instagram matnli xabar');
  try {
    await handleWebhookBody(buildBody(igsid, { text }));
    res.json({ ok: true, igsid, text });
  } catch (e) {
    logger.error({ err: errMessage(e) }, '[MOCK] text handler xatosi');
    res.status(500).json({ ok: false, error: errMessage(e) });
  }
});

/** Instagram'dan reels yuborilganini taqlid qiladi. */
devMockRouter.post('/reel', async (req: Request, res: Response) => {
  const igsid = String(req.body?.igsid ?? 'IGSID_TEST');
  const url = String(req.body?.url ?? env.MOCK_SAMPLE_VIDEO_URL);

  logger.info({ igsid, url }, '🧪 [MOCK] Instagram reels');
  try {
    await handleWebhookBody(
      buildBody(igsid, {
        attachments: [{ type: 'ig_reel', payload: { url } }],
      }),
    );
    res.json({ ok: true, igsid, url, note: 'Navbatga qo\'shildi — worker log\'iga qarang' });
  } catch (e) {
    logger.error({ err: errMessage(e) }, '[MOCK] reel handler xatosi');
    res.status(500).json({ ok: false, error: errMessage(e) });
  }
});
