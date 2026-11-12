import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { lagosDate } from '../common/lagos.js';
import { DB, type Db } from '../db/db.js';
import { StreakService } from '../study/streak.service.js';
import { MESSENGER, type BotMessenger } from './messenger.js';
import { PUSH, type PushSender } from './push.js';

export interface Preferences {
    channel: 'web_push' | 'telegram' | 'whatsapp' | 'none';
    dailyReminder: boolean;
    reminderLocalTime: string;
    streakNudges: boolean;
    leaderboardUpdates?: boolean;
    weeklyResults?: boolean;
}

interface PrefRow {
    channel: Preferences['channel'];
    daily_reminder: boolean;
    reminder_local_time: string;
    streak_nudges: boolean;
    leaderboard_updates: boolean;
    weekly_results: boolean;
}

const LATEST_REMINDER = '22:00';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function lagosTime(at: Date): string {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Africa/Lagos',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).format(at);
}

@Injectable()
export class NotificationsService {
    private readonly logger = new Logger('Notifications');

    constructor(
        @Inject(DB) private readonly db: Db,
        @Inject(CLOCK) private readonly clock: Clock,
        @Inject(PUSH) private readonly push: PushSender,
        @Inject(MESSENGER) private readonly messenger: BotMessenger,
        @Inject(StreakService) private readonly streaks: StreakService
    ) {}

    vapidKey() {
        return { publicKey: this.push.publicKey };
    }

    private view(r: PrefRow): Preferences {
        return {
            channel: r.channel,
            dailyReminder: r.daily_reminder,
            reminderLocalTime: r.reminder_local_time.slice(0, 5),
            streakNudges: r.streak_nudges,
            leaderboardUpdates: r.leaderboard_updates,
            weeklyResults: r.weekly_results,
        };
    }

    private async ensure(accountId: string) {
        await this.db.query(
            'insert into notification_preferences (account_id) values ($1) on conflict do nothing',
            [accountId]
        );
    }

    async get(accountId: string): Promise<Preferences> {
        await this.ensure(accountId);
        const [r] = await this.db.query<PrefRow>(
            `select channel, daily_reminder, reminder_local_time::text as reminder_local_time, streak_nudges, leaderboard_updates, weekly_results
         from notification_preferences where account_id = $1`,
            [accountId]
        );
        return this.view(r);
    }

    async set(accountId: string, p: Preferences): Promise<Preferences> {
        if (p.channel === 'telegram' || p.channel === 'whatsapp') {
            const linked = await this.db.query(
                'select 1 from identities where account_id = $1 and provider = $2',
                [accountId, p.channel]
            );
            if (linked.length === 0) {
                throw AppError.unprocessable(
                    'channel_not_linked',
                    `Link your ${p.channel === 'telegram' ? 'Telegram' : 'WhatsApp'} account first.`
                );
            }
        }
        await this.ensure(accountId);
        await this.db.query(
            `update notification_preferences
          set channel = $2, daily_reminder = $3, reminder_local_time = $4, streak_nudges = $5,
              leaderboard_updates = coalesce($6, leaderboard_updates), weekly_results = coalesce($7, weekly_results)
        where account_id = $1`,
            [
                accountId,
                p.channel,
                p.dailyReminder,
                p.reminderLocalTime,
                p.streakNudges,
                p.leaderboardUpdates ?? null,
                p.weeklyResults ?? null,
            ]
        );
        return this.get(accountId);
    }

    async subscribe(
        accountId: string,
        body: { endpoint: string; keys: { p256dh: string; auth: string } },
        userAgent: string | null
    ) {
        if (!/^https:\/\//.test(body.endpoint))
            throw AppError.unprocessable('invalid_subscription', 'Push endpoints must use https.');
        await this.ensure(accountId);
        const [row] = await this.db.query<{ id: string }>(
            `insert into push_subscriptions (account_id, endpoint, p256dh, auth, user_agent) values ($1, $2, $3, $4, $5)
       on conflict (endpoint) do update set account_id = excluded.account_id, p256dh = excluded.p256dh, auth = excluded.auth,
         user_agent = excluded.user_agent, failure_count = 0
       returning id`,
            [accountId, body.endpoint, body.keys.p256dh, body.keys.auth, userAgent]
        );
        return { id: row.id };
    }

    async unsubscribe(accountId: string, id: string) {
        if (!UUID.test(id)) throw AppError.notFound('No such subscription.');
        const rows = await this.db.query(
            'delete from push_subscriptions where id = $1 and account_id = $2 returning id',
            [id, accountId]
        );
        if (rows.length === 0) throw AppError.notFound('No such subscription.');
    }

    private async viaPush(accountId: string, payload: Record<string, unknown>): Promise<boolean> {
        const subs = await this.db.query<{
            id: string;
            endpoint: string;
            p256dh: string;
            auth: string;
        }>('select id, endpoint, p256dh, auth from push_subscriptions where account_id = $1', [
            accountId,
        ]);
        let delivered = false;
        for (const s of subs) {
            const outcome = await this.push.send(s, payload);
            if (outcome === 'sent') {
                delivered = true;
                await this.db.query(
                    'update push_subscriptions set last_success_at = now(), failure_count = 0 where id = $1',
                    [s.id]
                );
            } else if (outcome === 'gone') {
                await this.db.query('delete from push_subscriptions where id = $1', [s.id]);
            } else {
                await this.db.query(
                    'update push_subscriptions set failure_count = failure_count + 1 where id = $1',
                    [s.id]
                );
            }
        }
        return delivered;
    }

    private async viaBot(
        accountId: string,
        text: string,
        prefer?: 'telegram' | 'whatsapp'
    ): Promise<boolean> {
        const ids = await this.db.query<{
            provider: 'telegram' | 'whatsapp';
            provider_user_id: string;
        }>(
            `select provider, provider_user_id from identities where account_id = $1 and provider in ('telegram', 'whatsapp')
        order by (provider = $2) desc, created_at`,
            [accountId, prefer ?? 'telegram']
        );
        for (const i of ids) {
            if (await this.messenger.send(i.provider, i.provider_user_id, text)) return true;
        }
        return false;
    }

    async notify(
        accountId: string,
        message: { title: string; body: string; url: string },
        channel?: Preferences['channel']
    ): Promise<boolean> {
        const text = `${message.body}\n${message.url}`;
        if (channel === 'telegram' || channel === 'whatsapp') {
            return (
                (await this.viaBot(accountId, text, channel)) || this.viaPush(accountId, message)
            );
        }
        return (await this.viaPush(accountId, message)) || this.viaBot(accountId, text);
    }

    async sendReminders(appUrl: string): Promise<number> {
        const now = this.clock.now();
        const time = lagosTime(now);
        if (time > LATEST_REMINDER) return 0;
        const today = lagosDate(now);
        const due = await this.db.query<{ account_id: string; channel: Preferences['channel'] }>(
            `select p.account_id, p.channel
         from notification_preferences p
         join accounts a on a.id = p.account_id and a.deleted_at is null
        where p.daily_reminder and p.channel <> 'none'
          and p.reminder_local_time <= $2::time
          and (p.last_reminded_day is null or p.last_reminded_day < $1::date)
          and not exists (select 1 from study_days d where d.account_id = p.account_id and d.day = $1::date)
        limit 500`,
            [today, time]
        );
        let sent = 0;
        for (const d of due) {
            const claimed = await this.db.query(
                `update notification_preferences set last_reminded_day = $2
          where account_id = $1 and (last_reminded_day is null or last_reminded_day < $2::date) returning account_id`,
                [d.account_id, today]
            );
            if (claimed.length === 0) continue;
            const { current } = await this.streaks.summary(d.account_id);
            const body =
                current > 0
                    ? `Day ${current + 1} is waiting. Three quick questions keep it going.`
                    : 'Three quick questions make today a study day.';
            try {
                if (
                    await this.notify(
                        d.account_id,
                        { title: 'Florence', body, url: `${appUrl}/` },
                        d.channel
                    )
                )
                    sent += 1;
            } catch (error) {
                this.logger.warn(
                    `Reminder failed for ${d.account_id}: ${(error as Error).message}`
                );
            }
        }
        return sent;
    }
}
