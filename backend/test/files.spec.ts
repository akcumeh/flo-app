import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AiRequest } from '../src/ai/ai.provider.js';
import { makePdf, fakePng } from './fixtures.js';
import { Harness, bearer, signIn, startHarness } from './helpers.js';

const NOTES = [
    'Photosynthesis converts light energy into chemical energy.\nChlorophyll absorbs red and blue light.',
    'The Calvin cycle fixes carbon dioxide into glucose.\nIt runs in the stroma of the chloroplast.',
];

function fakeReader(req: AiRequest): string {
    const props = (req.jsonSchema?.properties ?? {}) as Record<string, unknown>;
    if ('topics' in props) {
        return JSON.stringify({
            topics: [
                { name: 'Light reactions', firstPage: 1, lastPage: 1 },
                { name: 'Calvin cycle', firstPage: 2, lastPage: 9 },
            ],
        });
    }
    if ('pages' in props) {
        const content = req.messages[0].content as Array<{ type: string }>;
        const images = content.filter((b) => b.type === 'image').length || 1;
        return JSON.stringify({
            pages: Array.from({ length: images }, (_, i) => ({
                page: i + 1,
                text: `Handwritten page ${i + 1} about osmosis.`,
            })),
        });
    }
    return 'ok';
}

describe('files and library', () => {
    let h: Harness;

    beforeAll(async () => {
        h = await startHarness();
    });

    beforeEach(() => {
        h.ai.respond = fakeReader;
        h.ai.calls.length = 0;
    });

    afterAll(async () => {
        await h.close();
    });

    const upload = (
        token: string,
        files: Array<{ data: Buffer; name: string; type: string }>,
        fields: Record<string, string> = {}
    ) => {
        const req = h.http().post('/v1/files').set(bearer(token));
        for (const [k, v] of Object.entries(fields)) req.field(k, v);
        for (const f of files)
            req.attach('pages', f.data, { filename: f.name, contentType: f.type });
        return req;
    };
    const pdf = (pages = NOTES, name = 'BIO 102 notes.pdf') => ({
        data: makePdf(pages),
        name,
        type: 'application/pdf',
    });

    it('reads a PDF into page-numbered chunks and topics', async () => {
        const a = await signIn(h);
        const res = await upload(a.body.accessToken, [pdf()]).expect(201);
        expect(res.body).toMatchObject({
            name: 'BIO 102 notes.pdf',
            kind: 'document',
            mimeType: 'application/pdf',
            status: 'reading',
        });

        await h.drain();
        const file = await h
            .http()
            .get(`/v1/files/${res.body.id}`)
            .set(bearer(a.body.accessToken))
            .expect(200);
        expect(file.body.status).toBe('ready');
        expect(file.body.pageCount).toBe(2);
        expect(
            file.body.topics.map((t: { name: string; pages: string }) => [t.name, t.pages])
        ).toEqual([
            ['Calvin cycle', '2'],
            ['Light reactions', '1'],
        ]);

        const chunks = await h.db.query<{ page: number; text: string }>(
            'select page, text from file_chunks where file_id = $1 order by ord',
            [res.body.id]
        );
        expect(chunks.map((c) => c.page)).toEqual([1, 2]);
        expect(chunks[1].text).toContain('Calvin cycle');
        const hit = await h.db.query<{ page: number }>(
            `select page from file_chunks where file_id = $1 and tsv @@ plainto_tsquery('english', 'stroma chloroplast')`,
            [res.body.id]
        );
        expect(hit).toEqual([{ page: 2 }]);
        expect(h.ai.calls).toHaveLength(1);
    });

    it('keeps a UTF-8 filename as the student wrote it', async () => {
        const a = await signIn(h);
        const res = await upload(a.body.accessToken, [
            pdf(['Osmosis moves water.'], 'Lecture 4 · Transport – Adébáyọ̀.pdf'),
        ]).expect(201);
        expect(res.body.name).toBe('Lecture 4 · Transport – Adébáyọ̀.pdf');
        await h.drain();
    });

    it('groups several camera pages into one material and reads them with vision', async () => {
        const a = await signIn(h);
        const res = await upload(a.body.accessToken, [
            { data: fakePng(1), name: 'p1.png', type: 'image/png' },
            { data: fakePng(2), name: 'p2.png', type: 'image/png' },
            { data: fakePng(3), name: 'p3.png', type: 'image/png' },
        ]).expect(201);
        expect(res.body).toMatchObject({ kind: 'image', mimeType: 'image/*', name: 'p1.png' });

        await h.drain();
        const file = await h
            .http()
            .get(`/v1/files/${res.body.id}`)
            .set(bearer(a.body.accessToken))
            .expect(200);
        expect(file.body).toMatchObject({ status: 'ready', pageCount: 3 });
        const vision = h.ai.calls.find(
            (c) => 'pages' in ((c.jsonSchema?.properties ?? {}) as object)
        );
        expect(
            (vision?.messages[0].content as Array<{ type: string }>).filter(
                (b) => b.type === 'image'
            )
        ).toHaveLength(3);
    });

    it('sends a scanned PDF to the model for OCR', async () => {
        const a = await signIn(h);
        const res = await upload(a.body.accessToken, [pdf(['', ''], 'scan.pdf')]).expect(201);
        await h.drain();
        const file = await h
            .http()
            .get(`/v1/files/${res.body.id}`)
            .set(bearer(a.body.accessToken))
            .expect(200);
        expect(file.body.status).toBe('ready');
        const ocr = h.ai.calls.find((c) => 'pages' in ((c.jsonSchema?.properties ?? {}) as object));
        expect((ocr?.messages[0].content as Array<{ type: string }>)[0].type).toBe('document');
    });

    it('marks a file failed with a reason when no text can be found, and keeps it', async () => {
        const a = await signIn(h);
        h.ai.respond = (req) =>
            'pages' in ((req.jsonSchema?.properties ?? {}) as object)
                ? JSON.stringify({ pages: [{ page: 1, text: '   ' }] })
                : '{}';
        const res = await upload(a.body.accessToken, [
            { data: fakePng(50), name: 'blur.png', type: 'image/png' },
        ]).expect(201);
        await h.drain();
        const file = await h
            .http()
            .get(`/v1/files/${res.body.id}`)
            .set(bearer(a.body.accessToken))
            .expect(200);
        expect(file.body.status).toBe('failed');
        expect(file.body.error).toMatch(/could not find any text/);
        const list = await h.http().get('/v1/files').set(bearer(a.body.accessToken)).expect(200);
        expect(list.body.items.map((f: { id: string }) => f.id)).toContain(res.body.id);
    });

    it('fails a file after three provider errors', async () => {
        const a = await signIn(h);
        h.ai.respond = () => {
            throw new Error('provider down');
        };
        const res = await upload(a.body.accessToken, [
            { data: fakePng(60), name: 'x.png', type: 'image/png' },
        ]).expect(201);
        await h.drain();
        const file = await h
            .http()
            .get(`/v1/files/${res.body.id}`)
            .set(bearer(a.body.accessToken))
            .expect(200);
        expect(file.body.status).toBe('failed');
        expect(file.body.error).toMatch(/could not read this file/);
        expect(h.ai.calls).toHaveLength(3);
    });

    it('returns the existing file for a duplicate upload and suffixes a repeated name', async () => {
        const a = await signIn(h);
        const first = await upload(a.body.accessToken, [pdf()]).expect(201);
        const again = await upload(a.body.accessToken, [pdf()]).expect(201);
        expect(again.body.id).toBe(first.body.id);

        const other = await upload(a.body.accessToken, [pdf(['Different notes'])]).expect(201);
        expect(other.body.name).toBe('BIO 102 notes-2.pdf');
        const list = await h.http().get('/v1/files').set(bearer(a.body.accessToken)).expect(200);
        expect(list.body.items).toHaveLength(2);
    });

    it('refuses unsupported types and mixed uploads', async () => {
        const a = await signIn(h);
        const text = await upload(a.body.accessToken, [
            { data: Buffer.from('hello'), name: 'a.txt', type: 'text/plain' },
        ]).expect(415);
        expect(text.body.code).toBe('unsupported_type');
        const fakePdf = await upload(a.body.accessToken, [
            { data: Buffer.from('not a pdf'), name: 'a.pdf', type: 'application/pdf' },
        ]).expect(415);
        expect(fakePdf.body.code).toBe('unsupported_type');
        await upload(a.body.accessToken, [
            pdf(),
            { data: fakePng(9), name: 'p.png', type: 'image/png' },
        ]).expect(415);
    });

    it('refuses uploads over 20 MB', async () => {
        const a = await signIn(h);
        const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(20 * 1024 * 1024)]);
        const res = await upload(a.body.accessToken, [
            { data: big, name: 'big.pdf', type: 'application/pdf' },
        ]).expect(413);
        expect(res.body.code).toBe('file_too_large');
    });

    it('answers library_full on the 21st file', async () => {
        const a = await signIn(h);
        for (let i = 0; i < 20; i += 1) {
            await h.db.query(
                `insert into stored_files (account_id, name, mime_type, size_bytes, kind, status) values ($1, $2, 'application/pdf', 1, 'document', 'ready')`,
                [a.body.account.id, `f${i}.pdf`]
            );
        }
        const res = await upload(a.body.accessToken, [pdf()]).expect(409);
        expect(res.body.code).toBe('library_full');
    });

    it('serves the content through a short-lived signed link', async () => {
        const a = await signIn(h);
        const body = makePdf(['Signed link test']);
        const res = await upload(a.body.accessToken, [
            { data: body, name: 's.pdf', type: 'application/pdf' },
        ]).expect(201);
        const redirect = await h
            .http()
            .get(`/v1/files/${res.body.id}/content`)
            .set(bearer(a.body.accessToken))
            .expect(302);
        const url = new URL(redirect.headers.location);
        expect(url.origin).toBe('http://storage.test');
        const blob = await h.http().get(url.pathname).expect(200);
        expect(blob.headers['content-type']).toBe('application/pdf');
        expect(Buffer.from(blob.body).equals(body)).toBe(true);
        await h.http().get(`${url.pathname}x`).expect(404);
    });

    it('deletes the stored object, chunks and topics', async () => {
        const a = await signIn(h);
        const res = await upload(a.body.accessToken, [pdf(['Delete me please'])]).expect(201);
        await h.drain();
        const [part] = await h.db.query<{ storage_path: string }>(
            'select storage_path from file_parts where file_id = $1',
            [res.body.id]
        );
        const onDisk = join((h.storage as unknown as { root: string }).root, part.storage_path);
        expect(existsSync(onDisk)).toBe(true);

        await h
            .http()
            .delete(`/v1/files/${res.body.id}`)
            .set(bearer(a.body.accessToken))
            .expect(204);
        expect(existsSync(onDisk)).toBe(false);
        const [{ chunks, topics }] = await h.db.query<{ chunks: number; topics: number }>(
            `select (select count(*)::int from file_chunks where file_id = $1) as chunks,
              (select count(*)::int from file_topics where file_id = $1) as topics`,
            [res.body.id]
        );
        expect({ chunks, topics }).toEqual({ chunks: 0, topics: 0 });
        await h.http().get(`/v1/files/${res.body.id}`).set(bearer(a.body.accessToken)).expect(404);
    });

    it('keeps one account out of another account files', async () => {
        const a = await signIn(h);
        const b = await signIn(h);
        const res = await upload(a.body.accessToken, [pdf(['Private notes'])]).expect(201);
        const id = res.body.id;
        const list = await h.http().get('/v1/files').set(bearer(b.body.accessToken)).expect(200);
        expect(list.body.items).toEqual([]);
        await h.http().get(`/v1/files/${id}`).set(bearer(b.body.accessToken)).expect(404);
        await h.http().get(`/v1/files/${id}/content`).set(bearer(b.body.accessToken)).expect(404);
        await h.http().delete(`/v1/files/${id}`).set(bearer(b.body.accessToken)).expect(404);
        await h.http().get(`/v1/files/${id}`).set(bearer(a.body.accessToken)).expect(200);
    });

    it('needs a session', async () => {
        await h.http().get('/v1/files').expect(401);
    });
});
