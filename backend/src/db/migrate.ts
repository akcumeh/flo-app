import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db.js';

export async function migrate(
    db: Db,
    dir = join(process.cwd(), 'db', 'migrations')
): Promise<string[]> {
    await db.exec(
        'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())'
    );
    const applied = new Set(
        (await db.query<{ name: string }>('select name from schema_migrations')).map((r) => r.name)
    );
    const files = readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

    const ran: string[] = [];
    for (const file of files) {
        if (applied.has(file)) continue;
        const sql = readFileSync(join(dir, file), 'utf8');
        try {
            await db.transaction(async (q) => {
                await q.exec(sql);
                await q.query('insert into schema_migrations (name) values ($1)', [file]);
            });
        } catch (error) {
            throw new Error(`Migration ${file} failed: ${(error as Error).message}`, {
                cause: error,
            });
        }
        ran.push(file);
    }
    return ran;
}

export async function seed(db: Db, dir = join(process.cwd(), 'db', 'seed')): Promise<string[]> {
    const files = readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    for (const file of files) {
        await db.transaction(async (q) => q.exec(readFileSync(join(dir, file), 'utf8')));
    }
    return files;
}
