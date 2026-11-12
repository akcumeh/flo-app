import { Harness, startHarness, uniqueEmail } from './helpers.js';

describe('security pass', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ WEB_ORIGIN: 'https://app.florence.test' }, { rateLimits: true });
  });

  afterAll(async () => {
    await h.close();
  });

  it('sets security headers and echoes a request id', async () => {
    const res = await h.http().get('/v1/health').set('X-Request-Id', 'req_test_123456').expect(200);
    expect(res.headers['x-request-id']).toBe('req_test_123456');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    const generated = await h.http().get('/v1/health').expect(200);
    expect(generated.headers['x-request-id']).toMatch(/^req_/);
  });

  it('allows CORS only from the app origin', async () => {
    const ok = await h.http().options('/v1/me').set('Origin', 'https://app.florence.test').set('Access-Control-Request-Method', 'GET');
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.florence.test');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const bad = await h.http().options('/v1/me').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'GET');
    expect(bad.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });

  it('refuses JSON bodies over 1 MB', async () => {
    await h.http().post('/v1/auth/email/start').set('X-Forwarded-For', '10.9.9.1').send({ email: 'a@b.co', pad: 'x'.repeat(1_100_000) }).expect(413);
  });

  it('limits sign-in calls per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 62; i += 1) {
      const res = await h.http().post('/v1/auth/refresh').set('X-Forwarded-For', '10.9.9.2');
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
    const limited = await h.http().post('/v1/auth/refresh').set('X-Forwarded-For', '10.9.9.2').expect(429);
    expect(limited.body.code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    await h.http().post('/v1/auth/email/start').set('X-Forwarded-For', '10.9.9.3').send({ email: uniqueEmail() }).expect(202);
  });
});
