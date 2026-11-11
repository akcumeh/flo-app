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
