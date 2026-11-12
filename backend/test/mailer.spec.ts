import { ResendMailer } from '../src/auth/mailer.js';
import { loadConfig } from '../src/config.js';

describe('mailer', () => {
    it('sends the code through the Resend API', async () => {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        const fake = (async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            return new Response('{"id":"x"}', { status: 200 });
        }) as unknown as typeof fetch;

        await new ResendMailer('re_test', 'Florence <hi@florence.example>', fake).sendSignInCode(
            'ada@example.com',
            '482913'
        );

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://api.resend.com/emails');
        expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
            'Bearer re_test'
        );
        const body = JSON.parse(calls[0].init.body as string);
        expect(body.to).toEqual(['ada@example.com']);
        expect(body.subject).toContain('482913');
    });

    it('throws when Resend refuses the message', async () => {
        const fake = (async () => new Response('{}', { status: 422 })) as unknown as typeof fetch;
        await expect(
            new ResendMailer('k', 'f@x.example', fake).sendSignInCode('a@b.example', '1')
        ).rejects.toThrow('422');
    });

    it('needs a key and a sender when the driver is resend', () => {
        expect(() =>
            loadConfig({ NODE_ENV: 'test', MAIL_DRIVER: 'resend' } as NodeJS.ProcessEnv)
        ).toThrow();
    });
});
