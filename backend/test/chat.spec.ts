import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AiRequest } from '../src/ai/ai.provider.js';
import { fakePng, makePdf } from './fixtures.js';
import { Harness, bearer, signIn, startHarness } from './helpers.js';

const NOTES = [
    'Osmosis is the movement of water across a semi-permeable membrane.\nIt does not need energy.',
    'The sodium-potassium pump moves three sodium ions out of the cell and two potassium ions in.\nEach cycle uses one ATP.',
];

type Event = { event: string; data: Record<string, unknown> };

function parseSse(body: string): Event[] {
    return body
        .split('\n\n')
        .filter((frame) => frame.startsWith('event:'))
        .map((frame) => {
            const [e, d] = frame.split('\n');
            return { event: e.slice('event: '.length), data: JSON.parse(d.slice('data: '.length)) };
        });
}

const raw = (res: { text?: string; body?: unknown }) =>
    typeof res.text === 'string' ? res.text : String(res.body);

describe('Ask chat', () => {
    let h: Harness;

    beforeAll(async () => {
        h = await startHarness();
    });

    beforeEach(() => {
        h.ai.respond = (req: AiRequest) => {
            if ('topics' in ((req.jsonSchema?.properties ?? {}) as object))
                return JSON.stringify({ topics: [] });
            if (!req.system) return 'Sodium pump notes';
            return 'It moves three sodium ions out [S1] and two potassium ions in [S1].';
        };
        h.ai.delayMs = 0;
        h.ai.failAfterPieces = null;
        h.ai.calls.length = 0;
    });

    afterAll(async () => {
        await h.close();
    });

    async function conversation(token: string) {
        return (await h.http().post('/v1/conversations').set(bearer(token)).send({}).expect(201))
            .body.id as string;
    }

    function ask(token: string, conversationId: string, body: object, key = randomUUID()) {
        return h
            .http()
            .post(`/v1/conversations/${conversationId}/messages`)
            .set(bearer(token))
            .set('Idempotency-Key', key)
            .buffer(true)
            .parse((res, done) => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', (c: string) => (text += c));
                res.on('end', () => done(null, text));
            })
            .send(body);
    }

    async function upload(token: string, pages = NOTES, name = 'transport.pdf') {
        const res = await h
            .http()
            .post('/v1/files')
            .set(bearer(token))
            .attach('pages', makePdf(pages), { filename: name, contentType: 'application/pdf' })
            .expect(201);
        await h.drain();
        return res.body.id as string;
    }

    const balance = async (token: string) =>
        (await h.http().get('/v1/tokens').set(bearer(token)).expect(200)).body.balance;

    it('streams start, deltas, a citation to the right page, then end, and charges 1 token', async () => {
        const a = await signIn(h);
        const t = a.body.accessToken;
        const fileId = await upload(t);
        const c = await conversation(t);

        const res = await ask(t, c, {
            text: 'How many sodium ions does the sodium-potassium pump move?',
        }).expect(200);
        expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
        expect(res.headers['x-accel-buffering']).toBe('no');
        const events = parseSse(raw(res));
        expect(events[0]).toMatchObject({
            event: 'message.start',
            data: { charged: 1, balance: 9 },
        });
        expect(events.at(-1)).toMatchObject({
            event: 'message.end',
            data: { balance: 9, grounded: true },
        });
        const text = events
            .filter((e) => e.event === 'delta')
            .map((e) => e.data.text)
            .join('');
        expect(text).toBe('It moves three sodium ions out and two potassium ions in.');
        const citations = events.filter((e) => e.event === 'citation').map((e) => e.data);
        expect(citations).toEqual([
            {
                fileId,
                label: 'transport.pdf',
                page: 2,
                snippet: expect.stringContaining('sodium-potassium pump'),
            },
        ]);

        const call = h.ai.calls.find((x) => x.system?.includes('[S1]'));
        expect(call?.system).toContain('[S1] transport.pdf, page 2');

        const list = await h
            .http()
            .get(`/v1/conversations/${c}/messages`)
            .set(bearer(t))
            .expect(200);
        expect(list.body.items.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
        expect(list.body.items[1]).toMatchObject({
            text,
            grounded: true,
            charged: 1,
            citations: [{ page: 2 }],
        });
        const convs = await h.http().get('/v1/conversations').set(bearer(t)).expect(200);
        expect(convs.body.items[0]).toMatchObject({ id: c, title: 'Sodium pump notes' });
        const [{ n }] = await h.db.query<{ n: number }>(
            `select count(*)::int as n from study_events where account_id = $1 and kind = 'ask_question'`,
            [a.body.account.id]
        );
        expect(n).toBe(1);
    });

    it('flags an answer that is not in the notes', async () => {
        const a = await signIn(h);
        const t = a.body.accessToken;
        await upload(t);
        const c = await conversation(t);
        h.ai.respond = () => 'That is not in your notes. England won in 1966.';
        const res = await ask(t, c, { text: 'Who won the 1966 football world cup?' }).expect(200);
        const events = parseSse(raw(res));
        expect(events.at(-1)).toMatchObject({ event: 'message.end', data: { grounded: false } });
        expect(events.some((e) => e.event === 'citation')).toBe(false);
        expect(h.ai.calls.find((x) => x.system?.startsWith('You are Florence'))?.system).toContain(
            'Nothing in the student'
        );
    });

    it('replays a finished request as JSON without charging again', async () => {
        const a = await signIn(h);
        const t = a.body.accessToken;
        const c = await conversation(t);
        const key = randomUUID();
        await ask(t, c, { text: 'What is osmosis?' }, key).expect(200);
        const replay = await h
            .http()
            .post(`/v1/conversations/${c}/messages`)
            .set(bearer(t))
            .set('Idempotency-Key', key)
            .send({ text: 'What is osmosis?' })
            .expect(200);
        expect(replay.headers['content-type']).toMatch(/^application\/json/);
        expect(replay.body).toMatchObject({ role: 'assistant', charged: 1 });
        expect(await balance(t)).toBe(9);
    });

    it('answers 409 while the same request is still running', async () => {
        const a = await signIn(h);
        const t = a.body.accessToken;
        const c = await conversation(t);
        const key = randomUUID();
        await h.db.query(
            `insert into requests (account_id, idempotency_key, kind) values ($1, $2, 'chat')`,
            [a.body.account.id, key]
        );
        const res = await h
            .http()
            .post(`/v1/conversations/${c}/messages`)
            .set(bearer(t))
            .set('Idempotency-Key', key)
            .send({ text: 'x' })
            .expect(409);
        expect(res.body.code).toBe('request_in_progress');
    });

    it('refunds once when the provider fails mid-stream, and a retry with the same key charges again', async () => {
        const a = await signIn(h);
        const t = a.body.accessToken;
        const c = await conversation(t);
        const key = randomUUID();
        h.ai.failAfterPieces = 2;
        const failed = parseSse(raw(await ask(t, c, { text: 'Explain osmosis' }, key).expect(200)));
        expect(failed.at(-1)).toEqual({
            event: 'error',
            data: { code: 'answer_failed', refunded: true, balance: 10 },
        });
        expect(await balance(t)).toBe(10);

        h.ai.failAfterPieces = null;
        const ok = parseSse(raw(await ask(t, c, { text: 'Explain osmosis' }, key).expect(200)));
        expect(ok.at(-1)?.event).toBe('message.end');
        expect(await balance(t)).toBe(9);
        const msgs = await h
            .http()
            .get(`/v1/conversations/${c}/messages`)
            .set(bearer(t))
            .expect(200);
        expect(msgs.body.items.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
        const ledger = await h.db.query<{ reason: string }>(
            'select reason from token_ledger where account_id = $1 order by id',
            [a.body.account.id]
        );
        expect(ledger.map((l) => l.reason)).toEqual([
            'welcome_grant',
            'chat_charge',
            'refund',
            'chat_charge',
        ]);
    });

    it('refunds when the student closes the stream', async () => {
        const a = await signIn(h);
        const t = a.body.accessToken;
        const c = await conversation(t);
        h.ai.respond = () => 'word '.repeat(200);
        h.ai.delayMs = 5;
        const server = h.app.getHttpServer() as http.Server;
        if (!server.listening) await new Promise<void>((r) => server.listen(0, r));
        const { port } = server.address() as AddressInfo;
        await new Promise<void>((resolve, reject) => {
            const req = http.request(
                {
                    port,
                    method: 'POST',
                    path: `/v1/conversations/${c}/messages`,
                    headers: {
                        Authorization: `Bearer ${t}`,
                        'Idempotency-Key': randomUUID(),
                        'Content-Type': 'application/json',
                    },
                },
                (res) => {
                    res.once('data', () => {
                        req.destroy();
                        resolve();
                    });
                }
            );
            req.on('error', () => undefined);
            req.end(JSON.stringify({ text: 'Tell me everything' }));
            setTimeout(() => reject(new Error('no data')), 5000);
        });
        for (let i = 0; i < 50 && (await balance(t)) !== 10; i += 1)
            await new Promise((r) => setTimeout(r, 50));
        expect(await balance(t)).toBe(10);
        const msgs = await h.db.query(
            `select 1 from messages m join conversations c on c.id = m.conversation_id where c.id = $1 and m.role = 'assistant'`,
            [c]
        );
        expect(msgs).toHaveLength(0);
    });

    it('answers 402 with no tokens and stores nothing', async () => {
        const a = await signIn(h);
        const t = a.body.accessToken;
        const c = await conversation(t);
        await h.db.query('update accounts set token_balance = 0 where id = $1', [
            a.body.account.id,
        ]);
        const res = await h
            .http()
            .post(`/v1/conversations/${c}/messages`)
            .set(bearer(t))
            .set('Idempotency-Key', randomUUID())
            .send({ text: 'Hi' })
            .expect(402);
        expect(res.body.code).toBe('insufficient_tokens');
        const [{ n }] = await h.db.query<{ n: number }>(
            'select count(*)::int as n from messages where conversation_id = $1',
            [c]
        );
        expect(n).toBe(0);
    });

    it('charges 2 tokens when a file is attached and refunds both on failure', async () => {
        const a = await signIn(h);
        const t = a.body.accessToken;
        const fileId = await upload(t);
        const c = await conversation(t);
        h.ai.failAfterPieces = 1;
        const failed = parseSse(
            raw(await ask(t, c, { text: 'Summarise this', fileIds: [fileId] }).expect(200))
        );
        expect(failed[0]).toMatchObject({
            event: 'message.start',
            data: { charged: 2, balance: 8 },
        });
        expect(failed.at(-1)).toEqual({
            event: 'error',
            data: { code: 'answer_failed', refunded: true, balance: 10 },
        });
        h.ai.failAfterPieces = null;
        const ok = parseSse(
            raw(await ask(t, c, { text: 'Summarise this', fileIds: [fileId] }).expect(200))
        );
        expect(ok.at(-1)).toMatchObject({ event: 'message.end', data: { balance: 8 } });
        const list = await h
            .http()
            .get(`/v1/conversations/${c}/messages`)
            .set(bearer(t))
            .expect(200);
        expect(list.body.items.map((m: { charged: number }) => m.charged)).toEqual([2, 2, 2]);
    });

    it('sends the earlier turns and attached photos to the model', async () => {
        const a = await signIn(h);
        const t = a.body.accessToken;
        const c = await conversation(t);
        await ask(t, c, { text: 'What is osmosis?' }).expect(200);
        h.ai.respond = (req) =>
            'topics' in ((req.jsonSchema?.properties ?? {}) as object)
                ? JSON.stringify({ topics: [] })
                : JSON.stringify({
                      pages: [
                          {
                              page: 1,
                              text: 'A photo of a question about diffusion and concentration.',
                          },
                      ],
                  });
        const photo = await h
            .http()
            .post('/v1/files')
            .set(bearer(t))
            .attach('pages', fakePng(77), { filename: 'q.png', contentType: 'image/png' })
            .expect(201);
        await h.drain();
        h.ai.respond = () => 'Diffusion answer.';
        h.ai.calls.length = 0;
        await ask(t, c, { text: 'Solve this one', fileIds: [photo.body.id] }).expect(200);
        const call = h.ai.calls.find((x) => x.system?.startsWith('You are Florence'));
        expect(call?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
        const last = call?.messages.at(-1)?.content as Array<{ type: string }>;
        expect(last.map((b) => b.type)).toEqual(['image', 'text']);
    });

    it('refuses voice notes until a transcription provider exists', async () => {
        const a = await signIn(h);
        const c = await conversation(a.body.accessToken);
        const res = await h
            .http()
            .post(`/v1/conversations/${c}/messages`)
            .set(bearer(a.body.accessToken))
            .set('Idempotency-Key', randomUUID())
            .send({ voiceFileId: randomUUID() })
            .expect(422);
        expect(res.body.code).toBe('voice_not_available');
    });

    it('saves and lists answers, renames and deletes conversations, and keeps accounts apart', async () => {
        const a = await signIn(h);
        const b = await signIn(h);
        const t = a.body.accessToken;
        const c = await conversation(t);
        await ask(t, c, { text: 'What is osmosis?' }).expect(200);
        const [user, assistant] = (
            await h.http().get(`/v1/conversations/${c}/messages`).set(bearer(t)).expect(200)
        ).body.items;

        await h
            .http()
            .put(`/v1/messages/${user.id}/saved`)
            .set(bearer(t))
            .send({ saved: true })
            .expect(404);
        await h
            .http()
            .put(`/v1/messages/${assistant.id}/saved`)
            .set(bearer(b.body.accessToken))
            .send({ saved: true })
            .expect(404);
        await h
            .http()
            .put(`/v1/messages/${assistant.id}/saved`)
            .set(bearer(t))
            .send({ saved: true })
            .expect(204);
        const saved = await h.http().get('/v1/saved-answers').set(bearer(t)).expect(200);
        expect(saved.body.items).toEqual([
            expect.objectContaining({ id: assistant.id, saved: true }),
        ]);
        await h
            .http()
            .put(`/v1/messages/${assistant.id}/saved`)
            .set(bearer(t))
            .send({ saved: false })
            .expect(204);
        expect(
            (await h.http().get('/v1/saved-answers').set(bearer(t)).expect(200)).body.items
        ).toEqual([]);

        const renamed = await h
            .http()
            .patch(`/v1/conversations/${c}`)
            .set(bearer(t))
            .send({ title: 'Osmosis revision' })
            .expect(200);
        expect(renamed.body.title).toBe('Osmosis revision');
        await h
            .http()
            .get(`/v1/conversations/${c}/messages`)
            .set(bearer(b.body.accessToken))
            .expect(404);
        await h.http().delete(`/v1/conversations/${c}`).set(bearer(b.body.accessToken)).expect(404);
        await h.http().delete(`/v1/conversations/${c}`).set(bearer(t)).expect(204);
        await h.http().get(`/v1/conversations/${c}/messages`).set(bearer(t)).expect(404);
        expect(
            (await h.http().get('/v1/conversations').set(bearer(t)).expect(200)).body.items
        ).toEqual([]);
    });
});

describe('guest Ask', () => {
    let h: Harness;

    beforeAll(async () => {
        h = await startHarness();
    });

    afterAll(async () => {
        await h.close();
    });

    function askGuest(token: string, text: string) {
        return h
            .http()
            .post('/v1/guest/messages')
            .set('X-Guest-Token', token)
            .buffer(true)
            .parse((res, done) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (c: string) => (body += c));
                res.on('end', () => done(null, body));
            })
            .send({ text });
    }

    it('gives 3 free answers per device, blocks the 4th, and moves the chat into an account', async () => {
        h.ai.respond = () => 'Guest answer.';
        const start = await h.http().post('/v1/guest/sessions').expect(201);
        expect(start.body.questionsLeft).toBe(3);
        const cookie = (start.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
        const token = start.body.guestToken as string;

        const lefts = [];
        for (const q of ['One?', 'Two?', 'Three?']) {
            const events = parseSse(raw(await askGuest(token, q).expect(200)));
            lefts.push(events.at(-1)?.data.questionsLeft);
        }
        expect(lefts).toEqual([2, 1, 0]);
        const blocked = await h
            .http()
            .post('/v1/guest/messages')
            .set('X-Guest-Token', token)
            .send({ text: 'Four?' })
            .expect(429);
        expect(blocked.body.code).toBe('guest_limit_reached');

        const again = await h.http().post('/v1/guest/sessions').set('Cookie', cookie).expect(201);
        expect(again.body.questionsLeft).toBe(0);
        await h
            .http()
            .post('/v1/guest/messages')
            .set('X-Guest-Token', again.body.guestToken)
            .send({ text: 'Five?' })
            .expect(429);

        const a = await signIn(h);
        const claimed = await h
            .http()
            .post('/v1/guest/claim')
            .set(bearer(a.body.accessToken))
            .send({ guestToken: token })
            .expect(200);
        expect(claimed.body).toMatchObject({ title: 'One?', mode: 'ask' });
        const msgs = await h
            .http()
            .get(`/v1/conversations/${claimed.body.id}/messages`)
            .set(bearer(a.body.accessToken))
            .expect(200);
        expect(msgs.body.items.map((m: { text: string }) => m.text)).toEqual([
            'One?',
            'Guest answer.',
            'Two?',
            'Guest answer.',
            'Three?',
            'Guest answer.',
        ]);
        expect(msgs.body.items.every((m: { charged: number }) => m.charged === 0)).toBe(true);

        const twice = await h
            .http()
            .post('/v1/guest/claim')
            .set(bearer(a.body.accessToken))
            .send({ guestToken: token })
            .expect(200);
        expect(twice.body.id).toBe(claimed.body.id);
        const b = await signIn(h);
        await h
            .http()
            .post('/v1/guest/claim')
            .set(bearer(b.body.accessToken))
            .send({ guestToken: token })
            .expect(404);
        await h
            .http()
            .post('/v1/guest/messages')
            .set('X-Guest-Token', token)
            .send({ text: 'More?' })
            .expect(401);
        expect(
            (await h.http().get('/v1/tokens').set(bearer(a.body.accessToken)).expect(200)).body
                .balance
        ).toBe(10);
    });

    it('gives the question back when the answer fails', async () => {
        h.ai.respond = () => {
            throw new Error('down');
        };
        const start = await h.http().post('/v1/guest/sessions').expect(201);
        const events = parseSse(raw(await askGuest(start.body.guestToken, 'Hello?').expect(200)));
        expect(events.at(-1)).toMatchObject({
            event: 'error',
            data: { refunded: true, questionsLeft: 3 },
        });
    });

    it('refuses a missing or unknown guest token', async () => {
        await h.http().post('/v1/guest/messages').send({ text: 'Hi' }).expect(401);
        await h
            .http()
            .post('/v1/guest/messages')
            .set('X-Guest-Token', 'gst_nope')
            .send({ text: 'Hi' })
            .expect(401);
    });
});
