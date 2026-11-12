import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { Db, Queryable } from './db.js';

function wrap(target: Pick<PGlite | Transaction, 'query' | 'exec'>): Queryable {
    return {
        async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
            return (await target.query<T>(sql, params)).rows;
        },
        async exec(sql: string) {
            await target.exec(sql);
        },
    };
}

export class PgliteDb implements Db {
    private readonly db = new PGlite();
    private readonly direct = wrap(this.db);

    query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
        return this.direct.query<T>(sql, params);
    }

    exec(sql: string): Promise<void> {
        return this.direct.exec(sql);
    }

    transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
        return this.db.transaction((tx) => fn(wrap(tx)));
    }

    async close(): Promise<void> {
        await this.db.close();
    }
}
