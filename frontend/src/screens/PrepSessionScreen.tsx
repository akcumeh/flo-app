import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
    api,
    listCourses,
    type PrepQuestion,
    type PrepResult,
    type PrepSession,
    type Verdict,
} from '../api';
import { Icon, type IconName } from '../components/Icon';
import { Button, Dialog } from '../components/ui';
import { useAccount } from '../state/AccountContext';
import s from './PrepSessionScreen.module.scss';

interface Answered {
    chosen: string | null;
    verdict: Verdict;
}

const KEYS = ['A', 'B', 'C', 'D', 'E', 'F'];
const COLLAPSE_MS = 10_000;
const MODE_LABEL: Record<string, string> = {
    quiz: 'Quiz',
    mock_exam: 'Mock exam',
    flashcards: 'Flashcards',
    fill_blank: 'Fill in the blank',
};

const marksLabel = (n: number) => `${n} mark${n === 1 ? '' : 's'}`;

function tone(answered: Answered): {
    kind: 'right' | 'wrong' | 'partly' | 'neutral';
    icon: IconName;
    title: string;
} {
    const v = answered.verdict;
    if (answered.chosen === null || v.result === 'skipped')
        return { kind: 'neutral', icon: 'book-large', title: 'Here’s the answer' };
    if (v.result === 'right')
        return { kind: 'right', icon: 'check-circle-fill', title: 'Correct!' };
    if (v.result === 'partly')
        return {
            kind: 'partly',
            icon: 'info',
            title: `${v.awardedMarks} of ${v.maxMarks} marks`,
        };
    return { kind: 'wrong', icon: 'warning-fill', title: 'Not quite' };
}

function summary(question: PrepQuestion, answered: Answered): string {
    const v = answered.verdict;
    const why = v.whyRight?.split('\n\n')[0] ?? '';
    if (answered.chosen === null) return `That’s fine, this is practice. ${why}`.trim();
    if (question.options && v.result !== 'right') {
        return `You chose ${answered.chosen}. The answer is ${v.correctAnswer}. ${why}`.trim();
    }
    return why || v.correctAnswer;
}

export function PrepSessionScreen() {
    const { id = '' } = useParams();
    const navigate = useNavigate();
    const { setBalance } = useAccount();
    const [session, setSession] = useState<PrepSession | null>(null);
    const [index, setIndex] = useState(0);
    const [answers, setAnswers] = useState<Array<Answered | undefined>>([]);
    const [selected, setSelected] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [pending, setPending] = useState(false);
    const [failed, setFailed] = useState(false);
    const [result, setResult] = useState<PrepResult | null>(null);
    const [loadError, setLoadError] = useState(false);
    const [collapsed, setCollapsed] = useState(false);
    const [working, setWorking] = useState(false);
    const [leaving, setLeaving] = useState(false);
    const timer = useRef<number | null>(null);

    const files = useQuery({ queryKey: ['files'], queryFn: () => api.listFiles() });
    const courses = useQuery({ queryKey: ['courses'], queryFn: listCourses });

    useEffect(() => {
        let live = true;
        api.getPrepSession(id)
            .then((sess) => {
                if (!live) return;
                setSession(sess);
                setIndex(Math.min(sess.currentIndex ?? 0, Math.max(0, sess.items.length - 1)));
            })
            .catch(() => {
                if (live) setLoadError(true);
            });
        return () => {
            live = false;
        };
    }, [id]);

    const answered = answers[index];

    const stopTimer = useCallback(() => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = null;
    }, []);

    useEffect(() => {
        if (!answered || collapsed || working) return;
        timer.current = window.setTimeout(() => setCollapsed(true), COLLAPSE_MS);
        return stopTimer;
    }, [answered, collapsed, working, stopTimer]);

    if (loadError) {
        return (
            <div className={s.page}>
                <main className={s.fallback}>
                    <p role="alert">This session ended. Start a new one from Prep.</p>
                    <Button block onClick={() => navigate('/prep')}>
                        Back to Prep
                    </Button>
                </main>
            </div>
        );
    }
    if (!session) return <div className={s.page} aria-busy="true" />;

    if (session.status === 'failed' || session.items.length === 0) {
        return (
            <div className={s.page}>
                <main className={s.fallback}>
                    <p role="alert">
                        Florence couldn’t write questions from this file. Your token was refunded.
                    </p>
                    <Button block onClick={() => navigate('/prep')}>
                        Back to Prep
                    </Button>
                </main>
            </div>
        );
    }

    const total = session.items.length;
    const question = session.items[index];
    const written = !question.options || question.options.length === 0;
    const fileId = session.fileIds?.[0];
    const file = files.data?.find((f) => f.id === fileId);
    const code = courses.data?.find((e) => e.course.id === file?.courseId)?.course.code;
    const label = [code, question.topic].filter(Boolean).join(' · ');
    const doneCount = answers.filter(Boolean).length + (session.currentIndex ?? 0);
    const isLast = index + 1 >= total;

    const submit = async (answer: string | null) => {
        if (answered || pending) return;
        setPending(true);
        setFailed(false);
        try {
            const verdict = await api.submitPrepAnswer(session.id, question.id, answer);
            setCollapsed(false);
            setAnswers((prev) => {
                const next = [...prev];
                next[index] = { chosen: answer, verdict };
                return next;
            });
        } catch {
            setFailed(true);
        } finally {
            setPending(false);
        }
    };

    const next = async () => {
        stopTimer();
        setWorking(false);
        setCollapsed(false);
        setSelected(null);
        setDraft('');
        if (!isLast) {
            setIndex(index + 1);
            window.scrollTo({ top: 0 });
            return;
        }
        const res = await api.completePrepSession(session.id);
        setBalance(res.balance ?? 0);
        setResult(res);
        window.scrollTo({ top: 0 });
    };

    const askAbout = () =>
        navigate('/ask', {
            state: {
                fromPrep: { question: index + 1, prompt: `Why does this work: ${question.prompt}` },
            },
        });

    if (result) {
        return (
            <div className={s.page}>
                <main className={s.result}>
                    <p className={s.label}>{label || 'Quiz done'}</p>
                    <h1 className={s.score}>
                        {result.score}/{result.total}
                    </h1>
                    <p className={s.resultSub}>
                        {result.failedTopics.length > 0
                            ? `Worth another look: ${result.failedTopics.join(', ')}.`
                            : 'Every question right. Nice work.'}
                    </p>
                    <p className={s.resultSub}>
                        {result.charged} token{result.charged === 1 ? '' : 's'} used.{' '}
                        {result.balance} left.
                    </p>
                    <div className={s.resultActions}>
                        <Button block onClick={() => navigate('/prep')}>
                            Done
                        </Button>
                        <Button variant="secondary" block onClick={() => navigate('/ask')}>
                            Ask Florence about this
                        </Button>
                    </div>
                </main>
            </div>
        );
    }

    const verdict = answered?.verdict;
    const feel = answered ? tone(answered) : null;
    const correctIndex = verdict ? (question.options?.indexOf(verdict.correctAnswer) ?? -1) : -1;

    if (answered && verdict && working) {
        const reasons = verdict.whyOthersFail ?? [];
        const paragraphs = (verdict.whyRight ?? '').split('\n\n').filter(Boolean);
        return (
            <div className={s.page}>
                <header className={s.appBar}>
                    <button
                        type="button"
                        className={s.iconButton}
                        aria-label="Back to the question"
                        onClick={() => setWorking(false)}
                    >
                        <Icon name="arrow-left" />
                    </button>
                    <h1 className={s.appBarTitle}>Explanation</h1>
                    <span className={s.iconButton} aria-hidden="true" />
                </header>
                <main className={s.working}>
                    <p className={s.label}>
                        Question {index + 1}
                        {code ? ` · ${code}` : ''}
                    </p>
                    <h2 className={s.workingTitle}>
                        {written
                            ? 'The model answer'
                            : `Why the answer is ${verdict.correctAnswer}`}
                    </h2>
                    <div className={s.pills} aria-hidden={!question.options}>
                        <div className={`${s.pill} ${s.pillRight}`}>
                            <span className={`${s.pillKey} ${s.keyRight}`}>
                                {written ? <Icon name="check-small" /> : KEYS[correctIndex]}
                            </span>
                            <span className={s.pillText}>
                                <span className={`${s.pillLabel} ${s.labelRight}`}>
                                    {written ? 'Model answer' : 'Right answer'}
                                </span>
                                <span className={s.pillBody}>{verdict.correctAnswer}</span>
                            </span>
                        </div>
                        {answered.chosen !== null && verdict.result !== 'right' ? (
                            <div className={`${s.pill} ${s.pillYours}`}>
                                <span className={`${s.pillKey} ${s.keyWrong}`}>
                                    {written ? (
                                        <Icon name="bang-small" />
                                    ) : (
                                        KEYS[question.options?.indexOf(answered.chosen) ?? -1]
                                    )}
                                </span>
                                <span className={s.pillText}>
                                    <span className={`${s.pillLabel} ${s.labelWrong}`}>
                                        Your answer
                                    </span>
                                    <span className={s.pillBody}>{answered.chosen}</span>
                                </span>
                            </div>
                        ) : null}
                    </div>
                    {paragraphs.map((p) => (
                        <p key={p} className={s.workingBody}>
                            {p}
                        </p>
                    ))}
                    {reasons.length > 0 ? (
                        <ol className={s.steps}>
                            {reasons.map((r, i) => (
                                <li key={r.option} className={s.step}>
                                    <span className={s.stepNum}>{i + 1}</span>
                                    <span className={s.stepText}>
                                        <span className={s.stepTitle}>Why not {r.option}</span>
                                        <span className={s.stepBody}>{r.reason}</span>
                                    </span>
                                </li>
                            ))}
                        </ol>
                    ) : null}
                    {verdict.source ? (
                        <blockquote className={s.quote}>
                            {verdict.source.snippet ? (
                                <p className={s.quoteText}>“{verdict.source.snippet}”</p>
                            ) : null}
                            <p className={s.quoteFrom}>
                                From your notes · {verdict.source.label}
                                {verdict.source.page ? `, page ${verdict.source.page}` : ''}
                            </p>
                        </blockquote>
                    ) : null}
                    {verdict.examTip ? (
                        <div className={s.tip}>
                            <Icon name="asterisk-tip" />
                            <div>
                                <p className={s.tipTitle}>Exam tip</p>
                                <p className={s.tipBody}>{verdict.examTip}</p>
                            </div>
                        </div>
                    ) : null}
                </main>
                <footer className={s.footer}>
                    <Button block onClick={() => void next()}>
                        {isLast ? 'See results' : 'Next question'}
                    </Button>
                    <Button variant="secondary" block onClick={askAbout}>
                        Ask a follow-up
                    </Button>
                </footer>
            </div>
        );
    }

    return (
        <div
            className={`${s.page} ${answered ? (collapsed ? s.withBar : s.withBanner) : ''}`}
            onPointerDown={() => {
                if (answered && !collapsed) setCollapsed(true);
            }}
        >
            <div className={s.sessionBar}>
                <button
                    type="button"
                    className={s.iconButton}
                    aria-label="Leave session"
                    onClick={() => setLeaving(true)}
                >
                    <Icon name="close-session" />
                </button>
                <span className={s.modeChip}>
                    <Icon name="mode-chip" />
                    {MODE_LABEL[session.mode] ?? 'Quiz'}
                </span>
                <div
                    className={s.progress}
                    role="progressbar"
                    aria-label="Questions answered"
                    aria-valuemin={0}
                    aria-valuemax={total}
                    aria-valuenow={Math.min(doneCount, total)}
                >
                    <span
                        className={s.progressFill}
                        style={{ width: `${(Math.min(doneCount, total) / total) * 100}%` }}
                    />
                </div>
                <p className={s.counter}>
                    {index + 1}/{total}
                </p>
            </div>

            <main className={s.content}>
                <section className={s.questionCard} aria-labelledby="prep-question">
                    {label ? <p className={s.label}>{label}</p> : null}
                    <h1 id="prep-question" className={s.question}>
                        {question.prompt}
                    </h1>
                    <p className={s.marks}>{marksLabel(question.marks)}</p>
                </section>

                {written ? (
                    answered?.chosen === null ? (
                        <p className={s.chosePill}>You chose “I don’t know”</p>
                    ) : (
                        <textarea
                            className={s.answerBox}
                            aria-label="Your answer"
                            placeholder="Type your answer"
                            value={answered ? (answered.chosen ?? '') : draft}
                            readOnly={Boolean(answered) || pending}
                            onChange={(e) => setDraft(e.target.value)}
                        />
                    )
                ) : (
                    <div className={s.options} role="radiogroup" aria-label="Answer options">
                        {question.options?.map((option, i) => {
                            const isCorrect = verdict?.correctAnswer === option;
                            const isChosen = answered?.chosen === option;
                            const state = !answered
                                ? selected === option
                                    ? 'selected'
                                    : 'idle'
                                : isCorrect
                                  ? 'correct'
                                  : isChosen
                                    ? 'wrong'
                                    : 'muted';
                            return (
                                <button
                                    key={option}
                                    type="button"
                                    role="radio"
                                    aria-checked={answered ? isChosen : selected === option}
                                    className={`${s.option} ${s[state]}`}
                                    disabled={Boolean(answered) || pending}
                                    onClick={() => setSelected(option)}
                                >
                                    <span className={s.badge}>
                                        {state === 'correct' ? (
                                            <Icon name="check" />
                                        ) : state === 'wrong' ? (
                                            <Icon name="x-small" />
                                        ) : (
                                            KEYS[i]
                                        )}
                                    </span>
                                    <span className={s.optionText}>{option}</span>
                                    {state === 'correct' ? (
                                        <span className={s.srOnly}>, right answer</span>
                                    ) : state === 'wrong' ? (
                                        <span className={s.srOnly}>, your answer</span>
                                    ) : null}
                                </button>
                            );
                        })}
                    </div>
                )}
                {failed ? (
                    <p className={s.error} role="alert">
                        Couldn’t send your answer. Check your connection and try again.
                    </p>
                ) : null}
            </main>

            {!answered ? (
                <footer className={s.footer}>
                    <Button
                        variant="ghost"
                        block
                        disabled={pending}
                        onClick={() => void submit(null)}
                    >
                        I don’t know
                    </Button>
                    <Button
                        block
                        loading={pending}
                        disabled={written ? draft.trim().length === 0 : selected === null}
                        onClick={() => void submit(written ? draft.trim() : selected)}
                    >
                        {pending && written
                            ? 'Marking your answer…'
                            : written
                              ? 'Submit answer'
                              : 'Check answer'}
                    </Button>
                </footer>
            ) : null}

            {answered && feel ? (
                <section
                    className={`${s.banner} ${s[`banner_${feel.kind}`]} ${collapsed ? s.bannerCollapsed : ''}`}
                    aria-live="polite"
                    aria-label="Feedback"
                    onPointerDown={(e) => {
                        e.stopPropagation();
                        stopTimer();
                    }}
                    onFocus={stopTimer}
                >
                    <button
                        type="button"
                        className={s.bannerHead}
                        aria-expanded={!collapsed}
                        onClick={() => setCollapsed((c) => !c)}
                    >
                        <Icon name={feel.icon} className={s.bannerIcon} />
                        <span className={s.bannerTitle}>{feel.title}</span>
                        <Icon
                            name="caret-down-small"
                            className={`${s.bannerCaret} ${collapsed ? s.caretUp : ''}`}
                        />
                    </button>
                    {!collapsed ? (
                        <>
                            <p className={s.bannerBody}>{summary(question, answered)}</p>
                            <button
                                type="button"
                                className={s.workingLink}
                                onClick={() => setWorking(true)}
                            >
                                <Icon name="book" />
                                See the working
                            </button>
                        </>
                    ) : null}
                    <Button block onClick={() => void next()}>
                        {isLast ? 'See results' : 'Next question'}
                    </Button>
                </section>
            ) : null}

            <Dialog open={leaving} onClose={() => setLeaving(false)} title="Leave this session?">
                <p className={s.dialogBody}>
                    Your answers so far are saved. You can pick up where you left off from Home.
                </p>
                <div className={s.dialogActions}>
                    <Button block onClick={() => setLeaving(false)}>
                        Keep going
                    </Button>
                    <Button variant="ghost" block onClick={() => navigate('/prep')}>
                        Leave
                    </Button>
                </div>
            </Dialog>
        </div>
    );
}
