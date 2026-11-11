import { Body, Controller, Get, Inject, Patch, Req, UseGuards } from '@nestjs/common';
import { AuthedRequest, JwtGuard } from '../auth/jwt.guard.js';
import { AccountsService } from './accounts.service.js';

@Controller('v1/me')
@UseGuards(JwtGuard)
export class AccountsController {
  constructor(@Inject(AccountsService) private readonly accounts: AccountsService) {}

  @Get()
  me(@Req() req: AuthedRequest) {
    return this.accounts.view(req.accountId);
  }

  @Patch()
  update(
    @Req() req: AuthedRequest,
    @Body() body: { displayName?: string; username?: string | null; timezone?: string }
  ) {
    return this.accounts.update(req.accountId, body);
  }
}
