import { pino, type Logger } from 'pino';

export type { Logger };

/** Fields of the single `request` log line written per chat call. Never message content. */
export interface RequestLogFields {
  requestId: string;
  route: string;
  model: string;
  stream: boolean;
  routeCase: string | null;
  status: number;
  adjustments: string[];
  durationMs: number;
  firstByteMs: number | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  errorCode: string | null;
}

export function createLogger(level = 'info'): Logger {
  return pino({
    level,
    redact: {
      paths: [
        'authorization',
        'headers.authorization',
        'req.headers.authorization',
        'secrets',
        'config.secrets',
        'apiKey',
        'claudeToken',
      ],
      censor: '[redacted]',
    },
  });
}
