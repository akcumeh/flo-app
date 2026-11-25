import { client, idempotencyKey } from './http';
import type { components } from './schema';
import type { PrepSession, Verdict } from './types';

export type StudyMode = components['schemas']['StudyMode'];
export type WebMode = Exclude<StudyMode, 'fill_blank' | 'mock_exam'>;

export const WEB_MODES: WebMode[] = ['quiz', 'flashcards'];

export interface StartInput {
    fileIds: string[];
    mode: WebMode;
    questionCount: number;
    topicIds?: string[];
}

export async function startSession(input: StartInput): Promise<PrepSession> {
    const res = await client.POST('/v1/sessions', {
        params: { header: { 'Idempotency-Key': idempotencyKey() } },
        body: {
            mode: input.mode,
            fileIds: input.fileIds,
            questionCount: input.questionCount,
            ...(input.topicIds && input.topicIds.length > 0 ? { topicIds: input.topicIds } : {}),
        },
    } as never);
    return (res as { data: PrepSession }).data;
}

export async function fetchSession(sessionId: string): Promise<PrepSession> {
    return (await client.GET('/v1/sessions/{sessionId}', { params: { path: { sessionId } } }))
        .data!;
}

export async function switchMode(sessionId: string, mode: WebMode): Promise<PrepSession> {
    return (
        await client.PATCH('/v1/sessions/{sessionId}/mode', {
            params: { path: { sessionId } },
            body: { mode },
        })
    ).data!;
}

export async function retryMissed(sessionId: string): Promise<PrepSession> {
    const res = await client.POST('/v1/sessions/{sessionId}/retry', {
        params: { path: { sessionId }, header: { 'Idempotency-Key': idempotencyKey() } },
    } as never);
    return (res as { data: PrepSession }).data;
}

export async function rateCard(
    sessionId: string,
    itemId: number,
    outcome: 'know' | 'missed'
): Promise<Verdict> {
    return (
        await client.POST('/v1/sessions/{sessionId}/answers', {
            params: { path: { sessionId }, header: { 'Idempotency-Key': idempotencyKey() } },
            body: { itemId, outcome, answeredAt: new Date().toISOString() },
        })
    ).data!;
}
