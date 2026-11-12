import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DisabledMailer } from '../src/auth/mailer.js';
import { loadConfig } from '../src/config.js';
import { startHarness, type Harness } from './helpers.js';

describe('web app served by the API', () => {
    let h: Harness;
    const dir = mkdtempSync(join(tmpdir(), 'flo-web-'));

    beforeAll(async () => {
        mkdirSync(join(dir, 'assets'));
        writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Florence</title>');
        writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
        writeFileSync(join(dir, 'sw.js'), 'self.x = 1');
        h = await startHarness({ WEB_DIST: dir });
    });

    afterAll(async () => {
        await h.close();
    });

    it('answers app paths with index.html so deep links work on a phone', async () => {
        for (const path of ['/', '/home', '/prep/123', '/signin/telegram']) {
            const res = await h.http().get(path).set('Accept', 'text/html').expect(200);
            expect(res.text).toContain('<title>Florence</title>');
            expect(res.headers['cache-control']).toBe('no-cache');
        }
    });

    it('serves hashed assets with a long cache and the service worker without one', async () => {
        const asset = await h.http().get('/assets/app-abc123.js').expect(200);
        expect(asset.headers['cache-control']).toContain('immutable');
        const sw = await h.http().get('/sw.js').expect(200);
        expect(sw.headers['cache-control']).toBe('no-cache');
    });

    it('keeps API paths as JSON and allows Google sign-in in the page policy', async () => {
        const missing = await h.http().get('/v1/nope').set('Accept', 'text/html').expect(404);
        expect(missing.headers['content-type']).toMatch(/problem\+json/);
        const health = await h.http().get('/v1/health').expect(200);
        expect(health.body.status).toBe('ok');
        expect(health.headers['content-security-policy']).toContain(
            'https://accounts.google.com/gsi/client'
        );
    });

    it('refuses email codes when mail is disabled, and production needs a real or disabled driver', async () => {
        await expect(new DisabledMailer().sendSignInCode()).rejects.toMatchObject({ status: 503 });
        const base = {
            NODE_ENV: 'production',
            DATABASE_URL: 'postgres://x',
            JWT_SECRET: 'x'.repeat(40),
            CODE_PEPPER: 'x'.repeat(40),
            INTERNAL_API_SECRET: 'x'.repeat(40),
        } as unknown as NodeJS.ProcessEnv;
        expect(() => loadConfig({ ...base, MAIL_DRIVER: 'console' })).toThrow(/resend or disabled/);
        expect(loadConfig({ ...base, MAIL_DRIVER: 'disabled' }).mailDriver).toBe('disabled');
    });
});
