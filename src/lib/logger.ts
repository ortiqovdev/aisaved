import pino from 'pino';
import { env, isProd } from '../config/env.ts';

export const logger = pino({
  level: env.LOG_LEVEL,
  // Ishlab chiqarishda JSON, lokalda o'qishga qulay format
  transport: isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
  redact: {
    paths: [
      'access_token',
      '*.access_token',
      'req.headers.authorization',
      'TELEGRAM_BOT_TOKEN',
      'AUDD_API_TOKEN',
    ],
    censor: '[maxfiy]',
  },
});

export type Logger = typeof logger;
