import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../common/clock.js';
import { addDays, lagosDate, lagosHour } from '../common/lagos.js';
import { DB, type Db, type Queryable } from '../db/db.js';
import { TokensService } from '../tokens/tokens.service.js';

export const ITEMS_TARGET = 3;
export const FREEZE_RUN = 6;
export const REWARD_EVERY = 7;
export const REWARD_TOKENS = 10;
const AT_RISK_HOUR = 18;

export type StudyEventKind =
    'prep_answer' | 'flashcard_rating' | 'ask_question' | 'session_finished';
export type StudySource = 'app' | 'telegram' | 'whatsapp';

export interface StudyDayEffect {
    counted: boolean;
    justEarned: boolean;
    streak: number;
}

export interface Replay {
    current: number;
    longest: number;
    run: number;
    freezeHeld: boolean;
    lastStudy: string | null;
    frozenDays: string[];
    rewardDays: string[];
}

export interface StreakSummary {
    current: number;
    longest: number;
    state: 'none' | 'active' | 'at_risk';
    studiedToday: boolean;
}

export function replayStreak(studyDays: string[], today: string): Replay {
    const studied = new Set(studyDays);
    const sorted = [...studied].sort();
    const out: Replay = {
        current: 0,
        longest: 0,
        run: 0,
        freezeHeld: false,
        lastStudy: null,
        frozenDays: [],
        rewardDays: [],
    };
    if (sorted.length === 0) return out;

    for (let day = sorted[0]; day <= today; day = addDays(day, 1)) {
        if (studied.has(day)) {
            out.current += 1;
            out.run += 1;
            out.lastStudy = day;
            if (out.run === FREEZE_RUN) {
                out.freezeHeld = true;
                out.run = 0;
            }
            if (out.current % REWARD_EVERY === 0) out.rewardDays.push(day);
            out.longest = Math.max(out.longest, out.current);
            continue;
        }
        if (day === today) break;
        out.run = 0;
        if (out.current > 0 && out.freezeHeld) {
            out.freezeHeld = false;
            out.frozenDays.push(day);
        } else {
            out.current = 0;
        }
    }
    return out;
}

@Injectable()
export class StreakService {
    constructor(
        @Inject(DB) private readonly db: Db,
        @Inject(CLOCK) private readonly clock: Clock,
        @Inject(TokensService) private readonly tokens: TokensService
    ) {}

    today(): string {
        return lagosDate(this.clock.now());
    }

    async recordEvent(
        q: Queryable,
        accountId: string,
        e: {
            kind: StudyEventKind;
            source: StudySource;
            occurredAt: Date;
            eventId?: string;
            sessionId?: string;
            questionCount?: number;
            answeredCount?: number;
        }
    ): Promise<StudyDayEffect & { inserted: boolean }> {
        const day = lagosDate(e.occurredAt);
        const inserted = await q.query(
            `insert into study_events (account_id, kind, source, event_id, session_id, question_count, answered_count, day, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (event_id) do nothing returning id`,
            [
                accountId,
                e.kind,
                e.source,
                e.eventId ?? null,
                e.sessionId ?? null,
                e.questionCount ?? null,
                e.answeredCount ?? null,
                day,
                e.occurredAt,
            ]
        );
        const effect = await this.evaluate(q, accountId, day);
        return { ...effect, inserted: inserted.length > 0 };
    }

    async evaluate(q: Queryable, accountId: string, day: string): Promise<StudyDayEffect> {
        const [{ items, sessions }] = await q.query<{ items: number; sessions: number }>(
            `select count(*) filter (where kind in ('prep_answer', 'flashcard_rating', 'ask_question'))::int as items,
              count(*) filter (where kind = 'session_finished')::int as sessions
         from study_events where account_id = $1 and day = $2`,
            [accountId, day]
        );
        const reason = sessions > 0 ? 'session' : items >= ITEMS_TARGET ? 'three_items' : null;
        let justEarned = false;
        if (reason) {
            const rows = await q.query(
                'insert into study_days (account_id, day, reason) values ($1, $2, $3) on conflict do nothing returning day',
                [accountId, day, reason]
            );
            justEarned = rows.length > 0;
        }
        const replay = await this.refresh(q, accountId);
        const counted =
            (
                await q.query('select 1 from study_days where account_id = $1 and day = $2', [
                    accountId,
                    day,
                ])
            ).length > 0;
        return { counted, justEarned, streak: replay.current };
    }

    async refresh(q: Queryable, accountId: string): Promise<Replay & { rewarded: string[] }> {
        await q.query('insert into streaks (account_id) values ($1) on conflict do nothing', [
            accountId,
        ]);
        const [stored] = await q.query<{ longest: number }>(
            'select longest from streaks where account_id = $1 for update',
            [accountId]
        );
        const days = await q.query<{ day: string }>(
            'select day::text as day from study_days where account_id = $1 order by day',
            [accountId]
        );
        const today = this.today();
        const replay = replayStreak(
            days.map((d) => d.day),
            today
        );
        replay.longest = Math.max(replay.longest, stored.longest);

        await q.query(
            `update streaks set current = $2, longest = $3, run_days = $4, freeze_held = $5, last_study_day = $6, last_closed_day = $7
        where account_id = $1`,
            [
                accountId,
                replay.current,
                replay.longest,
                replay.run,
                replay.freezeHeld,
                replay.lastStudy,
                addDays(today, -1),
            ]
        );
        for (const day of replay.frozenDays) {
            await q.query(
                'insert into streak_freezes (account_id, day) values ($1, $2) on conflict do nothing',
                [accountId, day]
            );
        }
        const rewarded: string[] = [];
        for (const day of replay.rewardDays) {
            const r = await this.tokens.credit(q, accountId, REWARD_TOKENS, 'streak_reward', {
                idempotencyKey: `streak7:${accountId}:${day}`,
                refType: 'study_day',
                refId: day,
            });
            if (r.applied) rewarded.push(day);
        }
        return { ...replay, rewarded };
    }

    summaryFrom(replay: Replay): StreakSummary {
        const today = this.today();
        const studiedToday = replay.lastStudy === today;
        let state: StreakSummary['state'] = 'none';
        if (replay.current > 0) {
            state =
                !studiedToday && lagosHour(this.clock.now()) >= AT_RISK_HOUR ? 'at_risk' : 'active';
        }
        return { current: replay.current, longest: replay.longest, state, studiedToday };
    }

    async summary(accountId: string): Promise<StreakSummary> {
        const replay = await this.db.transaction((q) => this.refresh(q, accountId));
        return this.summaryFrom(replay);
    }

    async full(accountId: string, month?: string) {
        const today = this.today();
        const replay = await this.db.transaction((q) => this.refresh(q, accountId));
        const [{ items, sessions }] = await this.db.query<{ items: number; sessions: number }>(
            `select count(*) filter (where kind in ('prep_answer', 'flashcard_rating', 'ask_question'))::int as items,
              count(*) filter (where kind = 'session_finished')::int as sessions
         from study_events where account_id = $1 and day = $2`,
            [accountId, today]
        );
        const monthKey = month ?? today.slice(0, 7);
        const studied = new Set(
            (
                await this.db.query<{ day: string }>(
                    `select day::text as day from study_days where account_id = $1 and to_char(day, 'YYYY-MM') = $2`,
                    [accountId, monthKey]
                )
            ).map((r) => r.day)
        );
        const frozen = new Set(
            (
                await this.db.query<{ day: string }>(
                    `select day::text as day from streak_freezes where account_id = $1 and to_char(day, 'YYYY-MM') = $2`,
                    [accountId, monthKey]
                )
            ).map((r) => r.day)
        );
        const calendar: Array<{
            date: string;
            state: 'studied' | 'frozen' | 'missed' | 'today' | 'upcoming';
        }> = [];
        for (let day = `${monthKey}-01`; day.startsWith(monthKey); day = addDays(day, 1)) {
            let state: (typeof calendar)[number]['state'];
            if (studied.has(day)) state = 'studied';
            else if (day === today) state = 'today';
            else if (day > today) state = 'upcoming';
            else if (frozen.has(day)) state = 'frozen';
            else state = 'missed';
            calendar.push({ date: day, state });
        }
        const mod = replay.current % REWARD_EVERY;
        return {
            ...this.summaryFrom(replay),
            todayProgress: { items, target: ITEMS_TARGET, sessionsFinished: sessions },
            freeze: {
                held: replay.freezeHeld,
                daysToEarn: replay.freezeHeld ? null : FREEZE_RUN - replay.run,
            },
            timezone: 'Africa/Lagos',
            calendar,
            rewardProgress: {
                daysToNextReward: mod === 0 ? REWARD_EVERY : REWARD_EVERY - mod,
                tokens: REWARD_TOKENS,
            },
        };
    }

    async closeDays(): Promise<number> {
        const yesterday = addDays(this.today(), -1);
        const due = await this.db.query<{ account_id: string }>(
            `select account_id from streaks
        where (current > 0 or freeze_held) and (last_closed_day is null or last_closed_day < $1)
        limit 500`,
            [yesterday]
        );
        for (const { account_id } of due)
            await this.db.transaction((q) => this.refresh(q, account_id));
        return due.length;
    }
}
