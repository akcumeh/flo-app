import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, formatSize, listCourses, uploadFiles } from '../api';
import { AppBar } from '../components/AppBar';
import { Icon } from '../components/Icon';
import { Button, useToast } from '../components/ui';
import s from './Library.module.scss';

interface Job {
    key: string;
    name: string;
    files: File[];
    size: number;
    sent: number;
    state: 'waiting' | 'sending' | 'done' | 'failed' | 'cancelled';
    error?: string;
    id?: string;
    abort: AbortController;
}

const sum = (files: File[]) => files.reduce((n, f) => n + f.size, 0);

function job(name: string, files: File[]): Job {
    return {
        key: `${name}-${Math.random()}`,
        name,
        files,
        size: sum(files),
        sent: 0,
        state: 'waiting',
        abort: new AbortController(),
    };
}

function caption(j: Job): string {
    if (j.state === 'done') return `Done · ${formatSize(j.size)}`;
    if (j.state === 'sending') return `${formatSize(j.sent)} of ${formatSize(j.size)}`;
    if (j.state === 'failed') return j.error ?? 'Could not upload this file.';
    if (j.state === 'cancelled') return 'Cancelled';
    return 'Waiting';
}

export function AddNotesScreen() {
    const navigate = useNavigate();
    const toast = useToast();
    const queryClient = useQueryClient();
    const [params] = useSearchParams();
    const courseId = params.get('course') ?? undefined;
    const courses = useQuery({ queryKey: ['courses'], queryFn: listCourses });
    const code = courses.data?.find((e) => e.course.id === courseId)?.course.code;
    const fileInput = useRef<HTMLInputElement>(null);
    const [jobs, setJobs] = useState<Job[] | null>(null);
    const left = useRef(false);

    useEffect(() => {
        left.current = false;
        return () => {
            left.current = true;
        };
    }, []);

    const update = (key: string, patch: Partial<Job>) =>
        setJobs((prev) => prev?.map((j) => (j.key === key ? { ...j, ...patch } : j)) ?? prev);

    const run = async (list: Job[]) => {
        setJobs(list);
        const saved: string[] = [];
        for (const j of list) {
            if (j.abort.signal.aborted) continue;
            update(j.key, { state: 'sending' });
            try {
                const file = await uploadFiles(j.files, {
                    courseId,
                    signal: j.abort.signal,
                    onProgress: (sent) => update(j.key, { sent }),
                });
                saved.push(file.id);
                update(j.key, { state: 'done', sent: j.size, id: file.id });
            } catch (err) {
                if (err instanceof DOMException && err.name === 'AbortError') {
                    update(j.key, { state: 'cancelled' });
                } else {
                    update(j.key, {
                        state: 'failed',
                        error: err instanceof ApiError ? err.message : undefined,
                    });
                }
            }
        }
        void queryClient.invalidateQueries({ queryKey: ['files'] });
        if (left.current) {
            if (saved.length > 0) toast('Florence is reading your notes.');
            return;
        }
        if (saved.length === 1 && list.length === 1) {
            navigate(`/library/${saved[0]}`, { replace: true });
        } else if (saved.length === list.length) {
            navigate('/library', { replace: true });
        }
    };

    const pickFiles = (picked: FileList | null) => {
        if (!picked || picked.length === 0) return;
        void run([...picked].map((f) => job(f.name, [f])));
    };

    const inputs = (
        <>
            <input
                ref={fileInput}
                type="file"
                accept="application/pdf,.pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                multiple
                hidden
                data-testid="file-input"
                onChange={(e) => {
                    pickFiles(e.target.files);
                    e.target.value = '';
                }}
            />
        </>
    );

    if (jobs) {
        const n = jobs.length;
        const finished = jobs.every((j) => j.state !== 'waiting' && j.state !== 'sending');
        return (
            <div className={s.page}>
                <AppBar title="Uploading" back="/library" />
                <main className={`${s.content} ${s.loose}`}>
                    <h2 className={s.title}>
                        Uploading {n} {n === 1 ? 'file' : 'files'}
                    </h2>
                    <ul className={`${s.box} ${s.boxGap16}`}>
                        {jobs.map((j) => (
                            <li key={j.key} className={s.upload}>
                                <span
                                    className={`${s.uploadIcon} ${j.state === 'done' ? s.uploadDone : ''}`}
                                >
                                    <Icon name="file-text" />
                                </span>
                                <span className={s.uploadText}>
                                    <span className={s.uploadName}>{j.name}</span>
                                    <span
                                        className={s.bar}
                                        role="progressbar"
                                        aria-label={`${j.name} upload`}
                                        aria-valuemin={0}
                                        aria-valuemax={j.size}
                                        aria-valuenow={j.sent}
                                    >
                                        <span
                                            className={`${s.barFill} ${j.state === 'done' ? s.barDone : ''}`}
                                            style={{
                                                display: 'block',
                                                width: `${j.size ? Math.round((j.sent / j.size) * 100) : 0}%`,
                                            }}
                                        />
                                    </span>
                                    <span
                                        className={`${s.caption} ${j.state === 'failed' ? s.rowError : ''}`}
                                    >
                                        {caption(j)}
                                    </span>
                                </span>
                                {j.state === 'done' ? (
                                    <Icon name="check-circle-fill" className={s.tick} />
                                ) : j.state === 'waiting' || j.state === 'sending' ? (
                                    <button
                                        type="button"
                                        className={s.caret}
                                        aria-label={`Cancel ${j.name}`}
                                        onClick={() => j.abort.abort()}
                                    >
                                        <Icon name="x" />
                                    </button>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                    <p className={s.caption}>
                        You can leave this screen. Library shows each file when it's ready.
                    </p>
                </main>
                <div className={s.spacer} />
                <div className={s.footer}>
                    {finished ? (
                        <Button block onClick={() => navigate('/library', { replace: true })}>
                            Go to Library
                        </Button>
                    ) : (
                        <Button
                            variant="secondary"
                            block
                            onClick={() => navigate('/library', { replace: true })}
                        >
                            Continue in the background
                        </Button>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className={s.page}>
            <AppBar title="Add notes" />
            <main className={`${s.content} ${s.loose}`}>
                <h2 className={s.title}>{code ? `Add notes to ${code}` : 'Add notes'}</h2>
                <p className={s.lead}>
                    Lecture slides, handouts and past questions all work, as PDF or Word files.
                </p>
                <button type="button" className={s.tile} onClick={() => fileInput.current?.click()}>
                    <span className={s.tileIcon}>
                        <Icon name="file-text" />
                    </span>
                    <span className={s.tileText}>
                        <span className={s.tileTitle}>Upload a file</span>
                        <span className={s.tileBody}>PDF or Word, up to 20 MB</span>
                    </span>
                    <Icon name="caret-right" className={s.caret} />
                </button>
                <p className={s.notice} role="note">
                    <Icon name="info" />
                    Photos of notes are paused for now. Scan or export your notes as a PDF or Word
                    file.
                </p>
                <p className={s.private}>
                    <Icon name="lock-small" />
                    Your notes are private. Only you can practise from them.
                </p>
            </main>
            {inputs}
        </div>
    );
}
