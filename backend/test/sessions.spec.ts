import { randomUUID } from 'node:crypto';
import { makePdf } from './fixtures.js';
import { STUDY_NOTES, studyResponder } from './study-fake.js';
import { Harness, bearer, signIn, startHarness } from './helpers.js';

describe('study sessions', () => {
    let h: Harness;

    beforeAll(async () => {
        h = await startHarness();
    });

    beforeEach(() => {
        h.clock.set(new Date());
        h.ai.respond = studyResponder();
    });

    afterAll(async () => {
        await h.close();
    });

    async function readyFile(token: string, pages = STUDY_NOTES) {
        const up = await h
            .http()
            .post('/v1/files')
            .set(bearer(token))
            .attach('pages', makePdf(pages), {
                filename: `notes-${randomUUID()}.pdf`,
                contentType: 'application/pdf',
            })
            .expect(201);
        await h.drain();
        return up.body.id as string;
    }

    async function start(token: string, body: Record<string, unknown> = {}) {
        const fileId = await readyFile(token);
        const res = await h
            .http()
            .post('/v1/sessions')
            .set(bearer(token))
            .send({ mode: 'quiz', fileIds: [fileId], questionCount: 3, ...body })
            .expect(202);
        expect(res.body.status).toBe('generating');
        await h.drain();
        return (await h.http().get(`/v1/sessions/${res.body.id}`).set(bearer(token)).expect(200))
            .body;
    }

    const answer = (token: string, id: string, body: object, key = randomUUID()) =>
        h
            .http()
            .post(`/v1/sessions/${id}/answers`)
            .set(bearer(token))
            .set('Idempotency-Key', key)
            .send({ answeredAt: new Date().toISOString(), ...body });

    const balance = async (token: string) =>
        (await h.http().get('/v1/tokens').set(bearer(token)).expect(200)).body.balance as number;

    async function ledgerHolds(accountId: string) {
        const [row] = await h.db.query<{ sum: number; balance: number; last: number }>(
            `select (select coalesce(sum(delta), 0)::int from token_ledger where account_id = $1) as sum,
              (select token_balance from accounts where id = $1) as balance,
              (select balance_after from token_ledger where account_id = $1 order by id desc limit 1) as last`,
            [accountId]
        );
        expect(row.sum).toBe(row.balance);
        expect(row.last).toBe(row.balance);
    }

    it('charges 1 token at start and serves items without answers', async () => {
        const a = await signIn(h);
        const s = await start(a.body.accessToken);
        expect(await balance(a.body.accessToken)).toBe(9);
        expect(s).toMatchObject({
            status: 'active',
            mode: 'quiz',
            cost: 1,
            refunded: false,
            generatedCount: 3,
            currentIndex: 0,
        });
        expect(s.items.map((i: { type: string }) => i.type)).toEqual([
            'mcq',
            'true_false',
            'theory',
        ]);
        expect(JSON.stringify(s.items)).not.toContain('"answer"');
        expect(s.items[0]).toMatchObject({
            options: ['ATP', 'Light', 'Water', 'Glucose'],
            state: 'unanswered',
            sourceLabel: expect.stringContaining('p. 1'),
        });
    });

    it('answers 402 with no tokens and charges nothing', async () => {
        const a = await signIn(h);
        const fileId = await readyFile(a.body.accessToken);
        await h.db.query('update accounts set token_balance = 0 where id = $1', [
            a.body.account.id,
        ]);
        const res = await h
            .http()
            .post('/v1/sessions')
            .set(bearer(a.body.accessToken))
            .send({ mode: 'quiz', fileIds: [fileId] })
            .expect(402);
        expect(res.body.code).toBe('insufficient_tokens');
        const [{ n }] = await h.db.query<{ n: number }>(
            'select count(*)::int as n from study_sessions where account_id = $1',
            [a.body.account.id]
        );
        expect(n).toBe(0);
    });

    it('refuses a file too small for 2 questions without charging', async () => {
        const a = await signIn(h);
        const fileId = await readyFile(a.body.accessToken, [
            'Cells divide by mitosis and that is all these notes say on it.',
        ]);
        const res = await h
            .http()
            .post('/v1/sessions')
            .set(bearer(a.body.accessToken))
            .send({ mode: 'quiz', fileIds: [fileId] })
            .expect(409);
        expect(res.body.code).toBe('not_enough_material');
        expect(await balance(a.body.accessToken)).toBe(10);
    });

    it('fails and refunds once when generation yields 1 item', async () => {
        const a = await signIn(h);
        h.ai.respond = studyResponder({ count: 1 });
        const fileId = await readyFile(a.body.accessToken);
        const res = await h
            .http()
            .post('/v1/sessions')
            .set(bearer(a.body.accessToken))
            .send({ mode: 'quiz', fileIds: [fileId] })
            .expect(202);
        await h.drain();
        const s = await h
            .http()
            .get(`/v1/sessions/${res.body.id}`)
            .set(bearer(a.body.accessToken))
            .expect(200);
        expect(s.body).toMatchObject({ status: 'failed', refunded: true });
        expect(await balance(a.body.accessToken)).toBe(10);
        await ledgerHolds(a.body.account.id);
    });

    it('marks choices locally, explains wrong options and replays by idempotency key', async () => {
        const a = await signIn(h);
        const s = await start(a.body.accessToken);
        const key = randomUUID();
        const wrong = await answer(
            a.body.accessToken,
            s.id,
            { itemId: 0, answer: 'B' },
            key
        ).expect(200);
        expect(wrong.body).toMatchObject({
            itemId: 0,
            result: 'not_quite',
            awardedMarks: 0,
            maxMarks: 1,
            correctAnswer: 'ATP',
        });
        expect(wrong.body.whyOthersFail).toHaveLength(2);
        expect(wrong.body.source).toMatchObject({ fileId: s.fileIds[0], page: 1 });

        const again = await answer(
            a.body.accessToken,
            s.id,
            { itemId: 0, answer: 'ATP' },
            key
        ).expect(200);
        expect(again.body).toEqual(wrong.body);
        const dup = await answer(a.body.accessToken, s.id, { itemId: 0, answer: 'ATP' }).expect(
            409
        );
        expect(dup.body.code).toBe('already_answered');

        const tf = await answer(a.body.accessToken, s.id, { itemId: 1, answer: 'false' }).expect(
            200
        );
        expect(tf.body.result).toBe('right');
    });

    it('has the model mark a theory answer with partial credit', async () => {
        const a = await signIn(h);
        const s = await start(a.body.accessToken);
        const v = await answer(a.body.accessToken, s.id, {
            itemId: 2,
            answer: 'Osmosis is about water.',
        }).expect(200);
        expect(v.body).toMatchObject({ result: 'partly', awardedMarks: 2, maxMarks: 4 });
        expect(v.body.whyRight).toContain('missed ATP');
        const marking = h.ai.calls.find(
            (c) => 'awardedMarks' in ((c.jsonSchema?.properties ?? {}) as object)
        );
        expect(String(marking?.messages[0].content)).toContain('semi-permeable membrane');
    });

    it('makes a study day from one finished 2-question session and completes idempotently', async () => {
        const a = await signIn(h);
        const s = await start(a.body.accessToken, { questionCount: 2 });
        await answer(a.body.accessToken, s.id, { itemId: 0, answer: 'ATP' }).expect(200);
        await answer(a.body.accessToken, s.id, { itemId: 1, dontKnow: true }).expect(200);

        const [r1, r2] = await Promise.all([
            h.http().post(`/v1/sessions/${s.id}/complete`).set(bearer(a.body.accessToken)),
            h.http().post(`/v1/sessions/${s.id}/complete`).set(bearer(a.body.accessToken)),
        ]);
        expect([r1.status, r2.status]).toEqual([200, 200]);
        expect(r1.body.id).toBe(r2.body.id);
        expect(r1.body).toMatchObject({
            score: 1,
            total: 2,
            charged: 1,
            balance: 9,
            failedTopics: ['Active transport'],
        });
        expect(r1.body.studyDay).toEqual({ counted: true, justEarned: true, streak: 1 });
        const again = await h
            .http()
            .post(`/v1/sessions/${s.id}/complete`)
            .set(bearer(a.body.accessToken))
            .expect(200);
        expect(again.body.studyDay).toEqual(r1.body.studyDay);
        await answer(a.body.accessToken, s.id, { itemId: 0, answer: 'ATP' }).expect(409);
        await ledgerHolds(a.body.account.id);
    });

    it('does not make a study day when a session is completed with items unanswered', async () => {
        const a = await signIn(h);
        const s = await start(a.body.accessToken);
        await answer(a.body.accessToken, s.id, { itemId: 0, answer: 'ATP' }).expect(200);
        const r = await h
            .http()
            .post(`/v1/sessions/${s.id}/complete`)
            .set(bearer(a.body.accessToken))
            .expect(200);
        expect(r.body.studyDay.counted).toBe(false);
    });

    it('refunds once when the student leaves with zero answers', async () => {
        const a = await signIn(h);
        const s = await start(a.body.accessToken);
        await h.http().delete(`/v1/sessions/${s.id}`).set(bearer(a.body.accessToken)).expect(204);
        await h.http().delete(`/v1/sessions/${s.id}`).set(bearer(a.body.accessToken)).expect(204);
        expect(await balance(a.body.accessToken)).toBe(10);
        const refunds = await h.db.query(
            `select 1 from token_ledger where account_id = $1 and reason = 'refund'`,
            [a.body.account.id]
        );
        expect(refunds).toHaveLength(1);
        const view = await h
            .http()
            .get(`/v1/sessions/${s.id}`)
            .set(bearer(a.body.accessToken))
            .expect(200);
        expect(view.body).toMatchObject({ status: 'expired', refunded: true });
        await ledgerHolds(a.body.account.id);
    });

    it('keeps the charge when the student leaves after answering', async () => {
        const a = await signIn(h);
        const s = await start(a.body.accessToken);
        await answer(a.body.accessToken, s.id, { itemId: 0, answer: 'ATP' }).expect(200);
        await h.http().delete(`/v1/sessions/${s.id}`).set(bearer(a.body.accessToken)).expect(204);
        expect(await balance(a.body.accessToken)).toBe(9);
    });

    it('closes the open session when another starts', async () => {
        const a = await signIn(h);
        const first = await start(a.body.accessToken);
        await start(a.body.accessToken);
        const old = await h
            .http()
            .get(`/v1/sessions/${first.id}`)
            .set(bearer(a.body.accessToken))
            .expect(200);
        expect(old.body).toMatchObject({ status: 'expired', refunded: true });
        expect(await balance(a.body.accessToken)).toBe(9);
    });

    it('repeats missed flashcards in a second round', async () => {
        const a = await signIn(h);
        const s = await start(a.body.accessToken, { mode: 'flashcards', questionCount: 3 });
        expect(s.items[0]).toMatchObject({ type: 'flashcard', back: expect.any(String) });
        await answer(a.body.accessToken, s.id, { itemId: 0, outcome: 'know' }).expect(200);
        await answer(a.body.accessToken, s.id, { itemId: 1, outcome: 'missed' }).expect(200);
        const bad = await answer(a.body.accessToken, s.id, { itemId: 2, answer: 'text' }).expect(
            422
        );
        expect(bad.body.code).toBe('invalid_answer');
        await answer(a.body.accessToken, s.id, { itemId: 2, outcome: 'missed' }).expect(200);
        const next = await h
            .http()
            .get(`/v1/sessions/${s.id}`)
            .set(bearer(a.body.accessToken))
            .expect(200);
        expect(next.body).toMatchObject({ round: 2, currentIndex: 0, generatedCount: 3 });
        expect(next.body.items).toHaveLength(2);
    });

    it('marks fill-the-gap answers against accepted spellings', async () => {
        const a = await signIn(h);
        const s = await start(a.body.accessToken, { mode: 'fill_blank' });
        const v = await answer(a.body.accessToken, s.id, {
            itemId: 0,
            answer: 'Adenosine triphosphate',
        }).expect(200);
        expect(v.body.result).toBe('right');
    });

    it('switches mode, keeping answers and rebuilding the rest', async () => {
        const a = await signIn(h);
        const s = await start(a.body.accessToken);
        await answer(a.body.accessToken, s.id, { itemId: 0, answer: 'ATP' }).expect(200);
        const res = await h
            .http()
            .patch(`/v1/sessions/${s.id}/mode`)
            .set(bearer(a.body.accessToken))
            .send({ mode: 'flashcards' })
            .expect(200);
        expect(res.body.mode).toBe('flashcards');
        expect(
            res.body.items.map((i: { type: string; state: string }) => [i.type, i.state])
        ).toEqual([
            ['mcq', 'right'],
            ['flashcard', 'unanswered'],
            ['flashcard', 'unanswered'],
        ]);
        expect(await balance(a.body.accessToken)).toBe(9);
    });

    it('lists mistakes and retries them as a new 1-token session', async () => {
        const a = await signIn(h);
        const s = await start(a.body.accessToken);
        await answer(a.body.accessToken, s.id, { itemId: 0, answer: 'Light' }).expect(200);
        await answer(a.body.accessToken, s.id, { itemId: 1, answer: 'True' }).expect(200);
        await answer(a.body.accessToken, s.id, { itemId: 2, dontKnow: true }).expect(200);
        await h
            .http()
            .post(`/v1/sessions/${s.id}/complete`)
            .set(bearer(a.body.accessToken))
            .expect(200);

        const m = await h
            .http()
            .get(`/v1/sessions/${s.id}/mistakes`)
            .set(bearer(a.body.accessToken))
            .expect(200);
        expect(
            m.body.items.map((x: { yourAnswer: string | null; verdict: { result: string } }) => [
                x.yourAnswer,
                x.verdict.result,
            ])
        ).toEqual([
            ['Light', 'not_quite'],
            ['True', 'not_quite'],
            [null, 'skipped'],
        ]);

        const retry = await h
            .http()
            .post(`/v1/sessions/${s.id}/retry`)
            .set(bearer(a.body.accessToken))
            .send({})
            .expect(202);
        expect(retry.body).toMatchObject({ status: 'active', generatedCount: 3 });
        expect(await balance(a.body.accessToken)).toBe(8);
    });

    it('refuses a retry with fewer than 2 mistakes', async () => {
        const a = await signIn(h);
        const s = await start(a.body.accessToken, { questionCount: 2 });
        await answer(a.body.accessToken, s.id, { itemId: 0, answer: 'ATP' }).expect(200);
        await answer(a.body.accessToken, s.id, { itemId: 1, answer: 'True' }).expect(200);
        const res = await h
            .http()
            .post(`/v1/sessions/${s.id}/retry`)
            .set(bearer(a.body.accessToken))
            .send({})
            .expect(409);
        expect(res.body.code).toBe('not_enough_material');
    });

    it('renders a share card as PNG', async () => {
        const a = await signIn(h);
        const s = await start(a.body.accessToken, { questionCount: 2 });
        await h
            .http()
            .get(`/v1/sessions/${s.id}/share-image`)
            .set(bearer(a.body.accessToken))
            .expect(404);
        await h
            .http()
            .post(`/v1/sessions/${s.id}/complete`)
            .set(bearer(a.body.accessToken))
            .expect(200);
        const png = await h
            .http()
            .get(`/v1/sessions/${s.id}/share-image?showScore=true`)
            .set(bearer(a.body.accessToken))
            .buffer(true)
            .parse((res, done) => {
                const parts: Buffer[] = [];
                res.on('data', (c: Buffer) => parts.push(c));
                res.on('end', () => done(null, Buffer.concat(parts)));
            })
            .expect(200);
        expect(png.headers['content-type']).toBe('image/png');
        const body = png.body as Buffer;
        expect(body.subarray(1, 4).toString()).toBe('PNG');
        expect(body.readUInt32BE(16)).toBe(1080);
        expect(body.readUInt32BE(20)).toBe(1350);
    });

    it('pages through sessions newest first', async () => {
        const a = await signIn(h);
        await start(a.body.accessToken);
        await start(a.body.accessToken);
        const p1 = await h
            .http()
            .get('/v1/sessions?limit=1')
            .set(bearer(a.body.accessToken))
            .expect(200);
        expect(p1.body.items).toHaveLength(1);
        expect(p1.body.items[0].status).toBe('active');
        const p2 = await h
            .http()
            .get(`/v1/sessions?limit=1&cursor=${p1.body.nextCursor}`)
            .set(bearer(a.body.accessToken))
            .expect(200);
        expect(p2.body.items[0].status).toBe('expired');
        expect(p2.body.nextCursor).toBeNull();
    });

    it('keeps other accounts out', async () => {
        const a = await signIn(h);
        const b = await signIn(h);
        const s = await start(a.body.accessToken);
        await h.http().get(`/v1/sessions/${s.id}`).set(bearer(b.body.accessToken)).expect(404);
        await answer(b.body.accessToken, s.id, { itemId: 0, answer: 'ATP' }).expect(404);
        const fileId = s.fileIds[0];
        await h
            .http()
            .post('/v1/sessions')
            .set(bearer(b.body.accessToken))
            .send({ mode: 'quiz', fileIds: [fileId] })
            .expect(404);
    });
});
