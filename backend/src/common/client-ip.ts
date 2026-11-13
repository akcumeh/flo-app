import { BlockList, isIP } from 'node:net';
import type { NextFunction, Request, Response } from 'express';

const CLOUDFLARE_V4 = [
    '173.245.48.0/20',
    '103.21.244.0/22',
    '103.22.200.0/22',
    '103.31.4.0/22',
    '141.101.64.0/18',
    '108.162.192.0/18',
    '190.93.240.0/20',
    '188.114.96.0/20',
    '197.234.240.0/22',
    '198.41.128.0/17',
    '162.158.0.0/15',
    '104.16.0.0/13',
    '104.24.0.0/14',
    '172.64.0.0/13',
    '131.0.72.0/22',
];

const CLOUDFLARE_V6 = [
    '2400:cb00::/32',
    '2606:4700::/32',
    '2803:f800::/32',
    '2405:b500::/32',
    '2405:8100::/32',
    '2a06:98c0::/29',
    '2c0f:f248::/32',
];

const cloudflare = new BlockList();
for (const range of CLOUDFLARE_V4) {
    const [net, bits] = range.split('/');
    cloudflare.addSubnet(net, Number(bits), 'ipv4');
}
for (const range of CLOUDFLARE_V6) {
    const [net, bits] = range.split('/');
    cloudflare.addSubnet(net, Number(bits), 'ipv6');
}

function clean(value: string | string[] | undefined): string | null {
    const raw = (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim();
    if (!raw) return null;
    const bare = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
    return isIP(bare) ? bare : null;
}

export function isCloudflare(ip: string): boolean {
    const kind = isIP(ip);
    if (kind === 4) return cloudflare.check(ip, 'ipv4');
    if (kind === 6) return cloudflare.check(ip, 'ipv6');
    return false;
}

export function clientIp(headers: Request['headers'], fallback: string | undefined): string {
    const edge = clean(headers['fly-client-ip']);
    if (!edge) return fallback ?? 'unknown';
    const visitor = clean(headers['cf-connecting-ip']);
    if (visitor && isCloudflare(edge)) return visitor;
    return edge;
}

export function realClientIp(req: Request, _res: Response, next: NextFunction) {
    const ip = clientIp(req.headers, req.ip);
    Object.defineProperty(req, 'ip', { value: ip, configurable: true, enumerable: true });
    next();
}
