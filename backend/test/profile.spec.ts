import { makePdf } from './fixtures.js';
import { Harness, bearer, seedSchool, signIn, startHarness } from './helpers.js';

describe('schools, profile and courses', () => {
  let h: Harness;
  let unilag: string;
  let unn: string;

  beforeAll(async () => {
    h = await startHarness();
    unilag = await seedSchool(h, 'University of Lagos', 'unilag.edu.ng');
    unn = await seedSchool(h, 'University of Nigeria, Nsukka', 'unn.edu.ng');
  });

  afterAll(async () => {
    await h.close();
  });

  it('searches schools without a session', async () => {
    const res = await h.http().get('/v1/schools?q=lagos').expect(200);
    expect(res.body.items).toEqual([{ id: unilag, name: 'University of Lagos', country: 'NG', kind: 'university' }]);
    const all = await h.http().get('/v1/schools?limit=1').expect(200);
    expect(all.body.items).toHaveLength(1);
  });

  it('answers 404 for departments of an unknown school', async () => {
    await h.http().get('/v1/schools/00000000-0000-4000-8000-000000000000/departments').expect(404);
    await h.http().get('/v1/schools/not-a-uuid/departments').expect(404);
  });

  it('saves a profile step by step and completes onboarding', async () => {
    const a = await signIn(h);
    const t = a.body.accessToken;
    const step1 = await h.http().put('/v1/me/profile').set(bearer(t)).send({ schoolId: unilag }).expect(200);
    expect(step1.body).toMatchObject({ school: { id: unilag }, department: null, onboardingComplete: false });

    const step2 = await h.http().put('/v1/me/profile').set(bearer(t)).send({ departmentName: '  Biochemistry ' }).expect(200);
    expect(step2.body.department.name).toBe('Biochemistry');

    const step3 = await h.http().put('/v1/me/profile').set(bearer(t)).send({ level: 200, examDate: '2027-01-20' }).expect(200);
    expect(step3.body).toMatchObject({ level: 200, examDate: '2027-01-20', onboardingComplete: true });

    const depts = await h.http().get(`/v1/schools/${unilag}/departments`).expect(200);
    expect(depts.body.items).toEqual([{ id: step2.body.department.id, name: 'Biochemistry' }]);

    const b = await signIn(h);
    await h.http().put('/v1/me/profile').set(bearer(b.body.accessToken)).send({ schoolId: unilag }).expect(200);
    const picked = await h
      .http()
      .put('/v1/me/profile')
      .set(bearer(b.body.accessToken))
      .send({ departmentId: step2.body.department.id })
      .expect(200);
    expect(picked.body.department.id).toBe(step2.body.department.id);
  });

  it('refuses a department from another school and clears it when the school changes', async () => {
    const a = await signIn(h);
    const t = a.body.accessToken;
    const [{ id: unnDept }] = await h.db.query<{ id: string }>(
      `insert into departments (school_id, name) values ($1, 'Physics') returning id`,
      [unn]
    );
    await h.http().put('/v1/me/profile').set(bearer(t)).send({ schoolId: unilag, departmentName: 'Law' }).expect(200);
    const wrong = await h.http().put('/v1/me/profile').set(bearer(t)).send({ departmentId: unnDept }).expect(422);
    expect(wrong.body.code).toBe('unknown_department');
    const moved = await h.http().put('/v1/me/profile').set(bearer(t)).send({ schoolId: unn }).expect(200);
    expect(moved.body.department).toBeNull();
  });

  it('enrols by normalised code, shares the course and counts files', async () => {
    const a = await signIn(h);
    const b = await signIn(h);
    const none = await h.http().post('/v1/me/courses').set(bearer(a.body.accessToken)).send({ code: 'BIO 102' }).expect(422);
    expect(none.body.code).toBe('school_required');

    for (const s of [a, b]) {
      await h.http().put('/v1/me/profile').set(bearer(s.body.accessToken)).send({ schoolId: unilag }).expect(200);
    }
    const first = await h.http().post('/v1/me/courses').set(bearer(a.body.accessToken)).send({ code: 'bio 102', title: 'Cell biology' }).expect(201);
    const second = await h.http().post('/v1/me/courses').set(bearer(b.body.accessToken)).send({ code: 'BIO-102' }).expect(201);
    expect(first.body.course).toMatchObject({ code: 'BIO102', title: 'Cell biology', schoolId: unilag });
    expect(second.body.course.id).toBe(first.body.course.id);

    const dup = await h.http().post('/v1/me/courses').set(bearer(a.body.accessToken)).send({ code: 'BIO102' }).expect(409);
    expect(dup.body.code).toBe('already_enrolled');
    const bad = await h.http().post('/v1/me/courses').set(bearer(a.body.accessToken)).send({ code: '!!' }).expect(422);
    expect(bad.body.code).toBe('invalid_course_code');

    const courseId = first.body.course.id;
    await h
      .http()
      .post('/v1/files')
      .set(bearer(a.body.accessToken))
      .field('courseId', courseId)
      .attach('pages', makePdf(['Mitochondria make ATP through oxidative phosphorylation on the inner membrane.']), { filename: 'cells.pdf', contentType: 'application/pdf' })
      .expect(201);
    h.ai.respond = (req) =>
      'topics' in ((req.jsonSchema?.properties ?? {}) as object)
        ? JSON.stringify({ topics: [{ name: 'Mitochondria', firstPage: 1, lastPage: 1 }] })
        : '{}';
    await h.drain();

    const mine = await h.http().get('/v1/me/courses').set(bearer(a.body.accessToken)).expect(200);
    expect(mine.body.items).toEqual([{ course: first.body.course, fileCount: 1, mastery: null }]);

    const detail = await h.http().get(`/v1/me/courses/${courseId}`).set(bearer(a.body.accessToken)).expect(200);
    expect(detail.body.files).toHaveLength(1);
    expect(detail.body.topics).toEqual([{ id: expect.any(String), name: 'Mitochondria', mastery: null, answered: 0 }]);

    await h.http().get(`/v1/me/courses/${courseId}`).set(bearer(b.body.accessToken)).expect(200).expect((r) => {
      expect(r.body.files).toEqual([]);
    });

    await h.http().delete(`/v1/me/courses/${courseId}`).set(bearer(a.body.accessToken)).expect(204);
    await h.http().get(`/v1/me/courses/${courseId}`).set(bearer(a.body.accessToken)).expect(404);
    const files = await h.http().get('/v1/files').set(bearer(a.body.accessToken)).expect(200);
    expect(files.body.items).toHaveLength(1);
  });

  it('refuses to attach a file to a course the student does not take', async () => {
    const a = await signIn(h);
    const res = await h
      .http()
      .post('/v1/files')
      .set(bearer(a.body.accessToken))
      .field('courseId', '00000000-0000-4000-8000-000000000000')
      .attach('pages', makePdf(['x']), { filename: 'x.pdf', contentType: 'application/pdf' })
      .expect(422);
    expect(res.body.code).toBe('course_not_enrolled');
  });

  it('gives one fact per Lagos day and falls back when the model fails', async () => {
    const a = await signIn(h);
    h.ai.respond = () => {
      throw new Error('down');
    };
    const first = await h.http().get('/v1/facts/today').set(bearer(a.body.accessToken)).expect(200);
    expect(first.body.text.length).toBeGreaterThan(10);
    expect(first.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    h.ai.respond = () => JSON.stringify({ text: 'A different fact.', topic: 'Physics' });
    const second = await h.http().get('/v1/facts/today').set(bearer(a.body.accessToken)).expect(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it('stores a generated fact', async () => {
    const h2 = await startHarness();
    try {
      const a = await signIn(h2);
      h2.ai.respond = () => JSON.stringify({ text: 'Light from the Sun takes about 8 minutes to reach Earth.', topic: 'Astronomy' });
      const res = await h2.http().get('/v1/facts/today').set(bearer(a.body.accessToken)).expect(200);
      expect(res.body).toMatchObject({ text: 'Light from the Sun takes about 8 minutes to reach Earth.', topic: 'Astronomy' });
    } finally {
      await h2.close();
    }
  });
});
