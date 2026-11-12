import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, deleteFile, getFile, listCourses, type StoredFile } from '../api';
import { AppBar } from '../components/AppBar';
import { Icon } from '../components/Icon';
import { Button, Dialog, ErrorState, Skeleton, useToast } from '../components/ui';
import s from './Library.module.scss';

const reading = (f: StoredFile | undefined) => f?.status === 'uploading' || f?.status === 'reading';

const added = (iso: string) =>
    new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function Reading() {
    return (
        <main className={`${s.content} ${s.loose}`}>
            <Icon name="asterisk-large" className={s.asterisk} />
            <h2 className={s.title}>Reading your notes</h2>
            <p className={s.lead}>Topics appear as Florence finds them. Usually under a minute.</p>
            <div className={s.box} aria-busy="true" aria-label="Finding topics">
                {[180, 140].map((w) => (
                    <div key={w} className={s.pending}>
                        <Skeleton width={20} height={20} radius={12} />
                        <Skeleton width={w} height={14} radius={12} />
                    </div>
                ))}
            </div>
        </main>
    );
}

export function MaterialScreen() {
    const { id = '' } = useParams();
    const navigate = useNavigate();
    const toast = useToast();
    const queryClient = useQueryClient();
    const [confirm, setConfirm] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const file = useQuery({
        queryKey: ['file', id],
        queryFn: () => getFile(id),
        refetchInterval: (q) => (reading(q.state.data) ? 2000 : false),
    });
    const courses = useQuery({ queryKey: ['courses'], queryFn: listCourses });
    const f = file.data;
    const code = courses.data?.find((e) => e.course.id === f?.courseId)?.course.code;

    const remove = async () => {
        setDeleting(true);
        try {
            await deleteFile(id);
            await queryClient.invalidateQueries({ queryKey: ['files'] });
            toast('File deleted');
            navigate('/library', { replace: true });
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Could not delete this file.');
            setConfirm(false);
        } finally {
            setDeleting(false);
        }
    };

    const practise = async () => {
        setStarting(true);
        setError(null);
        try {
            const session = await api.createPrepSession([id], 10);
            navigate(`/prep/${session.id}`);
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Could not start a session.');
        } finally {
            setStarting(false);
        }
    };

    const deleteButton = (
        <button type="button" className={s.danger} onClick={() => setConfirm(true)}>
            Delete file
        </button>
    );

    let body;
    if (file.isError) {
        body = <ErrorState onRetry={() => void file.refetch()} />;
    } else if (!f) {
        body = (
            <main className={s.content} aria-busy="true">
                <Skeleton width={220} height={18} />
                <Skeleton height={120} radius={24} />
            </main>
        );
    } else if (reading(f)) {
        body = <Reading />;
    } else if (f.status === 'failed') {
        body = (
            <>
                <main className={`${s.content} ${s.loose}`}>
                    <span className={s.warn}>
                        <Icon name="warning-fill" />
                    </span>
                    <h2 className={s.title}>We couldn't read this file</h2>
                    <p className={s.lead}>
                        {f.error ?? 'Try a clearer copy in good light, or a different file.'}
                    </p>
                    {error ? (
                        <p className={s.error} role="alert">
                            {error}
                        </p>
                    ) : null}
                </main>
                <div className={s.spacer} />
                <div className={s.footer}>
                    <Button block onClick={() => navigate('/library/add')}>
                        Try another file
                    </Button>
                    {deleteButton}
                </div>
            </>
        );
    } else {
        const meta = [
            code,
            f.pageCount ? `${f.pageCount} ${f.pageCount === 1 ? 'page' : 'pages'}` : null,
            `added ${added(f.createdAt)}`,
        ]
            .filter(Boolean)
            .join(' · ');
        const topics = f.topics ?? [];
        body = (
            <>
                <main className={`${s.content} ${s.loose}`}>
                    <p className={s.lead}>{meta}</p>
                    {topics.length > 0 ? (
                        <>
                            <h2 className={s.label}>Topics found</h2>
                            <ul className={s.chips}>
                                {topics.map((t) => (
                                    <li key={t.id} className={s.chip}>
                                        {t.name}
                                    </li>
                                ))}
                            </ul>
                        </>
                    ) : null}
                    {error ? (
                        <p className={s.error} role="alert">
                            {error}
                        </p>
                    ) : null}
                </main>
                <div className={s.spacer} />
                <div className={s.footer}>
                    <Button block loading={starting} onClick={() => void practise()}>
                        Practise from this file
                    </Button>
                    {deleteButton}
                </div>
            </>
        );
    }

    return (
        <div className={s.page}>
            <AppBar title={f && !reading(f) && f.status !== 'failed' ? f.name : undefined} />
            {body}
            <Dialog open={confirm} onClose={() => setConfirm(false)} title="Delete this file?">
                <p className={s.lead}>
                    Florence forgets its pages and topics. Chats that cited it keep their text.
                </p>
                <div className={s.actions}>
                    <Button block loading={deleting} onClick={() => void remove()}>
                        Delete file
                    </Button>
                    <Button variant="ghost" block onClick={() => setConfirm(false)}>
                        Cancel
                    </Button>
                </div>
            </Dialog>
        </div>
    );
}
