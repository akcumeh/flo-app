import createClient, { type Middleware } from 'openapi-fetch';
import type { components, paths } from './schema';

export type Problem = components['schemas']['Problem'];

export const API_URL = (import.meta.env.VITE_API_URL || location.origin).replace(/\/+$/, '');

export class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly problem: Problem | null;

    constructor(status: number, problem: Problem | null, fallback = 'Request failed') {
        super(problem?.detail ?? problem?.title ?? fallback);
        this.name = 'ApiError';
        this.status = status;
        this.code = problem?.code ?? (status === 0 ? 'network_error' : `http_${status}`);
        this.problem = problem;
    }

    get retryable(): boolean {
        return this.status === 0 || this.status >= 500 || this.status === 429;
    }
}

export function idempotencyKey(): string {
    return crypto.randomUUID();
}

type Listener = (token: string | null) => void;

let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;
const listeners = new Set<Listener>();
let onSessionLost: () => void = () => { };

export const session = {
    get token() {
        return accessToken;
    },
    set(token: string | null) {
        accessToken = token;
        for (const l of listeners) l(token);
    },
    subscribe(l: Listener) {
        listeners.add(l);
        return () => listeners.delete(l);
    },
    onLost(handler: () => void) {
        onSessionLost = handler;
    },
};

export async function readProblem(res: Response): Promise<Problem | null> {
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('json')) return null;
    try {
        return (await res.clone().json()) as Problem;
    } catch {
        return null;
    }
}

export function refreshAccessToken(): Promise<string | null> {
    refreshing ??= (async () => {
        try {
            const res = await fetch(`${API_URL}/v1/auth/refresh`, { method: 'POST', credentials: 'include' });
            if (!res.ok) {
                session.set(null);
                return null;
            }
            const body = (await res.json()) as { accessToken: string };
            session.set(body.accessToken);
            return body.accessToken;
        } catch {
            return accessToken;
        } finally {
            refreshing = null;
        }
    })();
    return refreshing;
}

function withAuth(req: Request, token: string | null): Request {
    const next = new Request(req);
    if (token) next.headers.set('Authorization', `Bearer ${token}`);
    return next;
}

const NO_REFRESH = ['/v1/auth/refresh', '/v1/auth/logout', '/v1/auth/email/start', '/v1/auth/email/verify'];

export async function authedFetch(input: Request): Promise<Response> {
    const retry = input.clone();
    let res: Response;
    try {
        res = await fetch(withAuth(input, accessToken));
    } catch {
        throw new ApiError(0, null, 'You seem to be offline.');
    }
    const path = new URL(input.url, location.origin).pathname;
    if (res.status !== 401 || NO_REFRESH.includes(path)) return res;
    const hadToken = accessToken !== null;
    const token = await refreshAccessToken();
    if (!token) {
        if (hadToken) onSessionLost();
        return res;
    }
    return fetch(withAuth(retry, token));
}

const problems: Middleware = {
    async onResponse({ response }) {
        if (response.ok) return undefined;
        throw new ApiError(response.status, await readProblem(response));
    },
};

export const client = createClient<paths>({
    baseUrl: API_URL,
    credentials: 'include',
    fetch: authedFetch,
});
client.use(problems);
