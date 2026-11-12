import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { session } from '../api';
import { ToastProvider } from '../components/ui';
import { AccountProvider } from '../state/AccountContext';
import { makeQueryClient } from '../state/query';
import { installFakeBackend, json } from '../test/fakeBackend';

const BIO = { id: 'c-bio', code: 'BIO201', title: null, schoolId: 'unilag' };
const MCB = { id: 'c-mcb', code: 'MCB201', title: null, schoolId: 'unilag' };

const file = (over: Record<string, unknown>) => ({
    id: 'f1',
    name: 'Lecture 4 · Transport.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 4_300_000,
    kind: 'document',
    status: 'ready',
    pageCount: 12,
    courseId: BIO.id,
    topics: [],
    error: null,
    createdAt: '2026-10-02T10:00:00Z',
    ...over,
});

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

interface SentUpload {
    url: string;
    auth: string | null;
    form: FormData;
}

function stubUpload(reply: () => { status: number; body: unknown }) {
    const sent: SentUpload[] = [];
    class FakeXhr {
        status = 0;
        responseText = '';
        upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onabort: (() => void) | null = null;
        withCredentials = false;
        private url = '';
        private headers: Record<string, string> = {};
        open(_method: string, url: string) {
            this.url = url;
        }
        setRequestHeader(k: string, v: string) {
            this.headers[k] = v;
        }
        abort() {
            this.onabort?.();
        }
        send(form: FormData) {
            sent.push({ url: this.url, auth: this.headers.Authorization ?? null, form });
            setTimeout(() => {
                this.upload.onprogress?.({
                    lengthComputable: true,
                    loaded: 50,
                    total: 100,
                } as ProgressEvent);
                const r = reply();
                this.status = r.status;
                this.responseText = JSON.stringify(r.body);
                this.onload?.();
            }, 0);
        }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    return sent;
}

beforeEach(() => {
    session.set(null);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('Library', () => {
    it('shows the empty state and opens Add notes', async () => {
        const fake = installFakeBackend();
        fake.on('GET', '/v1/files', () => json({ items: [] }));
        const user = userEvent.setup();
        renderAt('/library');

        await screen.findByRole('heading', { name: 'No notes yet' });
        await user.click(
            within(screen.getByRole('main')).getByRole('button', { name: 'Upload notes' })
        );
        await screen.findByRole('heading', { name: 'Add notes', level: 2 });
        expect(
            screen.getByText('Your notes are private. Only you can practise from them.')
        ).toBeInTheDocument();
    });

    it('filters by course and by name, and shows reading and failed files', async () => {
        const fake = installFakeBackend();
        fake.on('GET', '/v1/me/courses', () =>
            json({
                items: [
                    { course: BIO, fileCount: 2, mastery: null },
                    { course: MCB, fileCount: 1, mastery: null },
                ],
            })
        );
        fake.on('GET', '/v1/files', () =>
            json({
                items: [
                    file({}),
                    file({ id: 'f2', name: 'Handwritten · 6 pages', status: 'reading' }),
                    file({
                        id: 'f3',
                        name: 'Bacterial growth.pdf',
                        courseId: MCB.id,
                        status: 'failed',
                        error: 'The scan is too blurry.',
                    }),
                ],
            })
        );
        const user = userEvent.setup();
        renderAt('/library');

        const list = await screen.findByRole('list');
        expect(within(list).getAllByRole('button')).toHaveLength(3);
        expect(within(list).getByText('Reading')).toBeInTheDocument();
        expect(within(list).getByText("Couldn't read")).toBeInTheDocument();
        expect(screen.getByText('3 files · 12.3 MB')).toBeInTheDocument();

        await user.click(await screen.findByRole('button', { name: 'MCB201' }));
        expect(screen.getByRole('button', { name: 'MCB201' })).toHaveAttribute(
            'aria-pressed',
            'true'
        );
        expect(within(screen.getByRole('list')).getAllByRole('button')).toHaveLength(1);

        await user.click(screen.getByRole('button', { name: 'All' }));
        await user.type(screen.getByLabelText('Search your notes'), 'transport');
        const rows = within(screen.getByRole('list')).getAllByRole('button');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toHaveTextContent('Lecture 4 · Transport.pdf');
    });

    it('uploads a PDF with progress, then reads it until topics appear', async () => {
        const fake = installFakeBackend();
        fake.on('GET', '/v1/me/courses', () =>
            json({ items: [{ course: BIO, fileCount: 0, mastery: null }] })
        );
        let polls = 0;
        fake.on('GET', '/v1/files/f9', () => {
            polls += 1;
            return json(
                polls < 2
                    ? file({ id: 'f9', status: 'reading', topics: [] })
                    : file({
                          id: 'f9',
                          topics: [
                              { id: 't1', name: 'Osmosis' },
                              { id: 't2', name: 'Active transport' },
                          ],
                      })
            );
        });
        const sent = stubUpload(() => ({
            status: 201,
            body: file({ id: 'f9', status: 'reading' }),
        }));
        const user = userEvent.setup();
        renderAt(`/library/add?course=${BIO.id}`);

        await screen.findByRole('heading', { name: 'Add notes to BIO201' });
        const pdf = new File(['%PDF-1.7'], 'Lecture 4 · Transport.pdf', {
            type: 'application/pdf',
        });
        await user.upload(screen.getByTestId('file-input'), pdf);

        await screen.findByRole('heading', { name: 'Reading your notes' });
        expect(sent).toHaveLength(1);
        expect(sent[0].auth).toBe('Bearer tok-1');
        expect(sent[0].form.get('courseId')).toBe(BIO.id);
        expect((sent[0].form.get('pages') as File).name).toBe('Lecture 4 · Transport.pdf');

        await screen.findByText('Osmosis', {}, { timeout: 4000 });
        expect(screen.getByText('BIO201 · 12 pages · added 2 Oct')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Practise from this file' })).toBeEnabled();
    });

    it('groups camera pages into one upload', async () => {
        installFakeBackend();
        const sent = stubUpload(() => ({
            status: 201,
            body: file({ id: 'f7', status: 'reading' }),
        }));
        const user = userEvent.setup();
        renderAt('/library/add');

        await screen.findByRole('heading', { name: 'Add notes', level: 2 });
        const page = (n: number) => new File(['x'], `p${n}.jpg`, { type: 'image/jpeg' });
        await user.upload(screen.getByTestId('photo-input'), [page(1), page(2)]);
        await screen.findByRole('heading', { name: '2 pages' });
        await user.upload(screen.getByTestId('photo-input'), page(3));
        await user.click(screen.getByRole('button', { name: 'Remove page 2' }));
        await user.click(screen.getByRole('button', { name: 'Done (2)' }));

        await waitFor(() => expect(sent).toHaveLength(1));
        expect((sent[0].form.getAll('pages') as File[]).map((f) => f.name)).toEqual([
            'p1.jpg',
            'p3.jpg',
        ]);
    });

    it('shows why a file failed and deletes it after confirming', async () => {
        const fake = installFakeBackend();
        fake.on('GET', '/v1/files/f3', () =>
            json(file({ id: 'f3', status: 'failed', error: 'The scan is too blurry.' }))
        );
        fake.on('DELETE', '/v1/files/f3', () => new Response(null, { status: 204 }));
        fake.on('GET', '/v1/files', () => json({ items: [] }));
        const user = userEvent.setup();
        renderAt('/library/f3');

        await screen.findByRole('heading', { name: "We couldn't read this file" });
        expect(screen.getByText('The scan is too blurry.')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Delete file' }));
        const dialog = await screen.findByRole('dialog', { name: 'Delete this file?' });
        await user.click(within(dialog).getByRole('button', { name: 'Delete file' }));

        await screen.findByRole('heading', { name: 'No notes yet' });
        expect(fake.calls.some((c) => c.method === 'DELETE' && c.path === '/v1/files/f3')).toBe(
            true
        );
        expect(screen.getByText('File deleted')).toBeInTheDocument();
    });
});
