import { Harness, TEST_ENV, signIn, startHarness, uniqueIp } from './helpers.js';

const KEY = TEST_ENV.INTERNAL_API_SECRET;

describe('auth challenges', () => {
    let h: Harness;

    beforeAll(async () => {
        h = await startHarness();
    });

    afterAll(async () => {
        await h.close();
    });

    async function start(
        channel: 'telegram' | 'whatsapp',
        bearer?: string,
        intent?: 'signin' | 'link'
    ) {
        const req = h.http().post('/v1/auth/challenges').set('X-Forwarded-For', uniqueIp());
        if (bearer) req.set('Authorization', `Bearer ${bearer}`);
        const res = await req.send(intent ? { channel, intent } : { channel }).expect(201);
        return res.body as {
            challengeId: string;
            code: string;
            deepLink: string;
            expiresAt: string;
        };
    }

    function claim(
        code: string,
        provider: 'telegram' | 'whatsapp',
        providerUserId: string,
        extra = {}
    ) {
        return h
            .http()
            .post('/internal/v1/auth/challenges/claim')
            .set('X-Service-Key', KEY)
            .send({ code, provider, providerUserId, ...extra });
    }

    function redeem(challengeId: string, bearer?: string) {
        const req = h.http().post(`/v1/auth/challenges/${challengeId}/redeem`);
        if (bearer) req.set('Authorization', `Bearer ${bearer}`);
        return req;
    }

    it('creates a telegram challenge with a deep link and a secret id', async () => {
        const c = await start('telegram');
        expect(c.code).toMatch(/^FLO-[0-9]{6}$/);
        expect(c.challengeId).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(c.deepLink).toBe(`https://t.me/florence_test_bot?start=login_${c.code}`);
        await h
            .http()
            .get(`/v1/auth/challenges/${c.challengeId}`)
            .expect(200)
            .expect((r) => {
                expect(r.body.status).toBe('pending');
            });
    });

    it('builds a wa.me link with the code prefilled', async () => {
        const c = await start('whatsapp');
        expect(c.deepLink).toBe(`https://wa.me/2348000000000?text=${c.code}`);
    });

    it('answers challenge_pending before the bot claims it', async () => {
        const c = await start('telegram');
        const res = await redeem(c.challengeId).expect(409);
        expect(res.body.code).toBe('challenge_pending');
    });

    it('signs a new telegram user in once the bot claims the code, with 10 tokens', async () => {
        const c = await start('telegram');
        await claim(c.code, 'telegram', '700000001', {
            displayName: 'Ada',
            username: 'ada_o',
        }).expect(200, { status: 'verified' });
        await h
            .http()
            .get(`/v1/auth/challenges/${c.challengeId}`)
            .expect(200)
            .expect((r) => {
                expect(r.body.status).toBe('verified');
            });

        const res = await redeem(c.challengeId).expect(200);
        expect(res.body.isNewAccount).toBe(true);
        expect(res.body.welcomeGrant).toEqual({ granted: true, tokens: 10 });
        expect(res.body.account.displayName).toBe('Ada');
        expect(res.body.account.identities[0]).toMatchObject({
            provider: 'telegram',
            display: '@ada_o',
        });
        expect(res.headers['set-cookie'][0]).toMatch(/^flo_rt=/);
    });

    it('signs a returning whatsapp user into the same account without a second grant', async () => {
        const first = await start('whatsapp');
        await claim(first.code, 'whatsapp', '2348012345678').expect(200);
        const a = await redeem(first.challengeId).expect(200);

        const again = await start('whatsapp');
        await claim(again.code, 'whatsapp', '2348012345678').expect(200);
        const b = await redeem(again.challengeId).expect(200);

        expect(b.body.account.id).toBe(a.body.account.id);
        expect(b.body.isNewAccount).toBe(false);
        expect(b.body.welcomeGrant.granted).toBe(false);
        expect(b.body.account.tokenBalance).toBe(10);
        expect(b.body.account.identities[0].display).toBe('+234 80* *** 5678');
    });

    it('refuses a replayed challenge', async () => {
        const c = await start('telegram');
        await claim(c.code, 'telegram', '700000002').expect(200);
        await redeem(c.challengeId).expect(200);
        const res = await redeem(c.challengeId).expect(409);
        expect(res.body.code).toBe('challenge_already_redeemed');
    });

    it('refuses a second claim of the same code', async () => {
        const c = await start('telegram');
        await claim(c.code, 'telegram', '700000003').expect(200);
        const res = await claim(c.code, 'telegram', '700000099').expect(409);
        expect(res.body.code).toBe('challenge_already_claimed');
    });

    it('expires a challenge after 10 minutes', async () => {
        const c = await start('telegram');
        await claim(c.code, 'telegram', '700000004').expect(200);
        await h.db.query(
            `update auth_challenges set expires_at = now() - interval '1 second' where code = $1`,
            [c.code]
        );
        await h
            .http()
            .get(`/v1/auth/challenges/${c.challengeId}`)
            .expect(200)
            .expect((r) => {
                expect(r.body.status).toBe('expired');
            });
        const res = await redeem(c.challengeId).expect(410);
        expect(res.body.code).toBe('challenge_expired');
        await claim(c.code, 'telegram', '700000004').expect(404);
    });

    it('answers 404 to the bot for an unknown code', async () => {
        const res = await claim('FLO-000000', 'whatsapp', '2348000000001').expect(404);
        expect(res.body.code).toBe('not_found');
    });

    it('does not let a whatsapp claim use a telegram code', async () => {
        const c = await start('telegram');
        await claim(c.code, 'whatsapp', '2348000000002').expect(404);
    });

    it('rejects the internal endpoint without the service key', async () => {
        const c = await start('telegram');
        const res = await h
            .http()
            .post('/internal/v1/auth/challenges/claim')
            .set('X-Service-Key', 'wrong')
            .send({ code: c.code, provider: 'telegram', providerUserId: '1' })
            .expect(401);
        expect(res.body.code).toBe('invalid_service_key');
    });

    it('answers 404 for an unknown challenge id', async () => {
        await h
            .http()
            .get(`/v1/auth/challenges/${'a'.repeat(43)}`)
            .expect(404);
    });

    it('needs a session to start a link challenge', async () => {
        await h
            .http()
            .post('/v1/auth/challenges')
            .send({ channel: 'telegram', intent: 'link' })
            .expect(401);
    });

    it('links telegram to a signed-in email account', async () => {
        const s = await signIn(h);
        const c = await start('telegram', s.body.accessToken, 'link');
        await claim(c.code, 'telegram', '700000005', { username: 'linker' }).expect(200);
        const res = await redeem(c.challengeId, s.body.accessToken).expect(200);
        expect(res.body.account.id).toBe(s.body.account.id);
        expect(res.body.isNewAccount).toBe(false);
        expect(res.body.welcomeGrant.granted).toBe(false);
        expect(
            res.body.account.identities.map((i: { provider: string }) => i.provider).sort()
        ).toEqual(['email', 'telegram']);
    });

    it('refuses to redeem a link challenge as a different account and leaves it usable', async () => {
        const owner = await signIn(h);
        const other = await signIn(h);
        const c = await start('telegram', owner.body.accessToken, 'link');
        await claim(c.code, 'telegram', '700000006').expect(200);
        await redeem(c.challengeId, other.body.accessToken).expect(401);
        await redeem(c.challengeId, owner.body.accessToken).expect(200);
    });

    it('offers a merge token when the chat account belongs to someone else', async () => {
        const c1 = await start('telegram');
        await claim(c1.code, 'telegram', '700000007').expect(200);
        await redeem(c1.challengeId).expect(200);

        const s = await signIn(h);
        const c2 = await start('telegram', s.body.accessToken, 'link');
        await claim(c2.code, 'telegram', '700000007').expect(200);
        const res = await redeem(c2.challengeId, s.body.accessToken).expect(409);
        expect(res.body.code).toBe('identity_belongs_to_other_account');
        expect(res.body.mergeToken).toMatch(/^mrg_/);
        expect(new Date(res.body.mergeTokenExpiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('limits challenge creation per IP', async () => {
        const ip = '10.250.250.250';
        for (let i = 0; i < 20; i += 1) {
            await h
                .http()
                .post('/v1/auth/challenges')
                .set('X-Forwarded-For', ip)
                .send({ channel: 'telegram' })
                .expect(201);
        }
        const res = await h
            .http()
            .post('/v1/auth/challenges')
            .set('X-Forwarded-For', ip)
            .send({ channel: 'telegram' })
            .expect(429);
        expect(res.headers['retry-after']).toBe('3600');
    });
});

describe('auth challenges without bot settings', () => {
    let h: Harness;

    beforeAll(async () => {
        h = await startHarness({ TELEGRAM_BOT_USERNAME: '', WHATSAPP_BUSINESS_NUMBER: '' });
    });

    afterAll(async () => {
        await h.close();
    });

    it('answers 503 channel_unavailable when the channel is not configured', async () => {
        const res = await h
            .http()
            .post('/v1/auth/challenges')
            .send({ channel: 'whatsapp' })
            .expect(503);
        expect(res.body.code).toBe('channel_unavailable');
    });
});
