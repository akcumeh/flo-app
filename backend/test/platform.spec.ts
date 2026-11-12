import { randomUUID } from 'node:crypto';
import { makePdf } from './fixtures.js';
import { STUDY_NOTES, studyResponder } from './study-fake.js';
import { Harness, TEST_ENV, bearer, signIn, startHarness, uniqueEmail } from './helpers.js';

describe('push, reminders, referral, export and deletion', () => {
    let h: Harness;

    beforeAll(async () => {
        h = await startHarness();
    });

    beforeEach(() => {
        h.push.sent.length = 0;
        h.messenger.sent.length = 0;
        h.ai.respond = studyResponder();
    });

    afterAll(async () => {
        await h.close();
    });

    const subscribe = (t: string, endpoint = `https://push.example.com/${randomUUID()}`) =>
        h
            .http()
            .post('/v1/push/subscriptions')
            .set(bearer(t))
            .send({ endpoint, keys: { p256dh: 'BKey', auth: 'auth' } });

    it('serves the VAPID key and stores one subscription per endpoint', async () => {
        const key = await h.http().get('/v1/push/vapid-key').expect(200);
        expect(key.body.publicKey).toBe(h.push.publicKey);
        const a = await signIn(h);
        const endpoint = `https://push.example.com/${randomUUID()}`;
        const first = await subscribe(a.body.accessToken, endpoint).expect(201);
        const again = await subscribe(a.body.accessToken, endpoint).expect(201);
        expect(again.body.id).toBe(first.body.id);
        await subscribe(a.body.accessToken, 'http://insecure.example.com/x').expect(422);
        const b = await signIn(h);
        await h
            .http()
            .delete(`/v1/push/subscriptions/${first.body.id}`)
            .set(bearer(b.body.accessToken))
            .expect(404);
        await h
            .http()
            .delete(`/v1/push/subscriptions/${first.body.id}`)
            .set(bearer(a.body.accessToken))
            .expect(204);
    });

    it('keeps preferences, with 22:00 as the latest time and a linked chat for bot channels', async () => {
        const a = await signIn(h);
        const t = a.body.accessToken;
        const defaults = await h
            .http()
            .get('/v1/me/notification-preferences')
            .set(bearer(t))
            .expect(200);
        expect(defaults.body).toMatchObject({
            channel: 'web_push',
            dailyReminder: true,
            reminderLocalTime: '20:00',
            streakNudges: true,
        });
        const prefs = {
            channel: 'web_push',
            dailyReminder: true,
            reminderLocalTime: '21:30',
            streakNudges: false,
        };
        await h
            .http()
            .put('/v1/me/notification-preferences')
            .set(bearer(t))
            .send(prefs)
            .expect(200);
        await h
            .http()
            .put('/v1/me/notification-preferences')
            .set(bearer(t))
            .send({ ...prefs, reminderLocalTime: '22:01' })
            .expect(400);
        const bot = await h
            .http()
            .put('/v1/me/notification-preferences')
            .set(bearer(t))
            .send({ ...prefs, channel: 'telegram' })
            .expect(422);
        expect(bot.body.code).toBe('channel_not_linked');
    });

    it('sends one reminder a day after the chosen time, never after 22:00, and drops dead subscriptions', async () => {
        const a = await signIn(h);
        const t = a.body.accessToken;
        const live = `https://push.example.com/live-${randomUUID()}`;
        const dead = `https://push.example.com/dead-${randomUUID()}`;
        await subscribe(t, live).expect(201);
        await subscribe(t, dead).expect(201);
        h.push.gone.add(dead);
        await h
            .http()
            .put('/v1/me/notification-preferences')
            .set(bearer(t))
            .send({
                channel: 'web_push',
                dailyReminder: true,
                reminderLocalTime: '19:00',
                streakNudges: true,
            })
            .expect(200);

        h.clock.set('2026-07-01T17:30:00Z');
        await h.tick();
        expect(h.push.sent.filter((s) => s.endpoint === live)).toHaveLength(0);

        h.clock.set('2026-07-01T18:05:00Z');
        await h.tick();
        await h.tick();
        expect(h.push.sent.filter((s) => s.endpoint === live)).toEqual([
            {
                endpoint: live,
                payload: {
                    title: 'Florence',
                    body: 'Three quick questions make today a study day.',
                    url: expect.any(String),
                },
            },
        ]);
        const subs = await h.db.query<{ endpoint: string }>(
            'select endpoint from push_subscriptions where account_id = $1',
            [a.body.account.id]
        );
        expect(subs.map((s) => s.endpoint)).toEqual([live]);

        h.clock.set('2026-07-02T21:01:00Z');
        await h.tick();
        expect(h.push.sent.filter((s) => s.endpoint === live)).toHaveLength(1);
    });

    it('skips the reminder once today is a study day and falls back to the linked bot', async () => {
        const tg = await h
            .http()
            .post('/v1/auth/challenges')
            .set('X-Forwarded-For', '10.250.0.9')
            .send({ channel: 'telegram' })
            .expect(201);
        await h
            .http()
            .post('/internal/v1/auth/challenges/claim')
            .set('X-Service-Key', TEST_ENV.INTERNAL_API_SECRET)
            .send({ code: tg.body.code, provider: 'telegram', providerUserId: '9900001' })
            .expect(200);
        const s = await h
            .http()
            .post(`/v1/auth/challenges/${tg.body.challengeId}/redeem`)
            .expect(200);
        const t = s.body.accessToken;
        await h
            .http()
            .put('/v1/me/notification-preferences')
            .set(bearer(t))
            .send({
                channel: 'telegram',
                dailyReminder: true,
                reminderLocalTime: '08:00',
                streakNudges: true,
            })
            .expect(200);

        h.clock.set('2026-07-05T08:00:00Z');
        await h.db.query(
            `insert into study_days (account_id, day, reason) values ($1, '2026-07-05', 'session')`,
            [s.body.account.id]
        );
        await h.tick();
        expect(h.messenger.sent).toHaveLength(0);

        h.clock.set('2026-07-06T08:00:00Z');
        await h.tick();
        expect(h.messenger.sent).toEqual([
            {
                provider: 'telegram',
                providerUserId: '9900001',
                text: expect.stringContaining('Day 2 is waiting'),
            },
        ]);
    });

    it('pays 5 tokens to both sides when an invited student finishes a first session', async () => {
        const inviter = await signIn(h);
        const ref = await h
            .http()
            .get('/v1/me/referral')
            .set(bearer(inviter.body.accessToken))
            .expect(200);
        expect(ref.body).toMatchObject({
            code: expect.stringMatching(/^[A-Z2-9]{6}$/),
            invitedCount: 0,
            rewardTokens: 5,
        });
        expect(ref.body.link).toContain(`/r/${ref.body.code}`);
        const own = await h
            .http()
            .put('/v1/me/profile')
            .set(bearer(inviter.body.accessToken))
            .send({ referralCode: ref.body.code })
            .expect(422);
        expect(own.body.code).toBe('invalid_referral');

        const invitee = await signIn(h);
        const t = invitee.body.accessToken;
        await h
            .http()
            .put('/v1/me/profile')
            .set(bearer(t))
            .send({ referralCode: ref.body.code.toLowerCase() })
            .expect(200);
        expect(
            (
                await h
                    .http()
                    .get('/v1/me/referral')
                    .set(bearer(inviter.body.accessToken))
                    .expect(200)
            ).body.invitedCount
        ).toBe(1);

        const up = await h
            .http()
            .post('/v1/files')
            .set(bearer(t))
            .attach('pages', makePdf(STUDY_NOTES), {
                filename: 'n.pdf',
                contentType: 'application/pdf',
            })
            .expect(201);
        await h.drain();
        for (let round = 0; round < 2; round += 1) {
            const sres = await h
                .http()
                .post('/v1/sessions')
                .set(bearer(t))
                .send({ mode: 'quiz', fileIds: [up.body.id], questionCount: 2 })
                .expect(202);
            await h.drain();
            for (const itemId of [0, 1]) {
                await h
                    .http()
                    .post(`/v1/sessions/${sres.body.id}/answers`)
                    .set(bearer(t))
                    .set('Idempotency-Key', randomUUID())
                    .send({ itemId, dontKnow: true, answeredAt: new Date().toISOString() })
                    .expect(200);
            }
            await h.http().post(`/v1/sessions/${sres.body.id}/complete`).set(bearer(t)).expect(200);
        }
        const balances = await h.db.query<{ id: string; token_balance: number }>(
            'select id, token_balance from accounts where id = any($1::uuid[])',
            [[inviter.body.account.id, invitee.body.account.id]]
        );
        expect(Object.fromEntries(balances.map((b) => [b.id, b.token_balance]))).toEqual({
            [inviter.body.account.id]: 15,
            [invitee.body.account.id]: 13,
        });
    });

    it('builds a data export, sends the link and limits requests to one a day', async () => {
        const a = await signIn(h);
        await subscribe(a.body.accessToken).expect(201);
        await h.http().post('/v1/me/export').set(bearer(a.body.accessToken)).expect(202);
        await h.http().post('/v1/me/export').set(bearer(a.body.accessToken)).expect(429);
        await h.drain();
        const [row] = await h.db.query<{ status: string; storage_path: string }>(
            'select status, storage_path from data_exports where account_id = $1',
            [a.body.account.id]
        );
        expect(row.status).toBe('ready');
        const data = JSON.parse((await h.storage.get(row.storage_path)).toString('utf8'));
        expect(data.account[0].id).toBe(a.body.account.id);
        expect(data.ledger[0]).toMatchObject({ reason: 'welcome_grant', delta: 10 });
        expect(h.push.sent.at(-1)?.payload.body).toContain('ready to download');
    });

    it('erases an account after 7 days unless the student signs in during the grace period', async () => {
        const email = uniqueEmail();
        const a = await signIn(h, email);
        const res = await h
            .http()
            .post('/v1/me/delete')
            .set(bearer(a.body.accessToken))
            .expect(202);
        expect(new Date(res.body.deletesAt).getTime() - Date.now()).toBeGreaterThan(
            6.9 * 86_400_000
        );

        await signIn(h, email);
        await h.db.query(
            `update account_deletions set deletes_at = now() - interval '1 minute' where account_id = $1`,
            [a.body.account.id]
        );
        await h.tick();
        expect(
            (
                await h.db.query('select 1 from identities where account_id = $1', [
                    a.body.account.id,
                ])
            ).length
        ).toBe(1);

        await h.http().post('/v1/me/delete').set(bearer(a.body.accessToken)).expect(202);
        await h.db.query(
            `update account_deletions set deletes_at = now() - interval '1 minute' where account_id = $1`,
            [a.body.account.id]
        );
        await h.tick();
        const [acc] = await h.db.query<{
            display_name: string;
            deleted_at: Date | null;
            token_balance: number;
        }>('select display_name, deleted_at, token_balance from accounts where id = $1', [
            a.body.account.id,
        ]);
        expect(acc).toMatchObject({ display_name: 'Deleted account', token_balance: 0 });
        expect(acc.deleted_at).not.toBeNull();
        expect(
            (
                await h.db.query('select 1 from identities where account_id = $1', [
                    a.body.account.id,
                ])
            ).length
        ).toBe(0);
        const ledger = await h.db.query<{ reason: string }>(
            'select reason from token_ledger where account_id = $1 order by id',
            [a.body.account.id]
        );
        expect(ledger.map((l) => l.reason)).toEqual(['welcome_grant', 'admin_adjust']);
        await h.http().get('/v1/me').set(bearer(a.body.accessToken)).expect(404);
    });
});
