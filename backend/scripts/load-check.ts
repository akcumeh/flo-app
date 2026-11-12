import 'reflect-metadata';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAiProvider } from '../src/ai/ai.provider.js';
import type { Mailer } from '../src/auth/mailer.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/create-app.js';
import { migrate } from '../src/db/migrate.js';
import { PgliteDb } from '../src/db/pglite.db.js';
import { LocalDiskStorage } from '../src/storage/storage.js';

const CLIENTS = Number(process.env.CLIENTS ?? 200);
const SECONDS = Number(process.env.SECONDS ?? 60);

const codes = new Map<string, string>();
const mailer: Mailer = {
    async sendSignInCode(to, code) {
        codes.set(to, code);
    },
    async sendStudentCode() {},
};
const ai = new FakeAiProvider();
ai.respond = () => 'Osmosis moves water across a membrane without using energy. '.repeat(8);
ai.delayMs = 20;

const db = new PgliteDb();
await migrate(db);
const config = { ...loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv), nodeEnv: 'test' };
const app = await createApp({
    config,
    db,
    mailer,
    ai,
    storage: new LocalDiskStorage(
        mkdtempSync(join(tmpdir(), 'flo-load-')),
        'http://storage.local',
        'load'
    ),
    logger: false,
    rateLimits: false,
});
await app.listen(0);
const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

async function json(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as Record<string, unknown>;
}

const clients = [];
for (let i = 0; i < CLIENTS; i += 1) {
    const email = `load${i}@example.com`;
    const ip = { 'X-Forwarded-For': `10.${Math.floor(i / 250)}.${i % 250}.1` };
    await json('/v1/auth/email/start', { email }, ip);
    const session = await json('/v1/auth/email/verify', { email, code: codes.get(email) });
    const token = session.accessToken as string;
    const accountId = (session.account as { id: string }).id;
    await db.query('update accounts set token_balance = 100000 where id = $1', [accountId]);
    const conv = await json('/v1/conversations', {}, { Authorization: `Bearer ${token}` });
    clients.push({ token, conversationId: conv.id as string });
}

const firstDelta: number[] = [];
const totals: number[] = [];
let errors = 0;
let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 250);
const deadline = Date.now() + SECONDS * 1000;

await Promise.all(
    clients.map(async (c) => {
        while (Date.now() < deadline) {
            const started = performance.now();
            try {
                const res = await fetch(`${base}/v1/conversations/${c.conversationId}/messages`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${c.token}`,
                        'Idempotency-Key': crypto.randomUUID(),
                    },
                    body: JSON.stringify({ text: 'What is osmosis?' }),
                });
                const reader = (res.body as ReadableStream<Uint8Array>).getReader();
                const decoder = new TextDecoder();
                let text = '';
                let seen = false;
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    text += decoder.decode(value, { stream: true });
                    if (!seen && text.includes('event: delta')) {
                        seen = true;
                        firstDelta.push(performance.now() - started);
                    }
                }
                if (!text.includes('event: message.end')) errors += 1;
                else totals.push(performance.now() - started);
            } catch {
                errors += 1;
            }
        }
    })
);
clearInterval(sampler);

const pct = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length
        ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))])
        : null;
};
console.log(
    JSON.stringify({
        clients: CLIENTS,
        seconds: SECONDS,
        completed: totals.length,
        errors,
        perSecond: Number((totals.length / SECONDS).toFixed(1)),
        firstDeltaMs: {
            p50: pct(firstDelta, 50),
            p95: pct(firstDelta, 95),
            p99: pct(firstDelta, 99),
        },
        totalMs: { p50: pct(totals, 50), p95: pct(totals, 95), p99: pct(totals, 99) },
        peakRssMb: Math.round(peakRss / 1024 / 1024),
    })
);
await app.close();
await db.close();
