import { traceStorage } from './middleware/correlation';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';
const IS_PROD = process.env.NODE_ENV === 'production';

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  requestId?: string;
  traceId?: string;
  spanId?: string;
  [key: string]: unknown;
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const ctx = traceStorage.getStore();
  const entry: LogEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
    ...(ctx?.traceId ? { traceId: ctx.traceId } : {}),
    ...(ctx?.spanId ? { spanId: ctx.spanId } : {}),
    ...meta,
  };

  const line = IS_PROD ? JSON.stringify(entry) : prettyPrint(entry);

  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

function prettyPrint(e: Record<string, unknown>): string {
  const { level, timestamp, message, ...rest } = e;
  const extras = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
  return `[${String(timestamp).slice(11, 23)}] ${String(level).toUpperCase().padEnd(5)} ${message}${extras}`;
}

// ---------------------------------------------------------------------------
// Exported logger
// ---------------------------------------------------------------------------
export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => log('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log('error', msg, meta),
};

// ---------------------------------------------------------------------------
// Express enrichment middleware — attach request ID + duration to each log
// ---------------------------------------------------------------------------
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string) ?? randomUUID();
  const currentContext = traceStorage.getStore();
  const start = Date.now();

  res.setHeader('x-request-id', requestId);

  traceStorage.run(
    {
      requestId,
      traceId: currentContext?.traceId ?? '',
      spanId: currentContext?.spanId ?? '',
    },
    () => {
      res.on('finish', () => {
        logger.info('request completed', {
          method: req.method,
          route: req.route?.path ?? req.path,
          status: res.statusCode,
          duration_ms: Date.now() - start,
        });
      });
      next();
    },
  );
}
