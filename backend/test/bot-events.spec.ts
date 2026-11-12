import { randomUUID } from 'node:crypto';
import { Harness, TEST_ENV, startHarness } from './helpers.js';

describe('bot events and bot streak', () => {
    let h: Harness;

    beforeAll(async () => {
        h = await startHarness();
    });

    afterAll(async () => {
        await h.close();
    });

    const post = (body: object, key = TEST_ENV.INTERNAL_API_SECRET) =>
        h.http().post('/internal/v1/events').set('X-Service-Key', key).send(body);

    const event = (providerUserId: string, type: string, extra: object = {}) => ({
        eventId: randomUUID(),
        provider: 'telegram',
        providerUserId,
        type,
        occurredAt: new Date().toISOString(),
        ...extra,
    });

    it('counts 3 bot items as a study day, idempotently by event id', async () => {
        h.clock.set(new Date());
        const first = event('8100001', 'ask_question');
        const r1 = await post(first).expect(200);
        expect(r1.body).toEqual({
            accepted: true,
            streak: { current: 0, longest: 0, state: 'none', studiedToday: false },
        });
        const dup = await post(first).expect(200);
        expect(dup.body.accepted).toBe(false);

        await post(event('8100001', 'prep_answer')).expect(200);
        const third = await post(event('8100001', 'ask_question')).expect(200);
        expect(third.body.streak).toMatchObject({
            current: 1,
            studiedToday: true,
            state: 'active',
        });

        const streak = await h
            .http()
            .get('/internal/v1/streak?provider=telegram&providerUserId=8100001')
            .set('X-Service-Key', TEST_ENV.INTERNAL_API_SECRET)
            .expect(200);
        expect(streak.body).toEqual({
            current: 1,
            longest: 1,
            state: 'active',
            studiedToday: true,
        });
    });

    it('counts a finished bot quiz only when every question was answered', async () => {
        h.clock.set(new Date());
        const partial = await post(
            event('8100002', 'prep_session_finished', { questionCount: 5, answeredCount: 3 })
        ).expect(200);
        expect(partial.body.streak.current).toBe(0);
        const full = await post(
            event('8100002', 'prep_session_finished', { questionCount: 2, answeredCount: 2 })
        ).expect(200);
        expect(full.body.streak.current).toBe(1);
        await post({
            ...event('8100002', 'prep_session_finished'),
            questionCount: undefined,
        }).expect(400);
    });

    it('returns the 7-day reward to the bot and shares the streak with the app account', async () => {
        const id = '8100003';
        await post(event(id, 'ask_question')).expect(200);
        const [{ account_id }] = await h.db.query<{ account_id: string }>(
            `select account_id from identities where provider = 'telegram' and provider_user_id = $1`,
            [id]
        );
        for (let i = 6; i >= 1; i -= 1) {
            await h.db.query(
                `insert into study_days (account_id, day, reason) values ($1, (now() at time zone 'Africa/Lagos')::date - $2::int, 'session')`,
                [account_id, i]
            );
        }
        await post(event(id, 'ask_question')).expect(200);
        const tipping = await post(event(id, 'prep_answer')).expect(200);
        expect(tipping.body).toMatchObject({
            streak: { current: 7 },
            streakReward: { tokens: 10 },
        });
        const after = await post(event(id, 'ask_question')).expect(200);
        expect(after.body.streakReward).toBeUndefined();
    });

    it('refuses events older than 48 hours, unknown chats and a wrong service key', async () => {
        const old = await post(
            event('8100004', 'ask_question', {
                occurredAt: new Date(Date.now() - 49 * 3600_000).toISOString(),
            })
        ).expect(422);
        expect(old.body.code).toBe('event_too_old');
        await h
            .http()
            .get('/internal/v1/streak?provider=whatsapp&providerUserId=2340000000000')
            .set('X-Service-Key', TEST_ENV.INTERNAL_API_SECRET)
            .expect(404);
        await post(event('8100005', 'ask_question'), 'wrong').expect(401);
    });
});
