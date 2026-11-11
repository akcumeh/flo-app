import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { AppError } from '../common/app-error.js';
import { CONFIG, type Config } from '../config.js';
import { AuthService, REFRESH_TTL_DAYS } from './auth.service.js';

const COOKIE = 'flo_rt';

@Controller('v1/auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: Config
  ) {}

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'strict',
      path: '/v1/auth',
    };
  }

  private setRefreshCookie(res: Response, token: string) {
    res.cookie(COOKIE, token, { ...this.cookieOptions(), maxAge: REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000 });
  }

  private refreshFrom(req: Request): string | undefined {
    return (req.cookies as Record<string, string> | undefined)?.[COOKIE];
  }

  private rejectLinking(req: Request) {
    if (req.headers.authorization) throw AppError.notImplemented();
  }

  @Post('email/start')
  @HttpCode(202)
  async startEmail(@Body() body: { email: string }, @Req() req: Request) {
    this.rejectLinking(req);
    await this.auth.startEmail(body.email, req.ip ?? 'unknown');
  }

  @Post('email/verify')
  @HttpCode(200)
  async verifyEmail(
    @Body() body: { email: string; code: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    this.rejectLinking(req);
    const result = await this.auth.verifyEmail(body.email, body.code, req.headers['user-agent'] ?? null);
    this.setRefreshCookie(res, result.refreshToken);
    const { refreshToken: _omit, ...body200 } = result;
    void _omit;
    return body200;
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const tokens = await this.auth.refresh(this.refreshFrom(req), req.headers['user-agent'] ?? null);
    this.setRefreshCookie(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(this.refreshFrom(req));
    res.clearCookie(COOKIE, this.cookieOptions());
  }
}
