import { AppError } from '../common/app-error.js';
import { Logger } from '@nestjs/common';

export interface Mailer {
    sendSignInCode(to: string, code: string): Promise<void>;
    sendStudentCode(to: string, code: string): Promise<void>;
}

export const MAILER = Symbol('MAILER');

export class DisabledMailer implements Mailer {
    async sendSignInCode(): Promise<void> {
        throw AppError.unavailable(
            'channel_unavailable',
            'Email sign-in is not available. Use WhatsApp, Google or Telegram.'
        );
    }

    async sendStudentCode(): Promise<void> {
        throw AppError.unavailable(
            'channel_unavailable',
            'School email checks are not available yet.'
        );
    }
}

export class ConsoleMailer implements Mailer {
    private readonly logger = new Logger('Mailer');

    async sendSignInCode(to: string, code: string): Promise<void> {
        this.logger.log(`Sign-in code for ${to}: ${code}`);
    }

    async sendStudentCode(to: string, code: string): Promise<void> {
        this.logger.log(`Student code for ${to}: ${code}`);
    }
}

export class ResendMailer implements Mailer {
    constructor(
        private readonly apiKey: string,
        private readonly from: string,
        private readonly fetchImpl: typeof fetch = fetch
    ) {}

    private async send(to: string, subject: string, text: string): Promise<void> {
        const res = await this.fetchImpl('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: this.from, to: [to], subject, text }),
        });
        if (!res.ok) throw new Error(`Resend answered ${res.status}`);
    }

    async sendSignInCode(to: string, code: string): Promise<void> {
        await this.send(
            to,
            `${code} is your Florence code`,
            `Your Florence sign-in code is ${code}. It expires in 10 minutes. If you did not ask for it, ignore this email.`
        );
    }

    async sendStudentCode(to: string, code: string): Promise<void> {
        await this.send(
            to,
            `${code} confirms your school email on Florence`,
            `Enter ${code} in Florence to confirm this is your school email. It expires in 10 minutes. If you did not ask for it, ignore this email.`
        );
    }
}
