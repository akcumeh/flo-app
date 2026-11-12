import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { DB, type Db, type Queryable } from '../db/db.js';
import { JobsService } from '../jobs/jobs.service.js';
import { STORAGE, type ObjectStorage } from '../storage/storage.js';
import { TokensService } from '../tokens/tokens.service.js';
import { NotificationsService } from './notifications.service.js';

export const EXPORT_JOB = 'export_account';
export const DELETION_GRACE_DAYS = 7;
const EXPORT_LINK_SECONDS = 7 * 24 * 60 * 60;

const EXPORT_QUERIES: Record<string, string> = {
    account:
        'select id, display_name, username, timezone, token_balance, created_at from accounts where id = $1',
    identities: 'select provider, display, verified_at from identities where account_id = $1',
    profile: 'select * from profiles where account_id = $1',
    courses: `select c.code_display, c.title, e.exam_date, e.created_at from enrolments e join courses c on c.id = e.course_id where e.account_id = $1`,
    files: 'select id, name, mime_type, size_bytes, kind, status, page_count, created_at from stored_files where account_id = $1 and deleted_at is null',
    conversations:
        'select id, title, mode, created_at, last_message_at from conversations where account_id = $1 and deleted_at is null',
    messages: `select m.conversation_id, m.role, m.content, m.citations, m.created_at from messages m
               join conversations c on c.id = m.conversation_id where c.account_id = $1 and c.deleted_at is null order by m.created_at`,
    sessions:
        'select id, mode, status, requested_count, created_at, completed_at from study_sessions where account_id = $1',
    answers:
        'select session_id, item_idx, answer, result, awarded_marks, answered_at from session_answers where account_id = $1',
    results:
        'select session_id, mode, score, total, created_at from session_results where account_id = $1',
    studyDays: 'select day, reason from study_days where account_id = $1 order by day',
    ledger: 'select delta, reason, balance_after, created_at from token_ledger where account_id = $1 order by id',
    purchases:
        'select reference, amount_kobo, tokens, status, created_at from purchases where account_id = $1',
    notificationPreferences: 'select * from notification_preferences where account_id = $1',
};

@Injectable()
export class AccountLifecycleService implements OnModuleInit {
    private readonly logger = new Logger('AccountLifecycle');

    constructor(
        @Inject(DB) private readonly db: Db,
        @Inject(STORAGE) private readonly storage: ObjectStorage,
        @Inject(TokensService) private readonly tokens: TokensService,
        @Inject(NotificationsService) private readonly notifications: NotificationsService,
        @Inject(JobsService) private readonly jobs: JobsService
    ) {}

    onModuleInit() {
        this.jobs.register(EXPORT_JOB, {
            run: (payload) => this.buildExport(String(payload.exportId)),
            failed: async (payload) => {
                await this.db.query(`update data_exports set status = 'failed' where id = $1`, [
                    String(payload.exportId),
                ]);
            },
        });
    }

    async requestExport(accountId: string) {
        const recent = await this.db.query(
            `select 1 from data_exports where account_id = $1 and status in ('queued', 'ready') and requested_at > now() - interval '1 day'`,
            [accountId]
        );
        if (recent.length > 0) throw AppError.rateLimited(24 * 3600);
        await this.db.transaction(async (q) => {
            const [row] = await q.query<{ id: string }>(
                'insert into data_exports (account_id) values ($1) returning id',
                [accountId]
            );
            await q.query('insert into jobs (kind, payload) values ($1, $2)', [
                EXPORT_JOB,
                JSON.stringify({ exportId: row.id }),
            ]);
        });
    }

    async buildExport(exportId: string) {
        const [job] = await this.db.query<{ account_id: string; status: string }>(
            'select account_id, status from data_exports where id = $1',
            [exportId]
        );
        if (!job || job.status !== 'queued') return;
        const data: Record<string, unknown> = {
            exportedAt: new Date().toISOString(),
            format: 'florence-export-1',
        };
        for (const [key, sql] of Object.entries(EXPORT_QUERIES))
            data[key] = await this.db.query(sql, [job.account_id]);
        const path = `exports/${job.account_id}/${exportId}.json`;
        await this.storage.put(
            path,
            Buffer.from(JSON.stringify(data, null, 2)),
            'application/json'
        );
        await this.db.query(
            `update data_exports set status = 'ready', storage_path = $2, ready_at = now(), expires_at = now() + make_interval(secs => $3) where id = $1`,
            [exportId, path, EXPORT_LINK_SECONDS]
        );
        const url = await this.storage.signedUrl(path, EXPORT_LINK_SECONDS);
        await this.notifications
            .notify(job.account_id, {
                title: 'Florence',
                body: 'Your Florence data is ready to download. The link works for 7 days.',
                url,
            })
            .catch((error) =>
                this.logger.warn(`Export notice failed: ${(error as Error).message}`)
            );
    }

    async requestDeletion(accountId: string) {
        const [row] = await this.db.query<{ deletes_at: Date }>(
            `insert into account_deletions (account_id, deletes_at) values ($1, now() + make_interval(days => $2))
       on conflict (account_id) do update
         set requested_at = case when account_deletions.cancelled_at is null then account_deletions.requested_at else now() end,
             deletes_at = case when account_deletions.cancelled_at is null then account_deletions.deletes_at else excluded.deletes_at end,
             cancelled_at = null
       where account_deletions.completed_at is null
       returning deletes_at`,
            [accountId, DELETION_GRACE_DAYS]
        );
        if (!row) throw AppError.notFound('No such account.');
        return { deletesAt: new Date(row.deletes_at).toISOString() };
    }

    static async cancelDeletion(q: Queryable, accountId: string) {
        await q.query(
            `update account_deletions set cancelled_at = now() where account_id = $1 and cancelled_at is null and completed_at is null`,
            [accountId]
        );
    }

    async purgeDue(): Promise<number> {
        const due = await this.db.query<{ account_id: string }>(
            `select account_id from account_deletions where deletes_at <= now() and cancelled_at is null and completed_at is null limit 50`
        );
        for (const d of due) await this.purge(d.account_id);
        return due.length;
    }

    async purge(accountId: string) {
        const paths = await this.db.query<{ path: string }>(
            `select p.storage_path as path from file_parts p join stored_files f on f.id = p.file_id where f.account_id = $1
       union all select storage_path from data_exports where account_id = $1 and storage_path is not null`,
            [accountId]
        );
        await this.storage
            .delete(paths.map((p) => p.path))
            .catch((error) => this.logger.warn(`Storage purge: ${(error as Error).message}`));

        await this.db.transaction(async (q) => {
            const a = [accountId];
            await q.query('delete from saved_answers where account_id = $1', a);
            await q.query(
                'delete from messages where conversation_id in (select id from conversations where account_id = $1)',
                a
            );
            await q.query(
                'update study_sessions set conversation_id = null where account_id = $1',
                a
            );
            await q.query('delete from conversations where account_id = $1', a);
            await q.query('delete from requests where account_id = $1', a);
            await q.query('delete from study_sessions where account_id = $1', a);
            for (const table of [
                'study_events',
                'study_days',
                'streaks',
                'streak_freezes',
                'streak_imports',
                'leaderboard_optins',
                'weekly_scores',
                'wrapped_cache',
                'file_chunks',
                'stored_files',
                'enrolments',
                'profiles',
                'student_verifications',
                'push_subscriptions',
                'notification_preferences',
                'referral_codes',
                'data_exports',
                'bot_events',
                'auth_sessions',
                'auth_challenges',
                'welcome_grants',
                'identities',
            ]) {
                await q.query(`delete from ${table} where account_id = $1`, a);
            }
            await q.query(
                'delete from referrals where invitee_account_id = $1 or inviter_account_id = $1',
                a
            );
            await q.query(
                'delete from merge_tokens where account_id = $1 or other_account_id = $1',
                a
            );
            await q.query(
                'update guest_sessions set claimed_by = null, claimed_conversation_id = null where claimed_by = $1',
                a
            );
            const balance = await this.tokens.balance(accountId, q);
            if (balance > 0)
                await this.tokens.debit(q, accountId, balance, 'admin_adjust', {
                    idempotencyKey: 'account_deleted',
                });
            await q.query(
                `update accounts set display_name = 'Deleted account', username = null, timezone = null, deleted_at = coalesce(deleted_at, now())
          where id = $1`,
                a
            );
            await q.query(
                'update account_deletions set completed_at = now() where account_id = $1',
                a
            );
        });
    }
}
