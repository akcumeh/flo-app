import { createHash, createHmac } from 'node:crypto';
import {
    Harness,
    TEST_ENV,
    bearer,
    signIn,
    startHarness,
    uniqueEmail,
    uniqueIp,
} from './helpers.js';

function widget(id: number) {
    const fields: Record<string, string | number> = {
        id,
        first_name: 'Sam',
        auth_date: Math.floor(Date.now() / 1000),
    };
    const check = Object.keys(fields)
        .sort()
        .map((k) => `${k}=${fields[k]}`)
        .join('\n');
    const secret = createHash('sha256').update(TEST_ENV.TELEGRAM_BOT_TOKEN).digest();
    return { ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') };
}

describe('linking, unlinking and merging', () => {
    let h: Harness;
    let tgId = 8800000;

    beforeAll(async () => {
        h = await startHarness();
    });

    afterAll(async () => {
        await h.close();
    });

    const me = (token: string) => h.http().get('/v1/me').set(bearer(token)).expect(200);

    async function linkEmail(token: string, status: number, email = uniqueEmail()) {
        await h
            .http()
            .post('/v1/auth/email/start')
            .set(bearer(token))
            .set('X-Forwarded-For', uniqueIp())
            .send({ email })
            .expect(202);
        return h
            .http()
            .post('/v1/auth/email/verify')
            .set(bearer(token))
            .send({ email, code: h.mailer.lastCodeFor(email) })
            .expect(status);
    }

    async function telegramAccount() {
        tgId += 1;
        const res = await h.http().post('/v1/auth/telegram/oidc').send(widget(tgId)).expect(200);
        return {
            id: tgId,
            body: res.body,
            cookie: (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0],
        };
    }

    async function mergeOffer() {
        const other = await telegramAccount();
        const mine = await signIn(h);
        const res = await h
            .http()
            .post('/v1/auth/telegram/oidc')
            .set(bearer(mine.body.accessToken))
            .send(widget(other.id))
            .expect(409);
        return { other, mine, mergeToken: res.body.mergeToken as string };
    }

    it('links a second email to a signed-in account without a new grant', async () => {
        const a = await signIn(h);
        const res = await linkEmail(a.body.accessToken, 200);
        expect(res.body.account.id).toBe(a.body.account.id);
        expect(res.body.isNewAccount).toBe(false);
        expect(res.body.welcomeGrant.granted).toBe(false);
        expect(res.body.account.identities).toHaveLength(2);
        expect(res.body.account.tokenBalance).toBe(10);
    });

    it('offers a merge when the email belongs to another account', async () => {
        const b = await signIn(h);
        const a = await signIn(h);
        const res = await linkEmail(a.body.accessToken, 409, b.email);
        expect(res.body.code).toBe('identity_belongs_to_other_account');
        expect(res.body.mergeToken).toMatch(/^mrg_/);
    });

    it('unlinks an identity but never the last one', async () => {
        const a = await signIn(h);
        const linked = await linkEmail(a.body.accessToken, 200);
        const [first, second] = linked.body.account.identities as Array<{ id: string }>;

        await h
            .http()
            .delete(`/v1/me/identities/${second.id}`)
            .set(bearer(a.body.accessToken))
            .expect(204);
        const last = await h
            .http()
            .delete(`/v1/me/identities/${first.id}`)
            .set(bearer(a.body.accessToken))
            .expect(409);
        expect(last.body.code).toBe('last_identity');
        expect((await me(a.body.accessToken)).body.identities).toHaveLength(1);
    });

    it('answers 404 for an identity on another account', async () => {
        const a = await signIn(h);
        const b = await signIn(h);
        const theirs = (await me(b.body.accessToken)).body.identities[0].id;
        await h
            .http()
            .delete(`/v1/me/identities/${theirs}`)
            .set(bearer(a.body.accessToken))
            .expect(404);
    });

    it('does not grant welcome tokens again after unlink and sign-in', async () => {
        const a = await signIn(h);
        tgId += 1;
        const id = tgId;
        const linked = await h
            .http()
            .post('/v1/auth/telegram/oidc')
            .set(bearer(a.body.accessToken))
            .send(widget(id))
            .expect(200);
        const tgIdentity = linked.body.account.identities.find(
            (i: { provider: string }) => i.provider === 'telegram'
        );
        await h
            .http()
            .delete(`/v1/me/identities/${tgIdentity.id}`)
            .set(bearer(a.body.accessToken))
            .expect(204);

        const fresh = await h.http().post('/v1/auth/telegram/oidc').send(widget(id)).expect(200);
        expect(fresh.body.isNewAccount).toBe(true);
        expect(fresh.body.welcomeGrant).toEqual({ granted: false, tokens: 0 });
        expect(fresh.body.account.tokenBalance).toBe(0);
    });

    it('merges two accounts: balances summed, identities moved, loser signed out', async () => {
        const { other, mine, mergeToken } = await mergeOffer();
        await h.db.query('update accounts set token_balance = 17 where id = $1', [
            other.body.account.id,
        ]);

        const res = await h
            .http()
            .post('/v1/me/merge')
            .set(bearer(mine.body.accessToken))
            .send({ mergeToken })
            .expect(200);
        expect(res.body.id).toBe(mine.body.account.id);
        expect(res.body.tokenBalance).toBe(27);
        expect(res.body.identities.map((i: { provider: string }) => i.provider).sort()).toEqual([
            'email',
            'telegram',
        ]);

        const ledger = await h.db.query<{ account_id: string; reason: string; delta: number }>(
            `select account_id, reason, delta from token_ledger where reason in ('merge_in', 'merge_out') and account_id = any($1::uuid[])`,
            [[mine.body.account.id, other.body.account.id]]
        );
        expect(ledger).toEqual(
            expect.arrayContaining([
                { account_id: other.body.account.id, reason: 'merge_out', delta: -17 },
                { account_id: mine.body.account.id, reason: 'merge_in', delta: 17 },
            ])
        );

        const [loser] = await h.db.query<{ merged_into: string; deleted_at: Date | null }>(
            'select merged_into, deleted_at from accounts where id = $1',
            [other.body.account.id]
        );
        expect(loser.merged_into).toBe(mine.body.account.id);
        expect(loser.deleted_at).not.toBeNull();
        await h.http().post('/v1/auth/refresh').set('Cookie', other.cookie).expect(401);

        const back = await h
            .http()
            .post('/v1/auth/telegram/oidc')
            .send(widget(other.id))
            .expect(200);
        expect(back.body.account.id).toBe(mine.body.account.id);
    });

    it('refuses a merge token used twice', async () => {
        const { mine, mergeToken } = await mergeOffer();
        await h
            .http()
            .post('/v1/me/merge')
            .set(bearer(mine.body.accessToken))
            .send({ mergeToken })
            .expect(200);
        const res = await h
            .http()
            .post('/v1/me/merge')
            .set(bearer(mine.body.accessToken))
            .send({ mergeToken })
            .expect(410);
        expect(res.body.code).toBe('merge_token_expired');
    });

    it('refuses a merge token from another account', async () => {
        const { mergeToken } = await mergeOffer();
        const stranger = await signIn(h);
        await h
            .http()
            .post('/v1/me/merge')
            .set(bearer(stranger.body.accessToken))
            .send({ mergeToken })
            .expect(410);
    });

    it('applies concurrent merges with one token exactly once', async () => {
        const { mine, mergeToken } = await mergeOffer();
        const results = await Promise.all(
            [0, 1].map(() =>
                h
                    .http()
                    .post('/v1/me/merge')
                    .set(bearer(mine.body.accessToken))
                    .send({ mergeToken })
            )
        );
        expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
        expect((await me(mine.body.accessToken)).body.tokenBalance).toBe(20);
    });
});
