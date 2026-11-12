import { API_URL, ApiError, client, readProblem } from './http';
import { readSse } from './stream';
import type { ChatEvent, Citation, Message } from './types';

export type Conversation = { id: string; title: string | null; lastMessageAt: string | null };

export async function listConversations(): Promise<Conversation[]> {
    const out: Conversation[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i += 1) {
        const page = (
            await client.GET('/v1/conversations', {
                params: { query: { cursor, limit: 50 } },
            })
        ).data!;
        out.push(...(page.items as Conversation[]));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
    }
    return out;
}

export async function listMessages(conversationId: string): Promise<Message[]> {
    const out: Message[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i += 1) {
        const page = (
            await client.GET('/v1/conversations/{conversationId}/messages', {
                params: { path: { conversationId }, query: { cursor, limit: 100 } },
            })
        ).data!;
        out.push(...page.items);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
    }
    return out;
}

export async function deleteConversation(conversationId: string): Promise<void> {
    await client.DELETE('/v1/conversations/{conversationId}', {
        params: { path: { conversationId } },
    });
}

export async function setSaved(messageId: string, saved: boolean): Promise<void> {
    await client.PUT('/v1/messages/{messageId}/saved', {
        params: { path: { messageId } },
        body: { saved },
    });
}

export async function listSavedAnswers(): Promise<Message[]> {
    return (await client.GET('/v1/saved-answers', { params: { query: { limit: 100 } } })).data!
        .items;
}

const GUEST_KEY = 'florence.guest';

interface StoredGuest {
    token: string;
    expiresAt: string;
    asked: boolean;
}

function readGuest(): StoredGuest | null {
    try {
        const raw = localStorage.getItem(GUEST_KEY);
        if (!raw) return null;
        const g = JSON.parse(raw) as StoredGuest;
        return new Date(g.expiresAt).getTime() > Date.now() ? g : null;
    } catch {
        return null;
    }
}

function writeGuest(g: StoredGuest | null) {
    try {
        if (g) localStorage.setItem(GUEST_KEY, JSON.stringify(g));
        else localStorage.removeItem(GUEST_KEY);
    } catch {
        return;
    }
}

export async function startGuest(): Promise<{ token: string; questionsLeft: number }> {
    const existing = readGuest();
    const res = await fetch(`${API_URL}/v1/guest/sessions`, {
        method: 'POST',
        credentials: 'include',
    }).catch(() => {
        throw new ApiError(0, null, 'You seem to be offline.');
    });
    if (!res.ok) throw new ApiError(res.status, await readProblem(res));
    const body = (await res.json()) as {
        guestToken: string;
        expiresAt: string;
        questionsLeft: number;
    };
    if (existing && existing.asked) {
        return { token: existing.token, questionsLeft: body.questionsLeft };
    }
    writeGuest({ token: body.guestToken, expiresAt: body.expiresAt, asked: false });
    return { token: body.guestToken, questionsLeft: body.questionsLeft };
}

export type GuestEvent =
    | { type: 'delta'; text: string }
    | { type: 'end'; questionsLeft: number }
    | { type: 'error'; questionsLeft: number };

export async function* sendGuestMessage(token: string, text: string): AsyncGenerator<GuestEvent> {
    const res = await fetch(`${API_URL}/v1/guest/messages`, {
        method: 'POST',
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            'X-Guest-Token': token,
        },
        body: JSON.stringify({ text }),
    }).catch(() => {
        throw new ApiError(0, null, 'You seem to be offline.');
    });
    if (!res.ok) throw new ApiError(res.status, await readProblem(res));
    if (!res.body) throw new ApiError(0, null, 'The answer stream did not open.');
    const stored = readGuest();
    if (stored) writeGuest({ ...stored, asked: true });
    for await (const frame of readSse(res.body)) {
        const d = frame.data as Record<string, unknown>;
        if (frame.event === 'delta') yield { type: 'delta', text: d.text as string };
        if (frame.event === 'message.end')
            yield { type: 'end', questionsLeft: Number(d.questionsLeft ?? 0) };
        if (frame.event === 'error')
            yield { type: 'error', questionsLeft: Number(d.questionsLeft ?? 0) };
    }
}

export async function claimGuestChat(): Promise<string | null> {
    const g = readGuest();
    if (!g?.asked) return null;
    try {
        const res = await client.POST('/v1/guest/claim', { body: { guestToken: g.token } });
        writeGuest(null);
        return (res.data as Conversation).id;
    } catch (err) {
        if (err instanceof ApiError && err.status < 500) writeGuest(null);
        return null;
    }
}

export type { ChatEvent, Citation, Message };
