import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, api, getFile, listCourses } from '../api';
import { startSession, type WebMode } from '../api/study';
import { AppBar } from '../components/AppBar';
import { Icon, type IconName } from '../components/Icon';
import { isOutOfTokens, useOutOfTokens } from '../components/OutOfTokens';
import { Button, Sheet } from '../components/ui';
import { useAccount } from '../state/AccountContext';
import s from './PrepSetup.module.scss';

export const MODE_INFO: Record<
    WebMode,
    { title: string; body: string; icon: IconName; minutesPerItem: number }
> = {
    quiz: {
        title: 'Quiz',
        body: 'Questions with marking and an explanation for each',
        icon: 'help',
        minutesPerItem: 0.6,
    },
    flashcards: {
        title: 'Flashcards',
        body: 'Flip a card, then sort what you know from what you don’t',
        icon: 'mode-chip',
        minutesPerItem: 0.4,
    },
};

const COUNTS = [3, 5, 10, 20];
const READY: WebMode[] = ['quiz'];

export function ModeTile({
    mode,
    count,
    selected,
    busy,
    onPick,
}: {
    mode: WebMode;
    count: number;
    selected?: boolean;
    busy?: boolean;
    onPick: () => void;
}) {
    const info = MODE_INFO[mode];
    return (
        <button
            type="button"
            className={`${s.tile} ${selected ? s.tileOn : ''}`}
            onClick={onPick}
            disabled={busy}
            aria-busy={busy || undefined}
        >
            <span className={s.tileIcon}>
                <Icon name={info.icon} />
            </span>
            <span className={s.tileText}>
                <span className={s.tileTitle}>{info.title}</span>
                <span className={s.tileBody}>{info.body}</span>
            </span>
            {selected ? (
                <Icon name="check-circle-fill" className={s.tileCheck} />
            ) : (
                <span className={s.tileTime}>
                    ~{Math.max(1, Math.round(count * info.minutesPerItem))} min
                </span>
            )}
        </button>
    );
}

export function PrepSetupScreen() {
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const fileIds = params.getAll('file');
    const { account } = useAccount();
    const outOfTokens = useOutOfTokens();
    const [count, setCount] = useState(10);
    const [topicIds, setTopicIds] = useState<string[] | null>(null);
    const [sheet, setSheet] = useState<'items' | 'topics' | null>(null);
    const [starting, setStarting] = useState<WebMode | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [impossible, setImpossible] = useState<{ mode: WebMode; detail: string } | null>(null);

    const files = useQuery({ queryKey: ['files'], queryFn: () => api.listFiles() });
    const courses = useQuery({ queryKey: ['courses'], queryFn: listCourses });
    const single = fileIds.length === 1 ? fileIds[0] : null;
    const detail = useQuery({
        queryKey: ['file', single],
        queryFn: () => getFile(single!),
        enabled: Boolean(single),
    });

    const picked = (files.data ?? []).filter((f) => fileIds.includes(f.id));
    const code = courses.data?.find((e) => e.course.id === picked[0]?.courseId)?.course.code;
    const name =
        code ??
        (picked.length === 1
            ? picked[0].name.replace(/\.(pdf|docx)$/i, '')
            : picked.length > 1
              ? `${picked.length} files`
              : 'your notes');
    const topics = detail.data?.topics ?? [];
    const chosenTopics = topicIds ?? [];

    const start = async (mode: WebMode) => {
        if (starting) return;
        setStarting(mode);
        setError(null);
        try {
            const session = await startSession({
                fileIds,
                mode,
                questionCount: count,
                topicIds: chosenTopics,
            });
            navigate(`/prep/${session.id}`, { replace: true });
        } catch (err) {
            if (isOutOfTokens(err)) {
                outOfTokens({ what: `A ${count}-question session`, cost: count });
            } else if (err instanceof ApiError && err.code === 'mode_not_possible') {
                setImpossible({ mode, detail: err.message });
            } else {
                setError(
                    err instanceof ApiError ? err.message : 'Could not start a session. Try again.'
                );
            }
        } finally {
            setStarting(null);
        }
    };

    if (fileIds.length === 0) return <Navigate to="/prep" replace />;

    if (impossible) {
        const others = READY.filter((m) => m !== impossible.mode);
        return (
            <div className={s.page}>
                <AppBar title="" back={-1} />
                <main className={s.content}>
                    <span className={s.alert}>
                        <Icon name="warning-fill" />
                    </span>
                    <h1 className={s.title}>
                        {MODE_INFO[impossible.mode].title} won’t work for this file
                    </h1>
                    <p className={s.lead}>{impossible.detail} These modes still work:</p>
                    {others.map((m) => (
                        <ModeTile
                            key={m}
                            mode={m}
                            count={count}
                            busy={starting === m}
                            onPick={() => {
                                setImpossible(null);
                                void start(m);
                            }}
                        />
                    ))}
                </main>
                <div className={s.spacer} />
                <footer className={s.footer}>
                    <Button variant="link" block onClick={() => setImpossible(null)}>
                        Try again
                    </Button>
                </footer>
            </div>
        );
    }

    return (
        <div className={s.page}>
            <AppBar title="New session" />
            <main className={s.content}>
                <h1 className={s.title}>Practise {name}</h1>
                <ul className={s.group}>
                    {single && topics.length > 0 ? (
                        <li>
                            <button
                                type="button"
                                className={s.row}
                                onClick={() => setSheet('topics')}
                            >
                                <Icon name="book" className={s.rowIcon} />
                                <span className={s.rowText}>Topics</span>
                                <span className={s.rowValue}>
                                    {chosenTopics.length === 0
                                        ? `All ${topics.length}`
                                        : `${chosenTopics.length} of ${topics.length}`}
                                </span>
                                <Icon name="caret-right" className={s.rowCaret} />
                            </button>
                        </li>
                    ) : null}
                    <li>
                        <button type="button" className={s.row} onClick={() => setSheet('items')}>
                            <Icon name="row-cards" className={s.rowIcon} />
                            <span className={s.rowText}>Items</span>
                            <span className={s.rowValue}>{count}</span>
                            <Icon name="caret-right" className={s.rowCaret} />
                        </button>
                    </li>
                </ul>
                <h2 className={s.label}>Pick a mode to start</h2>
                {READY.map((m) => (
                    <ModeTile
                        key={m}
                        mode={m}
                        count={count}
                        selected={starting === m}
                        busy={starting !== null}
                        onPick={() => void start(m)}
                    />
                ))}
                {error ? (
                    <p className={s.error} role="alert">
                        {error}
                    </p>
                ) : null}
                <p className={s.note}>
                    <Icon name="row-bolt" />
                    Uses {count} tokens, 1 per question · you have {account?.tokenBalance ?? 0}
                </p>
            </main>

            <Sheet open={sheet === 'items'} onClose={() => setSheet(null)} title="How many items?">
                <div className={s.choices} role="radiogroup" aria-label="Items">
                    {COUNTS.map((n) => (
                        <button
                            key={n}
                            type="button"
                            role="radio"
                            aria-checked={count === n}
                            className={`${s.choice} ${count === n ? s.choiceOn : ''}`}
                            onClick={() => {
                                setCount(n);
                                setSheet(null);
                            }}
                        >
                            {count === n ? <Icon name="check-small" /> : null}
                            {n}
                        </button>
                    ))}
                </div>
            </Sheet>

            <Sheet open={sheet === 'topics'} onClose={() => setSheet(null)} title="Topics">
                <ul className={s.topicList}>
                    {topics.map((t) => {
                        const on = chosenTopics.includes(t.id);
                        return (
                            <li key={t.id}>
                                <label className={s.topic}>
                                    <input
                                        type="checkbox"
                                        checked={on}
                                        onChange={() =>
                                            setTopicIds(
                                                on
                                                    ? chosenTopics.filter((x) => x !== t.id)
                                                    : [...chosenTopics, t.id]
                                            )
                                        }
                                    />
                                    <span>{t.name}</span>
                                </label>
                            </li>
                        );
                    })}
                </ul>
                <div className={s.sheetActions}>
                    <Button block onClick={() => setSheet(null)}>
                        {chosenTopics.length === 0 ? 'Use all topics' : 'Done'}
                    </Button>
                    {chosenTopics.length > 0 ? (
                        <Button variant="link" block onClick={() => setTopicIds([])}>
                            Clear
                        </Button>
                    ) : null}
                </div>
            </Sheet>
        </div>
    );
}
