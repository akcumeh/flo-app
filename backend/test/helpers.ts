import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAiProvider } from '../src/ai/ai.provider.js';
import { FixedClock } from '../src/common/clock.js';
import type { ExternalAuth } from '../src/auth/external-auth.js';
import type { Mailer } from '../src/auth/mailer.js';
import { loadConfig, type Config } from '../src/config.js';
import { createApp } from '../src/create-app.js';
import type { Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { randomBytes } from 'node:crypto';
import { PgDb } from '../src/db/pg.db.js';
import { PgliteDb } from '../src/db/pglite.db.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import { SchedulerService } from '../src/jobs/scheduler.service.js';
import { FakePaystack } from '../src/money/paystack.js';
import { FakeMessenger } from '../src/platform/messenger.js';
import { FakeCodeSender } from '../src/auth/whatsapp-codes.js';
import { FakePushSender } from '../src/platform/push.js';
import { LocalDiskStorage } from '../src/storage/storage.js';

export class TestMailer implements Mailer {
    readonly sent: Array<{ to: string; code: string }> = [];

    async sendSignInCode(to: string, code: string) {
        this.sent.push({ to, code });
    }

    async sendStudentCode(to: string, code: string) {
        this.sent.push({ to, code });
    }

    lastCodeFor(email: string): string {
        const hit = [...this.sent].reverse().find((m) => m.to === email.toLowerCase());
        if (!hit) throw new Error(`no code sent to ${email}`);
        return hit.code;
    }
}

export interface Harness {
    app: NestExpressApplication;
    db: Db;
    mailer: TestMailer;
    ai: FakeAiProvider;
    storage: LocalDiskStorage;
    clock: FixedClock;
    paystack: FakePaystack;
    push: FakePushSender;
    messenger: FakeMessenger;
    whatsappCodes: FakeCodeSender;
    tick: () => Promise<void>;
    drain: () => Promise<void>;
    http: () => ReturnType<typeof request>;
    close: () => Promise<void>;
}

export const TEST_ENV = {
    NODE_ENV: 'test',
    INTERNAL_API_SECRET: 'test-internal-secret-0123456789abcdef',
    TELEGRAM_BOT_USERNAME: 'florence_test_bot',
    TELEGRAM_BOT_TOKEN: '123456789:TEST-token-for-the-login-widget-0000',
    WHATSAPP_BUSINESS_NUMBER: '2348000000000',
};

async function testDb(): Promise<{ db: Db; stop: () => Promise<void> }> {
    if (process.env.TEST_DATABASE_URL) {
        const url = process.env.TEST_DATABASE_URL;
        const schema = `test_${randomBytes(6).toString('hex')}`;
        const admin = new PgDb(url, { max: 1 });
        await admin.exec(`create schema ${schema}`);
        const db = new PgDb(url, { max: 5, schema });
        return {
            db,
            stop: async () => {
                await db.close();
                await admin.exec(`drop schema ${schema} cascade`);
                await admin.close();
            },
        };
    }
    if (process.env.TEST_DB === 'pg-socket') {
        const pglite = new PGlite();
        const port = 20000 + Math.floor(Math.random() * 20000);
        const server = new PGLiteSocketServer({
            db: pglite,
            port,
            host: '127.0.0.1',
            maxConnections: 1,
        });
        await server.start();
        const db = new PgDb(`postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`, {
            max: 1,
        });
        return {
            db,
            stop: async () => {
                await db.close();
                await server.stop();
                await pglite.close();
            },
        };
    }
    const db = new PgliteDb();
    return { db, stop: () => db.close() };
}

export async function startHarness(
    env: Record<string, string> = {},
    opts: { externalAuth?: (config: Config) => ExternalAuth; rateLimits?: boolean } = {}
): Promise<Harness> {
    const { db, stop } = await testDb();
    await migrate(db);
    const mailer = new TestMailer();
    const ai = new FakeAiProvider();
    const clock = new FixedClock();
    const paystack = new FakePaystack();
    const push = new FakePushSender();
    const messenger = new FakeMessenger();
    const whatsappCodes = new FakeCodeSender();
    const config = loadConfig({ ...TEST_ENV, ...env } as NodeJS.ProcessEnv);
    const storage = new LocalDiskStorage(
        mkdtempSync(join(tmpdir(), 'flo-storage-')),
        'http://storage.test',
        'test-storage-secret'
    );
    const app = await createApp({
        config,
        db,
        mailer,
        ai,
        storage,
        clock,
        paystack,
        push,
        messenger,
        whatsappCodes,
        externalAuth: opts.externalAuth?.(config),
        validateResponses: true,
        rateLimits: opts.rateLimits ?? false,
        logger: false,
    });
    await app.init();
    return {
        app,
        db,
        mailer,
        ai,
        storage,
        clock,
        paystack,
        push,
        messenger,
        whatsappCodes,
        tick: () => app.get(SchedulerService).tick(),
        drain: () => app.get(JobsService).drain(),
        http: () => request(app.getHttpServer()),
        close: async () => {
            await app.close();
            await stop();
        },
    };
}

let counter = 0;
export function uniqueEmail(): string {
    counter += 1;
    return `student${counter}.${Date.now()}@example.com`;
}

let ipCounter = 0;
export function uniqueIp(): string {
    ipCounter += 1;
    return `10.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}.7`;
}

export async function signIn(h: Harness, email = uniqueEmail()) {
    await h
        .http()
        .post('/v1/auth/email/start')
        .set('X-Forwarded-For', uniqueIp())
        .send({ email })
        .expect(202);
    const res = await h
        .http()
        .post('/v1/auth/email/verify')
        .send({ email, code: h.mailer.lastCodeFor(email) })
        .expect(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
        c.startsWith('flo_rt=')
    ) as string;
    return {
        email,
        body: res.body as {
            accessToken: string;
            account: { id: string; tokenBalance: number };
            isNewAccount: boolean;
        },
        cookie: cookie.split(';')[0],
        rawCookie: cookie,
    };
}

export async function seedSchool(h: Harness, name: string, domain: string): Promise<string> {
    const [{ id }] = await h.db.query<{ id: string }>(
        `insert into schools (name, short_name, kind) values ($1, $1, 'university')
     on conflict (country, name) do update set name = excluded.name returning id`,
        [name]
    );
    await h.db.query(
        'insert into school_domains (domain, school_id) values ($1, $2) on conflict do nothing',
        [domain, id]
    );
    return id;
}

export function bearer(token: string) {
    return { Authorization: `Bearer ${token}` };
}
