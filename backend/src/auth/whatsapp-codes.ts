import { Logger } from '@nestjs/common';

export interface WhatsAppCodeSender {
    readonly live: boolean;
    sendCode(phone: string, code: string): Promise<'sent' | 'refused'>;
}

export const WHATSAPP_CODES = Symbol('WHATSAPP_CODES');

export class CloudApiCodeSender implements WhatsAppCodeSender {
    readonly live = true;
    private readonly logger = new Logger('WhatsAppCodes');

    constructor(
        private readonly accessToken: string,
        private readonly phoneNumberId: string,
        private readonly template: string,
        private readonly language: string,
        private readonly fetchImpl: typeof fetch = fetch
    ) {}

    async sendCode(phone: string, code: string): Promise<'sent' | 'refused'> {
        const res = await this.fetchImpl(
            `https://graph.facebook.com/v22.0/${this.phoneNumberId}/messages`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    messaging_product: 'whatsapp',
                    to: phone,
                    type: 'template',
                    template: {
                        name: this.template,
                        language: { code: this.language },
                        components: [
                            { type: 'body', parameters: [{ type: 'text', text: code }] },
                            {
                                type: 'button',
                                sub_type: 'url',
                                index: '0',
                                parameters: [{ type: 'text', text: code }],
                            },
                        ],
                    },
                }),
                signal: AbortSignal.timeout(10_000),
            }
        );
        if (res.ok) return 'sent';
        const body = (await res.json().catch(() => ({}))) as {
            error?: { code?: number; message?: string };
        };
        this.logger.warn(
            `WhatsApp refused a code: ${res.status} ${body.error?.code ?? ''} ${body.error?.message ?? ''}`
        );
        if (res.status >= 500) throw new Error('WhatsApp is unavailable');
        return 'refused';
    }
}

export class ConsoleCodeSender implements WhatsAppCodeSender {
    readonly live = false;
    private readonly logger = new Logger('WhatsAppCodes');

    async sendCode(phone: string, code: string): Promise<'sent'> {
        this.logger.log(`WhatsApp sign-in code for +${phone}: ${code}`);
        return 'sent';
    }
}

export class FakeCodeSender implements WhatsAppCodeSender {
    readonly live = false;
    readonly sent: Array<{ phone: string; code: string }> = [];
    refuse = new Set<string>();

    async sendCode(phone: string, code: string): Promise<'sent' | 'refused'> {
        if (this.refuse.has(phone)) return 'refused';
        this.sent.push({ phone, code });
        return 'sent';
    }

    lastCodeFor(phone: string): string {
        const hit = [...this.sent].reverse().find((m) => m.phone === phone);
        if (!hit) throw new Error(`no code sent to ${phone}`);
        return hit.code;
    }
}

export function normalisePhone(raw: string): string | null {
    const trimmed = raw.trim();
    let digits = trimmed.replace(/[^0-9]/g, '');
    if (/[^0-9+\s().-]/.test(trimmed)) return null;
    if (trimmed.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? digits : null;
    if (digits.startsWith('00')) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith('0')) digits = `234${digits.slice(1)}`;
    else if (digits.length === 10 && /^[789]/.test(digits)) digits = `234${digits}`;
    return digits.length >= 8 && digits.length <= 15 ? digits : null;
}
