import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { Mailer } from '../src/auth/mailer.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/create-app.js';
import type { Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { PgliteDb } from '../src/db/pglite.db.js';

export class TestMailer implements Mailer {
  readonly sent: Array<{ to: string; code: string }> = [];

  async sendSignInCode(to: string, code: string) {
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
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

export const TEST_ENV = {
  NODE_ENV: 'test',
  INTERNAL_API_SECRET: 'test-internal-secret-0123456789abcdef',
  TELEGRAM_BOT_USERNAME: 'florence_test_bot',
  WHATSAPP_BUSINESS_NUMBER: '2348000000000',
};

export async function startHarness(env: Record<string, string> = {}): Promise<Harness> {
  const db = new PgliteDb();
  await migrate(db);
  const mailer = new TestMailer();
  const app = await createApp({
    config: loadConfig({ ...TEST_ENV, ...env } as NodeJS.ProcessEnv),
    db,
    mailer,
    validateResponses: true,
    logger: false,
  });
  await app.init();
  return {
    app,
    db,
    mailer,
    http: () => request(app.getHttpServer()),
    close: async () => {
      await app.close();
      await db.close();
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
  await h.http().post('/v1/auth/email/start').set('X-Forwarded-For', uniqueIp()).send({ email }).expect(202);
  const res = await h
    .http()
    .post('/v1/auth/email/verify')
    .send({ email, code: h.mailer.lastCodeFor(email) })
    .expect(200);
  const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('flo_rt=')) as string;
  return {
    email,
    body: res.body as { accessToken: string; account: { id: string; tokenBalance: number }; isNewAccount: boolean },
    cookie: cookie.split(';')[0],
    rawCookie: cookie,
  };
}
