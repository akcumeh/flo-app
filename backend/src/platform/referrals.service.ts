import { Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { AppError } from '../common/app-error.js';
import { CONFIG, type Config } from '../config.js';
import { DB, type Db, type Queryable } from '../db/db.js';
import { TokensService } from '../tokens/tokens.service.js';

export const REFERRAL_TOKENS = 5;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const REDEEM_WITHIN_DAYS = 7;
const UNIQUE_VIOLATION = '23505';

@Injectable()
export class ReferralsService {
    constructor(
        @Inject(DB) private readonly db: Db,
        @Inject(CONFIG) private readonly config: Config,
        @Inject(TokensService) private readonly tokens: TokensService
    ) {}

    private async code(accountId: string): Promise<string> {
        const [existing] = await this.db.query<{ code: string }>(
            'select code from referral_codes where account_id = $1',
            [accountId]
        );
        if (existing) return existing.code;
        for (let attempt = 0; attempt < 6; attempt += 1) {
            const code = Array.from(
                { length: 6 },
                () => ALPHABET[randomInt(0, ALPHABET.length)]
            ).join('');
            try {
                const rows = await this.db.query<{ code: string }>(
                    'insert into referral_codes (account_id, code) values ($1, $2) on conflict (account_id) do nothing returning code',
                    [accountId, code]
                );
                if (rows.length > 0) return rows[0].code;
                return (
                    await this.db.query<{ code: string }>(
                        'select code from referral_codes where account_id = $1',
                        [accountId]
                    )
                )[0].code;
            } catch (error) {
                if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
            }
        }
        throw AppError.unavailable('busy', 'Could not create an invite code. Try again.');
    }

    async get(accountId: string) {
        const code = await this.code(accountId);
        const [{ n }] = await this.db.query<{ n: number }>(
            'select count(*)::int as n from referrals where inviter_account_id = $1',
            [accountId]
        );
        return {
            code,
            link: `${this.config.appUrl}/r/${code}`,
            invitedCount: n,
            rewardTokens: REFERRAL_TOKENS,
        };
    }

    async redeem(q: Queryable, accountId: string, rawCode: string) {
        const code = rawCode.trim().toUpperCase();
        const [owner] = await q.query<{ account_id: string }>(
            'select account_id from referral_codes where code = $1',
            [code]
        );
        if (!owner)
            throw AppError.unprocessable('invalid_referral', 'That invite code does not exist.');
        if (owner.account_id === accountId)
            throw AppError.unprocessable(
                'invalid_referral',
                'You cannot use your own invite code.'
            );
        const [account] = await q.query<{ late: boolean }>(
            `select created_at < now() - make_interval(days => $2) as late from accounts where id = $1`,
            [accountId, REDEEM_WITHIN_DAYS]
        );
        if (account?.late)
            throw AppError.unprocessable(
                'referral_too_late',
                'Invite codes work in your first week only.'
            );
        await q.query(
            'insert into referrals (invitee_account_id, inviter_account_id) values ($1, $2) on conflict (invitee_account_id) do nothing',
            [accountId, owner.account_id]
        );
    }

    async rewardFirstSession(q: Queryable, inviteeId: string): Promise<void> {
        const [r] = await q.query<{ inviter_account_id: string }>(
            `update referrals set rewarded_at = now() where invitee_account_id = $1 and rewarded_at is null
        returning inviter_account_id`,
            [inviteeId]
        );
        if (!r) return;
        for (const account of [inviteeId, r.inviter_account_id]) {
            await this.tokens.credit(q, account, REFERRAL_TOKENS, 'referral_reward', {
                idempotencyKey: `referral:${inviteeId}`,
                refType: 'referral',
                refId: inviteeId,
            });
        }
    }
}
