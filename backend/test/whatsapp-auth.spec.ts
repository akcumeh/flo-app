import { CloudApiCodeSender, normalisePhone } from '../src/auth/whatsapp-codes.js';
import { bearer, signIn, startHarness, uniqueIp, type Harness } from './helpers.js';

describe('WhatsApp number sign-in', () => {
    let h: Harness;

    beforeAll(async () => {
        h = await startHarness();
    });

    afterAll(async () => {
        await h.close();
    });

    const start = (phone: string) =>
        h.http().post('/v1/auth/whatsapp/start').set('X-Forwarded-For', uniqueIp()).send({ phone });

    it('reads Nigerian numbers in every common shape', () => {
        expect(normalisePhone('0803 123 4567')).toBe('2348031234567');
        expect(normalisePhone('+234 803 123 4567')).toBe('2348031234567');
        expect(normalisePhone('2348031234567')).toBe('2348031234567');
        expect(normalisePhone('803-123-4567')).toBe('2348031234567');
        expect(normalisePhone('+44 7700 900123')).toBe('447700900123');
        expect(normalisePhone('hello')).toBeNull();
        expect(normalisePhone('12345')).toBeNull();
    });

    it('sends a code on WhatsApp and signs in to the same account the bot uses', async () => {
        const sent = await start('0803 111 2222').expect(202);
        expect(sent.body).toEqual({
            phone: '2348031112222',
            display: '0803 111 2222',
            resendAfter: 30,
        });
        const code = h.whatsappCodes.lastCodeFor('2348031112222');

        const res = await h
            .http()
            .post('/v1/auth/whatsapp/verify')
            .send({ phone: sent.body.phone, code })
            .expect(200);
        expect(res.body.isNewAccount).toBe(true);
        expect(res.body.welcomeGrant).toEqual({ granted: true, tokens: 10 });
        expect(res.body.account.identities[0]).toMatchObject({
            provider: 'whatsapp',
            display: '+234 80* *** 2222',
        });
        const [identity] = await h.db.query<{ provider_user_id: string }>(
            "select provider_user_id from identities where provider = 'whatsapp' and account_id = $1",
            [res.body.account.id]
        );
        expect(identity.provider_user_id).toBe('2348031112222');

        await start('+2348031112222').expect(429);
    });

    it('signs in to an account that already chatted on WhatsApp', async () => {
        const first = await start('08033334444').expect(202);
        const a = await h
            .http()
            .post('/v1/auth/whatsapp/verify')
            .send({ phone: first.body.phone, code: h.whatsappCodes.lastCodeFor('2348033334444') })
            .expect(200);
        await h.db.query("update phone_codes set created_at = now() - interval '1 minute'");
        await start('+234 803 333 4444').expect(202);
        const b = await h
            .http()
            .post('/v1/auth/whatsapp/verify')
            .send({ phone: '2348033334444', code: h.whatsappCodes.lastCodeFor('2348033334444') })
            .expect(200);
        expect(b.body.account.id).toBe(a.body.account.id);
        expect(b.body.isNewAccount).toBe(false);
        expect(b.body.welcomeGrant.granted).toBe(false);
    });

    it('refuses a wrong code, locks after five tries, and refuses a used code', async () => {
        const sent = await start('08035556666').expect(202);
        const code = h.whatsappCodes.lastCodeFor('2348035556666');
        const wrong = code === '000000' ? '111111' : '000000';
        const bad = await h
            .http()
            .post('/v1/auth/whatsapp/verify')
            .send({ phone: sent.body.phone, code: wrong })
            .expect(400);
        expect(bad.body.code).toBe('invalid_code');
        for (let i = 0; i < 4; i += 1)
            await h
                .http()
                .post('/v1/auth/whatsapp/verify')
                .send({ phone: sent.body.phone, code: wrong })
                .expect(400);
        const locked = await h
            .http()
            .post('/v1/auth/whatsapp/verify')
            .send({ phone: sent.body.phone, code })
            .expect(400);
        expect(locked.body.code).toBe('code_locked');
    });

    it('answers 503 and keeps no code when Meta blocks the account from sending', async () => {
        h.whatsappCodes.blockAll = true;
        try {
            const res = await start('08031230000').expect(503);
            expect(res.body.code).toBe('channel_unavailable');
            expect(res.body.detail).toContain('Continue with Google');
            const [{ n }] = await h.db.query<{ n: number }>(
                "select count(*)::int as n from phone_codes where phone = '2348031230000'"
            );
            expect(n).toBe(0);
        } finally {
            h.whatsappCodes.blockAll = false;
        }
    });

    it('reads a blocked account from Meta health status and caches it for 5 minutes', async () => {
        let clock = 0;
        const calls: string[] = [];
        const health = (state: string) => ({
            health_status: {
                can_send_message: state,
                entities: [
                    { entity_type: 'PHONE_NUMBER', can_send_message: 'AVAILABLE' },
                    {
                        entity_type: 'WABA',
                        can_send_message: state,
                        errors: [{ error_code: 141006, error_description: 'payment method' }],
                    },
                    { entity_type: 'APP', can_send_message: 'BLOCKED' },
                ],
            },
        });
        let state = 'BLOCKED';
        const fetchImpl = (async (url: string) => {
            calls.push(String(url));
            if (String(url).includes('health_status')) {
                return new Response(JSON.stringify(health(state)), { status: 200 });
            }
            return new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 });
        }) as unknown as typeof fetch;
        const sender = new CloudApiCodeSender(
            't',
            'p',
            'florence_signin_code',
            'en',
            fetchImpl,
            () => clock
        );

        expect(await sender.sendCode('2348031230000', '123456')).toBe('blocked');
        state = 'AVAILABLE';
        clock = 60_000;
        expect(await sender.sendCode('2348031230000', '123456')).toBe('blocked');
        clock = 6 * 60_000;
        expect(await sender.sendCode('2348031230000', '123456')).toBe('sent');
        expect(calls.filter((c) => c.includes('health_status'))).toHaveLength(2);
        expect(calls.filter((c) => c.endsWith('/messages'))).toHaveLength(1);
    });

    it('answers 422 for a bad number and when WhatsApp refuses the message', async () => {
        expect((await start('not a number').expect(422)).body.code).toBe('invalid_phone');
        h.whatsappCodes.refuse.add('2348037778888');
        expect((await start('08037778888').expect(422)).body.code).toBe('whatsapp_send_failed');
        const [{ n }] = await h.db.query<{ n: number }>(
            "select count(*)::int as n from phone_codes where phone = '2348037778888'"
        );
        expect(n).toBe(0);
    });

    it('links the number to a signed-in email account', async () => {
        const a = await signIn(h);
        await start('08039990000').expect(202);
        const res = await h
            .http()
            .post('/v1/auth/whatsapp/verify')
            .set(bearer(a.body.accessToken))
            .send({ phone: '2348039990000', code: h.whatsappCodes.lastCodeFor('2348039990000') })
            .expect(200);
        expect(res.body.account.id).toBe(a.body.account.id);
        expect(
            res.body.account.identities.map((i: { provider: string }) => i.provider).sort()
        ).toEqual(['email', 'whatsapp']);
    });
});
