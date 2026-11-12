import { Inject, Injectable } from '@nestjs/common';
import { IdentityService, type ProvenIdentity } from '../auth/identity.service.js';
import { AppError } from '../common/app-error.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { lagosDate } from '../common/lagos.js';
import { DB, type Db } from '../db/db.js';
import { REWARD_EVERY, REWARD_TOKENS, StreakService } from '../study/streak.service.js';

const OFFLINE_LIMIT_MS = 48 * 60 * 60 * 1000;

export interface BotEventInput {
    eventId: string;
    provider: 'telegram' | 'whatsapp';
    providerUserId: string;
    type: 'ask_question' | 'prep_answer' | 'prep_session_finished';
    questionCount?: number;
    answeredCount?: number;
    occurredAt: string;
}

@Injectable()
export class BotEventsService {
    constructor(
        @Inject(DB) private readonly db: Db,
        @Inject(CLOCK) private readonly clock: Clock,
        @Inject(IdentityService) private readonly identities: IdentityService,
        @Inject(StreakService) private readonly streaks: StreakService
    ) {}

    private identity(provider: 'telegram' | 'whatsapp', providerUserId: string): ProvenIdentity {
        return {
            provider,
            providerUserId,
            display:
                provider === 'whatsapp'
                    ? IdentityService.maskPhone(providerUserId)
                    : 'Telegram account',
            displayName: 'Student',
        };
    }

    async record(e: BotEventInput) {
        const now = this.clock.now();
        let occurredAt = new Date(e.occurredAt);
        if (occurredAt > now) occurredAt = now;
        if (now.getTime() - occurredAt.getTime() > OFFLINE_LIMIT_MS) {
            throw AppError.unprocessable(
                'event_too_old',
                'Events count for up to 48 hours after they happen.'
            );
        }

        return this.db.transaction(async (q) => {
            const { accountId } = await this.identities.findOrCreate(
                q,
                this.identity(e.provider, e.providerUserId)
            );
            const inserted = await q.query(
                `insert into bot_events (event_id, account_id, provider, type, occurred_at) values ($1, $2, $3, $4, $5)
         on conflict (event_id) do nothing returning event_id`,
                [e.eventId, accountId, e.provider, e.type, occurredAt]
            );
            const accepted = inserted.length > 0;
            let justEarned = false;
            let current = 0;
            if (accepted) {
                const finished =
                    e.type === 'prep_session_finished' &&
                    (e.questionCount ?? 0) >= 2 &&
                    e.answeredCount === e.questionCount;
                if (e.type !== 'prep_session_finished' || finished) {
                    const effect = await this.streaks.recordEvent(q, accountId, {
                        kind: e.type === 'prep_session_finished' ? 'session_finished' : e.type,
                        source: e.provider,
                        occurredAt,
                        eventId: e.eventId,
                        questionCount: e.questionCount,
                        answeredCount: e.answeredCount,
                    });
                    justEarned = effect.justEarned;
                    current = effect.streak;
                }
            }
            const replay = await this.streaks.refresh(q, accountId);
            const rewarded =
                justEarned &&
                current > 0 &&
                current % REWARD_EVERY === 0 &&
                replay.rewardDays.includes(lagosDate(occurredAt));
            return {
                accepted,
                streak: this.streaks.summaryFrom(replay),
                ...(rewarded ? { streakReward: { tokens: REWARD_TOKENS } } : {}),
            };
        });
    }

    async streak(provider: 'telegram' | 'whatsapp', providerUserId: string) {
        const accountId = await this.identities.ownerOf(this.db, provider, providerUserId);
        if (!accountId) throw AppError.notFound('No account for this chat yet.');
        return this.streaks.summary(accountId);
    }
}
