import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AI_PROVIDER, type AiMessage, type AiProvider } from '../ai/ai.provider.js';
import { ASK_SYSTEM, GUEST_RULES } from '../ai/prompts.js';
import { AppError } from '../common/app-error.js';
import { hmac, sha256 } from '../common/crypto.js';
import { CONFIG, type Config } from '../config.js';
import { DB, type Db } from '../db/db.js';
import type { SseWriter } from './sse.js';

export const GUEST_LIMIT = 3;
const GUEST_TTL_DAYS = 7;
const SESSIONS_PER_IP_PER_DAY = 10;
const QUESTIONS_PER_IP_PER_DAY = 15;

interface GuestRow {
    token_hash: string;
    device_hash: string;
    ip_hash: string;
    claimed_by: string | null;
    claimed_conversation_id: string | null;
    expired: boolean;
}

@Injectable()
export class GuestService {
    private readonly logger = new Logger('Guest');

    constructor(
        @Inject(DB) private readonly db: Db,
        @Inject(CONFIG) private readonly config: Config,
        @Inject(AI_PROVIDER) private readonly ai: AiProvider
    ) {}

    private hash(kind: string, value: string) {
        return hmac(this.config.codePepper, `${kind}:${value}`);
    }

    private async usedOnDevice(deviceHash: string): Promise<number> {
        const [{ used }] = await this.db.query<{ used: number }>(
            'select coalesce(sum(questions_used), 0)::int as used from guest_sessions where device_hash = $1',
            [deviceHash]
        );
        return used;
    }

    async create(deviceId: string, ip: string) {
        const deviceHash = this.hash('device', deviceId);
        const ipHash = this.hash('ip', ip);
        const [{ n }] = await this.db.query<{ n: number }>(
            `select count(*)::int as n from guest_sessions where ip_hash = $1 and created_at > now() - interval '1 day'`,
            [ipHash]
        );
        if (n >= SESSIONS_PER_IP_PER_DAY) throw AppError.rateLimited(3600);

        const token = `gst_${randomBytes(24).toString('base64url')}`;
        const [row] = await this.db.query<{ expires_at: Date }>(
            `insert into guest_sessions (token_hash, device_hash, ip_hash, expires_at)
       values ($1, $2, $3, now() + make_interval(days => $4)) returning expires_at`,
            [sha256(token), deviceHash, ipHash, GUEST_TTL_DAYS]
        );
        return {
            guestToken: token,
            expiresAt: new Date(row.expires_at).toISOString(),
            questionsLeft: Math.max(0, GUEST_LIMIT - (await this.usedOnDevice(deviceHash))),
        };
    }

    private async session(token: string | undefined): Promise<GuestRow> {
        if (!token)
            throw AppError.unauthorized('invalid_guest_token', 'Start a guest session first.');
        const [row] = await this.db.query<GuestRow>(
            `select token_hash, device_hash, ip_hash, claimed_by, claimed_conversation_id, expires_at <= now() as expired
         from guest_sessions where token_hash = $1`,
            [sha256(token)]
        );
        if (!row || row.expired)
            throw AppError.unauthorized(
                'invalid_guest_token',
                'This guest session has ended. Start again.'
            );
        return row;
    }

    async prepare(token: string | undefined, text: string) {
        const g = await this.session(token);
        if (g.claimed_by)
            throw AppError.unauthorized(
                'invalid_guest_token',
                'This chat was saved to an account. Sign in to continue.'
            );
        const [{ ipQuestions }] = await this.db.query<{ ipQuestions: number }>(
            `select coalesce(sum(questions_used), 0)::int as "ipQuestions" from guest_sessions
        where ip_hash = $1 and created_at > now() - interval '1 day'`,
            [g.ip_hash]
        );
        if (ipQuestions >= QUESTIONS_PER_IP_PER_DAY) throw AppError.rateLimited(3600);

        const reserved = await this.db.transaction(async (q) => {
            await q.query('select 1 from guest_sessions where device_hash = $1 for update', [
                g.device_hash,
            ]);
            const [{ used }] = await q.query<{ used: number }>(
                'select coalesce(sum(questions_used), 0)::int as used from guest_sessions where device_hash = $1',
                [g.device_hash]
            );
            if (used >= GUEST_LIMIT) return null;
            await q.query(
                'update guest_sessions set questions_used = questions_used + 1 where token_hash = $1',
                [g.token_hash]
            );
            return used + 1;
        });
        if (reserved === null) {
            throw new AppError(
                429,
                'guest_limit_reached',
                'Free questions used',
                'Sign up to keep asking Florence.',
                {}
            );
        }
        return (writer: SseWriter) => this.answer(writer, g, text.trim(), GUEST_LIMIT - reserved);
    }

    private async answer(writer: SseWriter, g: GuestRow, text: string, left: number) {
        writer.event('message.start', { messageId: null, charged: 0, balance: null });
        const history = await this.db.query<{ role: 'user' | 'assistant'; content: string }>(
            'select role, content from guest_messages where guest_token_hash = $1 order by created_at, id',
            [g.token_hash]
        );
        let full = '';
        try {
            const messages: AiMessage[] = [
                ...history.map((h) => ({ role: h.role, content: h.content })),
                { role: 'user', content: text },
            ];
            await this.ai.stream(
                {
                    system: `${ASK_SYSTEM}\n\n${GUEST_RULES}`,
                    messages,
                    maxTokens: 8000,
                    effort: 'medium',
                    signal: writer.signal,
                },
                (delta) => {
                    full += delta;
                    writer.event('delta', { text: delta });
                }
            );
            if (writer.signal.aborted) throw new Error('aborted');
        } catch (error) {
            await this.db.query(
                'update guest_sessions set questions_used = greatest(questions_used - 1, 0) where token_hash = $1',
                [g.token_hash]
            );
            writer.event('error', {
                code: 'answer_failed',
                refunded: true,
                balance: null,
                questionsLeft: left + 1,
            });
            this.logger.warn(`Guest answer failed: ${(error as Error).message}`);
            writer.end();
            return;
        }
        await this.db.transaction(async (q) => {
            await q.query(
                `insert into guest_messages (guest_token_hash, role, content, created_at) values ($1, 'user', $2, clock_timestamp())`,
                [g.token_hash, text]
            );
            await q.query(
                `insert into guest_messages (guest_token_hash, role, content, created_at) values ($1, 'assistant', $2, clock_timestamp() + interval '1 millisecond')`,
                [g.token_hash, full]
            );
        });
        writer.event('message.end', {
            messageId: null,
            balance: null,
            grounded: false,
            questionsLeft: left,
        });
        writer.end();
    }

    async claim(accountId: string, token: string) {
        const g = await this.session(token).catch(() => {
            throw AppError.notFound('No guest chat to keep.');
        });
        if (g.claimed_by && g.claimed_by !== accountId)
            throw AppError.notFound('No guest chat to keep.');

        const id = await this.db.transaction(async (q) => {
            const [row] = await q.query<{
                claimed_by: string | null;
                claimed_conversation_id: string | null;
            }>(
                'select claimed_by, claimed_conversation_id from guest_sessions where token_hash = $1 for update',
                [g.token_hash]
            );
            if (row.claimed_by === accountId && row.claimed_conversation_id)
                return row.claimed_conversation_id;
            if (row.claimed_by) throw AppError.notFound('No guest chat to keep.');

            const messages = await q.query<{ role: string; content: string; created_at: Date }>(
                'select role, content, created_at from guest_messages where guest_token_hash = $1 order by created_at, id',
                [g.token_hash]
            );
            if (messages.length === 0) throw AppError.notFound('No guest chat to keep.');
            const title = messages[0].content.replace(/\s+/g, ' ').slice(0, 60);
            const [c] = await q.query<{ id: string }>(
                'insert into conversations (account_id, title, last_message_at) values ($1, $2, $3) returning id',
                [accountId, title, messages[messages.length - 1].created_at]
            );
            let previous = 0;
            for (const m of messages) {
                const at = Math.max(new Date(m.created_at).getTime(), previous + 1);
                previous = at;
                await q.query(
                    `insert into messages (conversation_id, role, content, grounded, charged, created_at) values ($1, $2, $3, false, 0, $4)`,
                    [c.id, m.role, JSON.stringify({ text: m.content }), new Date(at)]
                );
            }
            await q.query(
                'update guest_sessions set claimed_by = $2, claimed_at = now(), claimed_conversation_id = $3 where token_hash = $1',
                [g.token_hash, accountId, c.id]
            );
            return c.id;
        });
        const [c] = await this.db.query<{
            id: string;
            title: string | null;
            mode: 'ask' | 'prep';
            last_message_at: Date | null;
        }>('select id, title, mode, last_message_at from conversations where id = $1', [id]);
        return {
            id: c.id,
            title: c.title,
            mode: c.mode,
            lastMessageAt: c.last_message_at ? new Date(c.last_message_at).toISOString() : null,
        };
    }
}
