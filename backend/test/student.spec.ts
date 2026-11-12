import { Harness, bearer, seedSchool, signIn, startHarness, uniqueIp } from './helpers.js';

describe('student verification', () => {
    let h: Harness;
    let n = 0;

    beforeAll(async () => {
        h = await startHarness();
        await seedSchool(h, 'University of Lagos', 'unilag.edu.ng');
    });

    afterAll(async () => {
        await h.close();
    });

    const nextEmail = () => {
        n += 1;
        return `student${n}@live.unilag.edu.ng`;
    };

    const start = (token: string, schoolEmail: string) =>
        h
            .http()
            .post('/v1/me/student/verify/start')
            .set(bearer(token))
            .set('X-Forwarded-For', uniqueIp())
            .send({ schoolEmail });
    const confirm = (token: string, schoolEmail: string, code: string) =>
        h
            .http()
            .post('/v1/me/student/verify/confirm')
            .set(bearer(token))
            .send({ schoolEmail, code });

    it('verifies a school email on a subdomain and grants 10 tokens once', async () => {
        const a = await signIn(h);
        const email = nextEmail();
        await start(a.body.accessToken, email).expect(202);
        const res = await confirm(a.body.accessToken, email, h.mailer.lastCodeFor(email)).expect(
            200
        );
        expect(res.body).toMatchObject({ status: 'verified', institution: 'University of Lagos' });
        expect(
            new Date(res.body.expiresAt).getTime() - new Date(res.body.verifiedAt).getTime()
        ).toBeGreaterThan(364 * 86400_000);

        const me = await h.http().get('/v1/me').set(bearer(a.body.accessToken)).expect(200);
        expect(me.body.tokenBalance).toBe(20);
        expect(me.body.student.status).toBe('verified');

        await start(a.body.accessToken, email).expect(202);
        await confirm(a.body.accessToken, email, h.mailer.lastCodeFor(email)).expect(200);
        const renewed = await h.http().get('/v1/me').set(bearer(a.body.accessToken)).expect(200);
        expect(renewed.body.tokenBalance).toBe(20);
    });

    it('strips plus tags so one mailbox is one student', async () => {
        const a = await signIn(h);
        const b = await signIn(h);
        const email = nextEmail();
        await start(a.body.accessToken, email).expect(202);
        await confirm(a.body.accessToken, email, h.mailer.lastCodeFor(email)).expect(200);

        const [local, domain] = email.split('@');
        const res = await start(
            b.body.accessToken,
            `${local.toUpperCase()}+second@${domain}`
        ).expect(422);
        expect(res.body.code).toBe('email_in_use');
    });

    it('refuses unknown domains and queues them for review', async () => {
        const a = await signIn(h);
        const res = await start(a.body.accessToken, 'someone@unknown-poly.edu.ng').expect(422);
        expect(res.body.code).toBe('unknown_institution');
        const [row] = await h.db.query<{ requests: number }>(
            "select requests from domain_reviews where domain = 'unknown-poly.edu.ng'"
        );
        expect(row.requests).toBe(1);
    });

    it('refuses disposable addresses', async () => {
        const a = await signIn(h);
        const res = await start(a.body.accessToken, 'me@mailinator.com').expect(422);
        expect(res.body.code).toBe('disposable_email');
    });

    it('rejects a wrong code and locks after five tries', async () => {
        const a = await signIn(h);
        const email = nextEmail();
        await start(a.body.accessToken, email).expect(202);
        const right = h.mailer.lastCodeFor(email);
        const wrong = right === '000000' ? '111111' : '000000';
        for (let i = 0; i < 5; i += 1) {
            const res = await confirm(a.body.accessToken, email, wrong).expect(400);
            expect(res.body.code).toBe('invalid_code');
        }
        const locked = await confirm(a.body.accessToken, email, right).expect(400);
        expect(locked.body.code).toBe('code_locked');
    });

    it('does not accept a sign-in code as a student code', async () => {
        const a = await signIn(h);
        const email = nextEmail();
        await start(a.body.accessToken, email).expect(202);
        await h
            .http()
            .post('/v1/auth/email/start')
            .set('X-Forwarded-For', uniqueIp())
            .send({ email })
            .expect(202);
        const signInCode = h.mailer.lastCodeFor(email);
        const studentCode = h.mailer.sent.filter((m) => m.to === email)[0].code;
        if (signInCode !== studentCode) {
            await confirm(a.body.accessToken, email, signInCode).expect(400);
        }
        await confirm(a.body.accessToken, email, studentCode).expect(200);
    });

    it('limits sends to 3 per address per hour', async () => {
        const a = await signIn(h);
        const email = nextEmail();
        for (let i = 0; i < 3; i += 1) await start(a.body.accessToken, email).expect(202);
        await start(a.body.accessToken, email).expect(429);
    });

    it('needs a session', async () => {
        await h
            .http()
            .post('/v1/me/student/verify/start')
            .send({ schoolEmail: 'a@unilag.edu.ng' })
            .expect(401);
    });
});
