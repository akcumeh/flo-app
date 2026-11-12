import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { addDays, daysBetween, lagosDate } from '../common/lagos.js';
import { DB, type Db, type Queryable } from '../db/db.js';
import { StreakService } from './streak.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXAM_WEEK_DAYS = 7;

const percent = (got: number, max: number) => (max > 0 ? Math.round((100 * got) / max) : null);

@Injectable()
export class ProgressService {
    constructor(
        @Inject(DB) private readonly db: Db,
        @Inject(CLOCK) private readonly clock: Clock,
        @Inject(StreakService) private readonly streaks: StreakService
    ) {}

    async topicStats(q: Queryable, accountId: string, courseId: string) {
        return q.query<{ topic: string; got: number; max: number; answered: number }>(
            `select i.topic, sum(a.awarded_marks)::int as got, sum(i.marks)::int as max, count(*)::int as answered
         from session_answers a
         join session_items i on i.session_id = a.session_id and i.round = a.round and i.idx = a.item_idx
         join study_sessions s on s.id = a.session_id
        where a.account_id = $1 and a.round = 1
          and exists (select 1 from stored_files f where f.id = any(s.file_ids) and f.course_id = $2)
        group by i.topic`,
            [accountId, courseId]
        );
    }

    async courseMasteryValue(
        q: Queryable,
        accountId: string,
        courseId: string
    ): Promise<number | null> {
        const stats = await this.topicStats(q, accountId, courseId);
        return percent(
            stats.reduce((n, s) => n + s.got, 0),
            stats.reduce((n, s) => n + s.max, 0)
        );
    }

    async courseMastery(accountId: string, courseId: string) {
        if (!UUID.test(courseId)) throw AppError.notFound('No such course.');
        const [course] = await this.db.query<{
            id: string;
            code_normalised: string;
            title: string | null;
            school_id: string;
        }>(
            `select c.id, c.code_normalised, c.title, c.school_id from enrolments e join courses c on c.id = e.course_id
        where e.account_id = $1 and e.course_id = $2`,
            [accountId, courseId]
        );
        if (!course) throw AppError.notFound('No such course.');
        const stats = await this.topicStats(this.db, accountId, courseId);
        const fileTopics = await this.db.query<{ id: string; name: string }>(
            `select t.id, t.name from file_topics t join stored_files f on f.id = t.file_id
        where f.account_id = $1 and f.course_id = $2 and f.deleted_at is null order by t.name`,
            [accountId, courseId]
        );
        const byName = new Map(stats.map((s) => [s.topic.toLowerCase(), s]));
        const topics = fileTopics.map((t) => {
            const s = byName.get(t.name.toLowerCase());
            byName.delete(t.name.toLowerCase());
            return {
                id: t.id,
                name: t.name,
                mastery: s ? percent(s.got, s.max) : null,
                answered: s?.answered ?? 0,
            };
        });
        for (const s of byName.values()) {
            topics.push({
                id: `topic:${s.topic}`,
                name: s.topic,
                mastery: percent(s.got, s.max),
                answered: s.answered,
            });
        }
        return {
            course: {
                id: course.id,
                code: course.code_normalised,
                title: course.title,
                schoolId: course.school_id,
            },
            mastery: percent(
                stats.reduce((n, s) => n + s.got, 0),
                stats.reduce((n, s) => n + s.max, 0)
            ),
            topics,
        };
    }

    async overview(accountId: string) {
        const today = lagosDate(this.clock.now());
        const [{ days }] = await this.db.query<{ days: number }>(
            'select count(*)::int as days from study_days where account_id = $1 and day > $2',
            [accountId, addDays(today, -30)]
        );
        const [{ sessions }] = await this.db.query<{ sessions: number }>(
            `select count(*)::int as sessions from study_sessions where account_id = $1 and status = 'completed'`,
            [accountId]
        );
        const [{ got, max }] = await this.db.query<{ got: number | null; max: number | null }>(
            `select sum(a.awarded_marks)::int as got, sum(i.marks)::int as max
         from session_answers a join session_items i on i.session_id = a.session_id and i.round = a.round and i.idx = a.item_idx
        where a.account_id = $1 and a.round = 1`,
            [accountId]
        );
        const courses = await this.db.query<{ id: string; code_normalised: string }>(
            'select c.id, c.code_normalised from enrolments e join courses c on c.id = e.course_id where e.account_id = $1 order by e.created_at',
            [accountId]
        );
        const out = [];
        for (const c of courses) {
            out.push({
                courseId: c.id,
                code: c.code_normalised,
                mastery: await this.courseMasteryValue(this.db, accountId, c.id),
            });
        }
        return {
            studyDaysLast30: days,
            sessions,
            accuracy: percent(got ?? 0, max ?? 0),
            courses: out,
        };
    }

    async home(accountId: string) {
        const now = this.clock.now();
        const today = lagosDate(now);
        const streak = await this.streaks.summary(accountId);
        const [{ files, conversations, sessions }] = await this.db.query<{
            files: number;
            conversations: number;
            sessions: number;
        }>(
            `select (select count(*)::int from stored_files where account_id = $1 and deleted_at is null) as files,
              (select count(*)::int from conversations where account_id = $1 and deleted_at is null) as conversations,
              (select count(*)::int from study_sessions where account_id = $1) as sessions`,
            [accountId]
        );
        const [exam] = await this.db.query<{
            id: string;
            code_normalised: string;
            exam_date: string;
        }>(
            `select c.id, c.code_normalised, coalesce(e.exam_date, p.exam_date)::text as exam_date
         from enrolments e join courses c on c.id = e.course_id
         left join profiles p on p.account_id = e.account_id
        where e.account_id = $1 and coalesce(e.exam_date, p.exam_date) >= $2::date
        order by coalesce(e.exam_date, p.exam_date) limit 1`,
            [accountId, today]
        );
        const [open] = await this.db.query<{
            id: string;
            mode: string;
            answered: number;
            total: number;
        }>(
            `select s.id, s.mode,
              (select count(*)::int from session_answers a where a.session_id = s.id and a.round = 1) as answered,
              (select count(*)::int from session_items i where i.session_id = s.id and i.round = 1) as total
         from study_sessions s
        where s.account_id = $1 and s.status = 'active' and s.expires_at > now()
        order by s.created_at desc limit 1`,
            [accountId]
        );

        const examInfo = exam
            ? {
                  courseId: exam.id,
                  courseCode: exam.code_normalised,
                  date: exam.exam_date,
                  daysLeft: daysBetween(today, exam.exam_date),
              }
            : null;
        let variant: 'today' | 'new_user' | 'chats_no_notes' | 'exam_week' = 'today';
        if (examInfo && examInfo.daysLeft <= EXAM_WEEK_DAYS) variant = 'exam_week';
        else if (files === 0 && conversations === 0 && sessions === 0) variant = 'new_user';
        else if (files === 0 && conversations > 0) variant = 'chats_no_notes';

        return {
            variant,
            streak,
            rank: null,
            wrappedTeaser: { period: today.slice(0, 7), ready: false },
            exam: examInfo,
            resume: open
                ? {
                      sessionId: open.id,
                      mode: open.mode,
                      answered: open.answered,
                      total: open.total,
                  }
                : null,
        };
    }
}
