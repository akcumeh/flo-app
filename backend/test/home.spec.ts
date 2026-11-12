import { randomUUID } from 'node:crypto';
import { makePdf } from './fixtures.js';
import { STUDY_NOTES, studyResponder } from './study-fake.js';
import { Harness, bearer, seedSchool, signIn, startHarness } from './helpers.js';

describe('home, progress and the skeleton boards', () => {
  let h: Harness;
  let school: string;

  beforeAll(async () => {
    h = await startHarness();
    school = await seedSchool(h, 'University of Ibadan', 'ui.edu.ng');
  });

  beforeEach(() => {
    h.clock.set(new Date());
    h.ai.respond = studyResponder();
  });

  afterAll(async () => {
    await h.close();
  });

  it('shows the new-user home, then today with a session to resume', async () => {
    const a = await signIn(h);
    const t = a.body.accessToken;
    const first = await h.http().get('/v1/home').set(bearer(t)).expect(200);
    expect(first.body).toMatchObject({
      variant: 'new_user',
      streak: { current: 0, state: 'none', studiedToday: false },
      rank: null,
      exam: null,
      resume: null,
      wrappedTeaser: { ready: false },
    });

    await h.http().put('/v1/me/profile').set(bearer(t)).send({ schoolId: school }).expect(200);
    const course = await h.http().post('/v1/me/courses').set(bearer(t)).send({ code: 'BIO 101' }).expect(201);
    const up = await h
      .http()
      .post('/v1/files')
      .set(bearer(t))
      .field('courseId', course.body.course.id)
      .attach('pages', makePdf(STUDY_NOTES), { filename: 'bio.pdf', contentType: 'application/pdf' })
      .expect(201);
    await h.drain();
    const s = await h.http().post('/v1/sessions').set(bearer(t)).send({ mode: 'quiz', fileIds: [up.body.id], questionCount: 2 }).expect(202);
    await h.drain();
    await h
      .http()
      .post(`/v1/sessions/${s.body.id}/answers`)
      .set(bearer(t))
      .set('Idempotency-Key', randomUUID())
      .send({ itemId: 0, answer: 'ATP', answeredAt: new Date().toISOString() })
      .expect(200);

    const home = await h.http().get('/v1/home').set(bearer(t)).expect(200);
    expect(home.body).toMatchObject({ variant: 'today', resume: { sessionId: s.body.id, mode: 'quiz', answered: 1, total: 2 } });

    const progress = await h.http().get('/v1/progress').set(bearer(t)).expect(200);
    expect(progress.body).toMatchObject({ sessions: 0, accuracy: 100, courses: [{ code: 'BIO101', mastery: 100 }] });
    const mastery = await h.http().get(`/v1/progress/courses/${course.body.course.id}`).set(bearer(t)).expect(200);
    expect(mastery.body.mastery).toBe(100);
    expect(mastery.body.topics).toContainEqual({ id: expect.any(String), name: 'Osmosis', mastery: 100, answered: 1 });

    await h.db.query(`update enrolments set exam_date = (now() + interval '3 days')::date where course_id = $1`, [course.body.course.id]);
    const exam = await h.http().get('/v1/home').set(bearer(t)).expect(200);
    expect(exam.body).toMatchObject({ variant: 'exam_week', exam: { courseCode: 'BIO101', daysLeft: expect.any(Number) } });
  });

  it('answers the leaderboard skeleton and stores the opt-in', async () => {
    const a = await signIn(h);
    const t = a.body.accessToken;
    const board = await h.http().get('/v1/leaderboard?scope=campus').set(bearer(t)).expect(200);
    expect(board.body).toMatchObject({ scope: 'campus', status: 'not_open', entries: [], minToOpen: 5, you: { rank: null, studyDays: 0 } });
    const missing = await h.http().get('/v1/leaderboard?scope=course').set(bearer(t)).expect(422);
    expect(missing.body.code).toBe('course_required');

    const ok = await h.http().put('/v1/leaderboard/optin').set(bearer(t)).send({ optedIn: true, displayName: 'Ada O' }).expect(200);
    expect(ok.body).toEqual({ optedIn: true, displayName: 'Ada O' });
    const bad = await h.http().put('/v1/leaderboard/optin').set(bearer(t)).send({ optedIn: true, displayName: 'W3rey boy' }).expect(422);
    expect(bad.body.code).toBe('display_name_rejected');
    const off = await h.http().put('/v1/leaderboard/optin').set(bearer(t)).send({ optedIn: false }).expect(200);
    expect(off.body).toEqual({ optedIn: false, displayName: 'Ada O' });
    expect((await h.http().get('/v1/leaderboard?scope=campus').set(bearer(t)).expect(200)).body.optedIn).toBe(false);

    await h.http().get('/v1/leaderboard/weekly-results').set(bearer(t)).expect(200, { items: [] });
  });

  it('answers 409 wrapped_not_ready for Wrapped', async () => {
    const a = await signIn(h);
    for (const path of ['/v1/wrapped?period=2026-10', '/v1/wrapped/share-image?period=2026', '/v1/wrapped?period=2026-11']) {
      const res = await h.http().get(path).set(bearer(a.body.accessToken)).expect(409);
      expect(res.body.code).toBe('wrapped_not_ready');
    }
  });
});
