import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CONFIG, type Config } from '../config.js';
import { AuthService } from './auth.service.js';
import { ChallengesService, type Channel, type Intent } from './challenges.service.js';
import { optionalAccount } from './jwt.guard.js';
import { setRefreshCookie, withoutRefreshToken } from './refresh-cookie.js';

@Controller('v1/auth/challenges')
export class ChallengesController {
  constructor(
    @Inject(ChallengesService) private readonly challenges: ChallengesService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: Config
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: { channel: Channel; intent?: Intent }, @Req() req: Request) {
    const accountId = optionalAccount(req, this.auth);
    return this.challenges.create(body.channel, body.intent ?? 'signin', accountId, req.ip ?? 'unknown');
  }

  @Get(':challengeId')
  status(@Param('challengeId') challengeId: string) {
    return this.challenges.status(challengeId);
  }

  @Post(':challengeId/redeem')
  @HttpCode(200)
  async redeem(
    @Param('challengeId') challengeId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    const accountId = optionalAccount(req, this.auth);
    const result = await this.challenges.redeem(challengeId, accountId, req.headers['user-agent'] ?? null);
    setRefreshCookie(res, this.config, result.refreshToken);
    return withoutRefreshToken(result);
  }
}
