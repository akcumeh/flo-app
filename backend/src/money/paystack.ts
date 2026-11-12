import { createHmac, timingSafeEqual } from 'node:crypto';

export interface PaystackInit {
    authorizationUrl: string;
    accessCode: string;
}

export interface PaystackTransfer {
    bankName: string;
    accountNumber: string;
    accountName: string;
    expiresAt: string;
}

export interface PaystackVerify {
    status: 'success' | 'failed' | 'abandoned' | 'pending' | 'ongoing' | string;
    amountKobo: number;
    channel: string | null;
}

export interface PaystackClient {
    readonly live: boolean;
    initialize(input: {
        email: string;
        amountKobo: number;
        reference: string;
        callbackUrl: string;
        channels: string[];
    }): Promise<PaystackInit>;
    chargeTransfer(input: {
        email: string;
        amountKobo: number;
        reference: string;
        expiresAt: Date;
    }): Promise<PaystackTransfer>;
    verify(reference: string): Promise<PaystackVerify>;
    checkSignature(rawBody: Buffer, signature: string | undefined): boolean;
}

export const PAYSTACK = Symbol('PAYSTACK');

export class PaystackUnavailable extends Error {}

export function paystackSignature(secret: string, rawBody: Buffer): string {
    return createHmac('sha512', secret).update(rawBody).digest('hex');
}

function signatureMatches(secret: string, rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = Buffer.from(paystackSignature(secret, rawBody), 'hex');
    const actual = Buffer.from(signature, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class HttpPaystack implements PaystackClient {
    readonly live = true;

    constructor(
        private readonly secret: string,
        private readonly fetchImpl: typeof fetch = fetch,
        private readonly base = 'https://api.paystack.co'
    ) {}

    private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
        const res = await this.fetchImpl(`${this.base}${path}`, {
            ...init,
            headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(15_000),
        });
        const body = (await res.json().catch(() => ({}))) as {
            status?: boolean;
            message?: string;
            data?: T;
        };
        if (!res.ok || body.status === false || !body.data) {
            throw new PaystackUnavailable(
                `Paystack ${path} answered ${res.status}: ${body.message ?? 'no message'}`
            );
        }
        return body.data;
    }

    async initialize(input: {
        email: string;
        amountKobo: number;
        reference: string;
        callbackUrl: string;
        channels: string[];
    }) {
        const data = await this.call<{ authorization_url: string; access_code: string }>(
            '/transaction/initialize',
            {
                method: 'POST',
                body: JSON.stringify({
                    email: input.email,
                    amount: input.amountKobo,
                    reference: input.reference,
                    callback_url: input.callbackUrl,
                    channels: input.channels,
                }),
            }
        );
        return { authorizationUrl: data.authorization_url, accessCode: data.access_code };
    }

    async chargeTransfer(input: {
        email: string;
        amountKobo: number;
        reference: string;
        expiresAt: Date;
    }) {
        const data = await this.call<{
            bank?: { name?: string };
            account_name?: string;
            account_number?: string;
            account_expires_at?: string;
        }>('/charge', {
            method: 'POST',
            body: JSON.stringify({
                email: input.email,
                amount: input.amountKobo,
                reference: input.reference,
                bank_transfer: { account_expires_at: input.expiresAt.toISOString() },
            }),
        });
        if (!data.account_number)
            throw new PaystackUnavailable('Paystack returned no transfer account');
        return {
            bankName: data.bank?.name ?? 'Paystack',
            accountNumber: data.account_number,
            accountName: data.account_name ?? 'Paystack Checkout',
            expiresAt: data.account_expires_at ?? input.expiresAt.toISOString(),
        };
    }

    async verify(reference: string) {
        const data = await this.call<{ status: string; amount: number; channel?: string }>(
            `/transaction/verify/${encodeURIComponent(reference)}`
        );
        return { status: data.status, amountKobo: data.amount, channel: data.channel ?? null };
    }

    checkSignature(rawBody: Buffer, signature: string | undefined) {
        return signatureMatches(this.secret, rawBody, signature);
    }
}

export class FakePaystack implements PaystackClient {
    readonly live = false;
    readonly results = new Map<string, PaystackVerify>();
    readonly calls: string[] = [];

    constructor(readonly secret = 'sk_test_fake_secret') {}

    async initialize(input: { reference: string }) {
        this.calls.push(`initialize:${input.reference}`);
        return {
            authorizationUrl: `https://checkout.paystack.test/${input.reference}`,
            accessCode: `ac_${input.reference}`,
        };
    }

    async chargeTransfer(input: { reference: string; expiresAt: Date }) {
        this.calls.push(`transfer:${input.reference}`);
        return {
            bankName: 'Test Bank',
            accountNumber: '0123456789',
            accountName: 'Paystack Checkout',
            expiresAt: input.expiresAt.toISOString(),
        };
    }

    async verify(reference: string) {
        this.calls.push(`verify:${reference}`);
        return this.results.get(reference) ?? { status: 'ongoing', amountKobo: 0, channel: null };
    }

    checkSignature(rawBody: Buffer, signature: string | undefined) {
        return signatureMatches(this.secret, rawBody, signature);
    }
}

export class DisabledPaystack implements PaystackClient {
    readonly live = false;

    constructor(private readonly reason: string) {}

    async initialize(): Promise<PaystackInit> {
        throw new PaystackUnavailable(this.reason);
    }

    async chargeTransfer(): Promise<PaystackTransfer> {
        throw new PaystackUnavailable(this.reason);
    }

    async verify(): Promise<PaystackVerify> {
        throw new PaystackUnavailable(this.reason);
    }

    checkSignature() {
        return false;
    }
}
