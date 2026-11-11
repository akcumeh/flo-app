import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { DB, type Db, type Queryable } from '../db/db.js';

export interface IdentityView {
  id: string;
  provider: string;
  display: string;
  verifiedAt: string;
}

export interface AccountView {
  id: string;
  displayName: string;
  username: string | null;
  tokenBalance: number;
  identities: IdentityView[];
  student: { status: 'none' };
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
      student: { status: 'none' },
      createdAt: new Date(a.created_at).toISOString(),
    };
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
        await this.db.query(`update accounts set ${sets.join(', ')} where id = $1 and deleted_at is null`, params);
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
