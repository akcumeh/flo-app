export interface Config {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  dbPoolMax: number;
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
  telegramBotToken: string | null;
  telegramOidcClientId: string | null;
  telegramOidcClientSecret: string | null;
  googleClientId: string | null;
  anthropicApiKey: string | null;
  aiModel: string;
  publicApiUrl: string;
  storageDir: string;
  supabaseUrl: string | null;
  supabaseServiceKey: string | null;
  storageBucket: string;
  paystackSecretKey: string | null;
  vapidPublicKey: string | null;
  vapidPrivateKey: string | null;
  vapidSubject: string;
  appUrl: string;
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
    dbPoolMax: Math.max(1, Number(env.DB_POOL_MAX) || 10),
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
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || null,
    telegramOidcClientId: env.TELEGRAM_OIDC_CLIENT_ID || null,
    telegramOidcClientSecret: env.TELEGRAM_OIDC_CLIENT_SECRET || null,
    googleClientId: env.GOOGLE_CLIENT_ID || null,
    anthropicApiKey: env.ANTHROPIC_API_KEY || null,
    aiModel: env.AI_MODEL || 'claude-sonnet-5-5',
    publicApiUrl: (env.PUBLIC_API_URL || `http://localhost:${env.PORT ?? 3000}`).replace(/\/+$/, ''),
    storageDir: env.STORAGE_DIR || '.storage',
    supabaseUrl: (env.SUPABASE_URL || supabaseUrlFrom(env.SUPABASE_DB_URL))?.replace(/\/+$/, '') || null,
    supabaseServiceKey: env.SUPABASE_SECRET_KEY || env.SUPABASE_SK || env.SUPABASE_SERVICE_KEY || null,
    storageBucket: env.STORAGE_BUCKET || 'materials',
    paystackSecretKey: (production ? env.PAYSTACK_SK_LIVE : env.PAYSTACK_SK_TEST) || env.PAYSTACK_SECRET_KEY || null,
    vapidPublicKey: env.VAPID_PUBLIC_KEY || null,
    vapidPrivateKey: env.VAPID_PRIVATE_KEY || null,
    vapidSubject: env.VAPID_SUBJECT || 'mailto:support@florence.app',
    appUrl: (env.APP_URL || env.WEB_ORIGIN || 'http://localhost:5180').replace(/\/+$/, ''),
  };
}

export function supabaseUrlFrom(dbUrl: string | undefined): string | null {
  if (!dbUrl) return null;
  const ref = /@db\.([a-z0-9]+)\.supabase\.co[:/]/.exec(dbUrl)?.[1] ?? /\/\/postgres\.([a-z0-9]+)[:@]/.exec(dbUrl)?.[1];
  return ref ? `https://${ref}.supabase.co` : null;
}

export const CONFIG = Symbol('CONFIG');
