import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { DB, type Db, type Queryable } from '../db/db.js';

export interface IdentityView {
    id: string;
    provider: string;
    display: string;
    verifiedAt: string;
}

export interface StudentView {
    status: 'none' | 'verified' | 'expired';
    institution?: string;
    verifiedAt?: string;
    expiresAt?: string;
}

export async function studentStatus(q: Queryable, accountId: string): Promise<StudentView> {
    const rows = await q.query<{
        name: string;
        verified_at: Date;
        expires_at: Date;
        expired: boolean;
    }>(
        `select s.name, v.verified_at, v.expires_at, v.expires_at <= now() as expired
       from student_verifications v join schools s on s.id = v.school_id
      where v.account_id = $1
      order by v.expires_at desc limit 1`,
        [accountId]
    );
    if (rows.length === 0) return { status: 'none' };
    const r = rows[0];
    return {
        status: r.expired ? 'expired' : 'verified',
        institution: r.name,
        verifiedAt: new Date(r.verified_at).toISOString(),
        expiresAt: new Date(r.expires_at).toISOString(),
    };
}

export interface AccountView {
    id: string;
    displayName: string;
    username: string | null;
    tokenBalance: number;
    identities: IdentityView[];
    student: StudentView;
    createdAt: string;
}

interface AccountRow {
    id: string;
    display_name: string;
    username: string | null;
    token_balance: number;
    created_at: Date;
}

interface IdentityRow {
    id: string;
    provider: string;
    display: string | null;
    verified_at: Date;
}

const UNIQUE_VIOLATION = '23505';

@Injectable()
export class AccountsService {
    constructor(@Inject(DB) private readonly db: Db) {}

    async view(accountId: string, q: Queryable = this.db): Promise<AccountView> {
        const rows = await q.query<AccountRow>(
            'select id, display_name, username, token_balance, created_at from accounts where id = $1 and deleted_at is null',
            [accountId]
        );
        if (rows.length === 0) throw AppError.notFound('No such account.');
        const identities = await q.query<IdentityRow>(
            'select id, provider, display, verified_at from identities where account_id = $1 order by created_at',
            [accountId]
        );
        const a = rows[0];
        return {
            id: a.id,
            displayName: a.display_name,
            username: a.username,
            tokenBalance: a.token_balance,
            identities: identities.map((i) => ({
                id: i.id,
                provider: i.provider,
                display: i.display ?? '',
                verifiedAt: new Date(i.verified_at).toISOString(),
            })),
            student: await studentStatus(q, accountId),
            createdAt: new Date(a.created_at).toISOString(),
        };
    }

    async unlink(accountId: string, identityId: string): Promise<void> {
        await this.db.transaction(async (q) => {
            const rows = await q.query<{ id: string }>(
                'select id from identities where account_id = $1 for update',
                [accountId]
            );
            if (!rows.some((r) => r.id === identityId))
                throw AppError.notFound('No such linked account.');
            if (rows.length === 1) {
                throw AppError.conflict(
                    'last_identity',
                    'This is your only way to sign in. Link another one first.'
                );
            }
            await q.query('delete from identities where id = $1 and account_id = $2', [
                identityId,
                accountId,
            ]);
        });
    }

    async update(
        accountId: string,
        changes: { displayName?: string; username?: string | null; timezone?: string }
    ): Promise<AccountView> {
        const sets: string[] = [];
        const params: unknown[] = [accountId];
        const add = (column: string, value: unknown) => {
            params.push(value);
            sets.push(`${column} = $${params.length}`);
        };
        if (changes.displayName !== undefined) add('display_name', changes.displayName);
        if (changes.username !== undefined) add('username', changes.username);
        if (changes.timezone !== undefined) add('timezone', changes.timezone);

        if (sets.length > 0) {
            try {
                await this.db.query(
                    `update accounts set ${sets.join(', ')} where id = $1 and deleted_at is null`,
                    params
                );
            } catch (error) {
                if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
                    throw AppError.conflict('username_taken', 'That username is already taken.');
                }
                throw error;
            }
        }
        return this.view(accountId);
    }
}
