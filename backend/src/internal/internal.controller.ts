import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { ChallengesService, type Channel } from '../auth/challenges.service.js';
import { ServiceKeyGuard } from './service-key.guard.js';

@Controller('internal/v1')
@UseGuards(ServiceKeyGuard)
export class InternalController {
  constructor(@Inject(ChallengesService) private readonly challenges: ChallengesService) {}

  @Post('auth/challenges/claim')
  @HttpCode(200)
  claim(
    @Body()
    body: { code: string; provider: Channel; providerUserId: string; displayName?: string; username?: string }
  ) {
    return this.challenges.claim(body);
  }
}
