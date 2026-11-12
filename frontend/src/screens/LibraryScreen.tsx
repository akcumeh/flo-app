import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, formatSize, listCourses, type StoredFile } from '../api';
import { AppBar, AppBarButton } from '../components/AppBar';
import { Icon } from '../components/Icon';
import { Button, ErrorState, Sheet, Skeleton } from '../components/ui';
import s from './Library.module.scss';

const busy = (f: StoredFile) => f.status === 'uploading' || f.status === 'reading';

export function NotesEmpty({ onUpload }: { onUpload: () => void }) {
    return (
        <div className={s.empty}>
            <div className={s.art} aria-hidden="true">
                <span className={s.artBack} />
                <span className={s.artMid} />
                <span className={s.artFront} />
            </div>
            <h2 className={s.emptyTitle}>No notes yet</h2>
            <p className={s.lead}>
                Upload your lecture notes and Florence will turn them into practice questions.
            </p>
            <Button onClick={onUpload}>Upload notes</Button>
        </div>
    );
}

function status(file: StoredFile, code: string | undefined) {
    if (file.status === 'failed') return <span className={s.rowError}>Couldn't read</span>;
    if (busy(file)) return 'Reading';
    return code ?? null;
}

export function LibraryScreen() {
    const navigate = useNavigate();
    const [query, setQuery] = useState('');
    const [course, setCourse] = useState<string | null>(null);
    const [menu, setMenu] = useState(false);
    const files = useQuery({
        queryKey: ['files'],
        queryFn: () => api.listFiles(),
        refetchInterval: (q) => (q.state.data?.some(busy) ? 3000 : false),
    });
    const courses = useQuery({ queryKey: ['courses'], queryFn: listCourses });

    const codes = useMemo(
        () => new Map((courses.data ?? []).map((e) => [e.course.id, e.course.code])),
        [courses.data]
    );
    const used = (courses.data ?? []).filter((e) =>
        files.data?.some((f) => f.courseId === e.course.id)
    );
    const needle = query.trim().toLowerCase();
    const shown = (files.data ?? []).filter(
        (f) =>
            (!course || f.courseId === course) && (!needle || f.name.toLowerCase().includes(needle))
    );
    const total = (files.data ?? []).reduce((sum, f) => sum + f.sizeBytes, 0);
    const add = () => navigate('/library/add');

    return (
        <div className={s.page}>
            <AppBar
                title="Library"
                back="/home"
                action={
                    <AppBarButton label="Library options" onClick={() => setMenu(true)}>
                        <Icon name="dots" />
                    </AppBarButton>
                }
            />
            {files.isError ? (
                <ErrorState onRetry={() => void files.refetch()} />
            ) : files.data?.length === 0 ? (
                <main className={s.content}>
                    <NotesEmpty onUpload={add} />
                </main>
            ) : (
                <main className={s.content}>
                    <label className={s.search}>
                        <Icon name="search-small" />
                        <input
                            type="search"
                            placeholder="Search your notes"
                            aria-label="Search your notes"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                        />
                    </label>
                    {used.length > 0 ? (
                        <div className={s.chips} role="group" aria-label="Filter by course">
                            <button
                                type="button"
                                className={s.chip}
                                aria-pressed={course === null}
                                onClick={() => setCourse(null)}
                            >
                                {course === null ? <Icon name="check-tiny" /> : null}
                                All
                            </button>
                            {used.map((e) => (
                                <button
                                    key={e.course.id}
                                    type="button"
                                    className={s.chip}
                                    aria-pressed={course === e.course.id}
                                    onClick={() => setCourse(e.course.id)}
                                >
                                    {course === e.course.id ? <Icon name="check-tiny" /> : null}
                                    {e.course.code}
                                </button>
                            ))}
                        </div>
                    ) : null}
                    {files.isPending ? (
                        <div className={s.list} aria-busy="true">
                            {[0, 1, 2].map((i) => (
                                <div key={i} className={s.row}>
                                    <Skeleton width={24} height={24} radius={6} />
                                    <Skeleton height={14} />
                                </div>
                            ))}
                        </div>
                    ) : shown.length > 0 ? (
                        <ul className={s.list}>
                            {shown.map((f) => (
                                <li key={f.id}>
                                    <button
                                        type="button"
                                        className={s.row}
                                        onClick={() => navigate(`/library/${f.id}`)}
                                    >
                                        <Icon name="file-line" className={s.rowIcon} />
                                        <span className={s.rowName}>{f.name}</span>
                                        <span className={s.rowMeta}>
                                            {status(
                                                f,
                                                f.courseId ? codes.get(f.courseId) : undefined
                                            )}
                                        </span>
                                        <Icon name="caret-right" className={s.caret} />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className={s.lead}>No notes match "{query.trim()}".</p>
                    )}
                    {files.data ? (
                        <p className={s.caption}>
                            {files.data.length} {files.data.length === 1 ? 'file' : 'files'} ·{' '}
                            {formatSize(total)}
                        </p>
                    ) : null}
                </main>
            )}
            <Sheet open={menu} onClose={() => setMenu(false)} title="Library">
                <div className={s.actions}>
                    <Button block onClick={add}>
                        Add notes
                    </Button>
                </div>
            </Sheet>
        </div>
    );
}
