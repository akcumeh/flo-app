import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { AppError } from '../common/app-error.js';
import { CONFIG, type Config } from '../config.js';
import { DB, type Db, type Queryable } from '../db/db.js';
import { TokensService } from '../tokens/tokens.service.js';
import { PAYSTACK, PaystackUnavailable, type PaystackClient } from './paystack.js';

export const BUNDLES = [
    { id: 'b_500', amountNaira: 500, tokens: 4 },
    { id: 'b_1000', amountNaira: 1000, tokens: 10 },
    { id: 'b_2500', amountNaira: 2500, tokens: 28 },
    { id: 'b_5000', amountNaira: 5000, tokens: 60 },
    { id: 'b_10000', amountNaira: 10000, tokens: 130 },
    { id: 'b_25000', amountNaira: 25000, tokens: 350 },
];

const TRANSFER_MINUTES = 30;
const VERIFY_AFTER_SECONDS = 10;

interface PurchaseRow {
    reference: string;
    account_id: string;
    amount_kobo: number;
    tokens: number;
    status: 'pending' | 'awaiting_transfer' | 'success' | 'failed' | 'expired';
    channel: string | null;
    created_at: Date;
    meta: {
        authorizationUrl?: string;
        transfer?: {
            bankName: string;
            accountNumber: string;
            accountName: string;
            expiresAt: string;
        };
    } | null;
}

@Injectable()
export class PurchasesService {
    private readonly logger = new Logger('Purchases');

    constructor(
        @Inject(DB) private readonly db: Db,
        @Inject(CONFIG) private readonly config: Config,
        @Inject(PAYSTACK) private readonly paystack: PaystackClient,
        @Inject(TokensService) private readonly tokens: TokensService
    ) {}

    private view(p: PurchaseRow) {
        return {
            reference: p.reference,
            status: p.status,
            ...(p.meta?.authorizationUrl && p.status === 'pending'
                ? { authorizationUrl: p.meta.authorizationUrl }
                : {}),
            ...(p.meta?.transfer && p.status === 'awaiting_transfer'
                ? { transfer: p.meta.transfer }
                : {}),
        };
    }

    private async email(accountId: string, given?: string): Promise<string> {
        if (given) return given.trim().toLowerCase();
        const [row] = await this.db.query<{ provider_user_id: string }>(
            `select provider_user_id from identities where account_id = $1 and provider = 'email' order by created_at limit 1`,
            [accountId]
        );
        if (!row)
            throw AppError.unprocessable(
                'email_required',
                'Add an email address for your receipt.'
            );
        return row.provider_user_id;
    }

    async create(
        accountId: string,
        key: string | undefined,
        body: { bundleId: string; email?: string; method?: 'card' | 'bank_transfer' }
    ) {
        const bundle = BUNDLES.find((b) => b.id === body.bundleId);
        if (!bundle) throw AppError.notFound('No such bundle.');
        const method = body.method ?? 'card';
        const email = await this.email(accountId, body.email);

        if (key) {
            const [existing] = await this.db.query<PurchaseRow>(
                `select reference, account_id, amount_kobo, tokens, status, channel, created_at, meta from purchases
          where account_id = $1 and idempotency_key = $2`,
                [accountId, key]
            );
            if (existing) return this.view(existing);
        }

        const reference = `FLO-PAY-${Math.floor(Date.now() / 1000)}-${randomInt(1000, 10000)}`;
        let meta: PurchaseRow['meta'];
        let status: PurchaseRow['status'] = 'pending';
        try {
            if (method === 'bank_transfer') {
                const transfer = await this.paystack.chargeTransfer({
                    email,
                    amountKobo: bundle.amountNaira * 100,
                    reference,
                    expiresAt: new Date(Date.now() + TRANSFER_MINUTES * 60_000),
                });
                meta = { transfer };
                status = 'awaiting_transfer';
            } else {
                const init = await this.paystack.initialize({
                    email,
                    amountKobo: bundle.amountNaira * 100,
                    reference,
                    callbackUrl: `${this.config.appUrl}/tokens/return?reference=${encodeURIComponent(reference)}`,
                    channels: ['card', 'bank', 'ussd', 'bank_transfer'],
                });
                meta = { authorizationUrl: init.authorizationUrl };
            }
        } catch (error) {
            if (error instanceof PaystackUnavailable) {
                this.logger.warn(error.message);
                throw AppError.unavailable(
                    'payments_unavailable',
                    'Payments are not available right now. Try again soon.'
                );
            }
            throw error;
        }

        const [row] = await this.db.query<PurchaseRow>(
            `insert into purchases (reference, account_id, bundle_id, amount_kobo, tokens, status, channel, idempotency_key, meta)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (account_id, idempotency_key) where idempotency_key is not null do nothing
       returning reference, account_id, amount_kobo, tokens, status, channel, created_at, meta`,
            [
                reference,
                accountId,
                bundle.id,
                bundle.amountNaira * 100,
                bundle.tokens,
                status,
                method,
                key ?? null,
                JSON.stringify(meta),
            ]
        );
        if (!row && key) {
            const [existing] = await this.db.query<PurchaseRow>(
                `select reference, account_id, amount_kobo, tokens, status, channel, created_at, meta from purchases
          where account_id = $1 and idempotency_key = $2`,
                [accountId, key]
            );
            return this.view(existing);
        }
        return this.view(row);
    }

    async get(accountId: string, reference: string) {
        const [p] = await this.db.query<PurchaseRow & { age: number }>(
            `select reference, account_id, amount_kobo, tokens, status, channel, created_at, meta,
              extract(epoch from now() - created_at)::int as age
         from purchases where reference = $1 and account_id = $2`,
            [reference, accountId]
        );
        if (!p) throw AppError.notFound('No such purchase.');
        if (
            (p.status === 'pending' || p.status === 'awaiting_transfer') &&
            p.age >= VERIFY_AFTER_SECONDS
        ) {
            await this.reconcile(reference).catch((error) =>
                this.logger.warn(`Verify failed: ${(error as Error).message}`)
            );
            const [fresh] = await this.db.query<PurchaseRow>(
                'select reference, account_id, amount_kobo, tokens, status, channel, created_at, meta from purchases where reference = $1',
                [reference]
            );
            return this.view(fresh);
        }
        return this.view(p);
    }

    async reconcile(reference: string): Promise<void> {
        const result = await this.paystack.verify(reference);
        if (result.status === 'success')
            await this.settle(reference, result.amountKobo, result.channel);
        else if (result.status === 'failed' || result.status === 'abandoned') {
            await this.db.query(
                `update purchases set status = 'failed', completed_at = now() where reference = $1 and status in ('pending', 'awaiting_transfer')`,
                [reference]
            );
        }
    }

    async settle(
        reference: string,
        amountKobo: number | null,
        channel: string | null
    ): Promise<boolean> {
        return this.db.transaction(async (q: Queryable) => {
            const [p] = await q.query<PurchaseRow>(
                'select reference, account_id, amount_kobo, tokens, status, channel, created_at, meta from purchases where reference = $1 for update',
                [reference]
            );
            if (!p) return false;
            if (amountKobo !== null && amountKobo < p.amount_kobo) {
                this.logger.warn(`Underpaid ${reference}: ${amountKobo} < ${p.amount_kobo}`);
                return false;
            }
            const { applied } = await this.tokens.credit(q, p.account_id, p.tokens, 'purchase', {
                idempotencyKey: `paystack:${reference}`,
                refType: 'purchase',
                refId: reference,
            });
            await q.query(
                `update purchases set status = 'success', completed_at = coalesce(completed_at, now()), channel = coalesce($2, channel)
          where reference = $1`,
                [reference, channel]
            );
            return applied;
        });
    }

    async webhook(
        rawBody: Buffer | undefined,
        signature: string | undefined,
        body: { event?: string; data?: { reference?: string; amount?: number; channel?: string } }
    ) {
        if (!rawBody || !this.paystack.checkSignature(rawBody, signature)) {
            throw AppError.unauthorized('invalid_signature', 'Signature mismatch.');
        }
        const reference = body.data?.reference;
        if (body.event === 'charge.success' && reference) {
            await this.settle(
                reference,
                typeof body.data?.amount === 'number' ? body.data.amount : null,
                body.data?.channel ?? null
            );
        }
    }
}
