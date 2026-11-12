import { client, idempotencyKey } from './http';
import { postStream } from './stream';
import type { Account, ChatEvent, Citation, FlorenceApi, PrepSession } from './types';

const POLL_MS = 800;
const POLL_LIMIT = 150;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function data<T>(p: Promise<{ data?: T }>): Promise<T> {
    const res = await p;
    return res.data as T;
}

async function waitUntilReady(session: PrepSession): Promise<PrepSession> {
    let current = session;
    for (let i = 0; current.status === 'generating' && i < POLL_LIMIT; i += 1) {
        await wait(POLL_MS);
        current = await data(
            client.GET('/v1/sessions/{sessionId}', { params: { path: { sessionId: current.id } } })
        );
    }
    return current;
}

export const api: FlorenceApi = {
    getMe: () => data<Account>(client.GET('/v1/me')),

    async listFiles() {
        const page = await data(client.GET('/v1/files'));
        return page.items;
    },

    async createPrepSession(fileIds, questionCount) {
        const created = await data(
            client.POST('/v1/sessions', {
                params: { header: { 'Idempotency-Key': idempotencyKey() } },
                body: { mode: 'quiz', fileIds, questionCount },
            } as never)
        );
        return waitUntilReady(created as PrepSession);
    },

    async getPrepSession(id) {
        const s = await data(
            client.GET('/v1/sessions/{sessionId}', { params: { path: { sessionId: id } } })
        );
        return waitUntilReady(s);
    },

    submitPrepAnswer: (sessionId, itemId, answer) =>
        data(
            client.POST('/v1/sessions/{sessionId}/answers', {
                params: { path: { sessionId }, header: { 'Idempotency-Key': idempotencyKey() } },
                body: { itemId, answer, answeredAt: new Date().toISOString() },
            })
        ),

    completePrepSession: (sessionId) =>
        data(client.POST('/v1/sessions/{sessionId}/complete', { params: { path: { sessionId } } })),

    async *sendMessage(conversationId, text, fileIds): AsyncGenerator<ChatEvent> {
        const id =
            conversationId ?? (await data(client.POST('/v1/conversations', { body: {} }))).id;
        const opened = await postStream(
            `/v1/conversations/${id}/messages`,
            fileIds.length > 0 ? { text, fileIds } : { text },
            { 'Idempotency-Key': idempotencyKey() }
        );
        if ('json' in opened) {
            const m = opened.json as { id: string; text: string; citations: Citation[] };
            const { balance } = await data(client.GET('/v1/tokens'));
            yield {
                type: 'message.start',
                conversationId: id,
                messageId: m.id,
                charged: 0,
                balance,
            };
            yield { type: 'delta', text: m.text };
            for (const c of m.citations) yield { type: 'citation', citation: c };
            yield { type: 'message.end', messageId: m.id, balance };
            return;
        }
        for await (const frame of opened.frames) {
            const d = frame.data as Record<string, unknown>;
            if (frame.event === 'message.start') {
                yield {
                    type: 'message.start',
                    conversationId: id,
                    messageId: d.messageId as string,
                    charged: d.charged as number,
                    balance: d.balance as number,
                };
            } else if (frame.event === 'delta') {
                yield { type: 'delta', text: d.text as string };
            } else if (frame.event === 'citation') {
                yield { type: 'citation', citation: d as unknown as Citation };
            } else if (frame.event === 'message.end') {
                yield {
                    type: 'message.end',
                    messageId: d.messageId as string,
                    balance: d.balance as number,
                    grounded: d.grounded as boolean,
                };
            } else if (frame.event === 'error') {
                yield {
                    type: 'error',
                    code: d.code as string,
                    refunded: Boolean(d.refunded),
                    balance: d.balance as number,
                };
            }
        }
    },
};

export { deleteFile, formatSize, getFile, listCourses, uploadFiles } from './library';
export { ApiError, client, idempotencyKey, session, refreshAccessToken } from './http';
export * from './types';
