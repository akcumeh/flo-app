import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { sha256 } from '../common/crypto.js';
import { DB, type Db, type Queryable } from '../db/db.js';
import { TokensService } from '../tokens/tokens.service.js';
import { AccountsService, type AccountView } from './accounts.service.js';

type Move = { table: string; column: string; unique?: string };

const MOVES: Move[] = [
    { table: 'identities', column: 'account_id' },
    { table: 'enrolments', column: 'account_id', unique: 'course_id' },
    { table: 'profiles', column: 'account_id', unique: '*' },
    { table: 'student_verifications', column: 'account_id' },
    { table: 'study_events', column: 'account_id' },
    { table: 'study_days', column: 'account_id', unique: 'day' },
    { table: 'streaks', column: 'account_id', unique: '*' },
    { table: 'streak_freezes', column: 'account_id', unique: 'day' },
    { table: 'streak_imports', column: 'account_id', unique: '*' },
    { table: 'leaderboard_optins', column: 'account_id', unique: '*' },
    { table: 'weekly_scores', column: 'account_id', unique: 'week_start' },
    { table: 'wrapped_cache', column: 'account_id', unique: 'period' },
    { table: 'requests', column: 'account_id', unique: 'idempotency_key' },
    { table: 'conversations', column: 'account_id' },
    { table: 'saved_answers', column: 'account_id', unique: 'message_id' },
    { table: 'purchases', column: 'account_id' },
    { table: 'push_subscriptions', column: 'account_id' },
    { table: 'notification_preferences', column: 'account_id', unique: '*' },
    { table: 'referral_codes', column: 'account_id', unique: '*' },
    { table: 'data_exports', column: 'account_id' },
];

function moveSql({ table, column, unique }: Move): string {
    const base = `update ${table} t set ${column} = $1 where t.${column} = $2`;
    if (!unique) return base;
    if (unique === '*')
        return `${base} and not exists (select 1 from ${table} x where x.${column} = $1)`;
    return `${base} and not exists (select 1 from ${table} x where x.${column} = $1 and x.${unique} = t.${unique})`;
}

const SPECIAL_MOVES = [
    `update stored_files t set account_id = $1
    where t.account_id = $2
      and (t.content_sha256 is null or t.deleted_at is not null or not exists (
            select 1 from stored_files x
             where x.account_id = $1 and x.content_sha256 = t.content_sha256 and x.deleted_at is null))`,
    `update file_chunks c set account_id = f.account_id
     from stored_files f where c.file_id = f.id and c.account_id = $2 and f.account_id = $1`,
    `update study_sessions t set account_id = $1
    where t.account_id = $2
      and (t.status not in ('generating', 'active') or not exists (
            select 1 from study_sessions x where x.account_id = $1 and x.status in ('generating', 'active')))`,
    `update session_answers a set account_id = s.account_id
     from study_sessions s where a.session_id = s.id and a.account_id = $2 and s.account_id = $1`,
    `update session_results r set account_id = s.account_id
     from study_sessions s where r.session_id = s.id and r.account_id = $2 and s.account_id = $1`,
    `update referrals set inviter_account_id = $1 where inviter_account_id = $2 and invitee_account_id <> $1`,
];

interface TokenRow {
    id: string;
    account_id: string;
    other_account_id: string;
    used_at: Date | null;
    expired: boolean;
}

@Injectable()
export class MergeService {
    constructor(
        @Inject(DB) private readonly db: Db,
        @Inject(TokensService) private readonly tokens: TokensService,
        @Inject(AccountsService) private readonly accounts: AccountsService
    ) {}

    async merge(accountId: string, mergeToken: string): Promise<AccountView> {
        await this.db.transaction(async (q) => {
            const rows = await q.query<TokenRow>(
                `select id, account_id, other_account_id, used_at, expires_at <= now() as expired
           from merge_tokens where token_hash = $1 for update`,
                [sha256(mergeToken)]
            );
            const t = rows[0];
            if (!t || t.account_id !== accountId || t.used_at || t.expired) {
                throw AppError.gone(
                    'merge_token_expired',
                    'This merge link has expired or was already used. Start again.'
                );
            }
            await q.query('update merge_tokens set used_at = now() where id = $1', [t.id]);
            await this.absorb(q, accountId, t.other_account_id, t.id);
        });
        return this.accounts.view(accountId);
    }

    private async absorb(
        q: Queryable,
        survivor: string,
        loser: string,
        mergeId: string
    ): Promise<void> {
        const accounts = await q.query<{
            id: string;
            token_balance: number;
            deleted_at: Date | null;
            app_bonus_granted_at: Date | null;
        }>(
            `select id, token_balance, deleted_at, app_bonus_granted_at from accounts
        where id = any($1::uuid[]) order by id for update`,
            [[survivor, loser]]
        );
        const winner = accounts.find((a) => a.id === survivor);
        const other = accounts.find((a) => a.id === loser);
        if (!winner || winner.deleted_at) throw AppError.unauthorized();
        if (!other || other.deleted_at) {
            throw AppError.gone(
                'merge_token_expired',
                'The other account was already merged or deleted.'
            );
        }

        if (other.token_balance > 0) {
            const key = `merge:${mergeId}`;
            const ref = { refType: 'merge', refId: mergeId, idempotencyKey: key };
            await this.tokens.debit(q, loser, other.token_balance, 'merge_out', ref);
            await this.tokens.credit(q, survivor, other.token_balance, 'merge_in', ref);
        }

        for (const move of MOVES) await q.query(moveSql(move), [survivor, loser]);
        for (const sql of SPECIAL_MOVES) await q.query(sql, [survivor, loser]);

        await q.query(
            'update auth_sessions set revoked_at = now() where account_id = $1 and revoked_at is null',
            [loser]
        );
        await q.query(
            `update accounts set app_bonus_granted_at = coalesce(app_bonus_granted_at, $2::timestamptz) where id = $1`,
            [survivor, other.app_bonus_granted_at]
        );
        await q.query('update accounts set merged_into = $1, deleted_at = now() where id = $2', [
            survivor,
            loser,
        ]);
    }
}
