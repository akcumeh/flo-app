import { randomUUID } from 'node:crypto';
import { paystackSignature } from '../src/money/paystack.js';
import { Harness, bearer, signIn, startHarness } from './helpers.js';

describe('bundles and Paystack purchases', () => {
    let h: Harness;

    beforeAll(async () => {
        h = await startHarness();
    });

    afterAll(async () => {
        await h.close();
    });

    const balance = async (t: string) =>
        (await h.http().get('/v1/tokens').set(bearer(t)).expect(200)).body.balance;

    function webhook(body: object, secret = h.paystack.secret) {
        const raw = JSON.stringify(body);
        return h
            .http()
            .post('/v1/webhooks/paystack')
            .set('Content-Type', 'application/json')
            .set('x-paystack-signature', paystackSignature(secret, Buffer.from(raw)))
            .send(raw);
    }

    it('lists the bot bundles without a session', async () => {
        const res = await h.http().get('/v1/tokens/bundles').expect(200);
        expect(res.body.items[1]).toEqual({ id: 'b_1000', amountNaira: 1000, tokens: 10 });
        expect(res.body.items).toHaveLength(6);
    });

    it('starts a card payment, credits once from a webhook and a verify together', async () => {
        const a = await signIn(h);
        const t = a.body.accessToken;
        const key = randomUUID();
        const p = await h
            .http()
            .post('/v1/tokens/purchases')
            .set(bearer(t))
            .set('Idempotency-Key', key)
            .send({ bundleId: 'b_1000' })
            .expect(201);
        expect(p.body).toMatchObject({
            status: 'pending',
            authorizationUrl: expect.stringContaining('checkout.paystack.test'),
        });
        const again = await h
            .http()
            .post('/v1/tokens/purchases')
            .set(bearer(t))
            .set('Idempotency-Key', key)
            .send({ bundleId: 'b_1000' })
            .expect(201);
        expect(again.body.reference).toBe(p.body.reference);

        const event = {
            event: 'charge.success',
            data: {
                reference: p.body.reference,
                amount: 100000,
                channel: 'card',
                status: 'success',
            },
        };
        await webhook(event).expect(200);
        await webhook(event).expect(200);
        h.paystack.results.set(p.body.reference, {
            status: 'success',
            amountKobo: 100000,
            channel: 'card',
        });
        await h.db.query(
            `update purchases set created_at = now() - interval '1 minute' where reference = $1`,
            [p.body.reference]
        );
        const status = await h
            .http()
            .get(`/v1/tokens/purchases/${p.body.reference}`)
            .set(bearer(t))
            .expect(200);
        expect(status.body).toEqual({ reference: p.body.reference, status: 'success' });

        expect(await balance(t)).toBe(20);
        const rows = await h.db.query(
            `select 1 from token_ledger where account_id = $1 and reason = 'purchase'`,
            [a.body.account.id]
        );
        expect(rows).toHaveLength(1);
    });

    it('ignores a webhook with a bad signature', async () => {
        const a = await signIn(h);
        const p = await h
            .http()
            .post('/v1/tokens/purchases')
            .set(bearer(a.body.accessToken))
            .send({ bundleId: 'b_500' })
            .expect(201);
        const res = await webhook(
            { event: 'charge.success', data: { reference: p.body.reference, amount: 50000 } },
            'sk_test_wrong'
        ).expect(401);
        expect(res.body.code).toBe('invalid_signature');
        await h
            .http()
            .post('/v1/webhooks/paystack')
            .send({ event: 'charge.success', data: { reference: p.body.reference } })
            .expect(401);
        expect(await balance(a.body.accessToken)).toBe(10);
    });

    it('does not credit an underpaid charge', async () => {
        const a = await signIn(h);
        const p = await h
            .http()
            .post('/v1/tokens/purchases')
            .set(bearer(a.body.accessToken))
            .send({ bundleId: 'b_5000' })
            .expect(201);
        await webhook({
            event: 'charge.success',
            data: { reference: p.body.reference, amount: 100 },
        }).expect(200);
        expect(await balance(a.body.accessToken)).toBe(10);
    });

    it('confirms a payment by verify when the webhook never comes', async () => {
        const a = await signIn(h);
        const p = await h
            .http()
            .post('/v1/tokens/purchases')
            .set(bearer(a.body.accessToken))
            .send({ bundleId: 'b_2500' })
            .expect(201);
        const early = await h
            .http()
            .get(`/v1/tokens/purchases/${p.body.reference}`)
            .set(bearer(a.body.accessToken))
            .expect(200);
        expect(early.body.status).toBe('pending');
        h.paystack.results.set(p.body.reference, {
            status: 'success',
            amountKobo: 250000,
            channel: 'card',
        });
        await h.db.query(
            `update purchases set created_at = now() - interval '1 minute' where reference = $1`,
            [p.body.reference]
        );
        const late = await h
            .http()
            .get(`/v1/tokens/purchases/${p.body.reference}`)
            .set(bearer(a.body.accessToken))
            .expect(200);
        expect(late.body.status).toBe('success');
        expect(await balance(a.body.accessToken)).toBe(38);
    });

    it('gives bank transfer details while the transfer is pending', async () => {
        const a = await signIn(h);
        const p = await h
            .http()
            .post('/v1/tokens/purchases')
            .set(bearer(a.body.accessToken))
            .send({ bundleId: 'b_1000', method: 'bank_transfer' })
            .expect(201);
        expect(p.body).toMatchObject({
            status: 'awaiting_transfer',
            transfer: {
                bankName: 'Test Bank',
                accountNumber: '0123456789',
                accountName: 'Paystack Checkout',
            },
        });
    });

    it('needs an email for the receipt and a real bundle, and keeps purchases private', async () => {
        const a = await signIn(h);
        await h
            .http()
            .post('/v1/tokens/purchases')
            .set(bearer(a.body.accessToken))
            .send({ bundleId: 'b_nope' })
            .expect(404);
        const p = await h
            .http()
            .post('/v1/tokens/purchases')
            .set(bearer(a.body.accessToken))
            .send({ bundleId: 'b_500' })
            .expect(201);
        const b = await signIn(h);
        await h
            .http()
            .get(`/v1/tokens/purchases/${p.body.reference}`)
            .set(bearer(b.body.accessToken))
            .expect(404);

        await h.db.query(`delete from identities where account_id = $1 and provider = 'email'`, [
            b.body.account.id,
        ]);
        const res = await h
            .http()
            .post('/v1/tokens/purchases')
            .set(bearer(b.body.accessToken))
            .send({ bundleId: 'b_500' })
            .expect(422);
        expect(res.body.code).toBe('email_required');
    });
});
