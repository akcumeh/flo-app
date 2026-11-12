import { Logger } from '@nestjs/common';

export interface Mailer {
  sendSignInCode(to: string, code: string): Promise<void>;
}

export const MAILER = Symbol('MAILER');

export class ConsoleMailer implements Mailer {
  private readonly logger = new Logger('Mailer');

  async sendSignInCode(to: string, code: string): Promise<void> {
    this.logger.log(`Sign-in code for ${to}: ${code}`);
  }
}

export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async sendSignInCode(to: string, code: string): Promise<void> {
    const res = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to: [to],
        subject: `${code} is your Florence code`,
        text: `Your Florence sign-in code is ${code}. It expires in 10 minutes. If you did not ask for it, ignore this email.`,
      }),
    });
    if (!res.ok) throw new Error(`Resend answered ${res.status}`);
  }
}
