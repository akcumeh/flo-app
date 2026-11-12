import { Body, Controller, Get, HttpCode, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { ChallengesService, type Channel } from '../auth/challenges.service.js';
import { BotEventsService, type BotEventInput } from './bot-events.service.js';
import { ServiceKeyGuard } from './service-key.guard.js';

@Controller('internal/v1')
@UseGuards(ServiceKeyGuard)
export class InternalController {
    constructor(
        @Inject(ChallengesService) private readonly challenges: ChallengesService,
        @Inject(BotEventsService) private readonly events: BotEventsService
    ) {}

    @Post('events')
    @HttpCode(200)
    event(@Body() body: BotEventInput) {
        return this.events.record(body);
    }

    @Get('streak')
    streak(
        @Query('provider') provider: 'telegram' | 'whatsapp',
        @Query('providerUserId') providerUserId: string
    ) {
        return this.events.streak(provider, providerUserId);
    }

    @Post('auth/challenges/claim')
    @HttpCode(200)
    claim(
        @Body()
        body: {
            code: string;
            provider: Channel;
            providerUserId: string;
            displayName?: string;
            username?: string;
        }
    ) {
        return this.challenges.claim(body);
    }
}
