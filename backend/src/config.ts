export interface Config {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  codePepper: string;
  mailDriver: 'console' | 'resend';
  resendApiKey: string | null;
  mailFrom: string | null;
  webOrigin: string;
  cookieSecure: boolean;
  internalApiSecret: string;
  telegramBotUsername: string | null;
  whatsappBusinessNumber: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const production = nodeEnv === 'production';

  const need = (name: string, devDefault: string): string => {
    const value = env[name];
    if (value) return value;
    if (production) throw new Error(`Missing required environment variable: ${name}`);
    return devDefault;
  };

  const mailDriver = env.MAIL_DRIVER === 'resend' ? 'resend' : 'console';
  if (production && mailDriver !== 'resend') throw new Error('MAIL_DRIVER must be resend in production');
  if (mailDriver === 'resend' && (!env.RESEND_API_KEY || !env.MAIL_FROM)) {
    throw new Error('MAIL_DRIVER=resend needs RESEND_API_KEY and MAIL_FROM');
  }

  return {
    nodeEnv,
    port: Number(env.PORT ?? 3000),
    databaseUrl: need('DATABASE_URL', 'postgresql://postgres:password@localhost:5432/postgres'),
    jwtSecret: need('JWT_SECRET', 'dev-only-jwt-secret-not-for-production-use'),
    codePepper: need('CODE_PEPPER', 'dev-only-code-pepper-not-for-production-use'),
    mailDriver,
    resendApiKey: env.RESEND_API_KEY || null,
    mailFrom: env.MAIL_FROM || null,
    webOrigin: env.WEB_ORIGIN ?? 'http://localhost:5180',
    cookieSecure: production,
    internalApiSecret: need('INTERNAL_API_SECRET', 'dev-only-internal-secret-not-for-production-use'),
    telegramBotUsername: env.TELEGRAM_BOT_USERNAME || null,
    whatsappBusinessNumber: env.WHATSAPP_BUSINESS_NUMBER?.replace(/[^0-9]/g, '') || null,
  };
}

export const CONFIG = Symbol('CONFIG');
