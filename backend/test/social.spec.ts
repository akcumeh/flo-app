import { createHash, createHmac } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { JoseExternalAuth } from '../src/auth/external-auth.js';
import { Harness, TEST_ENV, bearer, seedSchool, signIn, startHarness } from './helpers.js';

const GOOGLE_CLIENT = 'florence-test.apps.googleusercontent.com';
const TG_CLIENT = '123456789';
const TG_ISSUER = 'https://oauth.telegram.org';

let googleKey: CryptoKey;
let telegramKey: CryptoKey;
const tgCodes = new Map<string, string>();

function widget(fields: Record<string, string | number>, token = TEST_ENV.TELEGRAM_BOT_TOKEN) {
    const check = Object.keys(fields)
        .sort()
        .map((k) => `${k}=${fields[k]}`)
        .join('\n');
    const secret = createHash('sha256').update(token).digest();
    return { ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') };
}

const now = () => Math.floor(Date.now() / 1000);

async function googleToken(claims: Record<string, unknown>, audience = GOOGLE_CLIENT) {
    return new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'g1' })
        .setIssuer('https://accounts.google.com')
        .setAudience(audience)
        .setSubject(String(claims.sub))
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(googleKey);
}

async function telegramCode(id: number, name: string) {
    const token = await new SignJWT({ id, name, preferred_username: `user${id}` })
        .setProtectedHeader({ alg: 'RS256', kid: 't1' })
        .setIssuer(TG_ISSUER)
        .setAudience(TG_CLIENT)
        .setSubject(`tg${id}`)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(telegramKey);
    const code = `code-${id}-${Math.random()}`;
    tgCodes.set(code, token);
    return code;
}

const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/.well-known/openid-configuration')) {
        return Response.json({
            issuer: TG_ISSUER,
            token_endpoint: `${TG_ISSUER}/token`,
            jwks_uri: `${TG_ISSUER}/jwks`,
        });
    }
    if (url === `${TG_ISSUER}/token`) {
        const auth = new Headers(init?.headers).get('authorization');
        if (auth !== `Basic ${Buffer.from(`${TG_CLIENT}:tg-secret`).toString('base64')}`)
            return new Response('', { status: 401 });
        const code = new URLSearchParams(String(init?.body)).get('code') ?? '';
        const idToken = tgCodes.get(code);
        tgCodes.delete(code);
        return idToken ? Response.json({ id_token: idToken }) : new Response('', { status: 400 });
    }
    return new Response('', { status: 404 });
};

describe('telegram and google sign-in', () => {
    let h: Harness;

    beforeAll(async () => {
        const g = await generateKeyPair('RS256');
        const t = await generateKeyPair('RS256');
        googleKey = g.privateKey;
        telegramKey = t.privateKey;
        const googleKeys = createLocalJWKSet({
            keys: [{ ...(await exportJWK(g.publicKey)), kid: 'g1', alg: 'RS256' }],
        });
        const telegramKeys = createLocalJWKSet({
            keys: [{ ...(await exportJWK(t.publicKey)), kid: 't1', alg: 'RS256' }],
        });
        h = await startHarness(
            {
                GOOGLE_CLIENT_ID: GOOGLE_CLIENT,
                TELEGRAM_OIDC_CLIENT_ID: TG_CLIENT,
                TELEGRAM_OIDC_CLIENT_SECRET: 'tg-secret',
            },
            {
                externalAuth: (config) =>
                    new JoseExternalAuth(config, {
                        fetchImpl: fakeFetch,
                        googleKeys,
                        telegramKeys,
                    }),
            }
        );
        await seedSchool(h, 'University of Lagos', 'unilag.edu.ng');
    });

    afterAll(async () => {
        await h.close();
    });

    const tg = (body: object, token?: string) => {
        const req = h.http().post('/v1/auth/telegram/oidc');
        if (token) req.set(bearer(token));
        return req.send(body);
    };
    const google = (idToken: string, token?: string) => {
        const req = h.http().post('/v1/auth/google');
        if (token) req.set(bearer(token));
        return req.send({ idToken });
    };

    it('signs a new user in with the Login Widget and grants 10 tokens', async () => {
        const res = await tg(
            widget({ id: 5550001, first_name: 'Chidi', username: 'chidi_o', auth_date: now() })
        ).expect(200);
        expect(res.body.isNewAccount).toBe(true);
        expect(res.body.welcomeGrant).toEqual({ granted: true, tokens: 10 });
        expect(res.body.account.identities[0]).toMatchObject({
            provider: 'telegram',
            display: '@chidi_o',
        });
        expect(res.headers['set-cookie'][0]).toMatch(/^flo_rt=/);

        const again = await tg(
            widget({ id: 5550001, first_name: 'Chidi', auth_date: now() })
        ).expect(200);
        expect(again.body.account.id).toBe(res.body.account.id);
        expect(again.body.welcomeGrant.granted).toBe(false);
    });

    it('refuses a widget payload with a wrong hash', async () => {
        const body = widget({ id: 5550002, first_name: 'Eve', auth_date: now() });
        const res = await tg({ ...body, first_name: 'Mallory' }).expect(401);
        expect(res.body.code).toBe('invalid_telegram_auth');
    });

    it('refuses a widget payload signed with another bot token', async () => {
        const res = await tg(
            widget({ id: 5550003, first_name: 'Eve', auth_date: now() }, '999:other-bot')
        ).expect(401);
        expect(res.body.code).toBe('invalid_telegram_auth');
    });

    it('refuses a widget payload older than a day', async () => {
        const res = await tg(
            widget({ id: 5550004, first_name: 'Old', auth_date: now() - 90_000 })
        ).expect(401);
        expect(res.body.code).toBe('invalid_telegram_auth');
    });

    it('reaches the same account as a bot challenge for the same Telegram id', async () => {
        const c = await h
            .http()
            .post('/v1/auth/challenges')
            .set('X-Forwarded-For', '10.200.0.1')
            .send({ channel: 'telegram' })
            .expect(201);
        await h
            .http()
            .post('/internal/v1/auth/challenges/claim')
            .set('X-Service-Key', TEST_ENV.INTERNAL_API_SECRET)
            .send({ code: c.body.code, provider: 'telegram', providerUserId: '5550005' })
            .expect(200);
        const viaBot = await h
            .http()
            .post(`/v1/auth/challenges/${c.body.challengeId}/redeem`)
            .expect(200);
        const viaWidget = await tg(
            widget({ id: 5550005, first_name: 'Ngozi', auth_date: now() })
        ).expect(200);
        expect(viaWidget.body.account.id).toBe(viaBot.body.account.id);
    });

    it('signs in with the OIDC code flow and keys the identity on the id claim', async () => {
        const code = await telegramCode(5550006, 'Tunde Bakare');
        const body = {
            code,
            codeVerifier: 'v'.repeat(43),
            redirectUri: 'http://localhost:5180/auth/telegram/callback',
        };
        const res = await tg(body).expect(200);
        expect(res.body.account.displayName).toBe('Tunde Bakare');

        const viaWidget = await tg(
            widget({ id: 5550006, first_name: 'Tunde', auth_date: now() })
        ).expect(200);
        expect(viaWidget.body.account.id).toBe(res.body.account.id);
    });

    it('refuses an OIDC code Telegram does not accept', async () => {
        const body = {
            code: 'never-issued',
            codeVerifier: 'v'.repeat(43),
            redirectUri: 'http://localhost:5180/cb',
        };
        const res = await tg(body).expect(401);
        expect(res.body.code).toBe('invalid_telegram_auth');
    });

    it('signs a new user in with Google', async () => {
        const idToken = await googleToken({
            sub: 'g-1001',
            email: 'ada.lovelace@gmail.com',
            email_verified: true,
            name: 'Ada L',
        });
        const res = await google(idToken).expect(200);
        expect(res.body.isNewAccount).toBe(true);
        expect(res.body.account.displayName).toBe('Ada L');
        expect(res.body.account.identities[0]).toMatchObject({
            provider: 'google',
            display: 'a***@gmail.com',
        });
        expect(res.body.account.student.status).toBe('none');
    });

    it('verifies a student from the hd claim and grants the student bonus once', async () => {
        const claims = {
            sub: 'g-1002',
            email: 'bola@unilag.edu.ng',
            email_verified: true,
            hd: 'unilag.edu.ng',
            name: 'Bola',
        };
        const res = await google(await googleToken(claims)).expect(200);
        expect(res.body.account.student).toMatchObject({
            status: 'verified',
            institution: 'University of Lagos',
        });
        expect(res.body.account.tokenBalance).toBe(20);

        const again = await google(await googleToken(claims)).expect(200);
        expect(again.body.account.tokenBalance).toBe(20);
    });

    it('does not verify a student when the email is unverified', async () => {
        const claims = {
            sub: 'g-1003',
            email: 'kemi@unilag.edu.ng',
            email_verified: false,
            hd: 'unilag.edu.ng',
        };
        const res = await google(await googleToken(claims)).expect(200);
        expect(res.body.account.student.status).toBe('none');
        expect(res.body.account.tokenBalance).toBe(10);
    });

    it('refuses a Google token for another client', async () => {
        const idToken = await googleToken({ sub: 'g-1004', email: 'x@gmail.com' }, 'someone-else');
        const res = await google(idToken).expect(401);
        expect(res.body.code).toBe('invalid_id_token');
    });

    it('links Google to a signed-in account', async () => {
        const me = await signIn(h);
        const idToken = await googleToken({
            sub: 'g-1005',
            email: 'link.me@gmail.com',
            email_verified: true,
        });
        const res = await google(idToken, me.body.accessToken).expect(200);
        expect(res.body.account.id).toBe(me.body.account.id);
        expect(res.body.account.identities.map((i: { provider: string }) => i.provider)).toEqual([
            'email',
            'google',
        ]);
        expect(res.body.isNewAccount).toBe(false);
    });

    it('offers a merge when the Telegram account belongs to someone else', async () => {
        await tg(widget({ id: 5550007, first_name: 'Other', auth_date: now() })).expect(200);
        const me = await signIn(h);
        const res = await tg(
            widget({ id: 5550007, first_name: 'Other', auth_date: now() }),
            me.body.accessToken
        ).expect(409);
        expect(res.body.code).toBe('identity_belongs_to_other_account');
        expect(res.body.mergeToken).toMatch(/^mrg_/);
    });
});

describe('sign-in without provider settings', () => {
    let h: Harness;

    beforeAll(async () => {
        h = await startHarness({ TELEGRAM_BOT_TOKEN: '' });
    });

    afterAll(async () => {
        await h.close();
    });

    it('answers 503 channel_unavailable for Google, the widget and OIDC', async () => {
        const g = await h
            .http()
            .post('/v1/auth/google')
            .send({ idToken: 'x'.repeat(40) })
            .expect(503);
        expect(g.body.code).toBe('channel_unavailable');
        const w = await h
            .http()
            .post('/v1/auth/telegram/oidc')
            .send(widget({ id: 1, first_name: 'A', auth_date: now() }))
            .expect(503);
        expect(w.body.code).toBe('channel_unavailable');
        const o = await h
            .http()
            .post('/v1/auth/telegram/oidc')
            .send({ code: 'c', codeVerifier: 'v'.repeat(43), redirectUri: 'http://localhost/cb' })
            .expect(503);
        expect(o.body.code).toBe('channel_unavailable');
    });
});
