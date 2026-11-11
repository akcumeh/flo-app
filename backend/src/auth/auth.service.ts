import { Inject, Injectable } from '@nestjs/common';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { AccountsService, type AccountView } from '../accounts/accounts.service.js';
import { AppError } from '../common/app-error.js';
import { CONFIG, type Config } from '../config.js';
import { DB, type Db, type Queryable } from '../db/db.js';
import { TokensService } from '../tokens/tokens.service.js';
import { MAILER, type Mailer } from './mailer.js';

export const ACCESS_TTL_SECONDS = 900;
export const REFRESH_TTL_DAYS = 30;
const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MAX_SENDS_PER_ADDRESS_PER_HOUR = 3;
const MAX_SENDS_PER_IP_PER_HOUR = 10;
const WELCOME_TOKENS = 10;

export interface SessionTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
}

export interface SignInResult extends SessionTokens {
  account: AccountView;
  isNewAccount: boolean;
  welcomeGrant: { granted: boolean; tokens: number };
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(TokensService) private readonly tokens: TokensService
  ) {}

  private hashCode(email: string, code: string): string {
    return createHmac('sha256', this.config.codePepper).update(`${email}:${code}`).digest('hex');
  }

  private hashIp(ip: string): string {
    return createHmac('sha256', this.config.codePepper).update(`ip:${ip}`).digest('hex');
  }

  private static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  static canonicalEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private static mask(email: string): string {
    const [local, domain] = email.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }

  async startEmail(rawEmail: string, ip: string): Promise<void> {
    const email = AuthService.canonicalEmail(rawEmail);
    const ipHash = this.hashIp(ip);

    const [{ n: perAddress }] = await this.db.query<{ n: number }>(
      `select count(*)::int as n from email_codes
        where email_canonical = $1 and created_at > now() - interval '1 hour'`,
      [email]
    );
    if (perAddress >= MAX_SENDS_PER_ADDRESS_PER_HOUR) throw AppError.rateLimited(3600);

    const [{ n: perIp }] = await this.db.query<{ n: number }>(
      `select count(*)::int as n from email_codes
        where ip_hash = $1 and created_at > now() - interval '1 hour'`,
      [ipHash]
    );
    if (perIp >= MAX_SENDS_PER_IP_PER_HOUR) throw AppError.rateLimited(3600);

    const code = String(randomInt(100000, 1000000));
    await this.db.query(
      `insert into email_codes (email_canonical, purpose, code_hash, ip_hash, expires_at)
       values ($1, 'signin', $2, $3, now() + make_interval(mins => $4))`,
      [email, this.hashCode(email, code), ipHash, CODE_TTL_MINUTES]
    );
    await this.mailer.sendSignInCode(email, code);
  }

  async verifyEmail(rawEmail: string, code: string, userAgent: string | null): Promise<SignInResult> {
    const email = AuthService.canonicalEmail(rawEmail);

    const rows = await this.db.query<{ id: string; code_hash: string; attempts: number }>(
      `select id, code_hash, attempts from email_codes
        where email_canonical = $1 and purpose = 'signin'
          and consumed_at is null and expires_at > now()
        order by created_at desc limit 1`,
      [email]
    );
    if (rows.length === 0) throw AppError.badRequest('invalid_code', 'That code is wrong or has expired.');

    const row = rows[0];
    if (row.attempts >= MAX_ATTEMPTS) {
      throw AppError.badRequest('code_locked', 'Too many wrong tries. Ask for a new code.');
    }

    const expected = Buffer.from(row.code_hash, 'hex');
    const actual = Buffer.from(this.hashCode(email, code), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      await this.db.query('update email_codes set attempts = attempts + 1 where id = $1', [row.id]);
      throw AppError.badRequest('invalid_code', 'That code is wrong or has expired.');
    }

    return this.db.transaction(async (q) => {
      const consumed = await q.query(
        'update email_codes set consumed_at = now() where id = $1 and consumed_at is null returning id',
        [row.id]
      );
      if (consumed.length === 0) throw AppError.badRequest('invalid_code', 'That code is wrong or has expired.');

      const { accountId, isNew } = await this.resolveEmailAccount(q, email);
      let granted = false;
      if (isNew) {
        const claim = await q.query(
          'update accounts set app_bonus_granted_at = now() where id = $1 and app_bonus_granted_at is null returning id',
          [accountId]
        );
        if (claim.length > 0) {
          await this.tokens.credit(q, accountId, WELCOME_TOKENS, 'welcome_grant', { idempotencyKey: 'welcome' });
          granted = true;
        }
      }

      const session = await this.openSession(q, accountId, null, userAgent);
      return {
        ...session,
        account: await this.accounts.view(accountId, q),
        isNewAccount: isNew,
        welcomeGrant: { granted, tokens: granted ? WELCOME_TOKENS : 0 },
      };
    });
  }

  private async resolveEmailAccount(q: Queryable, email: string): Promise<{ accountId: string; isNew: boolean }> {
    const found = await q.query<{ account_id: string }>(
      `select account_id from identities where provider = 'email' and provider_user_id = $1`,
      [email]
    );
    if (found.length > 0) return { accountId: found[0].account_id, isNew: false };

    const local = email.split('@')[0] ?? 'Student';
    const name = local.charAt(0).toUpperCase() + local.slice(1, 40);
    const [{ id }] = await q.query<{ id: string }>('insert into accounts (display_name) values ($1) returning id', [name]);
    await q.query(
      `insert into identities (account_id, provider, provider_user_id, display) values ($1, 'email', $2, $3)`,
      [id, email, AuthService.mask(email)]
    );
    return { accountId: id, isNew: true };
  }

  private async openSession(
    q: Queryable,
    accountId: string,
    familyId: string | null,
    userAgent: string | null
  ): Promise<SessionTokens> {
    const refreshToken = randomBytes(32).toString('base64url');
    await q.query(
      `insert into auth_sessions (account_id, family_id, token_hash, user_agent, expires_at)
       values ($1, coalesce($2::uuid, gen_random_uuid()), $3, $4, now() + make_interval(days => $5))`,
      [accountId, familyId, AuthService.hashToken(refreshToken), userAgent, REFRESH_TTL_DAYS]
    );
    return { accessToken: this.signAccess(accountId), expiresIn: ACCESS_TTL_SECONDS, refreshToken };
  }

  signAccess(accountId: string): string {
    return jwt.sign({ sub: accountId }, this.config.jwtSecret, { expiresIn: ACCESS_TTL_SECONDS, algorithm: 'HS256' });
  }

  verifyAccess(token: string): string {
    try {
      const payload = jwt.verify(token, this.config.jwtSecret, { algorithms: ['HS256'] });
      if (typeof payload === 'string' || typeof payload.sub !== 'string') throw new Error('bad payload');
      return payload.sub;
    } catch {
      throw AppError.unauthorized('invalid_token', 'The access token is missing, invalid or expired.');
    }
  }

  /** Rotates the refresh token. Presenting an already rotated token revokes the whole family. */
  async refresh(refreshToken: string | undefined, userAgent: string | null): Promise<SessionTokens> {
    if (!refreshToken) throw AppError.unauthorized('invalid_refresh_token', 'No refresh token.');
    const hash = AuthService.hashToken(refreshToken);

    const reuse = await this.db.transaction(async (q) => {
      const rows = await q.query<{
        id: string;
        account_id: string;
        family_id: string;
        rotated_at: Date | null;
        revoked_at: Date | null;
        expired: boolean;
      }>(
        `select id, account_id, family_id, rotated_at, revoked_at, expires_at <= now() as expired
           from auth_sessions where token_hash = $1 for update`,
        [hash]
      );
      if (rows.length === 0) return { error: 'invalid' as const };
      const s = rows[0];
      if (s.revoked_at) return { error: 'invalid' as const };
      if (s.rotated_at) {
        await q.query('update auth_sessions set revoked_at = now() where family_id = $1 and revoked_at is null', [
          s.family_id,
        ]);
        return { error: 'reuse' as const };
      }
      if (s.expired) return { error: 'invalid' as const };

      await q.query('update auth_sessions set rotated_at = now(), last_used_at = now() where id = $1', [s.id]);
      return { tokens: await this.openSession(q, s.account_id, s.family_id, userAgent) };
    });

    if ('error' in reuse) {
      throw reuse.error === 'reuse'
        ? AppError.unauthorized('refresh_reuse_detected', 'This sign-in was used twice. Sign in again.')
        : AppError.unauthorized('invalid_refresh_token', 'Sign in again.');
    }
    return reuse.tokens;
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    await this.db.query(
      `update auth_sessions set revoked_at = now()
        where revoked_at is null
          and family_id in (select family_id from auth_sessions where token_hash = $1)`,
      [AuthService.hashToken(refreshToken)]
    );
  }
}
