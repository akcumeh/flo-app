import { Pool, type PoolClient } from 'pg';
import type { Db, Queryable } from './db.js';

function wrap(client: Pick<PoolClient, 'query'>): Queryable {
  return {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      return (await client.query(sql, params)).rows as T[];
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  };
}

export class PgDb implements Db {
  private readonly pool: Pool;
  private readonly direct: Queryable;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
    this.direct = wrap(this.pool);
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.direct.query<T>(sql, params);
  }

  exec(sql: string): Promise<void> {
    return this.direct.exec(sql);
  }

  async transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await fn(wrap(client));
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
