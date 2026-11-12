import type { Queryable } from '../db/db.js';

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const day = (d: Date | string | null): string | null =>
    d === null ? null : typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);

export async function readSchool(q: Queryable, schoolId: string): Promise<SchoolView | null> {
    if (!UUID.test(schoolId)) return null;
    const rows = await q.query<SchoolView>(
        'select id, name, country, kind from schools where id = $1',
        [schoolId]
    );
    return rows[0] ?? null;
}

export async function readProfile(q: Queryable, accountId: string): Promise<ProfileView> {
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
    if (!p) {
        return {
            school: null,
            department: null,
            level: null,
            examDate: null,
            onboardingComplete: false,
        };
    }
    return {
        school: p.school_id ? await readSchool(q, p.school_id) : null,
        department: p.department_id
            ? { id: p.department_id, name: p.department_name as string }
            : null,
        level: p.level,
        examDate: day(p.exam_date),
        onboardingComplete: p.onboarding_complete,
    };
}
