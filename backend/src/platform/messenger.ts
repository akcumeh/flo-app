export interface BotMessenger {
    readonly live: boolean;
    send(provider: 'telegram' | 'whatsapp', providerUserId: string, text: string): Promise<boolean>;
}

export const MESSENGER = Symbol('MESSENGER');

export class TelegramMessenger implements BotMessenger {
    readonly live = true;

    constructor(
        private readonly botToken: string | null,
        private readonly fetchImpl: typeof fetch = fetch
    ) {}

    async send(
        provider: 'telegram' | 'whatsapp',
        providerUserId: string,
        text: string
    ): Promise<boolean> {
        if (provider !== 'telegram' || !this.botToken) return false;
        const res = await this.fetchImpl(
            `https://api.telegram.org/bot${this.botToken}/sendMessage`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: providerUserId,
                    text,
                    disable_web_page_preview: true,
                }),
                signal: AbortSignal.timeout(10_000),
            }
        ).catch(() => null);
        return Boolean(res?.ok);
    }
}

export class FakeMessenger implements BotMessenger {
    readonly live = false;
    readonly sent: Array<{ provider: string; providerUserId: string; text: string }> = [];

    async send(
        provider: 'telegram' | 'whatsapp',
        providerUserId: string,
        text: string
    ): Promise<boolean> {
        if (provider !== 'telegram') return false;
        this.sent.push({ provider, providerUserId, text });
        return true;
    }
}
