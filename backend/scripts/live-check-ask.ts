import 'reflect-metadata';
import 'dotenv/config';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { ConsoleMailer } from '../src/auth/mailer.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/create-app.js';
import { migrate } from '../src/db/migrate.js';
import { PgliteDb } from '../src/db/pglite.db.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import { LocalDiskStorage } from '../src/storage/storage.js';
import { makePdf } from '../test/fixtures.js';

const config = { ...loadConfig(), nodeEnv: 'development', mailDriver: 'console' as const };
if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not set');
const db = new PgliteDb();
await migrate(db);
const codes: string[] = [];
const mailer = new (class extends ConsoleMailer {
    async sendSignInCode(_to: string, code: string) {
        codes.push(code);
    }
})();
const storage = new LocalDiskStorage(
    mkdtempSync(join(tmpdir(), 'flo-live-')),
    'http://storage.local',
    'live-check'
);
const app = await createApp({ config, db, mailer, storage, logger: false });
await app.init();
const http = () => request(app.getHttpServer());

const email = 'live.check@example.com';
await http().post('/v1/auth/email/start').send({ email }).expect(202);
const auth = (
    await http().post('/v1/auth/email/verify').send({ email, code: codes[0] }).expect(200)
).body;
const bearer = { Authorization: `Bearer ${auth.accessToken}` };

const pdf = makePdf([
    'Photosynthesis takes place in the chloroplast.\nThe light reactions happen in the thylakoid membranes and make ATP and NADPH.',
    'The Calvin cycle runs in the stroma.\nThe enzyme RuBisCO fixes carbon dioxide onto ribulose bisphosphate.\nThree turns of the cycle make one G3P molecule.',
]);
const file = (
    await http()
        .post('/v1/files')
        .set(bearer)
        .attach('pages', pdf, {
            filename: 'BIO 201 photosynthesis.pdf',
            contentType: 'application/pdf',
        })
        .expect(201)
).body;
await app.get(JobsService).drain();
const ready = (await http().get(`/v1/files/${file.id}`).set(bearer).expect(200)).body;
console.log(
    'file',
    ready.status,
    'pages',
    ready.pageCount,
    'topics',
    ready.topics.map((t: { name: string }) => t.name).join(', ')
);

const conv = (await http().post('/v1/conversations').set(bearer).send({}).expect(201)).body;
const started = Date.now();
const res = await http()
    .post(`/v1/conversations/${conv.id}/messages`)
    .set(bearer)
    .set('Idempotency-Key', crypto.randomUUID())
    .buffer(true)
    .parse((r, done) => {
        let t = '';
        r.setEncoding('utf8');
        r.on('data', (c: string) => (t += c));
        r.on('end', () => done(null, t));
    })
    .send({
        text: 'Which enzyme fixes carbon dioxide in the Calvin cycle, and where does that happen?',
    })
    .expect(200);
const events = String(res.body)
    .split('\n\n')
    .filter((f) => f.startsWith('event:'))
    .map((f) => ({
        event: f.split('\n')[0].slice(7),
        data: JSON.parse(f.split('\n')[1].slice(6)),
    }));
const text = events
    .filter((e) => e.event === 'delta')
    .map((e) => e.data.text)
    .join('');
console.log(
    'events',
    events
        .map((e) => e.event)
        .filter((e, i, a) => a.indexOf(e) === i)
        .join(' > '),
    'deltas',
    events.filter((e) => e.event === 'delta').length
);
console.log('answer', JSON.stringify(text.slice(0, 220)));
console.log(
    'citations',
    JSON.stringify(
        events.filter((e) => e.event === 'citation').map((e) => `${e.data.label} p.${e.data.page}`)
    )
);
console.log(
    'end',
    JSON.stringify(events.at(-1)?.data),
    'seconds',
    ((Date.now() - started) / 1000).toFixed(1)
);
await app.close();
await db.close();
