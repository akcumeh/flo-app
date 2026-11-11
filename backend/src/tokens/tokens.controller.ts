import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { AuthedRequest, JwtGuard } from '../auth/jwt.guard.js';
import { TokensService } from './tokens.service.js';

@Controller('v1/tokens')
@UseGuards(JwtGuard)
export class TokensController {
  constructor(@Inject(TokensService) private readonly tokens: TokensService) {}

  @Get()
  async balance(@Req() req: AuthedRequest) {
    return { balance: await this.tokens.balance(req.accountId) };
  }

  @Get('ledger')
  ledger(@Req() req: AuthedRequest, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.tokens.ledger(req.accountId, cursor, limit ? Number(limit) : 25);
  }
}
