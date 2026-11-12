import { AppError } from '../src/common/app-error.js';
import type { Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { PgliteDb } from '../src/db/pglite.db.js';
import { TokensService } from '../src/tokens/tokens.service.js';

describe('TokensService', () => {
    let db: Db;
    let tokens: TokensService;

    beforeAll(async () => {
        db = new PgliteDb();
        await migrate(db);
        tokens = new TokensService(db);
    });

    afterAll(async () => {
        await db.close();
    });

    async function account(balance = 0): Promise<string> {
        const [{ id }] = await db.query<{ id: string }>(
            `insert into accounts (display_name) values ('T') returning id`
        );
        if (balance > 0) await tokens.credit(db, id, balance, 'admin_adjust');
        return id;
    }

    it('credits and records the balance after each change', async () => {
        const id = await account();
        const r = await tokens.credit(db, id, 7, 'admin_adjust');
        expect(r).toEqual({ balance: 7, applied: true });
        const rows = await db.query<{ balance_after: number }>(
            'select balance_after from token_ledger where account_id = $1',
            [id]
        );
        expect(rows.map((x) => x.balance_after)).toEqual([7]);
    });

    it('applies a credit with the same idempotency key only once', async () => {
        const id = await account();
        const a = await tokens.credit(db, id, 10, 'welcome_grant', { idempotencyKey: 'welcome' });
        const b = await tokens.credit(db, id, 10, 'welcome_grant', { idempotencyKey: 'welcome' });
        expect(a.applied).toBe(true);
        expect(b).toEqual({ balance: 10, applied: false });
        expect(await tokens.balance(id)).toBe(10);
    });

    it('refuses to overdraw and leaves the balance alone', async () => {
        const id = await account(2);
        await expect(tokens.debit(db, id, 3, 'chat_charge')).rejects.toMatchObject({
            status: 402,
            code: 'insufficient_tokens',
        });
        expect(await tokens.balance(id)).toBe(2);
    });

    it('lets a debit with the same key replay without charging twice', async () => {
        const id = await account(10);
        const first = await tokens.debit(db, id, 4, 'chat_charge', { idempotencyKey: 'req-1' });
        const replay = await tokens.debit(db, id, 4, 'chat_charge', { idempotencyKey: 'req-1' });
        expect(first).toEqual({ balance: 6, applied: true });
        expect(replay.applied).toBe(false);
        expect(await tokens.balance(id)).toBe(6);
    });

    it('never lets simultaneous debits spend more than the balance', async () => {
        const id = await account(10);
        const results = await Promise.allSettled(
            Array.from({ length: 6 }, () => tokens.debit(db, id, 3, 'chat_charge'))
        );
        const ok = results.filter((r) => r.status === 'fulfilled').length;
        const refused = results.filter(
            (r) => r.status === 'rejected' && (r.reason as AppError).code === 'insufficient_tokens'
        ).length;
        expect(ok).toBe(3);
        expect(refused).toBe(3);
        expect(await tokens.balance(id)).toBe(1);
    });

    it('allows only one refund per charge', async () => {
        const id = await account(5);
        await tokens.debit(db, id, 2, 'chat_charge', { refType: 'request', refId: 'r1' });
        await tokens.credit(db, id, 2, 'refund', {
            refType: 'request',
            refId: 'r1',
            idempotencyKey: 'refund:r1',
        });
        await expect(
            tokens.credit(db, id, 2, 'refund', {
                refType: 'request',
                refId: 'r1',
                idempotencyKey: 'refund:r1-again',
            })
        ).resolves.toMatchObject({ applied: false });
        expect(await tokens.balance(id)).toBe(5);
    });
});
