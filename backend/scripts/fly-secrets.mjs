import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const env = dotenv.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.env')));
const db = /^postgres(?:ql)?:\/\/([^:]+):(.*)@db\.([a-z0-9]+)\.supabase\.co:\d+\/(\w+)$/.exec(
    env.SUPABASE_DB_URL ?? ''
);
if (!db) throw new Error('SUPABASE_DB_URL is missing or not a db.<ref>.supabase.co address');
const [, , password, ref, name] = db;
const region = process.env.SUPABASE_POOLER_HOST ?? 'aws-0-eu-west-1.pooler.supabase.com';

const out = {
    DATABASE_URL: `postgresql://postgres.${ref}:${encodeURIComponent(password)}@${region}:5432/${name}?sslmode=no-verify`,
    SUPABASE_URL: `https://${ref}.supabase.co`,
    SUPABASE_SECRET_KEY: env.SUPABASE_SK,
    JWT_SECRET: env.JWT_SECRET,
    CODE_PEPPER: env.CODE_PEPPER,
    INTERNAL_API_SECRET: env.INTERNAL_API_SECRET,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN,
    PAYSTACK_SECRET_KEY:
        process.env.PAYSTACK_LIVE === '1' ? env.PAYSTACK_SK_LIVE : env.PAYSTACK_SK_TEST,
    VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY,
};
const missing = Object.entries(out)
    .filter(([, v]) => !v)
    .map(([k]) => k);
if (missing.length > 0) throw new Error(`Missing in backend/.env: ${missing.join(', ')}`);
const body = Object.entries(out)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
const at = process.argv.indexOf('--app');
if (at === -1) {
    process.stdout.write(`${body}\n`);
} else {
    const result = spawnSync('fly', ['secrets', 'import', '--stage', '-a', process.argv[at + 1]], {
        input: `${body}\n`,
        stdio: ['pipe', 'inherit', 'inherit'],
        shell: process.platform === 'win32',
    });
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
}
