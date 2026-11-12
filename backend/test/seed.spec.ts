import { seed } from '../src/db/migrate.js';
import { startHarness, type Harness } from './helpers.js';

describe('seed', () => {
    let h: Harness;

    beforeAll(async () => {
        h = await startHarness();
    });

    afterAll(async () => {
        await h.close();
    });

    it('loads the Nigerian schools once and can run again without duplicates', async () => {
        await seed(h.db);
        const [{ n }] = await h.db.query<{ n: number }>('select count(*)::int as n from schools');
        expect(n).toBeGreaterThanOrEqual(100);
        await seed(h.db);
        const [{ n: again }] = await h.db.query<{ n: number }>(
            'select count(*)::int as n from schools'
        );
        expect(again).toBe(n);
        const res = await h.http().get('/v1/schools?q=lagos').expect(200);
        expect(
            res.body.items.some((s: { name: string }) => /University of Lagos/.test(s.name))
        ).toBe(true);
    });
});
