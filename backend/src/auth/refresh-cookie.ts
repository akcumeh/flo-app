import type { CookieOptions, Request, Response } from 'express';
import type { Config } from '../config.js';
import { REFRESH_TTL_DAYS } from './auth.service.js';

export const REFRESH_COOKIE = 'flo_rt';

export function refreshCookieOptions(config: Config): CookieOptions {
  return { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/v1/auth' };
}

export function setRefreshCookie(res: Response, config: Config, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    ...refreshCookieOptions(config),
    maxAge: REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearRefreshCookie(res: Response, config: Config) {
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(config));
}

export function refreshTokenFrom(req: Request): string | undefined {
  return (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
}

export function withoutRefreshToken<T extends { refreshToken: string }>(result: T): Omit<T, 'refreshToken'> {
  const copy: Partial<T> = { ...result };
  delete copy.refreshToken;
  return copy as Omit<T, 'refreshToken'>;
}
