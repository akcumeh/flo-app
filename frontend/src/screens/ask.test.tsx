import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { session } from '../api';
import { ToastProvider } from '../components/ui';
import { AccountProvider } from '../state/AccountContext';
import { makeQueryClient } from '../state/query';
import { installFakeBackend, json, problem, sse } from '../test/fakeBackend';

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

beforeEach(() => {
    session.set(null);
    localStorage.clear();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const answer = (text: string, extra: Array<[string, unknown]> = [], grounded = true) =>
    sse([
        ['message.start', { messageId: 'm1', charged: 1, balance: 9 }],
        ['delta', { text }],
        ...extra,
        ['message.end', { messageId: 'm1', balance: 9, grounded }],
    ]);

describe('Guest Ask', () => {
    it('answers the question from the website, then shows the save prompt after the last free one', async () => {
        const fake = installFakeBackend({ signedIn: false });
        fake.on('POST', '/v1/guest/sessions', () =>
            json({ guestToken: 'g-1', expiresAt: '2099-01-01T00:00:00Z', questionsLeft: 1 }, 201)
        );
        fake.on('POST', '/v1/guest/messages', () =>
            sse([
                ['message.start', { messageId: null, charged: 0, balance: null }],
                ['delta', { text: '1. Find the pKa\n2. Put in the ratio' }],
                [
                    'message.end',
                    { messageId: null, balance: null, grounded: false, questionsLeft: 0 },
                ],
            ])
        );
        renderAt('/ask?q=How%20do%20I%20find%20the%20pH%20of%20a%20buffer%3F&from=site');

        await screen.findByText('How do I find the pH of a buffer?');
        await screen.findByText('Find the pKa');
        expect(screen.getByText('Put in the ratio')).toBeInTheDocument();
        expect(
            screen.getByText(
                'General answer. Add your notes to get answers from your own course material.'
            )
        ).toBeInTheDocument();
        const send = fake.calls.find((c) => c.path === '/v1/guest/messages');
        expect(send?.headers.get('X-Guest-Token')).toBe('g-1');
        expect(send?.auth).toBeNull();
        expect(send?.body).toEqual({ text: 'How do I find the pH of a buffer?' });

        await screen.findByRole('dialog', { name: 'Save this and keep going?' });
        expect(screen.getByRole('button', { name: 'Continue with phone number' })).toBeEnabled();
    });

    it('shows the save prompt when the device has used its free questions', async () => {
        const fake = installFakeBackend({ signedIn: false });
        fake.on('POST', '/v1/guest/sessions', () =>
            json({ guestToken: 'g-2', expiresAt: '2099-01-01T00:00:00Z', questionsLeft: 3 }, 201)
        );
        fake.on('POST', '/v1/guest/messages', () =>
            problem(429, 'guest_limit_reached', 'You have used your free questions.')
        );
        const user = userEvent.setup();
        renderAt('/ask');

        await screen.findByRole('heading', { name: 'What do you want to understand?' });
        await user.type(screen.getByLabelText('Message'), 'What is osmosis?');
        await user.click(screen.getByRole('button', { name: 'Send' }));
        await screen.findByRole('dialog', { name: 'Save this and keep going?' });
        await user.click(screen.getByRole('button', { name: 'Continue with phone number' }));
        await screen.findByRole('heading', { name: 'Save your progress' });
    });

    it('moves the guest chat into the account after sign-in', async () => {
        localStorage.setItem(
            'florence.guest',
            JSON.stringify({ token: 'g-3', expiresAt: '2099-01-01T00:00:00Z', asked: true })
        );
        const fake = installFakeBackend();
        fake.on('POST', '/v1/guest/claim', () =>
            json({ id: 'conv-g', title: 'Buffers', mode: 'ask', lastMessageAt: null })
        );
        fake.on('GET', '/v1/conversations/conv-g/messages', () =>
            json({
                items: [
                    {
                        id: 'u1',
                        role: 'user',
                        text: 'How do buffers work?',
                        citations: [],
                        charged: 0,
                        grounded: true,
                        saved: false,
                        createdAt: '2026-11-12T09:00:00Z',
                    },
                    {
                        id: 'a1',
                        role: 'assistant',
                        text: 'A buffer resists pH change.',
                        citations: [],
                        charged: 0,
                        grounded: false,
                        saved: false,
                        createdAt: '2026-11-12T09:00:01Z',
                    },
                ],
                nextCursor: null,
            })
        );
        renderAt('/ask');

        await screen.findByText('A buffer resists pH change.');
        expect(fake.calls.find((c) => c.path === '/v1/guest/claim')?.body).toEqual({
            guestToken: 'g-3',
        });
        expect(localStorage.getItem('florence.guest')).toBeNull();
    });
});

describe('Ask', () => {
    it('flags a general answer, saves it and opens a cited passage', async () => {
        const fake = installFakeBackend();
        fake.on('POST', '/v1/conversations', () =>
            json({ id: 'conv-1', title: null, mode: 'ask', lastMessageAt: null }, 201)
        );
        fake.on('POST', '/v1/conversations/conv-1/messages', () =>
            answer('The Krebs cycle runs in the mitochondrial matrix.', [], false)
        );
        fake.on('PUT', '/v1/messages/m1/saved', () => new Response(null, { status: 204 }));
        const user = userEvent.setup();
        renderAt('/ask');

        await screen.findByRole('heading', { name: 'What do you want to understand?' });
        await user.click(screen.getByRole('button', { name: /Compare mitosis and meiosis/ }));
        await screen.findByText('The Krebs cycle runs in the mitochondrial matrix.');
        expect(
            screen.getByText("This isn't in your notes, so this is a general answer.")
        ).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Save answer' }));
        await waitFor(() =>
            expect(fake.calls.find((c) => c.path === '/v1/messages/m1/saved')?.body).toEqual({
                saved: true,
            })
        );
        expect(screen.getByRole('button', { name: 'Remove from saved' })).toHaveAttribute(
            'aria-pressed',
            'true'
        );
    });

    it('shows the passage behind a source chip', async () => {
        const fake = installFakeBackend();
        fake.on('POST', '/v1/conversations', () =>
            json({ id: 'conv-2', title: null, mode: 'ask', lastMessageAt: null }, 201)
        );
        fake.on('POST', '/v1/conversations/conv-2/messages', () =>
            answer('Osmosis moves water.', [
                [
                    'citation',
                    {
                        fileId: 'f1',
                        label: 'Lecture 4.pdf',
                        page: 6,
                        snippet: 'Osmosis is the net movement of water molecules.',
                    },
                ],
            ])
        );
        const user = userEvent.setup();
        renderAt('/ask');

        await screen.findByRole('heading', { name: 'What do you want to understand?' });
        await user.type(screen.getByLabelText('Message'), 'Explain osmosis');
        await user.click(screen.getByRole('button', { name: 'Send' }));
        await user.click(await screen.findByRole('button', { name: 'Lecture 4 · p. 6' }));
        const sheet = await screen.findByRole('dialog', { name: 'Lecture 4 · page 6' });
        expect(
            within(sheet).getByText('Osmosis is the net movement of water molecules.')
        ).toBeInTheDocument();
        expect(within(sheet).getByRole('button', { name: 'Open the full notes' })).toBeEnabled();
    });

    it('lists chats and opens one', async () => {
        const fake = installFakeBackend();
        fake.on('GET', '/v1/conversations', () =>
            json({
                items: [
                    { id: 'c1', title: 'Osmosis', mode: 'ask', lastMessageAt: null },
                    { id: 'c2', title: 'Krebs cycle', mode: 'ask', lastMessageAt: null },
                ],
                nextCursor: null,
            })
        );
        fake.on('GET', '/v1/conversations/c2/messages', () =>
            json({
                items: [
                    {
                        id: 'a2',
                        role: 'assistant',
                        text: 'It makes NADH.',
                        citations: [],
                        charged: 1,
                        grounded: true,
                        saved: true,
                        createdAt: '2026-11-12T09:00:01Z',
                    },
                ],
                nextCursor: null,
            })
        );
        const user = userEvent.setup();
        renderAt('/ask/history');

        await screen.findByRole('heading', { name: 'Chats' });
        await user.type(screen.getByLabelText('Search your chats'), 'krebs');
        const rows = within(screen.getByRole('list')).getAllByRole('button');
        expect(rows).toHaveLength(1);
        await user.click(rows[0]);
        await screen.findByText('It makes NADH.');
        expect(screen.getByRole('heading', { name: 'Krebs cycle' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Remove from saved' })).toBeInTheDocument();
    });
});
