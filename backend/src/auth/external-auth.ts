import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { AppError } from '../common/app-error.js';
import type { Config } from '../config.js';

export interface GoogleClaims {
    sub: string;
    email?: string;
    emailVerified: boolean;
    hd?: string;
    name?: string;
}

export interface TelegramClaims {
    id: string;
    name?: string;
    username?: string;
}

export interface ExternalAuth {
    verifyGoogle(idToken: string): Promise<GoogleClaims>;
    exchangeTelegram(
        code: string,
        codeVerifier: string,
        redirectUri: string
    ): Promise<TelegramClaims>;
}

export const EXTERNAL_AUTH = Symbol('EXTERNAL_AUTH');

export interface ExternalAuthOptions {
    fetchImpl?: typeof fetch;
    googleKeys?: JWTVerifyGetKey;
    telegramKeys?: JWTVerifyGetKey;
}

interface TelegramProvider {
    issuer: string;
    tokenEndpoint: string;
    keys: JWTVerifyGetKey;
}

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const TELEGRAM_DISCOVERY = 'https://oauth.telegram.org/.well-known/openid-configuration';

const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value ? value : undefined;

export class JoseExternalAuth implements ExternalAuth {
    private googleKeys?: JWTVerifyGetKey;
    private telegram?: Promise<TelegramProvider>;
    private readonly fetchImpl: typeof fetch;

    constructor(
        private readonly config: Config,
        private readonly options: ExternalAuthOptions = {}
    ) {
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.googleKeys = options.googleKeys;
    }

    async verifyGoogle(idToken: string): Promise<GoogleClaims> {
        const audience = this.config.googleClientId;
        if (!audience)
            throw AppError.unavailable('channel_unavailable', 'Google sign-in is not set up yet.');
        this.googleKeys ??= createRemoteJWKSet(new URL(GOOGLE_JWKS));

        let payload: JWTPayload;
        try {
            ({ payload } = await jwtVerify(idToken, this.googleKeys, {
                issuer: GOOGLE_ISSUERS,
                audience,
            }));
        } catch {
            throw AppError.unauthorized(
                'invalid_id_token',
                'The Google sign-in could not be verified. Try again.'
            );
        }
        const sub = text(payload.sub);
        if (!sub)
            throw AppError.unauthorized(
                'invalid_id_token',
                'The Google sign-in could not be verified. Try again.'
            );
        return {
            sub,
            email: text(payload.email)?.toLowerCase(),
            emailVerified: payload.email_verified === true,
            hd: text(payload.hd)?.toLowerCase(),
            name: text(payload.name),
        };
    }

    private async telegramProvider(): Promise<TelegramProvider> {
        this.telegram ??= (async () => {
            const res = await this.fetchImpl(TELEGRAM_DISCOVERY, {
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) throw new Error(`Telegram discovery answered ${res.status}`);
            const d = (await res.json()) as {
                issuer: string;
                token_endpoint: string;
                jwks_uri: string;
            };
            return {
                issuer: d.issuer,
                tokenEndpoint: d.token_endpoint,
                keys: this.options.telegramKeys ?? createRemoteJWKSet(new URL(d.jwks_uri)),
            };
        })();
        try {
            return await this.telegram;
        } catch {
            this.telegram = undefined;
            throw AppError.unavailable(
                'channel_unavailable',
                'Telegram sign-in cannot be reached right now. Try again.'
            );
        }
    }

    async exchangeTelegram(
        code: string,
        codeVerifier: string,
        redirectUri: string
    ): Promise<TelegramClaims> {
        const clientId = this.config.telegramOidcClientId;
        const clientSecret = this.config.telegramOidcClientSecret;
        if (!clientId || !clientSecret) {
            throw AppError.unavailable(
                'channel_unavailable',
                'Log in with Telegram is not set up yet.'
            );
        }
        const provider = await this.telegramProvider();
        const refused = AppError.unauthorized(
            'invalid_telegram_auth',
            'Telegram did not accept this sign-in. Start again.'
        );

        const res = await this.fetchImpl(provider.tokenEndpoint, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                code_verifier: codeVerifier,
                redirect_uri: redirectUri,
                client_id: clientId,
            }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw refused;
        const idToken = text(((await res.json()) as { id_token?: unknown }).id_token);
        if (!idToken) throw refused;

        let payload: JWTPayload;
        try {
            ({ payload } = await jwtVerify(idToken, provider.keys, {
                issuer: provider.issuer,
                audience: clientId,
            }));
        } catch {
            throw refused;
        }
        const id = payload.id ?? payload.sub;
        if (typeof id !== 'string' && typeof id !== 'number') throw refused;
        return {
            id: String(id),
            name: text(payload.name),
            username: text(payload.preferred_username),
        };
    }
}
