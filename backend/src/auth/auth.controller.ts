import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError } from '../common/app-error.js';
import { CONFIG, type Config } from '../config.js';
import { AuthService } from './auth.service.js';
import { clearRefreshCookie, refreshTokenFrom, setRefreshCookie, withoutRefreshToken } from './refresh-cookie.js';

@Controller('v1/auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: Config
  ) {}

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
    setRefreshCookie(res, this.config, result.refreshToken);
    return withoutRefreshToken(result);
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const tokens = await this.auth.refresh(refreshTokenFrom(req), req.headers['user-agent'] ?? null);
    setRefreshCookie(res, this.config, tokens.refreshToken);
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(refreshTokenFrom(req));
    clearRefreshCookie(res, this.config);
  }
}
