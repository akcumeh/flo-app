import * as webpushModule from 'web-push';

const webpush = ((webpushModule as unknown as { default?: typeof webpushModule }).default ??
    webpushModule) as typeof webpushModule;

export interface PushTarget {
    endpoint: string;
    p256dh: string;
    auth: string;
}

export type PushOutcome = 'sent' | 'gone' | 'failed';

export interface PushSender {
    readonly live: boolean;
    readonly publicKey: string;
    send(target: PushTarget, payload: Record<string, unknown>): Promise<PushOutcome>;
}

export const PUSH = Symbol('PUSH');

export class WebPushSender implements PushSender {
    readonly live = true;

    constructor(
        readonly publicKey: string,
        private readonly privateKey: string,
        private readonly subject: string
    ) {}

    async send(target: PushTarget, payload: Record<string, unknown>): Promise<PushOutcome> {
        try {
            await webpush.sendNotification(
                { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
                JSON.stringify(payload),
                {
                    vapidDetails: {
                        subject: this.subject,
                        publicKey: this.publicKey,
                        privateKey: this.privateKey,
                    },
                    TTL: 60 * 60 * 6,
                }
            );
            return 'sent';
        } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            return status === 404 || status === 410 ? 'gone' : 'failed';
        }
    }
}

export class FakePushSender implements PushSender {
    readonly live = false;
    readonly sent: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
    readonly gone = new Set<string>();
    readonly publicKey =
        'BFakePublicVapidKeyForTests0000000000000000000000000000000000000000000000000000000000';

    async send(target: PushTarget, payload: Record<string, unknown>): Promise<PushOutcome> {
        if (this.gone.has(target.endpoint)) return 'gone';
        this.sent.push({ endpoint: target.endpoint, payload });
        return 'sent';
    }
}

export function ephemeralVapid(): { publicKey: string; privateKey: string } {
    return webpush.generateVAPIDKeys();
}
