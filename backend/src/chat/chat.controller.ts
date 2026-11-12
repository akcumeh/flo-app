import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { AuthedRequest, JwtGuard } from '../auth/jwt.guard.js';
import { CONFIG, type Config } from '../config.js';
import { ChatService, type SendInput } from './chat.service.js';
import { GuestService } from './guest.service.js';
import { openSse } from './sse.js';

const DEVICE_COOKIE = 'flo_gd';

@Controller('v1')
@UseGuards(JwtGuard)
export class ChatController {
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  @Get('conversations')
  list(@Req() req: AuthedRequest, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.chat.list(req.accountId, cursor, Number(limit ?? 25));
  }

  @Post('conversations')
  @HttpCode(201)
  create(@Req() req: AuthedRequest, @Body() body: { mode?: 'ask' | 'prep' } = {}) {
    return this.chat.create(req.accountId, body?.mode ?? 'ask');
  }

  @Patch('conversations/:conversationId')
  rename(@Req() req: AuthedRequest, @Param('conversationId') id: string, @Body() body: { title: string }) {
    return this.chat.rename(req.accountId, id, body.title);
  }

  @Delete('conversations/:conversationId')
  @HttpCode(204)
  async remove(@Req() req: AuthedRequest, @Param('conversationId') id: string) {
    await this.chat.remove(req.accountId, id);
  }

  @Get('conversations/:conversationId/messages')
  messages(
    @Req() req: AuthedRequest,
    @Param('conversationId') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string
  ) {
    return this.chat.messages(req.accountId, id, cursor, Number(limit ?? 25));
  }

  @Post('conversations/:conversationId/messages')
  async send(
    @Req() req: AuthedRequest,
    @Res() res: Response,
    @Param('conversationId') id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: SendInput
  ) {
    const prepared = await this.chat.prepare(req.accountId, id, key, body);
    if ('replay' in prepared) {
      res.status(200).json(prepared.replay);
      return;
    }
    await prepared.run(openSse(req, res));
  }

  @Put('messages/:messageId/saved')
  @HttpCode(204)
  async setSaved(@Req() req: AuthedRequest, @Param('messageId') id: string, @Body() body: { saved: boolean }) {
    await this.chat.setSaved(req.accountId, id, body.saved);
  }

  @Get('saved-answers')
  saved(@Req() req: AuthedRequest, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.chat.savedAnswers(req.accountId, cursor, Number(limit ?? 25));
  }
}

@Controller('v1/guest')
export class GuestController {
  constructor(
    @Inject(GuestService) private readonly guests: GuestService,
    @Inject(CONFIG) private readonly config: Config
  ) {}

  @Post('sessions')
  @HttpCode(201)
  create(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    let device = (req.cookies as Record<string, string> | undefined)?.[DEVICE_COOKIE];
    if (!device || !/^[A-Za-z0-9_-]{32}$/.test(device)) {
      device = randomBytes(24).toString('base64url');
      res.cookie(DEVICE_COOKIE, device, {
        httpOnly: true,
        secure: this.config.cookieSecure,
        sameSite: 'lax',
        path: '/v1/guest',
        maxAge: 365 * 24 * 60 * 60 * 1000,
      });
    }
    return this.guests.create(device, req.ip ?? 'unknown');
  }

  @Post('messages')
  async send(@Req() req: Request, @Res() res: Response, @Headers('x-guest-token') token: string | undefined, @Body() body: { text: string }) {
    const run = await this.guests.prepare(token, body.text);
    await run(openSse(req, res));
  }
}

@Controller('v1/guest')
@UseGuards(JwtGuard)
export class GuestClaimController {
  constructor(@Inject(GuestService) private readonly guests: GuestService) {}

  @Post('claim')
  @HttpCode(200)
  claim(@Req() req: AuthedRequest, @Body() body: { guestToken: string }) {
    return this.guests.claim(req.accountId, body.guestToken);
  }
}
