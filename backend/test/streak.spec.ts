import { randomUUID } from 'node:crypto';
import { addDays } from '../src/common/lagos.js';
import { replayStreak } from '../src/study/streak.service.js';
import { makePdf } from './fixtures.js';
import { STUDY_NOTES, studyResponder } from './study-fake.js';
import { Harness, bearer, signIn, startHarness } from './helpers.js';

const START = '2026-03-02';
const day = (n: number) => addDays(START, n - 1);

describe('streak rules (workplan 4.3)', () => {
    it('reproduces the worked example day by day', () => {
        const studied = new Set([1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 16]);
        const expected: Record<number, [number, boolean]> = {
            6: [6, true],
            7: [6, false],
            8: [7, false],
            13: [12, true],
            14: [13, true],
            15: [13, false],
            16: [14, false],
        };
        for (const [n, [streak, freeze]] of Object.entries(expected)) {
            const upTo = Number(n);
            const days = [...studied].filter((d) => d <= upTo).map(day);
            const r = replayStreak(days, day(upTo + 1));
            expect([upTo, r.current, r.freezeHeld]).toEqual([upTo, streak, freeze]);
        }
        const final = replayStreak([...studied].map(day), day(17));
        expect(final.rewardDays).toEqual([day(8), day(16)]);
        expect(final.frozenDays).toEqual([day(7), day(15)]);
    });

    it('resets after two missed days in a row even with a freeze held', () => {
        const r = replayStreak([1, 2, 3, 4, 5, 6].map(day), day(9));
        expect(r.current).toBe(0);
        expect(r.frozenDays).toEqual([day(7)]);
        expect(r.longest).toBe(6);
    });

    it('resets after one missed day with no freeze', () => {
        expect(replayStreak([1, 2, 3].map(day), day(5)).current).toBe(0);
    });

    it('does not count today as missed before it ends', () => {
        expect(replayStreak([1, 2].map(day), day(3)).current).toBe(2);
    });

    it('earns at most one freeze and restarts the run', () => {
        const r = replayStreak(
            Array.from({ length: 12 }, (_, i) => day(i + 1)),
            day(13)
        );
        expect(r.freezeHeld).toBe(true);
        expect(r.run).toBe(0);
    });
});

describe('study days through the API', () => {
    let h: Harness;

    beforeAll(async () => {
        h = await startHarness();
    });

    beforeEach(() => {
        h.ai.respond = studyResponder();
    });

    afterAll(async () => {
        await h.close();
    });

    async function readyFile(token: string) {
        const up = await h
            .http()
            .post('/v1/files')
            .set(bearer(token))
            .attach('pages', makePdf(STUDY_NOTES), {
                filename: `notes-${randomUUID()}.pdf`,
                contentType: 'application/pdf',
            })
            .expect(201);
        await h.drain();
        return up.body.id as string;
    }

    async function session(token: string, count = 4) {
        const fileId = await readyFile(token);
        const s = await h
            .http()
            .post('/v1/sessions')
            .set(bearer(token))
            .send({ mode: 'quiz', fileIds: [fileId], questionCount: count })
            .expect(202);
        await h.drain();
        return (await h.http().get(`/v1/sessions/${s.body.id}`).set(bearer(token)).expect(200))
            .body;
    }

    const answer = (
        token: string,
        sessionId: string,
        itemId: number,
        answeredAt: string,
        body: object = { dontKnow: true }
    ) =>
        h
            .http()
            .post(`/v1/sessions/${sessionId}/answers`)
            .set(bearer(token))
            .set('Idempotency-Key', randomUUID())
            .send({ itemId, answeredAt, ...body });

    it('makes a study day after 3 answered items, not 2', async () => {
        h.clock.set('2026-05-04T10:00:00Z');
        const a = await signIn(h);
        const s = await session(a.body.accessToken, 5);
        const t = '2026-05-04T10:00:00Z';
        const v1 = await answer(a.body.accessToken, s.id, 0, t).expect(200);
        expect(v1.body.studyDay).toEqual({ counted: false, justEarned: false, streak: 0 });
        await answer(a.body.accessToken, s.id, 1, t).expect(200);
        const v3 = await answer(a.body.accessToken, s.id, 2, t).expect(200);
        expect(v3.body.studyDay).toEqual({ counted: true, justEarned: true, streak: 1 });
        const v4 = await answer(a.body.accessToken, s.id, 3, t).expect(200);
        expect(v4.body.studyDay).toEqual({ counted: true, justEarned: false, streak: 1 });
    });

    it('splits the day at midnight Lagos time, not UTC', async () => {
        h.clock.set('2026-05-06T10:00:00Z');
        const a = await signIn(h);
        const s = await session(a.body.accessToken, 6);
        for (const i of [0, 1, 2])
            await answer(a.body.accessToken, s.id, i, '2026-05-05T22:59:00Z').expect(200);
        const days = await h.db.query<{ day: string }>(
            'select day::text as day from study_days where account_id = $1',
            [a.body.account.id]
        );
        expect(days).toEqual([{ day: '2026-05-05' }]);

        for (const i of [3, 4, 5])
            await answer(a.body.accessToken, s.id, i, '2026-05-05T23:00:00Z').expect(200);
        const after = await h.db.query<{ day: string }>(
            'select day::text as day from study_days where account_id = $1 order by day',
            [a.body.account.id]
        );
        expect(after).toEqual([{ day: '2026-05-05' }, { day: '2026-05-06' }]);
    });

    it('counts an offline answer for the day it was given, up to 48 hours late', async () => {
        h.clock.set('2026-05-10T12:00:00Z');
        const a = await signIn(h);
        const s = await session(a.body.accessToken, 4);
        for (const i of [0, 1, 2])
            await answer(a.body.accessToken, s.id, i, '2026-05-08T13:00:00Z').expect(200);
        const late = await answer(a.body.accessToken, s.id, 3, '2026-05-08T11:00:00Z').expect(422);
        expect(late.body.code).toBe('answer_too_old');
        const days = await h.db.query<{ day: string }>(
            'select day::text as day from study_days where account_id = $1',
            [a.body.account.id]
        );
        expect(days).toEqual([{ day: '2026-05-08' }]);
    });

    it('credits the 7-day reward once, uses the freeze and shows the calendar', async () => {
        const a = await signIn(h);
        const id = a.body.account.id;
        for (const n of [1, 2, 3, 4, 5, 6, 8]) {
            await h.db.query(
                `insert into study_days (account_id, day, reason) values ($1, $2, 'session')`,
                [id, day(n)]
            );
        }
        h.clock.set(`${day(8)}T15:00:00Z`);
        const first = await h
            .http()
            .get(`/v1/streak?month=${START.slice(0, 7)}`)
            .set(bearer(a.body.accessToken))
            .expect(200);
        expect(first.body).toMatchObject({
            current: 7,
            longest: 7,
            state: 'active',
            studiedToday: true,
            freeze: { held: false, daysToEarn: 5 },
            rewardProgress: { daysToNextReward: 7, tokens: 10 },
            timezone: 'Africa/Lagos',
        });
        const states = Object.fromEntries(
            first.body.calendar.map((c: { date: string; state: string }) => [c.date, c.state])
        );
        expect([states[day(1)], states[day(7)], states[day(8)], states[day(9)]]).toEqual([
            'studied',
            'frozen',
            'studied',
            'upcoming',
        ]);
        expect(states[addDays(START, -1)]).toBe('missed');

        await h.http().get('/v1/streak').set(bearer(a.body.accessToken)).expect(200);
        const rewards = await h.db.query<{ delta: number; idempotency_key: string }>(
            `select delta, idempotency_key from token_ledger where account_id = $1 and reason = 'streak_reward'`,
            [id]
        );
        expect(rewards).toEqual([{ delta: 10, idempotency_key: `streak7:${id}:${day(8)}` }]);
    });

    it('shows at_risk from 18:00 Lagos when today is not yet a study day', async () => {
        const a = await signIn(h);
        await h.db.query(
            `insert into study_days (account_id, day, reason) values ($1, '2026-06-01', 'session')`,
            [a.body.account.id]
        );
        h.clock.set('2026-06-02T16:59:00Z');
        expect(
            (await h.http().get('/v1/streak').set(bearer(a.body.accessToken)).expect(200)).body
                .state
        ).toBe('active');
        h.clock.set('2026-06-02T17:00:00Z');
        expect(
            (await h.http().get('/v1/streak').set(bearer(a.body.accessToken)).expect(200)).body
                .state
        ).toBe('at_risk');
        h.clock.set('2026-06-04T09:00:00Z');
        const gone = await h.http().get('/v1/streak').set(bearer(a.body.accessToken)).expect(200);
        expect(gone.body).toMatchObject({ current: 0, longest: 1, state: 'none' });
    });
});
