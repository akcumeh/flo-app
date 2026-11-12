import type { LoggerService } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

const SECRET_KEYS = /authorization|cookie|token|secret|password|key|code/i;

function line(level: string, message: unknown, context?: unknown, extra: Record<string, unknown> = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,
    ...(typeof context === 'string' ? { context } : {}),
    msg: message instanceof Error ? message.message : typeof message === 'string' ? message : JSON.stringify(message),
    ...extra,
  };
  const out = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') process.stderr.write(`${out}\n`);
  else process.stdout.write(`${out}\n`);
}

export class JsonLogger implements LoggerService {
  log(message: unknown, context?: unknown) {
    line('info', message, context);
  }
  error(message: unknown, stack?: unknown, context?: unknown) {
    line('error', message, context, typeof stack === 'string' ? { stack } : {});
  }
  warn(message: unknown, context?: unknown) {
    line('warn', message, context);
  }
  debug(message: unknown, context?: unknown) {
    line('debug', message, context);
  }
  verbose(message: unknown, context?: unknown) {
    line('verbose', message, context);
  }
}

export function requestIds(log: boolean) {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(incoming) ? incoming : `req_${randomUUID().slice(0, 12)}`;
    req.headers['x-request-id'] = id;
    res.setHeader('X-Request-Id', id);
    if (log) {
      const started = process.hrtime.bigint();
      res.on('finish', () => {
        const query = Object.keys(req.query ?? {}).filter((k) => !SECRET_KEYS.test(k));
        line('info', 'request', 'Http', {
          requestId: id,
          method: req.method,
          path: req.path,
          ...(query.length ? { query } : {}),
          status: res.statusCode,
          ms: Number((process.hrtime.bigint() - started) / 1_000_000n),
        });
      });
    }
    next();
  };
}
