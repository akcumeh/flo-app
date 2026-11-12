import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { lagosDate } from '../common/lagos.js';
import { DB, type Db, type Queryable } from '../db/db.js';
import { JobsService } from '../jobs/jobs.service.js';
import { ReferralsService } from '../platform/referrals.service.js';
import { TokensService } from '../tokens/tokens.service.js';
import {
    GeneratorService,
    MODES,
    normalise,
    type AnswerKey,
    type GeneratedItem,
    type ItemType,
    type StudyMode,
} from './generator.service.js';
import {
    REWARD_EVERY,
    REWARD_TOKENS,
    StreakService,
    type StudyDayEffect,
} from './streak.service.js';

export const GENERATE_JOB = 'generate_session';
const SESSION_TTL_HOURS = 24;
const OFFLINE_LIMIT_MS = 48 * 60 * 60 * 1000;
const OPEN = ['generating', 'active'];

type Status = 'generating' | 'active' | 'completed' | 'failed' | 'expired';
type Result = 'right' | 'not_quite' | 'partly' | 'skipped';

interface SessionRow {
    id: string;
    account_id: string;
    mode: StudyMode;
    status: Status;
    file_ids: string[];
    topic_ids: string[];
    requested_count: number;
    round: number;
    refunded_at: Date | null;
    time_limit_seconds: number | null;
    created_at: Date;
    expires_at: Date;
}

interface ItemRow {
    round: number;
    idx: number;
    type: ItemType;
    prompt: string;
    options: string[] | null;
    back: string | null;
    answer_key: AnswerKey;
    marks: number;
    difficulty: 'easy' | 'medium' | 'hard';
    topic: string;
    source_label: string;
}

interface AnswerRow {
    round: number;
    item_idx: number;
    answer: string | null;
    result: Result;
    awarded_marks: number;
    verdict: Verdict;
    idempotency_key: string;
}

export interface Verdict {
    itemId: number;
    result: Result;
    awardedMarks: number;
    maxMarks: number;
    correctAnswer: string;
    whyRight?: string;
    whyOthersFail?: Array<{ option: string; reason: string }>;
    examTip?: string;
    source?: { fileId: string; label: string; page?: number };
    studyDay?: StudyDayEffect;
}

export interface AnswerInput {
    itemId: number;
    answeredAt: string;
    answer?: string;
    outcome?: 'know' | 'missed';
    dontKnow?: boolean;
}

const SESSION_COLUMNS = `id, account_id, mode, status, file_ids, topic_ids, requested_count, round, refunded_at,
  time_limit_seconds, created_at, expires_at`;
const ITEM_COLUMNS =
    'round, idx, type, prompt, options, back, answer_key, marks, difficulty, topic, source_label';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function chooseOption(answer: string, options: string[]): string | null {
    const chosen = normalise(answer);
    const exact = options.find((o) => normalise(o) === chosen);
    if (exact) return exact;
    const letter = chosen.replace(/[).\s]/g, '');
    if (/^[a-z]$/.test(letter)) return options[letter.charCodeAt(0) - 97] ?? null;
    return null;
}

@Injectable()
export class SessionsService implements OnModuleInit {
    constructor(
        @Inject(DB) private readonly db: Db,
        @Inject(CLOCK) private readonly clock: Clock,
        @Inject(TokensService) private readonly tokens: TokensService,
        @Inject(StreakService) private readonly streaks: StreakService,
        @Inject(GeneratorService) private readonly generator: GeneratorService,
        @Inject(JobsService) private readonly jobs: JobsService,
        @Inject(ReferralsService) private readonly referrals: ReferralsService
    ) {}

    onModuleInit() {
        this.jobs.register(GENERATE_JOB, {
            run: (payload) =>
                this.runGeneration(
                    String(payload.sessionId),
                    payload.focus ? String(payload.focus) : undefined
                ),
            failed: (payload) =>
                this.fail(
                    String(payload.sessionId),
                    'Florence could not write questions from this material.'
                ),
        });
    }

    private async load(
        q: Queryable,
        accountId: string,
        sessionId: string,
        lock = false
    ): Promise<SessionRow> {
        if (!UUID.test(sessionId)) throw AppError.notFound('No such session.');
        const rows = await q.query<SessionRow>(
            `select ${SESSION_COLUMNS} from study_sessions where id = $1 and account_id = $2${lock ? ' for update' : ''}`,
            [sessionId, accountId]
        );
        if (rows.length === 0) throw AppError.notFound('No such session.');
        return rows[0];
    }

    private async refundOnce(q: Queryable, s: SessionRow) {
        if (s.refunded_at) return;
        await this.tokens.credit(q, s.account_id, 1, 'refund', {
            refType: 'session',
            refId: s.id,
            idempotencyKey: `refund:session:${s.id}`,
        });
        await q.query(
            'update study_sessions set refunded_at = now() where id = $1 and refunded_at is null',
            [s.id]
        );
        s.refunded_at = new Date();
    }

    private async close(q: Queryable, s: SessionRow, status: 'expired' | 'completed') {
        const [{ n }] = await q.query<{ n: number }>(
            'select count(*)::int as n from session_answers where session_id = $1',
            [s.id]
        );
        if (n === 0) await this.refundOnce(q, s);
        await q.query(
            'update study_sessions set status = $2, completed_at = coalesce(completed_at, now()) where id = $1',
            [s.id, status]
        );
        s.status = status;
    }

    private async closeOpen(q: Queryable, accountId: string) {
        const open = await q.query<SessionRow>(
            `select ${SESSION_COLUMNS} from study_sessions where account_id = $1 and status = any($2::text[]) for update`,
            [accountId, OPEN]
        );
        for (const s of open) await this.close(q, s, 'expired');
    }

    private async expireIfDue(q: Queryable, s: SessionRow) {
        if (OPEN.includes(s.status) && new Date(s.expires_at) <= this.clock.now())
            await this.close(q, s, 'expired');
    }

    private async charge(q: Queryable, accountId: string, sessionId: string) {
        await this.tokens.debit(q, accountId, 1, 'prep_charge', {
            idempotencyKey: `session:${sessionId}`,
            refType: 'session',
            refId: sessionId,
        });
    }

    private async insertItems(
        q: Queryable,
        sessionId: string,
        round: number,
        items: Array<GeneratedItem & { idx: number }>
    ) {
        for (const it of items) {
            await q.query(
                `insert into session_items (session_id, round, idx, type, prompt, options, back, answer_key, marks, difficulty, topic, source_label)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                [
                    sessionId,
                    round,
                    it.idx,
                    it.type,
                    it.prompt,
                    it.options ? JSON.stringify(it.options) : null,
                    it.back,
                    JSON.stringify(it.key),
                    it.marks,
                    it.difficulty,
                    it.topic,
                    it.sourceLabel,
                ]
            );
        }
    }

    async create(
        accountId: string,
        body: {
            mode: StudyMode;
            fileIds: string[];
            topicIds?: string[];
            questionCount?: number;
            timeLimitMinutes?: number;
        }
    ) {
        await this.generator.material(this.db, accountId, body.fileIds, body.topicIds);
        const id = await this.db.transaction(async (q) => {
            await this.closeOpen(q, accountId);
            const [row] = await q.query<{ id: string }>(
                `insert into study_sessions (account_id, mode, status, file_ids, topic_ids, requested_count, time_limit_seconds, expires_at)
         values ($1, $2, 'generating', $3::uuid[], $4::uuid[], $5, $6, now() + make_interval(hours => $7)) returning id`,
                [
                    accountId,
                    body.mode,
                    [...new Set(body.fileIds)],
                    (body.topicIds ?? []).filter((t) => UUID.test(t)),
                    body.questionCount ?? 10,
                    body.mode === 'mock_exam' && body.timeLimitMinutes
                        ? body.timeLimitMinutes * 60
                        : null,
                    SESSION_TTL_HOURS,
                ]
            );
            await this.charge(q, accountId, row.id);
            await q.query('insert into jobs (kind, payload) values ($1, $2)', [
                GENERATE_JOB,
                JSON.stringify({ sessionId: row.id }),
            ]);
            return row.id;
        });
        return this.get(accountId, id);
    }

    async runGeneration(sessionId: string, focus?: string) {
        const [s] = await this.db.query<SessionRow>(
            `select ${SESSION_COLUMNS} from study_sessions where id = $1`,
            [sessionId]
        );
        if (!s || s.status !== 'generating') return;
        let items: GeneratedItem[];
        try {
            const material = await this.generator.material(
                this.db,
                s.account_id,
                s.file_ids,
                s.topic_ids
            );
            items = await this.generator.generate(material, s.mode, s.requested_count, focus);
        } catch (error) {
            if (error instanceof AppError) {
                await this.fail(sessionId, error.detail ?? error.title);
                return;
            }
            throw error;
        }
        if (items.length < 2) {
            await this.fail(sessionId, 'There was not enough in this material for 2 questions.');
            return;
        }
        await this.db.transaction(async (q) => {
            const [cur] = await q.query<{ status: Status }>(
                'select status from study_sessions where id = $1 for update',
                [sessionId]
            );
            if (cur?.status !== 'generating') return;
            await this.insertItems(
                q,
                sessionId,
                1,
                items.map((it, idx) => ({ ...it, idx }))
            );
            await q.query(
                `update study_sessions set status = 'active', error = null where id = $1`,
                [sessionId]
            );
        });
    }

    async fail(sessionId: string, reason: string) {
        await this.db.transaction(async (q) => {
            const [s] = await q.query<SessionRow>(
                `select ${SESSION_COLUMNS} from study_sessions where id = $1 for update`,
                [sessionId]
            );
            if (!s || s.status !== 'generating') return;
            await this.refundOnce(q, s);
            await q.query(
                `update study_sessions set status = 'failed', error = $2, completed_at = now() where id = $1`,
                [sessionId, reason]
            );
        });
    }

    private itemView(it: ItemRow, state: Result | 'unanswered') {
        return {
            id: it.idx,
            type: it.type,
            prompt: it.prompt,
            ...(it.options ? { options: it.options } : {}),
            ...(it.type === 'flashcard' && it.back ? { back: it.back } : {}),
            marks: it.marks,
            difficulty: it.difficulty,
            topic: it.topic,
            sourceLabel: it.source_label,
            state,
        };
    }

    private async view(q: Queryable, s: SessionRow) {
        const items = await q.query<ItemRow>(
            `select ${ITEM_COLUMNS} from session_items where session_id = $1 and round = $2 order by idx`,
            [s.id, s.round]
        );
        const answers = await q.query<{ item_idx: number; result: Result }>(
            'select item_idx, result from session_answers where session_id = $1 and round = $2',
            [s.id, s.round]
        );
        const [{ generated }] = await q.query<{ generated: number }>(
            'select count(*)::int as generated from session_items where session_id = $1 and round = 1',
            [s.id]
        );
        const state = new Map(answers.map((a) => [a.item_idx, a.result]));
        const firstOpen = items.find((it) => !state.has(it.idx));
        return {
            id: s.id,
            mode: s.mode,
            status: s.status,
            fileIds: s.file_ids,
            requestedCount: s.requested_count,
            generatedCount: generated,
            currentIndex: firstOpen ? firstOpen.idx : items.length,
            round: s.round,
            items: items.map((it) => this.itemView(it, state.get(it.idx) ?? 'unanswered')),
            switchableModes: MODES,
            cost: 1 as const,
            refunded: Boolean(s.refunded_at),
            ...(s.time_limit_seconds ? { timeLimitSeconds: s.time_limit_seconds } : {}),
            expiresAt: new Date(s.expires_at).toISOString(),
        };
    }

    async get(accountId: string, sessionId: string) {
        return this.db.transaction(async (q) => {
            const s = await this.load(q, accountId, sessionId, true);
            await this.expireIfDue(q, s);
            return this.view(q, s);
        });
    }

    async list(
        accountId: string,
        opts: { cursor?: string; limit: number; mode?: StudyMode; status?: 'active' | 'completed' }
    ) {
        let before: { at: string; id: string } | null = null;
        if (opts.cursor) {
            const [at, id] = Buffer.from(opts.cursor, 'base64url').toString('utf8').split('|');
            if (!at || !UUID.test(id ?? '') || Number.isNaN(Date.parse(at))) {
                throw AppError.badRequest('invalid_cursor', 'The cursor is not valid.');
            }
            before = { at, id };
        }
        const statuses =
            opts.status === 'active' ? OPEN : opts.status === 'completed' ? ['completed'] : null;
        const rows = await this.db.query<SessionRow>(
            `select ${SESSION_COLUMNS} from study_sessions
        where account_id = $1
          and ($2::text is null or mode = $2)
          and ($3::text[] is null or status = any($3::text[]))
          and ($4::timestamptz is null or (created_at, id) < ($4::timestamptz, $5::uuid))
        order by created_at desc, id desc
        limit $6`,
            [
                accountId,
                opts.mode ?? null,
                statuses,
                before?.at ?? null,
                before?.id ?? null,
                opts.limit + 1,
            ]
        );
        const page = rows.slice(0, opts.limit);
        const items = [];
        for (const s of page) items.push(await this.view(this.db, s));
        const last = page[page.length - 1];
        return {
            items,
            nextCursor:
                rows.length > opts.limit
                    ? Buffer.from(
                          `${new Date(last.created_at).toISOString()}|${last.id}`,
                          'utf8'
                      ).toString('base64url')
                    : null,
        };
    }

    async exit(accountId: string, sessionId: string) {
        await this.db.transaction(async (q) => {
            const s = await this.load(q, accountId, sessionId, true);
            if (OPEN.includes(s.status)) await this.close(q, s, 'expired');
        });
    }

    async switchMode(accountId: string, sessionId: string, mode: StudyMode) {
        const s = await this.db.transaction(async (q) => {
            const row = await this.load(q, accountId, sessionId, true);
            await this.expireIfDue(q, row);
            return row;
        });
        if (s.status !== 'active')
            throw AppError.conflict('session_not_active', 'This session is not open.');
        if (s.mode === mode) return this.get(accountId, sessionId);

        const open = await this.db.query<{ idx: number }>(
            `select i.idx from session_items i
        where i.session_id = $1 and i.round = $2
          and not exists (select 1 from session_answers a where a.session_id = i.session_id and a.round = i.round and a.item_idx = i.idx)
        order by i.idx`,
            [s.id, s.round]
        );
        let fresh: GeneratedItem[] = [];
        if (open.length > 0) {
            const material = await this.generator.material(
                this.db,
                accountId,
                s.file_ids,
                s.topic_ids
            );
            try {
                fresh = await this.generator.generate(material, mode, open.length);
            } catch {
                fresh = [];
            }
            if (fresh.length === 0)
                throw AppError.unavailable(
                    'generation_failed',
                    'Florence could not switch modes right now. Try again.'
                );
        }

        await this.db.transaction(async (q) => {
            const slots = open.slice(0, fresh.length).map((o) => o.idx);
            await q.query(
                `delete from session_items i where i.session_id = $1 and i.round = $2 and i.idx = any($3::int[])`,
                [s.id, s.round, open.map((o) => o.idx)]
            );
            await this.insertItems(
                q,
                s.id,
                s.round,
                fresh.map((it, i) => ({ ...it, idx: slots[i] }))
            );
            await q.query(
                `update study_sessions set mode = $2, time_limit_seconds = case when $2 = 'mock_exam' then time_limit_seconds end where id = $1`,
                [s.id, mode]
            );
        });
        return this.get(accountId, sessionId);
    }

    private async notesFor(key: AnswerKey): Promise<string> {
        if (!key.fileId) return '';
        const rows = await this.db.query<{ text: string }>(
            `select text from file_chunks where file_id = $1 and ($2::int is null or page = $2) order by ord limit 3`,
            [key.fileId, key.page]
        );
        return rows.map((r) => r.text).join('\n\n');
    }

    private async mark(item: ItemRow, input: AnswerInput): Promise<Verdict> {
        const key = item.answer_key;
        const base: Verdict = {
            itemId: item.idx,
            result: 'skipped',
            awardedMarks: 0,
            maxMarks: item.marks,
            correctAnswer: key.answer,
            ...(key.explanation ? { whyRight: key.explanation } : {}),
            ...(key.examTip ? { examTip: key.examTip } : {}),
            ...(key.fileId
                ? {
                      source: {
                          fileId: key.fileId,
                          label: item.source_label,
                          ...(key.page ? { page: key.page } : {}),
                      },
                  }
                : {}),
        };
        if (input.dontKnow) return base;

        const verdict = (right: boolean): Verdict => ({
            ...base,
            result: right ? 'right' : 'not_quite',
            awardedMarks: right ? item.marks : 0,
        });

        switch (item.type) {
            case 'flashcard':
                return verdict(input.outcome === 'know');
            case 'mcq': {
                const chosen = chooseOption(input.answer as string, item.options ?? []);
                const v = verdict(chosen !== null && normalise(chosen) === normalise(key.answer));
                return key.wrongOptionReasons.length > 0
                    ? { ...v, whyOthersFail: key.wrongOptionReasons }
                    : v;
            }
            case 'true_false': {
                const a = normalise(input.answer as string);
                const value = ['true', 't', 'yes', 'y'].includes(a)
                    ? 'true'
                    : ['false', 'f', 'no', 'n'].includes(a)
                      ? 'false'
                      : a;
                return verdict(value === normalise(key.answer));
            }
            case 'fill_gap': {
                const a = normalise(input.answer as string);
                return verdict([key.answer, ...key.acceptable].some((k) => normalise(k) === a));
            }
            default: {
                if (normalise(input.answer as string) === normalise(key.answer))
                    return verdict(true);
                const marked = await this.generator.mark({
                    prompt: item.prompt,
                    marks: item.marks,
                    key,
                    notes: await this.notesFor(key),
                    answer: input.answer as string,
                });
                if (!marked) {
                    return {
                        ...verdict(false),
                        whyRight: `Marking is not available right now. Compare your answer with the model answer: ${key.answer}`,
                    };
                }
                const result: Result =
                    marked.awardedMarks >= item.marks
                        ? 'right'
                        : marked.awardedMarks === 0
                          ? 'not_quite'
                          : 'partly';
                return {
                    ...base,
                    result,
                    awardedMarks: marked.awardedMarks,
                    whyRight:
                        [marked.feedback, marked.whyRight].filter(Boolean).join('\n\n') ||
                        key.explanation,
                    ...(marked.examTip || key.examTip
                        ? { examTip: marked.examTip || key.examTip }
                        : {}),
                };
            }
        }
    }

    async answer(
        accountId: string,
        sessionId: string,
        idempotencyKey: string,
        input: AnswerInput
    ): Promise<Verdict> {
        const s = await this.db.transaction(async (q) => {
            const row = await this.load(q, accountId, sessionId, true);
            await this.expireIfDue(q, row);
            return row;
        });
        const replay = await this.db.query<{ verdict: Verdict }>(
            'select verdict from session_answers where session_id = $1 and idempotency_key = $2',
            [s.id, idempotencyKey]
        );
        if (replay.length > 0) return replay[0].verdict;
        if (s.status !== 'active')
            throw AppError.conflict('session_not_active', 'This session is not open.');

        const now = this.clock.now();
        let answeredAt = new Date(input.answeredAt);
        if (Number.isNaN(answeredAt.getTime()) || answeredAt > now) answeredAt = now;
        if (now.getTime() - answeredAt.getTime() > OFFLINE_LIMIT_MS) {
            throw AppError.unprocessable(
                'answer_too_old',
                'Answers sync for up to 48 hours. This one is older.'
            );
        }

        const [item] = await this.db.query<ItemRow>(
            `select ${ITEM_COLUMNS} from session_items where session_id = $1 and round = $2 and idx = $3`,
            [s.id, s.round, input.itemId]
        );
        if (!item) throw AppError.notFound('No such item in this session.');
        const done = await this.db.query(
            'select 1 from session_answers where session_id = $1 and round = $2 and item_idx = $3',
            [s.id, s.round, input.itemId]
        );
        if (done.length > 0)
            throw AppError.conflict('already_answered', 'This item already has an answer.');

        const hasOutcome = input.outcome !== undefined;
        const hasText = typeof input.answer === 'string' && input.answer.trim() !== '';
        if (!input.dontKnow && (item.type === 'flashcard' ? !hasOutcome : !hasText)) {
            throw AppError.unprocessable(
                'invalid_answer',
                item.type === 'flashcard'
                    ? 'Rate the card: know or missed.'
                    : 'Type an answer, or choose "I don\'t know".'
            );
        }

        const verdict = await this.mark(item, input);

        return this.db.transaction(async (q) => {
            const inserted = await q.query<{ id: string }>(
                `insert into session_answers (session_id, account_id, round, item_idx, answer, outcome, dont_know, result, awarded_marks, verdict, idempotency_key, answered_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict do nothing returning id`,
                [
                    s.id,
                    accountId,
                    s.round,
                    item.idx,
                    input.answer ?? null,
                    input.outcome ?? null,
                    Boolean(input.dontKnow),
                    verdict.result,
                    verdict.awardedMarks,
                    JSON.stringify(verdict),
                    idempotencyKey,
                    answeredAt,
                ]
            );
            if (inserted.length === 0) {
                const again = await q.query<{ verdict: Verdict }>(
                    'select verdict from session_answers where session_id = $1 and idempotency_key = $2',
                    [s.id, idempotencyKey]
                );
                if (again.length > 0) return again[0].verdict;
                throw AppError.conflict('already_answered', 'This item already has an answer.');
            }

            const effect = await this.streaks.recordEvent(q, accountId, {
                kind: item.type === 'flashcard' ? 'flashcard_rating' : 'prep_answer',
                source: 'app',
                occurredAt: answeredAt,
                sessionId: s.id,
            });
            const studyDay = {
                counted: effect.counted,
                justEarned: effect.justEarned,
                streak: effect.streak,
            };
            const full = { ...verdict, studyDay };
            await q.query('update session_answers set verdict = $2 where id = $1', [
                inserted[0].id,
                JSON.stringify(full),
            ]);
            await q.query('update study_sessions set current_index = $2 where id = $1', [
                s.id,
                item.idx + 1,
            ]);
            await this.advanceRound(q, s);
            return full;
        });
    }

    private async advanceRound(q: Queryable, s: SessionRow) {
        if (s.mode !== 'flashcards') return;
        const rows = await q.query<ItemRow & { result: Result | null }>(
            `select ${ITEM_COLUMNS.split(', ')
                .map((c) => `i.${c}`)
                .join(', ')}, a.result
         from session_items i
         left join session_answers a on a.session_id = i.session_id and a.round = i.round and a.item_idx = i.idx
        where i.session_id = $1 and i.round = $2 order by i.idx`,
            [s.id, s.round]
        );
        if (rows.some((r) => r.result === null)) return;
        const missed = rows.filter((r) => r.result !== 'right');
        if (missed.length === 0) return;
        const next = s.round + 1;
        await this.insertItems(
            q,
            s.id,
            next,
            missed.map((r, idx) => ({
                idx,
                type: r.type,
                prompt: r.prompt,
                options: r.options,
                back: r.back,
                key: r.answer_key,
                marks: r.marks,
                difficulty: r.difficulty,
                topic: r.topic,
                sourceLabel: r.source_label,
            }))
        );
        await q.query('update study_sessions set round = $2, current_index = 0 where id = $1', [
            s.id,
            next,
        ]);
    }

    private async resultView(q: Queryable, accountId: string, sessionId: string) {
        const [r] = await q.query<{
            id: string;
            mode: StudyMode;
            score: number;
            total: number;
            failed_topics: string[];
            source_docs: string[];
            charged: number;
            study_day: StudyDayEffect | null;
            streak_reward: number | null;
            created_at: Date;
        }>('select * from session_results where session_id = $1 and account_id = $2', [
            sessionId,
            accountId,
        ]);
        if (!r) return null;
        return {
            id: r.id,
            sessionId,
            mode: r.mode,
            score: r.score,
            total: r.total,
            failedTopics: r.failed_topics,
            sourceDocs: r.source_docs,
            charged: r.charged,
            balance: await this.tokens.balance(accountId, q),
            studyDay: r.study_day ?? { counted: false, justEarned: false, streak: 0 },
            ...(r.streak_reward ? { streakReward: { tokens: r.streak_reward } } : {}),
            createdAt: new Date(r.created_at).toISOString(),
        };
    }

    async complete(accountId: string, sessionId: string) {
        return this.db.transaction(async (q) => {
            const s = await this.load(q, accountId, sessionId, true);
            const existing = await this.resultView(q, accountId, sessionId);
            if (existing) return existing;
            if (s.status === 'generating' || s.status === 'failed') {
                throw AppError.conflict(
                    'session_not_active',
                    'This session has no questions to finish.'
                );
            }

            const items = await q.query<ItemRow>(
                `select ${ITEM_COLUMNS} from session_items where session_id = $1 and round = 1`,
                [s.id]
            );
            const answers = await q.query<AnswerRow>(
                'select round, item_idx, answer, result, awarded_marks, verdict, idempotency_key from session_answers where session_id = $1 and round = 1',
                [s.id]
            );
            const byIdx = new Map(answers.map((a) => [a.item_idx, a]));
            if (answers.length === 0) await this.refundOnce(q, s);
            await q.query(
                `update study_sessions set status = 'completed', completed_at = coalesce(completed_at, now()) where id = $1`,
                [s.id]
            );

            const finished = items.length >= 2 && items.every((it) => byIdx.has(it.idx));
            const now = this.clock.now();
            let studyDay: StudyDayEffect;
            let reward: number | null = null;
            if (finished) {
                const effect = await this.streaks.recordEvent(q, accountId, {
                    kind: 'session_finished',
                    source: 'app',
                    occurredAt: now,
                    sessionId: s.id,
                    questionCount: items.length,
                    answeredCount: answers.length,
                });
                studyDay = {
                    counted: effect.counted,
                    justEarned: effect.justEarned,
                    streak: effect.streak,
                };
                if (effect.justEarned && effect.streak > 0 && effect.streak % REWARD_EVERY === 0)
                    reward = REWARD_TOKENS;
                await this.referrals.rewardFirstSession(q, accountId);
            } else {
                studyDay = await this.streaks.evaluate(q, accountId, lagosDate(now));
                studyDay = { ...studyDay, justEarned: false };
            }

            const files = await q.query<{ name: string }>(
                'select name from stored_files where id = any($1::uuid[]) order by name',
                [s.file_ids]
            );
            const failedTopics = [
                ...new Set(
                    items
                        .filter((it) => byIdx.get(it.idx)?.result !== 'right')
                        .map((it) => it.topic)
                ),
            ];
            await q.query(
                `insert into session_results (account_id, session_id, mode, score, total, failed_topics, source_docs, charged, study_day, streak_reward)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (session_id) do nothing`,
                [
                    accountId,
                    s.id,
                    s.mode,
                    answers.reduce((n, a) => n + a.awarded_marks, 0),
                    items.reduce((n, it) => n + it.marks, 0),
                    failedTopics,
                    files.map((f) => f.name),
                    s.refunded_at ? 0 : 1,
                    JSON.stringify(studyDay),
                    reward,
                ]
            );
            return (await this.resultView(q, accountId, sessionId)) as NonNullable<
                Awaited<ReturnType<SessionsService['resultView']>>
            >;
        });
    }

    async mistakes(accountId: string, sessionId: string) {
        const s = await this.load(this.db, accountId, sessionId);
        const rows = await this.db.query<
            ItemRow & { answer: string | null; result: Result; verdict: Verdict }
        >(
            `select ${ITEM_COLUMNS.split(', ')
                .map((c) => `i.${c}`)
                .join(', ')}, a.answer, a.result, a.verdict
         from session_answers a join session_items i on i.session_id = a.session_id and i.round = a.round and i.idx = a.item_idx
        where a.session_id = $1 and a.round = 1 and a.result <> 'right'
        order by i.idx`,
            [s.id]
        );
        return {
            items: rows.map((r) => ({
                item: this.itemView(r, r.result),
                yourAnswer: r.answer,
                verdict: r.verdict,
            })),
        };
    }

    async retry(accountId: string, sessionId: string, mode?: StudyMode) {
        const source = await this.load(this.db, accountId, sessionId);
        const wrong = await this.db.query<ItemRow>(
            `select ${ITEM_COLUMNS.split(', ')
                .map((c) => `i.${c}`)
                .join(', ')}
         from session_answers a join session_items i on i.session_id = a.session_id and i.round = a.round and i.idx = a.item_idx
        where a.session_id = $1 and a.round = 1 and a.result <> 'right'
        order by i.idx`,
            [source.id]
        );
        if (wrong.length < 2) {
            throw AppError.conflict(
                'not_enough_material',
                'Fewer than 2 questions were missed, so there is nothing to retry.'
            );
        }
        const nextMode = mode ?? source.mode;
        const sameMode = nextMode === source.mode;
        if (!sameMode)
            await this.generator.material(this.db, accountId, source.file_ids, source.topic_ids);

        const id = await this.db.transaction(async (q) => {
            await this.closeOpen(q, accountId);
            const [row] = await q.query<{ id: string }>(
                `insert into study_sessions (account_id, mode, status, file_ids, topic_ids, requested_count, retry_of, expires_at)
         values ($1, $2, $3, $4::uuid[], $5::uuid[], $6, $7, now() + make_interval(hours => $8)) returning id`,
                [
                    accountId,
                    nextMode,
                    sameMode ? 'active' : 'generating',
                    source.file_ids,
                    source.topic_ids,
                    Math.min(30, Math.max(2, wrong.length)),
                    source.id,
                    SESSION_TTL_HOURS,
                ]
            );
            await this.charge(q, accountId, row.id);
            if (sameMode) {
                await this.insertItems(
                    q,
                    row.id,
                    1,
                    wrong.slice(0, 30).map((r, idx) => ({
                        idx,
                        type: r.type,
                        prompt: r.prompt,
                        options: r.options,
                        back: r.back,
                        key: r.answer_key,
                        marks: r.marks,
                        difficulty: r.difficulty,
                        topic: r.topic,
                        sourceLabel: r.source_label,
                    }))
                );
            } else {
                const focus = `the topics the student missed: ${[...new Set(wrong.map((w) => w.topic))].join(', ')}`;
                await q.query('insert into jobs (kind, payload) values ($1, $2)', [
                    GENERATE_JOB,
                    JSON.stringify({ sessionId: row.id, focus }),
                ]);
            }
            return row.id;
        });
        return this.get(accountId, id);
    }

    async shareData(accountId: string, sessionId: string) {
        await this.load(this.db, accountId, sessionId);
        const result = await this.resultView(this.db, accountId, sessionId);
        if (!result) throw AppError.notFound('Finish the session first.');
        return result;
    }
}
