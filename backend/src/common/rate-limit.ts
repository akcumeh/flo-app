import type { NextFunction, Request, Response } from 'express';

interface Rule {
  prefix: string;
  limit: number;
  windowMs: number;
}

export const RATE_RULES: Rule[] = [
  { prefix: '/v1/auth/', limit: 60, windowMs: 60_000 },
  { prefix: '/v1/guest/', limit: 30, windowMs: 60_000 },
  { prefix: '/internal/', limit: 1200, windowMs: 60_000 },
  { prefix: '/v1/webhooks/', limit: 600, windowMs: 60_000 },
  { prefix: '/', limit: 600, windowMs: 60_000 },
];

export function rateLimit(rules: Rule[] = RATE_RULES) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = Date.now();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (now - lastSweep > 60_000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      lastSweep = now;
    }
    const rule = rules.find((r) => req.path.startsWith(r.prefix));
    if (!rule) return next();
    const key = `${rule.prefix}|${req.ip ?? 'unknown'}`;
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + rule.windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count <= rule.limit) return next();
    const retry = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res
      .status(429)
      .setHeader('Retry-After', String(retry))
      .type('application/problem+json')
      .json({
        type: 'https://florence.example/problems/rate-limited',
        title: 'Too many requests',
        status: 429,
        code: 'rate_limited',
        detail: `Try again in ${retry} seconds.`,
      });
  };
}
