import {
    Body,
    Controller,
    Delete,
    Get,
    Headers,
    HttpCode,
    Inject,
    Param,
    Post,
    Put,
    Req,
    UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthedRequest, JwtGuard } from '../auth/jwt.guard.js';
import { BUNDLES, PurchasesService } from '../money/purchases.service.js';
import { AccountLifecycleService } from './account-lifecycle.service.js';
import { NotificationsService, type Preferences } from './notifications.service.js';
import { ReferralsService } from './referrals.service.js';

@Controller('v1')
export class PublicPlatformController {
    constructor(
        @Inject(NotificationsService) private readonly notifications: NotificationsService,
        @Inject(PurchasesService) private readonly purchases: PurchasesService
    ) {}

    @Get('tokens/bundles')
    bundles() {
        return { items: BUNDLES };
    }

    @Get('push/vapid-key')
    vapid() {
        return this.notifications.vapidKey();
    }

    @Post('webhooks/paystack')
    @HttpCode(200)
    async paystack(
        @Req() req: Request & { rawBody?: Buffer },
        @Headers('x-paystack-signature') signature: string | undefined,
        @Body()
        body: { event?: string; data?: { reference?: string; amount?: number; channel?: string } }
    ) {
        await this.purchases.webhook(req.rawBody, signature, body);
        return { received: true };
    }
}

@Controller('v1')
@UseGuards(JwtGuard)
export class PlatformController {
    constructor(
        @Inject(PurchasesService) private readonly purchases: PurchasesService,
        @Inject(NotificationsService) private readonly notifications: NotificationsService,
        @Inject(ReferralsService) private readonly referrals: ReferralsService,
        @Inject(AccountLifecycleService) private readonly lifecycle: AccountLifecycleService
    ) {}

    @Post('tokens/purchases')
    @HttpCode(201)
    createPurchase(
        @Req() req: AuthedRequest,
        @Headers('idempotency-key') key: string | undefined,
        @Body() body: { bundleId: string; email?: string; method?: 'card' | 'bank_transfer' }
    ) {
        return this.purchases.create(req.accountId, key, body);
    }

    @Get('tokens/purchases/:reference')
    getPurchase(@Req() req: AuthedRequest, @Param('reference') reference: string) {
        return this.purchases.get(req.accountId, reference);
    }

    @Post('push/subscriptions')
    @HttpCode(201)
    subscribe(
        @Req() req: AuthedRequest,
        @Body() body: { endpoint: string; keys: { p256dh: string; auth: string } }
    ) {
        return this.notifications.subscribe(req.accountId, body, req.headers['user-agent'] ?? null);
    }

    @Delete('push/subscriptions/:subscriptionId')
    @HttpCode(204)
    async unsubscribe(@Req() req: AuthedRequest, @Param('subscriptionId') id: string) {
        await this.notifications.unsubscribe(req.accountId, id);
    }

    @Get('me/notification-preferences')
    preferences(@Req() req: AuthedRequest) {
        return this.notifications.get(req.accountId);
    }

    @Put('me/notification-preferences')
    setPreferences(@Req() req: AuthedRequest, @Body() body: Preferences) {
        return this.notifications.set(req.accountId, body);
    }

    @Get('me/referral')
    referral(@Req() req: AuthedRequest) {
        return this.referrals.get(req.accountId);
    }

    @Post('me/export')
    @HttpCode(202)
    async export(@Req() req: AuthedRequest) {
        await this.lifecycle.requestExport(req.accountId);
    }

    @Post('me/delete')
    @HttpCode(202)
    deleteAccount(@Req() req: AuthedRequest) {
        return this.lifecycle.requestDeletion(req.accountId);
    }
}
