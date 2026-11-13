import { clientIp, isCloudflare } from '../src/common/client-ip.js';

describe('client IP', () => {
    it('trusts CF-Connecting-IP only when the request reached Fly from Cloudflare', () => {
        expect(isCloudflare('172.70.12.4')).toBe(true);
        expect(isCloudflare('2606:4700:10::ac43:1')).toBe(true);
        expect(isCloudflare('41.58.10.20')).toBe(false);
        expect(
            clientIp(
                { 'fly-client-ip': '172.70.12.4', 'cf-connecting-ip': '41.58.10.20' },
                '10.0.0.1'
            )
        ).toBe('41.58.10.20');
        expect(
            clientIp({ 'fly-client-ip': '41.58.10.20', 'cf-connecting-ip': '1.2.3.4' }, '10.0.0.1')
        ).toBe('41.58.10.20');
        expect(clientIp({ 'fly-client-ip': '::ffff:102.89.4.7' }, undefined)).toBe('102.89.4.7');
        expect(clientIp({}, '127.0.0.1')).toBe('127.0.0.1');
        expect(clientIp({ 'fly-client-ip': 'not-an-ip' }, '127.0.0.1')).toBe('127.0.0.1');
    });
});
