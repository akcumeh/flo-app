import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, randomInt } from 'node:crypto';
import { AppError } from '../common/app-error.js';
import { hmac, sha256 } from '../common/crypto.js';
import { CONFIG, type Config } from '../config.js';
import { DB, type Db } from '../db/db.js';
import { AuthService, type SignInResult } from './auth.service.js';
import { IdentityService, type MergeOffer, type ProvenIdentity } from './identity.service.js';

export type Channel = 'telegram' | 'whatsapp';
export type Intent = 'signin' | 'link';

const TTL_MINUTES = 10;
const MAX_PER_IP_PER_HOUR = 20;
const UNIQUE_VIOLATION = '23505';

interface ChallengeRow {
  id: string;
  channel: Channel;
  intent: Intent;
  account_id: string | null;
  status: 'pending' | 'verified' | 'redeemed' | 'expired';
  claimed_provider_user_id: string | null;
  claimed_profile: { displayName?: string; username?: string } | null;
  expires_at: Date;
  expired: boolean;
}

type RedeemOutcome =
  | { kind: 'session'; result: SignInResult }
  | { kind: 'merge'; offer: MergeOffer; label: string }
  | { kind: 'error'; error: AppError };

@Injectable()
export class ChallengesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(IdentityService) private readonly identities: IdentityService
  ) {}

  private deepLink(channel: Channel, code: string): string {
    if (channel === 'telegram') {
      if (!this.config.telegramBotUsername) {
        throw AppError.unavailable('channel_unavailable', 'Telegram sign-in is not set up yet.');
      }
      return `https://t.me/${this.config.telegramBotUsername}?start=login_${code}`;
    }
    if (!this.config.whatsappBusinessNumber) {
      throw AppError.unavailable('channel_unavailable', 'WhatsApp sign-in is not set up yet.');
    }
    return `https://wa.me/${this.config.whatsappBusinessNumber}?text=${code}`;
  }

  async create(channel: Channel, intent: Intent, accountId: string | null, ip: string) {
    if (intent === 'link' && !accountId) throw AppError.unauthorized('unauthorized', 'Sign in to link an account.');
    const ipHash = hmac(this.config.codePepper, `ip:${ip}`);

    const [{ n }] = await this.db.query<{ n: number }>(
      `select count(*)::int as n from auth_challenges where ip_hash = $1 and created_at > now() - interval '1 hour'`,
      [ipHash]
    );
    if (n >= MAX_PER_IP_PER_HOUR) throw AppError.rateLimited(3600);

    const secret = randomBytes(32).toString('base64url');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = `FLO-${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
      const deepLink = this.deepLink(channel, code);
      try {
        const [row] = await this.db.query<{ expires_at: Date }>(
          `insert into auth_challenges (secret_hash, code, channel, intent, account_id, ip_hash, expires_at)
           values ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7)) returning expires_at`,
          [sha256(secret), code, channel, intent, intent === 'link' ? accountId : null, ipHash, TTL_MINUTES]
        );
        return { challengeId: secret, code, deepLink, expiresAt: new Date(row.expires_at).toISOString() };
      } catch (error) {
        if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      }
    }
    throw AppError.unavailable('busy', 'Could not create a code. Try again.');
  }

  async status(secret: string) {
    const rows = await this.db.query<{ status: ChallengeRow['status']; expires_at: Date; expired: boolean }>(
      'select status, expires_at, expires_at <= now() as expired from auth_challenges where secret_hash = $1',
      [sha256(secret)]
    );
    if (rows.length === 0) throw AppError.notFound('No such challenge.');
    const row = rows[0];
    const live = row.status === 'pending' || row.status === 'verified';
    return {
      status: live && row.expired ? 'expired' : row.status,
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  }

  async redeem(secret: string, accountId: string | null, userAgent: string | null): Promise<SignInResult> {
    const outcome = await this.db.transaction<RedeemOutcome>(async (q) => {
      const rows = await q.query<ChallengeRow>(
        `select id, channel, intent, account_id, status, claimed_provider_user_id, claimed_profile, expires_at,
                expires_at <= now() as expired
           from auth_challenges where secret_hash = $1 for update`,
        [sha256(secret)]
      );
      if (rows.length === 0) return { kind: 'error', error: AppError.notFound('No such challenge.') };
      const c = rows[0];

      if (c.status === 'redeemed') {
        return {
          kind: 'error',
          error: AppError.conflict('challenge_already_redeemed', 'This sign-in link was already used.'),
        };
      }
      if (c.status === 'expired' || c.expired) {
        await q.query(`update auth_challenges set status = 'expired' where id = $1`, [c.id]);
        return { kind: 'error', error: AppError.gone('challenge_expired', 'This code has expired. Start again.') };
      }
      if (c.status === 'pending') {
        return {
          kind: 'error',
          error: AppError.conflict('challenge_pending', 'Send the code from the app first, then try again.'),
        };
      }

      if (c.intent === 'link' && (!accountId || accountId !== c.account_id)) {
        return {
          kind: 'error',
          error: AppError.unauthorized('unauthorized', 'Sign in as the account that started this link.'),
        };
      }

      const identity = ChallengesService.identityFrom(c);
      await q.query(`update auth_challenges set status = 'redeemed', redeemed_at = now() where id = $1`, [c.id]);

      if (c.intent === 'link' && accountId) {
        const attached = await this.identities.attach(q, accountId, identity);
        if (attached.kind === 'conflict') {
          return { kind: 'merge', offer: attached.offer, label: c.channel === 'telegram' ? 'Telegram' : 'WhatsApp' };
        }
        return { kind: 'session', result: await this.auth.sessionFor(q, accountId, false, false, userAgent) };
      }

      return { kind: 'session', result: await this.auth.signInWith(q, identity, userAgent) };
    });

    if (outcome.kind === 'error') throw outcome.error;
    if (outcome.kind === 'merge') throw ChallengesService.mergeConflict(outcome.label, outcome.offer);
    return outcome.result;
  }

  async claim(input: {
    code: string;
    provider: Channel;
    providerUserId: string;
    displayName?: string;
    username?: string;
  }): Promise<{ status: 'verified' }> {
    const profile = { displayName: input.displayName, username: input.username };
    const claimed = await this.db.query(
      `update auth_challenges
          set status = 'verified', claimed_provider_user_id = $3, claimed_profile = $4, verified_at = now()
        where channel = $1 and code = $2 and status = 'pending' and expires_at > now()
        returning id`,
      [input.provider, input.code, input.providerUserId, JSON.stringify(profile)]
    );
    if (claimed.length > 0) return { status: 'verified' };

    const seen = await this.db.query(
      `select 1 from auth_challenges
        where channel = $1 and code = $2 and status in ('verified', 'redeemed') and expires_at > now()`,
      [input.provider, input.code]
    );
    if (seen.length > 0) throw AppError.conflict('challenge_already_claimed', 'This code was already used.');
    throw AppError.notFound('That code is wrong or has expired.');
  }

  static identityFrom(c: Pick<ChallengeRow, 'channel' | 'claimed_provider_user_id' | 'claimed_profile'>): ProvenIdentity {
    const id = c.claimed_provider_user_id as string;
    const profile = c.claimed_profile ?? {};
    if (c.channel === 'telegram') {
      return {
        provider: 'telegram',
        providerUserId: id,
        display: IdentityService.telegramDisplay(profile.username, profile.displayName),
        displayName: profile.displayName ?? profile.username ?? 'Student',
      };
    }
    return {
      provider: 'whatsapp',
      providerUserId: id,
      display: IdentityService.maskPhone(id),
      displayName: profile.displayName ?? 'Student',
    };
  }

  static mergeConflict(label: string, offer: MergeOffer): AppError {
    return AppError.conflict(
      'identity_belongs_to_other_account',
      `This ${label} account is already linked to another Florence account.`,
      { ...offer }
    );
  }
}
