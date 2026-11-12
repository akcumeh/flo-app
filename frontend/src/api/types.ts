import type { components } from './schema';

type S = components['schemas'];

export type Account = S['Account'];
export type StoredFile = S['StoredFile'];
export type PrepSession = S['Session'];
export type PrepQuestion = S['SessionItem'];
export type Verdict = S['Verdict'];
export type PrepResult = S['SessionResult'];
export type Citation = S['Citation'];
export type Message = S['Message'];
export type AuthSession = S['AuthSession'];

export type ChatEvent =
    | {
          type: 'message.start';
          conversationId: string;
          messageId: string;
          charged: number;
          balance: number;
      }
    | { type: 'delta'; text: string }
    | { type: 'citation'; citation: Citation }
    | { type: 'message.end'; messageId: string; balance: number; grounded?: boolean }
    | { type: 'error'; code: string; refunded: boolean; balance: number };

export interface FlorenceApi {
    getMe(): Promise<Account>;
    listFiles(): Promise<StoredFile[]>;
    createPrepSession(fileIds: string[], questionCount: number): Promise<PrepSession>;
    getPrepSession(id: string): Promise<PrepSession>;
    submitPrepAnswer(sessionId: string, questionId: number, answer: string): Promise<Verdict>;
    completePrepSession(sessionId: string): Promise<PrepResult>;
    sendMessage(
        conversationId: string | null,
        text: string,
        fileIds: string[]
    ): AsyncGenerator<ChatEvent>;
}
