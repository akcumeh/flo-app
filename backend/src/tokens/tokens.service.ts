import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { DB, type Db, type Queryable } from '../db/db.js';

export type LedgerReason =
    | 'welcome_grant'
    | 'student_bonus'
    | 'streak_reward'
    | 'purchase'
    | 'chat_charge'
    | 'prep_charge'
    | 'create_charge'
    | 'refund'
    | 'merge_in'
    | 'merge_out'
    | 'legacy_import'
    | 'admin_adjust'
    | 'referral_reward';

export interface LedgerOptions {
    idempotencyKey?: string;
    refType?: string;
    refId?: string;
}

export interface LedgerEntry {
    id: number;
    delta: number;
    reason: LedgerReason;
    balanceAfter: number;
    createdAt: string;
}

const UNIQUE_VIOLATION = '23505';

@Injectable()
export class TokensService {
    constructor(@Inject(DB) private readonly db: Db) {}

    async balance(accountId: string, q: Queryable = this.db): Promise<number> {
        const rows = await q.query<{ token_balance: number }>(
            'select token_balance from accounts where id = $1',
            [accountId]
        );
        if (rows.length === 0) throw AppError.notFound('No such account.');
        return rows[0].token_balance;
    }

    /**
     * Adds tokens. With an idempotency key the same call never applies twice.
     * Returns the balance and whether this call changed it.
     */
    async credit(
        q: Queryable,
        accountId: string,
        amount: number,
        reason: LedgerReason,
        opts: LedgerOptions = {}
    ): Promise<{ balance: number; applied: boolean }> {
        if (!Number.isInteger(amount) || amount <= 0)
            throw new Error('credit amount must be a positive integer');
        return this.apply(q, accountId, amount, reason, opts);
    }

    /**
     * Removes tokens in a single statement. The balance can never go below zero, so two
     * simultaneous debits cannot both succeed on a balance that covers only one.
     */
    async debit(
        q: Queryable,
        accountId: string,
        amount: number,
        reason: LedgerReason,
        opts: LedgerOptions = {}
    ): Promise<{ balance: number; applied: boolean }> {
        if (!Number.isInteger(amount) || amount <= 0)
            throw new Error('debit amount must be a positive integer');
        const result = await this.apply(q, accountId, -amount, reason, opts);
        if (result.applied) return result;

        if (opts.idempotencyKey !== undefined) {
            const seen = await q.query(
                'select 1 from token_ledger where account_id = $1 and idempotency_key = $2',
                [accountId, opts.idempotencyKey]
            );
            if (seen.length > 0) return result;
        }
        throw AppError.insufficientTokens(amount, result.balance);
    }

    private async apply(
        q: Queryable,
        accountId: string,
        delta: number,
        reason: LedgerReason,
        opts: LedgerOptions
    ): Promise<{ balance: number; applied: boolean }> {
        const key = opts.idempotencyKey ?? null;
        try {
            const rows = await q.query<{ balance_after: number }>(
                `with upd as (
           update accounts
              set token_balance = token_balance + $2
            where id = $1
              and token_balance + $2 >= 0
              and ($6::text is null or not exists (
                    select 1 from token_ledger where account_id = $1 and idempotency_key = $6))
          returning token_balance
         )
         insert into token_ledger (account_id, delta, reason, ref_type, ref_id, idempotency_key, balance_after)
         select $1, $2, $3, $4, $5, $6, token_balance from upd
         returning balance_after`,
                [accountId, delta, reason, opts.refType ?? null, opts.refId ?? null, key]
            );
            if (rows.length > 0) return { balance: rows[0].balance_after, applied: true };
        } catch (error) {
            if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
        }
        return { balance: await this.balance(accountId, q), applied: false };
    }

    async ledger(
        accountId: string,
        cursor: string | undefined,
        limit: number
    ): Promise<{ items: LedgerEntry[]; nextCursor: string | null }> {
        const before = cursor ? Number(Buffer.from(cursor, 'base64url').toString('utf8')) : null;
        if (cursor && (before === null || !Number.isInteger(before))) {
            throw AppError.badRequest('invalid_cursor', 'The cursor is not valid.');
        }
        const rows = await this.db.query<{
            id: number;
            delta: number;
            reason: LedgerReason;
            balance_after: number;
            created_at: Date;
        }>(
            `select id::int as id, delta, reason, balance_after, created_at
         from token_ledger
        where account_id = $1 and ($2::bigint is null or id < $2)
        order by id desc
        limit $3`,
            [accountId, before, limit + 1]
        );
        const page = rows.slice(0, limit);
        return {
            items: page.map((r) => ({
                id: r.id,
                delta: r.delta,
                reason: r.reason,
                balanceAfter: r.balance_after,
                createdAt: new Date(r.created_at).toISOString(),
            })),
            nextCursor:
                rows.length > limit
                    ? Buffer.from(String(page[page.length - 1].id), 'utf8').toString('base64url')
                    : null,
        };
    }
}
