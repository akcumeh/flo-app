type Handler = (req: Request, url: URL) => Response | Promise<Response>;

export const ACCOUNT = {
    id: '0b6f2c52-7f1d-4c1e-9d0a-4a3b8f2e9c10',
    displayName: 'Ada Obi',
    username: null,
    tokenBalance: 10,
    identities: [],
    student: { status: 'none' },
    createdAt: '2026-11-10T20:00:00Z',
    profile: {
        school: { id: 'unilag', name: 'University of Lagos', country: 'NG', kind: 'university' },
        department: { id: 'mcb', name: 'Microbiology' },
        level: 200,
        examDate: null,
        onboardingComplete: true,
    },
};

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
    });

export const problem = (status: number, code: string, detail: string) =>
    new Response(JSON.stringify({ type: 'about:blank', title: code, status, code, detail }), {
        status,
        headers: { 'Content-Type': 'application/problem+json' },
    });

export function sse(frames: Array<[string, unknown]>): Response {
    const text = frames.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
    const bytes = new TextEncoder().encode(`: keep-alive\n\n${text}`);
    const stream = new ReadableStream<Uint8Array>({
        start(c) {
            c.enqueue(bytes.slice(0, 40));
            c.enqueue(bytes.slice(40));
            c.close();
        },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

export interface FakeBackend {
    calls: Array<{
        method: string;
        path: string;
        auth: string | null;
        body: unknown;
        headers: Headers;
    }>;
    routes: Map<string, Handler>;
    on(method: string, path: string | RegExp, handler: Handler): void;
    signedIn: boolean;
    balance: number;
}

export function installFakeBackend(opts: { signedIn?: boolean } = {}): FakeBackend {
    const routes = new Map<string, Handler>();
    const patterns: Array<{ method: string; re: RegExp; handler: Handler }> = [];
    const fake: FakeBackend = {
        calls: [],
        routes,
        signedIn: opts.signedIn ?? true,
        balance: 10,
        on(method, path, handler) {
            if (typeof path === 'string') routes.set(`${method} ${path}`, handler);
            else patterns.push({ method, re: path, handler });
        },
    };

    fake.on('POST', '/v1/auth/refresh', () =>
        fake.signedIn
            ? json({ accessToken: 'tok-1', expiresIn: 900 })
            : problem(401, 'unauthenticated', 'No session.')
    );
    fake.on('POST', '/v1/auth/logout', () => new Response(null, { status: 204 }));
    fake.on('GET', '/v1/me', (req) =>
        req.headers.get('Authorization')
            ? json({ ...ACCOUNT, tokenBalance: fake.balance })
            : problem(401, 'unauthenticated', 'Sign in.')
    );
    fake.on('GET', '/v1/streak', () =>
        json({
            current: 3,
            longest: 5,
            state: 'active',
            studiedToday: false,
            freezesHeld: 0,
            rewardEvery: 7,
            nextRewardAt: 7,
        })
    );
    fake.on('GET', '/v1/tokens', () => json({ balance: fake.balance }));
    fake.on('GET', '/v1/me/courses', () => json({ items: [] }));
    fake.on('GET', '/v1/conversations', () => json({ items: [], nextCursor: null }));
    fake.on('GET', '/v1/facts/today', () =>
        json({ id: 'f1', date: '2026-11-12', text: 'Octopuses have three hearts.' })
    );
    fake.on('GET', '/v1/home', () =>
        json({
            variant: 'today',
            streak: { current: 3, longest: 5, state: 'active', studiedToday: false },
            exam: { courseId: 'c1', courseCode: 'BIO 201', date: '2026-12-05', daysLeft: 23 },
        })
    );

    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
        const req =
            input instanceof Request
                ? input
                : new Request(new URL(String(input), 'http://localhost'), init);
        const url = new URL(req.url, 'http://localhost');
        let body: unknown = null;
        const text = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.clone().text();
        if (text) {
            try {
                body = JSON.parse(text);
            } catch {
                body = text;
            }
        }
        fake.calls.push({
            method: req.method,
            path: url.pathname,
            auth: req.headers.get('Authorization'),
            body,
            headers: req.headers,
        });
        const exact = routes.get(`${req.method} ${url.pathname}`);
        if (exact) return exact(req, url);
        const match = patterns.find((p) => p.method === req.method && p.re.test(url.pathname));
        if (match) return match.handler(req, url);
        return problem(404, 'not_found', `No fake route for ${req.method} ${url.pathname}`);
    };
    vi.stubGlobal('fetch', vi.fn(fetchMock));
    return fake;
}
