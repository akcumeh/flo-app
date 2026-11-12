import { Inject, Injectable } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import { StudentService } from '../accounts/student.service.js';
import { AppError } from '../common/app-error.js';
import { safeEqual } from '../common/crypto.js';
import { CONFIG, type Config } from '../config.js';
import { AuthService, type AfterProof, type SignInResult } from './auth.service.js';
import { EXTERNAL_AUTH, type ExternalAuth, type TelegramClaims } from './external-auth.js';
import { IdentityService, type ProvenIdentity } from './identity.service.js';

export interface TelegramWidgetAuth {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
    photo_url?: string;
    auth_date: number;
    hash: string;
}

export interface TelegramOidcCode {
    code: string;
    codeVerifier: string;
    redirectUri: string;
}

const WIDGET_MAX_AGE_SECONDS = 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 300;

@Injectable()
export class SocialAuthService {
    constructor(
        @Inject(CONFIG) private readonly config: Config,
        @Inject(EXTERNAL_AUTH) private readonly external: ExternalAuth,
        @Inject(AuthService) private readonly auth: AuthService,
        @Inject(StudentService) private readonly students: StudentService
    ) {}

    verifyWidget(data: TelegramWidgetAuth, now = Math.floor(Date.now() / 1000)): TelegramClaims {
        const token = this.config.telegramBotToken;
        if (!token)
            throw AppError.unavailable(
                'channel_unavailable',
                'Telegram sign-in is not set up yet.'
            );

        const { hash, ...fields } = data;
        const checkString = Object.entries(fields)
            .filter(([, value]) => value !== undefined && value !== null)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');
        const secret = createHash('sha256').update(token).digest();
        const expected = createHmac('sha256', secret).update(checkString).digest('hex');
        if (!safeEqual(expected, hash)) {
            throw AppError.unauthorized(
                'invalid_telegram_auth',
                'Telegram did not confirm this sign-in. Try again.'
            );
        }
        if (
            now - data.auth_date > WIDGET_MAX_AGE_SECONDS ||
            data.auth_date - now > CLOCK_SKEW_SECONDS
        ) {
            throw AppError.unauthorized(
                'invalid_telegram_auth',
                'This Telegram sign-in is too old. Try again.'
            );
        }
        return {
            id: String(data.id),
            name: [data.first_name, data.last_name].filter(Boolean).join(' ') || undefined,
            username: data.username,
        };
    }

    async telegram(
        body: TelegramWidgetAuth | TelegramOidcCode,
        accountId: string | null,
        userAgent: string | null
    ): Promise<SignInResult> {
        const claims =
            'hash' in body
                ? this.verifyWidget(body)
                : await this.external.exchangeTelegram(
                      body.code,
                      body.codeVerifier,
                      body.redirectUri
                  );
        const identity: ProvenIdentity = {
            provider: 'telegram',
            providerUserId: claims.id,
            display: IdentityService.telegramDisplay(claims.username, claims.name),
            displayName: claims.name ?? claims.username ?? 'Student',
        };
        return this.auth.prove(accountId, userAgent, async () => identity);
    }

    async google(
        idToken: string,
        accountId: string | null,
        userAgent: string | null
    ): Promise<SignInResult> {
        const c = await this.external.verifyGoogle(idToken);
        const local = c.email?.split('@')[0];
        const identity: ProvenIdentity = {
            provider: 'google',
            providerUserId: c.sub,
            display: c.email ? IdentityService.maskEmail(c.email) : 'Google account',
            displayName:
                c.name ?? (local ? local.charAt(0).toUpperCase() + local.slice(1, 40) : 'Student'),
        };

        const email = c.email;
        const hd = c.hd;
        let after: AfterProof | undefined;
        if (email && hd && c.emailVerified && email.endsWith(`@${hd}`)) {
            after = async (q, id) => {
                const school = await this.students.schoolFor(q, hd);
                if (school)
                    await this.students.grant(
                        q,
                        id,
                        StudentService.canonical(email),
                        school.id,
                        'google_hd'
                    );
            };
        }
        return this.auth.prove(accountId, userAgent, async () => identity, after);
    }
}
