import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { sha256 } from '../common/crypto.js';
import type { Queryable } from '../db/db.js';

export type Provider = 'telegram' | 'whatsapp' | 'email' | 'google';

export interface ProvenIdentity {
  provider: Provider;
  providerUserId: string;
  display: string;
  displayName: string;
}

export interface MergeOffer {
  mergeToken: string;
  mergeTokenExpiresAt: string;
}

export type AttachResult = { kind: 'attached' } | { kind: 'conflict'; offer: MergeOffer };

const MERGE_TOKEN_TTL_MINUTES = 10;

@Injectable()
export class IdentityService {
  static maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }

  static maskPhone(digits: string): string {
    return `+${digits.slice(0, 3)} ${digits.slice(3, 5)}* *** ${digits.slice(-4)}`;
  }

  static telegramDisplay(username: string | undefined, displayName: string | undefined): string {
    if (username) return `@${username}`;
    return displayName?.trim() || 'Telegram account';
  }

  async ownerOf(q: Queryable, provider: Provider, providerUserId: string): Promise<string | null> {
    const rows = await q.query<{ account_id: string }>(
      'select account_id from identities where provider = $1 and provider_user_id = $2',
      [provider, providerUserId]
    );
    return rows[0]?.account_id ?? null;
  }

  async findOrCreate(q: Queryable, identity: ProvenIdentity): Promise<{ accountId: string; isNew: boolean }> {
    const existing = await this.ownerOf(q, identity.provider, identity.providerUserId);
    if (existing) return { accountId: existing, isNew: false };

    const name = identity.displayName.trim().slice(0, 60) || 'Student';
    const [{ id }] = await q.query<{ id: string }>('insert into accounts (display_name) values ($1) returning id', [name]);
    const inserted = await q.query(
      `insert into identities (account_id, provider, provider_user_id, display) values ($1, $2, $3, $4)
       on conflict (provider, provider_user_id) do nothing returning id`,
      [id, identity.provider, identity.providerUserId, identity.display]
    );
    if (inserted.length > 0) return { accountId: id, isNew: true };

    await q.query('delete from accounts where id = $1', [id]);
    const winner = await this.ownerOf(q, identity.provider, identity.providerUserId);
    return { accountId: winner as string, isNew: false };
  }

  async attach(q: Queryable, accountId: string, identity: ProvenIdentity): Promise<AttachResult> {
    const owner = await this.ownerOf(q, identity.provider, identity.providerUserId);
    if (owner === accountId) return { kind: 'attached' };
    if (owner) return { kind: 'conflict', offer: await this.offerMerge(q, accountId, owner, identity) };

    const inserted = await q.query(
      `insert into identities (account_id, provider, provider_user_id, display) values ($1, $2, $3, $4)
       on conflict (provider, provider_user_id) do nothing returning id`,
      [accountId, identity.provider, identity.providerUserId, identity.display]
    );
    if (inserted.length > 0) return { kind: 'attached' };
    return this.attach(q, accountId, identity);
  }

  private async offerMerge(
    q: Queryable,
    accountId: string,
    otherAccountId: string,
    identity: ProvenIdentity
  ): Promise<MergeOffer> {
    const token = `mrg_${randomBytes(24).toString('base64url')}`;
    const [{ expires_at }] = await q.query<{ expires_at: Date }>(
      `insert into merge_tokens (token_hash, account_id, other_account_id, provider, provider_user_id, expires_at)
       values ($1, $2, $3, $4, $5, now() + make_interval(mins => $6)) returning expires_at`,
      [sha256(token), accountId, otherAccountId, identity.provider, identity.providerUserId, MERGE_TOKEN_TTL_MINUTES]
    );
    return { mergeToken: token, mergeTokenExpiresAt: new Date(expires_at).toISOString() };
  }
}
