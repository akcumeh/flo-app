import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { session } from '../api';
import { ToastProvider } from '../components/ui';
import { googleSignInUrl } from '../lib/google';
import { AccountProvider } from '../state/AccountContext';
import { makeQueryClient } from '../state/query';
import { ACCOUNT, installFakeBackend, json } from '../test/fakeBackend';

function renderAt(path: string) {
    return render(
        <QueryClientProvider client={makeQueryClient()}>
            <MemoryRouter initialEntries={[path]}>
                <AccountProvider>
                    <ToastProvider>
                        <App />
                    </ToastProvider>
                </AccountProvider>
            </MemoryRouter>
        </QueryClientProvider>
    );
}

const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

beforeEach(() => {
    session.set(null);
    sessionStorage.clear();
});

afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
});

describe('Google sign-in', () => {
    it('sends the ID token Google returns and goes back where the student started', async () => {
        const fake = installFakeBackend({ signedIn: false });
        fake.on('POST', '/v1/auth/google', () =>
            json({
                accessToken: 'tok-g',
                expiresIn: 900,
                account: ACCOUNT,
                isNewAccount: false,
                welcomeGrant: { granted: false, tokens: 0 },
            })
        );
        fake.on('GET', '/v1/conversations', () => json({ items: [], nextCursor: null }));
        const url = new URL(googleSignInUrl('/ask/history'));
        expect(url.origin).toBe('https://accounts.google.com');
        expect(url.searchParams.get('response_type')).toBe('id_token');
        expect(url.searchParams.get('redirect_uri')).toBe(`${location.origin}/signin/google`);
        const nonce = url.searchParams.get('nonce');
        const state = url.searchParams.get('state')!;
        const idToken = `${b64({ alg: 'RS256' })}.${b64({ nonce, sub: '1' })}.sig`;
        window.history.replaceState(null, '', `/signin/google#id_token=${idToken}&state=${state}`);

        renderAt('/signin/google');

        await screen.findByRole('heading', { name: 'Chats' });
        expect(fake.calls.find((c) => c.path === '/v1/auth/google')?.body).toEqual({ idToken });
    });

    it('refuses a return that did not start here', async () => {
        const fake = installFakeBackend({ signedIn: false });
        const url = new URL(googleSignInUrl('/home'));
        const idToken = `${b64({ alg: 'RS256' })}.${b64({ nonce: 'other' })}.sig`;
        window.history.replaceState(
            null,
            '',
            `/signin/google#id_token=${idToken}&state=${url.searchParams.get('state')}`
        );
        renderAt('/signin/google');

        await screen.findByText('That sign-in did not start here. Try again.');
        await waitFor(() =>
            expect(fake.calls.some((c) => c.path === '/v1/auth/google')).toBe(false)
        );
    });
});
