export interface Queryable {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
    exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
    transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
    close(): Promise<void>;
}

export const DB = Symbol('DB');
