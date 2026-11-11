export interface Config {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  codePepper: string;
  mailDriver: 'console';
  webOrigin: string;
  cookieSecure: boolean;
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

  return {
    nodeEnv,
    port: Number(env.PORT ?? 3000),
    databaseUrl: need('DATABASE_URL', 'postgresql://postgres:password@localhost:5432/postgres'),
    jwtSecret: need('JWT_SECRET', 'dev-only-jwt-secret-not-for-production-use'),
    codePepper: need('CODE_PEPPER', 'dev-only-code-pepper-not-for-production-use'),
    mailDriver: 'console',
    webOrigin: env.WEB_ORIGIN ?? 'http://localhost:5180',
    cookieSecure: production,
  };
}

export const CONFIG = Symbol('CONFIG');
