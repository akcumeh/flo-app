import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

export function hmac(key: string, value: string): string {
    return createHmac('sha256', key).update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(sha256(a), 'hex');
    const y = Buffer.from(sha256(b), 'hex');
    return timingSafeEqual(x, y);
}
