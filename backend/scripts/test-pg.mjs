import { spawnSync } from 'node:child_process';

const env = { ...process.env, TEST_DB: process.env.TEST_DATABASE_URL ? '' : 'pg-socket' };
const result = spawnSync('npx', ['vitest', 'run', ...process.argv.slice(2)], { stdio: 'inherit', env, shell: true });
process.exit(result.status ?? 1);
