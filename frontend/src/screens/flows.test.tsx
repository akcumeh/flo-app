import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { session } from '../api';
import { ToastProvider } from '../components/ui';
import { AccountProvider } from '../state/AccountContext';
import { makeQueryClient } from '../state/query';
import { ACCOUNT, installFakeBackend, json, problem, sse } from '../test/fakeBackend';

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
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('Sign-in', () => {
    it('sends a WhatsApp code, verifies it and returns to the page the student asked for', async () => {
        const fake = installFakeBackend({ signedIn: false });
        fake.on('POST', '/v1/auth/whatsapp/start', () =>
            json({ phone: '2348031234567', display: '0803 123 4567', resendAfter: 30 }, 202)
        );
        fake.on('POST', '/v1/auth/whatsapp/verify', () =>
            json({
                accessToken: 'tok-new',
                expiresIn: 900,
                account: ACCOUNT,
                isNewAccount: false,
                welcomeGrant: { granted: false, tokens: 0 },
            })
        );
        const user = userEvent.setup();
        renderAt('/ask');

        await screen.findByRole('heading', { name: 'Save your progress' });
        await user.type(screen.getByLabelText('Phone number'), '0803 123 4567');
        await user.click(screen.getByRole('button', { name: 'Send code' }));

        await screen.findByRole('heading', { name: 'Enter the 6-digit code' });
        expect(screen.getByText('We sent it on WhatsApp to 0803 123 4567.')).toBeInTheDocument();
        await user.type(screen.getByLabelText('Digit 1'), '482913');

        await screen.findByRole('heading', { name: 'Ask anything about your course.' });
        expect(fake.calls.find((c) => c.path === '/v1/auth/whatsapp/start')?.body).toEqual({
            phone: '0803 123 4567',
        });
        expect(fake.calls.find((c) => c.path === '/v1/auth/whatsapp/verify')?.body).toEqual({
            phone: '2348031234567',
            code: '482913',
        });
        expect(fake.calls.find((c) => c.path === '/v1/streak')?.auth).toBe('Bearer tok-new');
    });

    it('shows the server message when the code is wrong', async () => {
        const fake = installFakeBackend({ signedIn: false });
        fake.on('POST', '/v1/auth/whatsapp/start', () =>
            json({ phone: '2348031234567', display: '0803 123 4567', resendAfter: 30 }, 202)
        );
        fake.on('POST', '/v1/auth/whatsapp/verify', () =>
            problem(400, 'invalid_code', 'That code is wrong.')
        );
        const user = userEvent.setup();
        renderAt('/signin');
        await user.type(await screen.findByLabelText('Phone number'), '0803 123 4567');
        await user.click(screen.getByRole('button', { name: 'Send code' }));
        await user.type(await screen.findByLabelText('Digit 1'), '000000');
        expect(await screen.findByRole('alert')).toHaveTextContent("That code didn't work");
    });

    it('signs in through Telegram: opens the bot, waits for Start, then redeems', async () => {
        const fake = installFakeBackend({ signedIn: false });
        vi.stubGlobal(
            'open',
            vi.fn(() => null)
        );
        let polls = 0;
        fake.on('POST', '/v1/auth/challenges', () =>
            json(
                {
                    challengeId: 'chal-secret-1234567890',
                    code: 'FLO-482913',
                    deepLink: 'https://t.me/FlorenceAIBot?start=login_FLO-482913',
                    expiresAt: '2026-11-12T21:10:00Z',
                },
                201
            )
        );
        fake.on('GET', '/v1/auth/challenges/chal-secret-1234567890', () => {
            polls += 1;
            return json({
                status: polls > 1 ? 'verified' : 'pending',
                expiresAt: '2026-11-12T21:10:00Z',
            });
        });
        fake.on('POST', '/v1/auth/challenges/chal-secret-1234567890/redeem', () =>
            json({
                accessToken: 'tok-tg',
                expiresIn: 900,
                account: ACCOUNT,
                isNewAccount: false,
                welcomeGrant: { granted: false, tokens: 0 },
            })
        );
        const user = userEvent.setup();
        renderAt('/signin');

        await user.click(await screen.findByRole('button', { name: 'Continue with Telegram' }));
        await screen.findByRole('heading', { name: 'Tap Start in Telegram' });
        expect(screen.getByRole('link', { name: 'Open Telegram' })).toHaveAttribute(
            'href',
            'https://t.me/FlorenceAIBot?start=login_FLO-482913'
        );
        expect(fake.calls.find((c) => c.path === '/v1/auth/challenges')?.body).toEqual({
            channel: 'telegram',
            intent: 'signin',
        });

        await screen.findByRole('heading', { name: /Ada/ }, { timeout: 8000 });
        expect(polls).toBe(2);
        expect(fake.calls.find((c) => c.path === '/v1/streak')?.auth).toBe('Bearer tok-tg');
    }, 15000);

    it('shows the server message when WhatsApp cannot reach the number', async () => {
        const fake = installFakeBackend({ signedIn: false });
        fake.on('POST', '/v1/auth/whatsapp/start', () =>
            problem(
                422,
                'whatsapp_send_failed',
                "We couldn't send a WhatsApp message to that number. Check it and try again."
            )
        );
        const user = userEvent.setup();
        renderAt('/signin');
        await user.type(await screen.findByLabelText('Phone number'), '0803 000 0000');
        await user.click(screen.getByRole('button', { name: 'Send code' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(
            "We couldn't send a WhatsApp message"
        );
    });

    it('restores the session from the refresh cookie and refreshes once on a 401', async () => {
        const fake = installFakeBackend();
        let first = true;
        fake.on('GET', '/v1/home', () => {
            if (first) {
                first = false;
                return problem(401, 'token_expired', 'Expired.');
            }
            return json({
                variant: 'today',
                streak: { current: 3, longest: 5, state: 'active', studiedToday: false },
                exam: null,
            });
        });
        renderAt('/home');
        await screen.findByRole('heading', { name: /Ada/ });
        await waitFor(() =>
            expect(fake.calls.filter((c) => c.path === '/v1/home')).toHaveLength(2)
        );
        expect(
            fake.calls.filter((c) => c.path === '/v1/auth/refresh').length
        ).toBeGreaterThanOrEqual(2);
    });

    it('shows "Please log in again" when the refresh cookie stops working', async () => {
        const fake = installFakeBackend();
        fake.on('GET', '/v1/home', () => {
            fake.signedIn = false;
            return problem(401, 'token_expired', 'Expired.');
        });
        renderAt('/home');
        expect(
            await screen.findByRole('heading', { name: 'Please log in again' })
        ).toBeInTheDocument();
    });
});

describe('Onboarding and profile', () => {
    it('sends a new account through school, department and level, then home', async () => {
        const fake = installFakeBackend();
        let profile: Record<string, unknown> = {
            school: null,
            department: null,
            level: null,
            examDate: null,
            onboardingComplete: false,
        };
        fake.on('GET', '/v1/me', () => json({ ...ACCOUNT, profile }));
        fake.on('GET', '/v1/schools', () =>
            json({
                items: [
                    {
                        id: 'unilag',
                        name: 'University of Lagos (UNILAG)',
                        country: 'NG',
                        kind: 'university',
                    },
                    {
                        id: 'ui',
                        name: 'University of Ibadan (UI)',
                        country: 'NG',
                        kind: 'university',
                    },
                ],
            })
        );
        fake.on('GET', '/v1/schools/unilag/departments', () =>
            json({ items: [{ id: 'mcb', name: 'Microbiology' }] })
        );
        fake.on('PUT', '/v1/me/profile', async (req) => {
            const body = (await req.json()) as Record<string, unknown>;
            if (body.schoolId)
                profile = {
                    ...profile,
                    school: {
                        id: 'unilag',
                        name: 'University of Lagos (UNILAG)',
                        country: 'NG',
                        kind: 'university',
                    },
                };
            if (body.departmentId)
                profile = { ...profile, department: { id: 'mcb', name: 'Microbiology' } };
            if (body.level) profile = { ...profile, level: body.level, onboardingComplete: true };
            return json(profile);
        });
        const user = userEvent.setup();
        renderAt('/home');

        await screen.findByRole('heading', { name: 'Where do you study?' });
        await user.click(await screen.findByRole('radio', { name: /University of Lagos/ }));
        await user.click(screen.getByRole('button', { name: 'Continue' }));

        await screen.findByRole('heading', { name: 'What are you studying?' });
        await user.type(screen.getByLabelText('Department'), 'Microbiology');
        await user.click(screen.getByRole('radio', { name: /200L/ }));
        await user.click(screen.getByRole('button', { name: 'Continue' }));

        await screen.findByRole('heading', { name: "Pick this semester's courses" });
        const puts = fake.calls.filter((c) => c.path === '/v1/me/profile').map((c) => c.body);
        expect(puts).toEqual([{ schoolId: 'unilag' }, { departmentId: 'mcb', level: 200 }]);
    });

    it('logs out from Profile and lands on sign-in', async () => {
        const fake = installFakeBackend();
        const user = userEvent.setup();
        renderAt('/profile');
        await user.click(await screen.findByRole('button', { name: 'Log out' }));
        const dialog = await screen.findByRole('dialog', { name: 'Log out?' });
        fake.signedIn = false;
        await user.click(within(dialog).getByRole('button', { name: 'Log out' }));
        await screen.findByRole('heading', { name: 'Save your progress' });
        expect(fake.calls.some((c) => c.path === '/v1/auth/logout')).toBe(true);
    });
});

describe('Ask', () => {
    it('creates a conversation, streams the answer with its sources and updates the balance', async () => {
        const fake = installFakeBackend();
        fake.on('POST', '/v1/conversations', () =>
            json(
                {
                    id: 'conv-1',
                    title: null,
                    createdAt: '2026-11-12T09:00:00Z',
                    lastMessageAt: null,
                },
                201
            )
        );
        fake.on('POST', '/v1/conversations/conv-1/messages', () => {
            fake.balance = 9;
            return sse([
                ['message.start', { messageId: 'm1', charged: 1, balance: 9 }],
                ['delta', { text: 'Ribosomes build proteins. ' }],
                ['delta', { text: 'They need ATP from mitochondria.' }],
                ['citation', { fileId: 'f1', label: 'BIO 102.pdf', page: 14 }],
                ['citation', { fileId: 'f1', label: 'BIO 102.pdf', page: 17 }],
                ['message.end', { messageId: 'm1', balance: 9, grounded: true }],
            ]);
        });
        const user = userEvent.setup();
        renderAt('/ask');

        await waitFor(() =>
            expect(screen.getAllByLabelText('10 tokens').length).toBeGreaterThan(0)
        );
        await user.type(screen.getByLabelText('Message'), 'Why does protein building slow down?');
        await user.click(screen.getByRole('button', { name: 'Send' }));

        await screen.findByText(/They need ATP from mitochondria/);
        await screen.findByText('Cited on pages 14 and 17');
        expect(screen.getAllByLabelText('9 tokens').length).toBeGreaterThan(0);
        const send = fake.calls.find((c) => c.path === '/v1/conversations/conv-1/messages');
        expect(send?.body).toEqual({ text: 'Why does protein building slow down?' });
        expect(send?.headers.get('Idempotency-Key')).toMatch(/.+/);
    });
});

describe('Prep', () => {
    it('starts a session from a file, waits for generation and shows the verdict', async () => {
        const fake = installFakeBackend();
        const file = {
            id: 'f1',
            name: 'BIO 102.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 20480,
            kind: 'document',
            status: 'ready',
            createdAt: '2026-11-10T20:10:00Z',
        };
        const item = {
            id: 0,
            type: 'mcq',
            prompt: 'Main site of ATP production?',
            options: ['Golgi apparatus', 'Mitochondrion'],
            marks: 1,
            difficulty: 'easy',
            topic: 'Cells',
            sourceLabel: 'BIO 102.pdf, p. 1',
            state: 'unanswered',
        };
        const base = {
            id: 's1',
            mode: 'quiz',
            requestedCount: 10,
            generatedCount: 1,
            currentIndex: 0,
            cost: 1,
            refunded: false,
            switchableModes: ['quiz'],
            expiresAt: '2026-11-14T09:00:00Z',
        };
        let polls = 0;
        fake.on('GET', '/v1/files', () => json({ items: [file], nextCursor: null }));
        fake.on('POST', '/v1/sessions', () =>
            json({ ...base, status: 'generating', items: [] }, 202)
        );
        fake.on('GET', '/v1/sessions/s1', () => {
            polls += 1;
            return json({
                ...base,
                status: polls > 1 ? 'active' : 'generating',
                items: polls > 1 ? [item] : [],
            });
        });
        fake.on('POST', '/v1/sessions/s1/answers', () =>
            json({
                itemId: 0,
                result: 'not_quite',
                awardedMarks: 0,
                maxMarks: 1,
                studyDay: { counted: false, streak: 3 },
                correctAnswer: 'Mitochondrion',
                whyRight: 'Mitochondria make ATP.',
                whyOthersFail: [],
                examTip: 'Energy means mitochondria.',
                source: { fileId: 'f1', label: 'BIO 102.pdf', page: 1 },
            })
        );
        const user = userEvent.setup();
        renderAt('/prep');
        await user.click(await screen.findByRole('button', { name: 'Start quiz' }));
        await user.click(
            await screen.findByRole('button', { name: /Golgi apparatus/ }, { timeout: 5000 })
        );
        await screen.findByText('Not quite.');
        const answer = fake.calls.find((c) => c.path === '/v1/sessions/s1/answers');
        expect(answer?.body).toMatchObject({ itemId: 0, answer: 'Golgi apparatus' });
        expect(answer?.headers.get('Idempotency-Key')).toMatch(/.+/);
    });
});
