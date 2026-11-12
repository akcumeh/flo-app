import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CONFIG, type Config } from '../config.js';
import { AuthService, type SignInResult } from './auth.service.js';
import { optionalAccount } from './jwt.guard.js';
import {
    clearRefreshCookie,
    refreshTokenFrom,
    setRefreshCookie,
    withoutRefreshToken,
} from './refresh-cookie.js';
import {
    SocialAuthService,
    type TelegramOidcCode,
    type TelegramWidgetAuth,
} from './social.service.js';

@Controller('v1/auth')
export class AuthController {
    constructor(
        @Inject(AuthService) private readonly auth: AuthService,
        @Inject(SocialAuthService) private readonly social: SocialAuthService,
        @Inject(CONFIG) private readonly config: Config
    ) {}

    private session(res: Response, result: SignInResult) {
        setRefreshCookie(res, this.config, result.refreshToken);
        return withoutRefreshToken(result);
    }

    @Post('telegram/oidc')
    @HttpCode(200)
    async telegram(
        @Body() body: TelegramWidgetAuth | TelegramOidcCode,
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response
    ) {
        const accountId = optionalAccount(req, this.auth);
        return this.session(
            res,
            await this.social.telegram(body, accountId, req.headers['user-agent'] ?? null)
        );
    }

    @Post('google')
    @HttpCode(200)
    async google(
        @Body() body: { idToken: string },
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response
    ) {
        const accountId = optionalAccount(req, this.auth);
        return this.session(
            res,
            await this.social.google(body.idToken, accountId, req.headers['user-agent'] ?? null)
        );
    }

    @Post('whatsapp/start')
    @HttpCode(202)
    async startWhatsApp(@Body() body: { phone: string }, @Req() req: Request) {
        optionalAccount(req, this.auth);
        return this.auth.startWhatsApp(body.phone, req.ip ?? 'unknown');
    }

    @Post('whatsapp/verify')
    @HttpCode(200)
    async verifyWhatsApp(
        @Body() body: { phone: string; code: string },
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response
    ) {
        const accountId = optionalAccount(req, this.auth);
        return this.session(
            res,
            await this.auth.verifyWhatsApp(
                body.phone,
                body.code,
                accountId,
                req.headers['user-agent'] ?? null
            )
        );
    }

    @Post('email/start')
    @HttpCode(202)
    async startEmail(@Body() body: { email: string }, @Req() req: Request) {
        optionalAccount(req, this.auth);
        await this.auth.startEmail(body.email, req.ip ?? 'unknown');
    }

    @Post('email/verify')
    @HttpCode(200)
    async verifyEmail(
        @Body() body: { email: string; code: string },
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response
    ) {
        const accountId = optionalAccount(req, this.auth);
        return this.session(
            res,
            await this.auth.verifyEmail(
                body.email,
                body.code,
                accountId,
                req.headers['user-agent'] ?? null
            )
        );
    }

    @Post('refresh')
    @HttpCode(200)
    async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
        const tokens = await this.auth.refresh(
            refreshTokenFrom(req),
            req.headers['user-agent'] ?? null
        );
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
