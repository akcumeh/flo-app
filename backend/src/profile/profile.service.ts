import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { DB, type Db, type Queryable } from '../db/db.js';
import { FilesService, type StoredFileView } from '../files/files.service.js';
import { ReferralsService } from '../platform/referrals.service.js';
import { ProgressService } from '../study/progress.service.js';

export interface SchoolView {
    id: string;
    name: string;
    country: string;
    kind: 'university' | 'polytechnic' | 'college_of_education' | 'other';
}

export interface ProfileView {
    school: SchoolView | null;
    department: { id: string; name: string } | null;
    level: number | null;
    examDate: string | null;
    onboardingComplete: boolean;
}

export interface CourseView {
    id: string;
    code: string;
    title: string | null;
    schoolId: string;
}

export interface ProfileUpdate {
    schoolId?: string;
    departmentId?: string;
    departmentName?: string;
    level?: number;
    examDate?: string | null;
    referralCode?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COURSE_CODE = /^[A-Z0-9]{2,12}$/;

const day = (d: Date | string | null): string | null =>
    d === null ? null : typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);

export function normaliseCourseCode(code: string): string {
    return code.toUpperCase().replace(/[\s\-_.]/g, '');
}

@Injectable()
export class ProfileService {
    constructor(
        @Inject(DB) private readonly db: Db,
        @Inject(FilesService) private readonly files: FilesService,
        @Inject(ProgressService) private readonly progress: ProgressService,
        @Inject(ReferralsService) private readonly referrals: ReferralsService
    ) {}

    async searchSchools(q: string | undefined, limit: number): Promise<SchoolView[]> {
        const term = q?.trim().toLowerCase() ?? '';
        return this.db.query<SchoolView>(
            `select id, name, country, kind from schools
        where $1 = '' or lower(name) like '%' || $1 || '%' or lower(coalesce(short_name, '')) like $1 || '%'
        order by (lower(coalesce(short_name, '')) = $1) desc, (lower(name) like $1 || '%') desc, name
        limit $2`,
            [term, limit]
        );
    }

    private async school(q: Queryable, schoolId: string): Promise<SchoolView | null> {
        if (!UUID.test(schoolId)) return null;
        const rows = await q.query<SchoolView>(
            'select id, name, country, kind from schools where id = $1',
            [schoolId]
        );
        return rows[0] ?? null;
    }

    async departments(schoolId: string): Promise<Array<{ id: string; name: string }>> {
        if (!(await this.school(this.db, schoolId))) throw AppError.notFound('No such school.');
        return this.db.query(
            'select id, name from departments where school_id = $1 order by name',
            [schoolId]
        );
    }

    async profile(accountId: string, q: Queryable = this.db): Promise<ProfileView> {
        const rows = await q.query<{
            school_id: string | null;
            department_id: string | null;
            department_name: string | null;
            level: number | null;
            exam_date: Date | string | null;
            onboarding_complete: boolean;
        }>(
            `select p.school_id, p.department_id, d.name as department_name, p.level, p.exam_date, p.onboarding_complete
         from profiles p left join departments d on d.id = p.department_id
        where p.account_id = $1`,
            [accountId]
        );
        const p = rows[0];
        if (!p)
            return {
                school: null,
                department: null,
                level: null,
                examDate: null,
                onboardingComplete: false,
            };
        return {
            school: p.school_id ? await this.school(q, p.school_id) : null,
            department: p.department_id
                ? { id: p.department_id, name: p.department_name as string }
                : null,
            level: p.level,
            examDate: day(p.exam_date),
            onboardingComplete: p.onboarding_complete,
        };
    }

    async update(accountId: string, input: ProfileUpdate): Promise<ProfileView> {
        return this.db.transaction(async (q) => {
            await q.query('insert into profiles (account_id) values ($1) on conflict do nothing', [
                accountId,
            ]);
            if (input.referralCode) await this.referrals.redeem(q, accountId, input.referralCode);
            const [current] = await q.query<{
                school_id: string | null;
                department_id: string | null;
            }>('select school_id, department_id from profiles where account_id = $1 for update', [
                accountId,
            ]);

            let schoolId = current.school_id;
            let departmentId = current.department_id;
            if (input.schoolId !== undefined && input.schoolId !== schoolId) {
                if (!(await this.school(q, input.schoolId)))
                    throw AppError.notFound('No such school.');
                schoolId = input.schoolId;
                departmentId = null;
            }

            if (input.departmentId !== undefined || input.departmentName !== undefined) {
                if (!schoolId)
                    throw AppError.unprocessable('school_required', 'Choose your school first.');
                if (input.departmentId !== undefined) {
                    const ok = UUID.test(input.departmentId)
                        ? await q.query(
                              'select 1 from departments where id = $1 and school_id = $2',
                              [input.departmentId, schoolId]
                          )
                        : [];
                    if (ok.length === 0)
                        throw AppError.unprocessable(
                            'unknown_department',
                            'That department is not in your school.'
                        );
                    departmentId = input.departmentId;
                } else {
                    const name = (input.departmentName as string).trim().replace(/\s+/g, ' ');
                    if (name.length < 2)
                        throw AppError.unprocessable(
                            'unknown_department',
                            'Type the name of your department.'
                        );
                    const [row] = await q.query<{ id: string }>(
                        `insert into departments (school_id, name) values ($1, $2)
             on conflict (school_id, name) do update set name = excluded.name returning id`,
                        [schoolId, name]
                    );
                    departmentId = row.id;
                }
            }

            const sets = ['school_id = $2', 'department_id = $3'];
            const params: unknown[] = [accountId, schoolId, departmentId];
            if (input.level !== undefined) {
                params.push(input.level);
                sets.push(`level = $${params.length}`);
            }
            if (input.examDate !== undefined) {
                params.push(input.examDate);
                sets.push(`exam_date = $${params.length}`);
            }
            await q.query(`update profiles set ${sets.join(', ')} where account_id = $1`, params);
            await q.query(
                `update profiles set onboarding_complete = (school_id is not null and department_id is not null and level is not null)
          where account_id = $1`,
                [accountId]
            );
            return this.profile(accountId, q);
        });
    }

    private static course(r: {
        id: string;
        code_normalised: string;
        title: string | null;
        school_id: string;
    }): CourseView {
        return { id: r.id, code: r.code_normalised, title: r.title, schoolId: r.school_id };
    }

    async listCourses(accountId: string) {
        const rows = await this.db.query<{
            id: string;
            code_normalised: string;
            title: string | null;
            school_id: string;
            file_count: number;
        }>(
            `select c.id, c.code_normalised, c.title, c.school_id,
              (select count(*)::int from stored_files f
                where f.account_id = $1 and f.course_id = c.id and f.deleted_at is null) as file_count
         from enrolments e join courses c on c.id = e.course_id
        where e.account_id = $1
        order by e.created_at`,
            [accountId]
        );
        const out = [];
        for (const r of rows) {
            out.push({
                course: ProfileService.course(r),
                fileCount: r.file_count,
                mastery: await this.progress.courseMasteryValue(this.db, accountId, r.id),
            });
        }
        return out;
    }

    async enrol(accountId: string, rawCode: string, title?: string) {
        const code = normaliseCourseCode(rawCode);
        if (!COURSE_CODE.test(code)) {
            throw AppError.unprocessable(
                'invalid_course_code',
                'Use the course code from your timetable, like BIO 102.'
            );
        }
        return this.db.transaction(async (q) => {
            const [profile] = await q.query<{ school_id: string | null }>(
                'select school_id from profiles where account_id = $1',
                [accountId]
            );
            if (!profile?.school_id)
                throw AppError.unprocessable('school_required', 'Choose your school first.');

            const [course] = await q.query<{
                id: string;
                code_normalised: string;
                title: string | null;
                school_id: string;
            }>(
                `insert into courses (school_id, code_normalised, code_display, title, created_by)
         values ($1, $2, $3, $4, $5)
         on conflict (school_id, code_normalised) do update set title = coalesce(courses.title, excluded.title)
         returning id, code_normalised, title, school_id`,
                [
                    profile.school_id,
                    code,
                    rawCode.trim().toUpperCase(),
                    title?.trim() || null,
                    accountId,
                ]
            );
            const enrolled = await q.query(
                'insert into enrolments (account_id, course_id) values ($1, $2) on conflict do nothing returning course_id',
                [accountId, course.id]
            );
            if (enrolled.length === 0)
                throw AppError.conflict(
                    'already_enrolled',
                    'This course is already on your profile.'
                );
            return { course: ProfileService.course(course), fileCount: 0, mastery: null };
        });
    }

    async course(accountId: string, courseId: string) {
        if (!UUID.test(courseId)) throw AppError.notFound('No such course.');
        const [row] = await this.db.query<{
            id: string;
            code_normalised: string;
            title: string | null;
            school_id: string;
            exam_date: Date | string | null;
        }>(
            `select c.id, c.code_normalised, c.title, c.school_id, coalesce(e.exam_date, p.exam_date) as exam_date
         from enrolments e join courses c on c.id = e.course_id
         left join profiles p on p.account_id = e.account_id
        where e.account_id = $1 and e.course_id = $2`,
            [accountId, courseId]
        );
        if (!row) throw AppError.notFound('No such course.');
        const files: StoredFileView[] = await this.files.list(accountId, courseId);
        const { topics } = await this.progress.courseMastery(accountId, courseId);
        return { course: ProfileService.course(row), files, topics, examDate: day(row.exam_date) };
    }

    async leave(accountId: string, courseId: string): Promise<void> {
        if (!UUID.test(courseId)) throw AppError.notFound('No such course.');
        const rows = await this.db.query(
            'delete from enrolments where account_id = $1 and course_id = $2 returning course_id',
            [accountId, courseId]
        );
        if (rows.length === 0) throw AppError.notFound('No such course.');
    }
}
