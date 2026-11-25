import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { OutOfTokensProvider } from '../components/OutOfTokens';
import { ToastProvider } from '../components/ui';
import { leaveTo } from '../lib/leave';
import { AccountProvider } from '../state/AccountContext';
import { makeQueryClient } from '../state/query';
import { installFakeBackend, json, problem } from '../test/fakeBackend';

vi.mock('../lib/leave', () => ({ leaveTo: vi.fn() }));

function renderAt(path: string) {
    return render(
        <QueryClientProvider client={makeQueryClient()}>
            <MemoryRouter initialEntries={[path]}>
                <AccountProvider>
                    <ToastProvider>
                        <OutOfTokensProvider>
                            <App />
                        </OutOfTokensProvider>
                    </ToastProvider>
                </AccountProvider>
            </MemoryRouter>
        </QueryClientProvider>
    );
}

const BUNDLES = [
    { id: 'b_500', amountNaira: 500, tokens: 4 },
    { id: 'b_1000', amountNaira: 1000, tokens: 10 },
    { id: 'b_2500', amountNaira: 2500, tokens: 28 },
];

describe('Tokens', () => {
    beforeEach(() => vi.mocked(leaveTo).mockClear());

    it('shows the balance, real costs and recent ledger rows', async () => {
        const fake = installFakeBackend();
        fake.balance = 24;
        fake.on('GET', '/v1/tokens/ledger', () =>
            json({
                items: [
                    {
                        id: 2,
                        delta: -1,
                        reason: 'prep_charge',
                        balanceAfter: 24,
                        createdAt: '2026-11-20T10:00:00Z',
                        detail: '10 questions, Chemistry.pdf',
                    },
                    {
                        id: 1,
                        delta: 10,
                        reason: 'streak_reward',
                        balanceAfter: 25,
                        createdAt: '2026-11-19T10:00:00Z',
                        detail: null,
                    },
                ],
                nextCursor: null,
            })
        );
        renderAt('/tokens');
        expect(await screen.findByText('24')).toBeInTheDocument();
        expect(screen.getByText('Prep, per question (at least 3)')).toBeInTheDocument();
        expect(await screen.findByText('Streak reward')).toBeInTheDocument();
        expect(screen.getByText('+10')).toBeInTheDocument();
        expect(screen.getByText('−1')).toBeInTheDocument();
        expect(screen.getByText(/10 questions, Chemistry\.pdf ·/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    });

    it('shows 5 entries, then 25 after Show more', async () => {
        const fake = installFakeBackend();
        const limits: number[] = [];
        fake.on('GET', '/v1/tokens/ledger', (req) => {
            const limit = Number(new URL(req.url).searchParams.get('limit'));
            limits.push(limit);
            return json({
                items: Array.from({ length: limit }, (_, i) => ({
                    id: 100 - i,
                    delta: -1,
                    reason: 'chat_charge',
                    balanceAfter: 10,
                    createdAt: '2026-11-20T10:00:00Z',
                    detail: `Chat ${i}`,
                })),
                nextCursor: 'more',
            });
        });
        renderAt('/tokens');
        await screen.findByText(/Chat 4 ·/);
        expect(screen.getAllByText('Ask Florence')).toHaveLength(5);
        await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
        await screen.findByText(/Chat 24 ·/);
        expect(screen.getAllByText('Ask Florence')).toHaveLength(25);
        expect(limits).toEqual([5, 25]);
    });

    it('starts a Paystack payment and asks for an email when the account has none', async () => {
        const fake = installFakeBackend();
        fake.on('GET', '/v1/tokens/bundles', () => json({ items: BUNDLES }));
        let tries = 0;
        fake.on('POST', '/v1/tokens/purchases', () => {
            tries += 1;
            if (tries === 1) return problem(422, 'email_required', 'Add an email address.');
            return json(
                {
                    reference: 'FLO-1',
                    status: 'pending',
                    authorizationUrl: 'https://checkout.paystack.com/abc',
                },
                201
            );
        });
        const user = userEvent.setup();
        renderAt('/tokens/top-up');
        const plans = await screen.findByRole('radiogroup', { name: 'Token bundles' });
        expect(within(plans).getByText('Best value')).toBeInTheDocument();
        await user.click(within(plans).getByRole('radio', { name: /28 tokens/ }));
        await user.click(screen.getByRole('button', { name: 'Continue to payment' }));
        const field = await screen.findByLabelText('Email for your receipt');
        await user.type(field, 'ada@example.com');
        await user.click(screen.getByRole('button', { name: 'Continue to payment' }));
        await vi.waitFor(() =>
            expect(leaveTo).toHaveBeenCalledWith('https://checkout.paystack.com/abc')
        );
        const sent = fake.calls.filter((c) => c.path === '/v1/tokens/purchases');
        expect(sent[1].body).toEqual({ bundleId: 'b_2500', email: 'ada@example.com' });
        expect(sent[1].headers.get('Idempotency-Key')).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        );
    });

    it('confirms a payment on return from Paystack', async () => {
        const fake = installFakeBackend();
        fake.on('GET', '/v1/tokens/purchases/FLO-1', () =>
            json({ reference: 'FLO-1', status: 'success' })
        );
        renderAt('/tokens/return?reference=FLO-1');
        expect(
            await screen.findByRole('heading', { name: 'Payment received' })
        ).toBeInTheDocument();
    });

    it('opens the out-of-tokens sheet when a session cannot be paid for', async () => {
        const fake = installFakeBackend();
        fake.balance = 0;
        fake.on('GET', '/v1/files', () =>
            json({
                items: [
                    {
                        id: 'f1',
                        name: 'notes.pdf',
                        mimeType: 'application/pdf',
                        sizeBytes: 2048,
                        kind: 'document',
                        status: 'ready',
                        createdAt: '2026-11-10T20:10:00Z',
                    },
                ],
                nextCursor: null,
            })
        );
        fake.on('POST', '/v1/sessions', () =>
            problem(402, 'insufficient_tokens', 'You have no tokens left.')
        );
        const user = userEvent.setup();
        renderAt('/prep');
        await user.click(await screen.findByRole('button', { name: 'Practise' }));
        expect(await screen.findByText(/Uses 10 tokens, 1 per question/)).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: /^Quiz/ }));
        const sheet = await screen.findByRole('dialog', { name: 'You’re out of tokens' });
        expect(within(sheet).getByText(/needs 10 tokens and you have 0/)).toBeInTheDocument();
        await user.click(within(sheet).getByRole('button', { name: 'Top up' }));
        expect(await screen.findByRole('heading', { name: 'Get more tokens' })).toBeInTheDocument();
    });
});

describe('Contact support', () => {
    it('builds a WhatsApp message with the account details', async () => {
        const fake = installFakeBackend();
        fake.on('GET', '/v1/status', () =>
            json({
                maintenance: false,
                message: null,
                minClientVersion: '0.0.0',
                latestClientVersion: '0.0.0',
                support: { whatsapp: '2348000000000', email: 'help@example.com' },
            })
        );
        const user = userEvent.setup();
        const open = vi.spyOn(window, 'open').mockReturnValue(null);
        renderAt('/settings/support');
        await user.click(await screen.findByRole('button', { name: 'Chat on WhatsApp' }));
        const url = String(open.mock.calls[0][0]);
        expect(url).toMatch(/^https:\/\/wa\.me\/2348000000000\?text=/);
        expect(decodeURIComponent(url)).toContain('Hi Florence, I need help with');
        await user.click(screen.getByRole('button', { name: 'Email us instead' }));
        expect(leaveTo).toHaveBeenCalledWith(expect.stringMatching(/^mailto:help@example\.com/));
        open.mockRestore();
    });
});
