import { ApiError, client } from '../api';
import { offlineQueue, type QueuedAnswer, type SendAnswer } from './offlineQueue';

export const sendQueuedAnswer: SendAnswer = async (a: QueuedAnswer) => {
    try {
        await client.POST('/v1/sessions/{sessionId}/answers', {
            params: { path: { sessionId: a.sessionId }, header: { 'Idempotency-Key': a.key } },
            body: {
                itemId: a.itemId,
                answer: a.answer,
                outcome: a.outcome,
                dontKnow: a.dontKnow,
                answeredAt: a.answeredAt,
            },
        });
        return 'sent';
    } catch (error) {
        if (error instanceof ApiError && !error.retryable && error.status !== 401) return 'drop';
        return 'retry';
    }
};

let running: Promise<{ sent: number; left: number }> | null = null;

export function syncAnswers() {
    running ??= offlineQueue.flush(sendQueuedAnswer).finally(() => {
        running = null;
    });
    return running;
}
