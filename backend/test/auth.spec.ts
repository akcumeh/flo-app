import { Harness, signIn, startHarness, uniqueEmail } from './helpers.js';

describe('auth, account and tokens', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('answers health and status', async () => {
    await h.http().get('/v1/health').expect(200, { status: 'ok' });
    const res = await h.http().get('/v1/status').expect(200);
    expect(res.body.maintenance).toBe(false);
  });

  it('answers 202 for any address and sends a six digit code', async () => {
    const email = uniqueEmail();
    await h.http().post('/v1/auth/email/start').send({ email }).expect(202);
    expect(h.mailer.lastCodeFor(email)).toMatch(/^[0-9]{6}$/);
  });

  it('rejects a malformed email with a problem document', async () => {
    const res = await h.http().post('/v1/auth/email/start').send({ email: 'not-an-email' }).expect(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe('invalid_request');
  });

  it('creates an account, grants 10 tokens once and sets a refresh cookie', async () => {
    const s = await signIn(h);
    expect(s.body.isNewAccount).toBe(true);
    expect(s.body.account.tokenBalance).toBe(10);
    expect(s.rawCookie).toMatch(/HttpOnly/i);
    expect(s.rawCookie).toMatch(/SameSite=Strict/i);
    expect(s.rawCookie).toMatch(/Path=\/v1\/auth/);

    const again = await signIn(h, s.email);
    expect(again.body.isNewAccount).toBe(false);
    expect(again.body.account.id).toBe(s.body.account.id);
    expect(again.body.account.tokenBalance).toBe(10);
  });

  it('serves /me and the token ledger to a signed-in student', async () => {
    const s = await signIn(h);
    const auth = { Authorization: `Bearer ${s.body.accessToken}` };

    const me = await h.http().get('/v1/me').set(auth).expect(200);
    expect(me.body.identities[0].provider).toBe('email');
    expect(me.body.identities[0].display).toMatch(/^.\*\*\*@example\.com$/);

    await h.http().get('/v1/tokens').set(auth).expect(200, { balance: 10 });
    const ledger = await h.http().get('/v1/tokens/ledger').set(auth).expect(200);
    expect(ledger.body.items).toHaveLength(1);
    expect(ledger.body.items[0]).toMatchObject({ delta: 10, reason: 'welcome_grant', balanceAfter: 10 });
    expect(ledger.body.nextCursor).toBeNull();
  });

  it('refuses /me without a valid token', async () => {
    const res = await h.http().get('/v1/me').expect(401);
    expect(res.body.code).toBe('unauthorized');
    await h.http().get('/v1/me').set('Authorization', 'Bearer nonsense').expect(401);
  });

  it('updates the username and reports a clash with 409', async () => {
    const a = await signIn(h);
    const b = await signIn(h);
    const authA = { Authorization: `Bearer ${a.body.accessToken}` };
    const authB = { Authorization: `Bearer ${b.body.accessToken}` };

    const name = `ada_${Date.now() % 100000}`;
    await h.http().patch('/v1/me').set(authA).send({ username: name }).expect(200);
    const clash = await h.http().patch('/v1/me').set(authB).send({ username: name }).expect(409);
    expect(clash.body.code).toBe('username_taken');
  });

  it('locks a code after five wrong tries', async () => {
    const email = uniqueEmail();
    await h.http().post('/v1/auth/email/start').send({ email }).expect(202);
    const real = h.mailer.lastCodeFor(email);
    const wrong = real === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i++) {
      const res = await h.http().post('/v1/auth/email/verify').send({ email, code: wrong }).expect(400);
      expect(res.body.code).toBe('invalid_code');
    }
    const locked = await h.http().post('/v1/auth/email/verify').send({ email, code: real }).expect(400);
    expect(locked.body.code).toBe('code_locked');
  });

  it('allows three sends per address per hour, then 429 with Retry-After', async () => {
    const email = uniqueEmail();
    for (let i = 0; i < 3; i++) await h.http().post('/v1/auth/email/start').send({ email }).expect(202);
    const res = await h.http().post('/v1/auth/email/start').send({ email }).expect(429);
    expect(res.headers['retry-after']).toBe('3600');
    expect(res.body.code).toBe('rate_limited');
  });

  it('allows ten sends per IP per hour across different addresses, then 429', async () => {
    const ip = '203.0.113.9';
    for (let i = 0; i < 10; i++) {
      await h.http().post('/v1/auth/email/start').set('X-Forwarded-For', ip).send({ email: uniqueEmail() }).expect(202);
    }
    const res = await h
      .http()
      .post('/v1/auth/email/start')
      .set('X-Forwarded-For', ip)
      .send({ email: uniqueEmail() })
      .expect(429);
    expect(res.body.code).toBe('rate_limited');
  });

  it('rotates the refresh token and revokes the family when an old one is replayed', async () => {
    const s = await signIn(h);

    const first = await h.http().post('/v1/auth/refresh').set('Cookie', s.cookie).expect(200);
    expect(first.body.accessToken).toEqual(expect.any(String));
    const rotated = (first.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    expect(rotated).not.toBe(s.cookie);

    const replay = await h.http().post('/v1/auth/refresh').set('Cookie', s.cookie).expect(401);
    expect(replay.body.code).toBe('refresh_reuse_detected');

    const afterRevoke = await h.http().post('/v1/auth/refresh').set('Cookie', rotated).expect(401);
    expect(afterRevoke.body.code).toBe('invalid_refresh_token');
  });

  it('logs out by revoking the refresh token', async () => {
    const s = await signIn(h);
    await h.http().post('/v1/auth/logout').set('Cookie', s.cookie).expect(204);
    await h.http().post('/v1/auth/refresh').set('Cookie', s.cookie).expect(401);
  });

  it('answers 404 for paths that are not in the spec', async () => {
    const s = await signIn(h);
    const res = await h
      .http()
      .get('/v1/not-a-route')
      .set('Authorization', `Bearer ${s.body.accessToken}`)
      .expect(404);
    expect(res.body.code).toBe('not_found');
  });
});
