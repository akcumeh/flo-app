import Anthropic from '@anthropic-ai/sdk';

export type AiContent = string | Anthropic.Beta.BetaContentBlockParam[];

export interface AiMessage {
    role: 'user' | 'assistant';
    content: AiContent;
}

export interface AiRequest {
    system?: string;
    messages: AiMessage[];
    maxTokens?: number;
    effort?: 'low' | 'medium' | 'high';
    jsonSchema?: Record<string, unknown>;
    signal?: AbortSignal;
}

export interface AiProvider {
    readonly live: boolean;
    complete(req: AiRequest): Promise<string>;
    stream(req: AiRequest, onText: (delta: string) => void): Promise<string>;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');

export class AiRefusedError extends Error {
    constructor() {
        super('The model declined this request.');
    }
}

export class AiTruncatedError extends Error {
    constructor() {
        super('The model reply hit the token limit.');
    }
}

function textOf(message: Anthropic.Beta.BetaMessage): string {
    if (message.stop_reason === 'refusal') throw new AiRefusedError();
    if (message.stop_reason === 'max_tokens') throw new AiTruncatedError();
    return message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
}

export class AnthropicProvider implements AiProvider {
    readonly live = true;
    private readonly client: Anthropic;

    constructor(
        apiKey: string,
        private readonly model: string
    ) {
        this.client = new Anthropic({ apiKey, maxRetries: 2 });
    }

    private params(req: AiRequest): Anthropic.Beta.MessageCreateParamsStreaming {
        return {
            model: this.model,
            max_tokens: req.maxTokens ?? 16000,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            ...(req.system ? { system: req.system } : {}),
            messages: req.messages,
            output_config: {
                effort: req.effort ?? 'medium',
                ...(req.jsonSchema
                    ? { format: { type: 'json_schema' as const, schema: req.jsonSchema } }
                    : {}),
            },
            stream: true,
        };
    }

    async complete(req: AiRequest): Promise<string> {
        const stream = this.client.beta.messages.stream(this.params(req), { signal: req.signal });
        return textOf(await stream.finalMessage());
    }

    async stream(req: AiRequest, onText: (delta: string) => void): Promise<string> {
        const stream = this.client.beta.messages.stream(this.params(req), { signal: req.signal });
        stream.on('text', (delta) => onText(delta));
        return textOf(await stream.finalMessage());
    }
}

export type FakeResponder = (req: AiRequest) => string | Promise<string>;

export class FakeAiProvider implements AiProvider {
    readonly live = false;
    readonly calls: AiRequest[] = [];
    respond: FakeResponder = () => 'This is a test answer from the fake provider.';
    delayMs = 0;
    failAfterPieces: number | null = null;

    async complete(req: AiRequest): Promise<string> {
        this.calls.push(req);
        return this.respond(req);
    }

    async stream(req: AiRequest, onText: (delta: string) => void): Promise<string> {
        const text = await this.complete(req);
        let sent = 0;
        for (const piece of text.match(/.{1,12}/gs) ?? []) {
            if (this.failAfterPieces !== null && sent >= this.failAfterPieces)
                throw new Error('provider failed mid-stream');
            if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
            if (req.signal?.aborted) throw new Error('aborted');
            onText(piece);
            sent += 1;
        }
        return text;
    }
}

export function parseJson<T>(text: string): T {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('No JSON object in model reply');
    return JSON.parse(text.slice(start, end + 1)) as T;
}
