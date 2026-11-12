import { Inject, Injectable } from '@nestjs/common';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { MAILER, type Mailer } from '../auth/mailer.js';
import { AppError } from '../common/app-error.js';
import { hmac } from '../common/crypto.js';
import { CONFIG, type Config } from '../config.js';
import { DB, type Db, type Queryable } from '../db/db.js';
import { TokensService } from '../tokens/tokens.service.js';
import { studentStatus, type StudentView } from './accounts.service.js';

const STUDENT_BONUS = 10;
const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MAX_SENDS_PER_ADDRESS_PER_HOUR = 3;
const MAX_SENDS_PER_IP_PER_HOUR = 10;

const DISPOSABLE_DOMAINS = new Set([
    '10minutemail.com',
    'dispostable.com',
    'emailondeck.com',
    'fakeinbox.com',
    'getnada.com',
    'guerrillamail.com',
    'mailinator.com',
    'maildrop.cc',
    'mintemail.com',
    'sharklasers.com',
    'tempmail.com',
    'temp-mail.org',
    'throwawaymail.com',
    'trashmail.com',
    'yopmail.com',
]);

export type VerificationMethod = 'email_code' | 'google_hd';

@Injectable()
export class StudentService {
    constructor(
        @Inject(DB) private readonly db: Db,
        @Inject(CONFIG) private readonly config: Config,
        @Inject(MAILER) private readonly mailer: Mailer,
        @Inject(TokensService) private readonly tokens: TokensService
    ) {}

    static canonical(email: string): string {
        const [local, domain] = email.trim().toLowerCase().split('@');
        return `${local.split('+')[0]}@${domain}`;
    }

    private hashCode(email: string, code: string): string {
        return hmac(this.config.codePepper, `student:${email}:${code}`);
    }

    async schoolFor(q: Queryable, domain: string): Promise<{ id: string; name: string } | null> {
        const parts = domain.toLowerCase().split('.');
        const candidates = parts
            .map((_, i) => parts.slice(i).join('.'))
            .filter((d) => d.includes('.'));
        const rows = await q.query<{ id: string; name: string }>(
            `select s.id, s.name from school_domains d join schools s on s.id = d.school_id
        where d.domain = any($1::text[]) order by length(d.domain) desc limit 1`,
            [candidates]
        );
        return rows[0] ?? null;
    }

    private async ownerOf(q: Queryable, email: string): Promise<string | null> {
        const rows = await q.query<{ account_id: string }>(
            'select account_id from student_verifications where school_email_canonical = $1',
            [email]
        );
        return rows[0]?.account_id ?? null;
    }

    async start(accountId: string, rawEmail: string, ip: string): Promise<void> {
        const email = StudentService.canonical(rawEmail);
        const domain = email.split('@')[1];
        if (DISPOSABLE_DOMAINS.has(domain)) {
            throw AppError.unprocessable(
                'disposable_email',
                'Use the email address your school gave you.'
            );
        }

        const school = await this.schoolFor(this.db, domain);
        if (!school) {
            await this.db.query(
                `insert into domain_reviews (domain) values ($1)
         on conflict (domain) do update set requests = domain_reviews.requests + 1, last_seen_at = now()`,
                [domain]
            );
            throw AppError.unprocessable(
                'unknown_institution',
                'We do not know this school email domain yet. It has been sent for review.'
            );
        }

        const owner = await this.ownerOf(this.db, email);
        if (owner && owner !== accountId) {
            throw AppError.unprocessable(
                'email_in_use',
                'This school email is already verified on another account.'
            );
        }

        const ipHash = hmac(this.config.codePepper, `ip:${ip}`);
        const [{ perAddress, perIp }] = await this.db.query<{ perAddress: number; perIp: number }>(
            `select count(*) filter (where email_canonical = $1)::int as "perAddress",
              count(*) filter (where ip_hash = $2)::int as "perIp"
         from email_codes
        where purpose = 'student' and created_at > now() - interval '1 hour'
          and (email_canonical = $1 or ip_hash = $2)`,
            [email, ipHash]
        );
        if (perAddress >= MAX_SENDS_PER_ADDRESS_PER_HOUR || perIp >= MAX_SENDS_PER_IP_PER_HOUR) {
            throw AppError.rateLimited(3600);
        }

        const code = String(randomInt(100000, 1000000));
        await this.db.query(
            `insert into email_codes (email_canonical, purpose, code_hash, ip_hash, expires_at)
       values ($1, 'student', $2, $3, now() + make_interval(mins => $4))`,
            [email, this.hashCode(email, code), ipHash, CODE_TTL_MINUTES]
        );
        await this.mailer.sendStudentCode(email, code);
    }

    async confirm(accountId: string, rawEmail: string, code: string): Promise<StudentView> {
        const email = StudentService.canonical(rawEmail);
        const rows = await this.db.query<{ id: string; code_hash: string; attempts: number }>(
            `select id, code_hash, attempts from email_codes
        where email_canonical = $1 and purpose = 'student' and consumed_at is null and expires_at > now()
        order by created_at desc limit 1`,
            [email]
        );
        if (rows.length === 0)
            throw AppError.badRequest('invalid_code', 'That code is wrong or has expired.');
        const row = rows[0];
        if (row.attempts >= MAX_ATTEMPTS)
            throw AppError.badRequest('code_locked', 'Too many wrong tries. Ask for a new code.');

        const expected = Buffer.from(row.code_hash, 'hex');
        const actual = Buffer.from(this.hashCode(email, code), 'hex');
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
            await this.db.query('update email_codes set attempts = attempts + 1 where id = $1', [
                row.id,
            ]);
            throw AppError.badRequest('invalid_code', 'That code is wrong or has expired.');
        }

        return this.db.transaction(async (q) => {
            const consumed = await q.query(
                'update email_codes set consumed_at = now() where id = $1 and consumed_at is null returning id',
                [row.id]
            );
            if (consumed.length === 0)
                throw AppError.badRequest('invalid_code', 'That code is wrong or has expired.');

            const school = await this.schoolFor(q, email.split('@')[1]);
            if (!school)
                throw AppError.badRequest(
                    'unknown_institution',
                    'We do not know this school email domain yet.'
                );
            const granted = await this.grant(q, accountId, email, school.id, 'email_code');
            if (!granted) {
                throw AppError.badRequest(
                    'email_in_use',
                    'This school email is already verified on another account.'
                );
            }
            return studentStatus(q, accountId);
        });
    }

    async grant(
        q: Queryable,
        accountId: string,
        email: string,
        schoolId: string,
        method: VerificationMethod
    ): Promise<boolean> {
        const rows = await q.query<{ id: string; bonus_granted_at: Date | null }>(
            `insert into student_verifications (account_id, school_email_canonical, school_id, method, verified_at, expires_at)
       values ($1, $2, $3, $4, now(), now() + interval '1 year')
       on conflict (school_email_canonical) do update
          set school_id = excluded.school_id, method = excluded.method,
              verified_at = now(), expires_at = now() + interval '1 year'
        where student_verifications.account_id = excluded.account_id
       returning id, bonus_granted_at`,
            [accountId, email, schoolId, method]
        );
        if (rows.length === 0) return false;

        if (!rows[0].bonus_granted_at) {
            await this.tokens.credit(q, accountId, STUDENT_BONUS, 'student_bonus', {
                idempotencyKey: 'student_bonus',
                refType: 'student_verification',
                refId: rows[0].id,
            });
            await q.query(
                'update student_verifications set bonus_granted_at = now() where id = $1',
                [rows[0].id]
            );
        }
        return true;
    }
}
