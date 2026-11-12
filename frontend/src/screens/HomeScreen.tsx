import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { client, uploadFiles } from '../api';
import { Dock } from '../components/Dock';
import { Header } from '../components/Header';
import { Icon } from '../components/Icon';
import { Button, ErrorState, Lead, ProgressBar, Sheet, Skeleton, useToast } from '../components/ui';
import { enablePush, pushSupported } from '../lib/push';
import { useAccount } from '../state/AccountContext';
import s from './Home.module.scss';

const MODE_TITLE: Record<string, string> = {
    quiz: 'Quiz',
    flashcards: 'Flashcards',
    fill_blank: 'Fill in the blank',
    mock_exam: 'Mock exam',
};

const REMINDERS_ASKED = 'florence.remindersAsked';

export function greeting(now = new Date()): string {
    const hour = Number(
        new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Africa/Lagos',
            hour: '2-digit',
            hourCycle: 'h23',
        }).format(now)
    );
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
}

function examDay(date: string): string {
    return new Intl.DateTimeFormat('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
    }).format(new Date(`${date}T00:00:00Z`));
}

function days(n: number): string {
    return `${n} ${n === 1 ? 'day' : 'days'}`;
}

function ReminderSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
    const toast = useToast();
    const [busy, setBusy] = useState(false);
    const turnOn = async () => {
        setBusy(true);
        try {
            const result = await enablePush();
            if (result === 'subscribed') {
                await client.PUT('/v1/me/notification-preferences', {
                    body: {
                        channel: 'web_push',
                        dailyReminder: true,
                        reminderLocalTime: '20:00',
                        streakNudges: true,
                    },
                });
                toast('Reminders are on.');
            } else if (result === 'denied') {
                toast(
                    'Notifications are blocked for this site. You can allow them in your browser settings.'
                );
            } else {
                toast(
                    'This browser cannot show reminders. Add Florence to your home screen first.'
                );
            }
        } catch {
            toast('Could not turn on reminders. Try again from Profile.');
        } finally {
            setBusy(false);
            onClose();
        }
    };
    return (
        <Sheet open={open} onClose={onClose} title="Want a nudge before exams?">
            <Lead>
                We'll remind you to practise and count down to each exam. Quiet hours are on from
                10pm to 7am. Change it any time.
            </Lead>
            <div className={s.sheetActions}>
                <Button block loading={busy} onClick={() => void turnOn()}>
                    Turn on reminders
                </Button>
                <Button variant="link" block onClick={onClose}>
                    Not now
                </Button>
            </div>
        </Sheet>
    );
}

function StartWithNotes() {
    const navigate = useNavigate();
    const toast = useToast();
    const input = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const upload = async (list: FileList | null) => {
        if (!list || list.length === 0) return;
        setBusy(true);
        try {
            await uploadFiles([...list]);
            toast('Florence is reading your notes. Questions will be ready in about a minute.');
            navigate('/library');
        } catch (err) {
            toast(err instanceof Error ? err.message : 'Could not upload that file.');
        } finally {
            setBusy(false);
        }
    };
    return (
        <section className={s.startCard}>
            <div className={s.startArt} aria-hidden="true">
                <span className={s.paperBack} />
                <span className={s.paperFront} />
            </div>
            <h2 className={s.startTitle}>Start with your notes</h2>
            <p className={s.startBody}>
                Upload a lecture note or past questions. Florence turns them into practice questions
                in about a minute.
            </p>
            <Button loading={busy} onClick={() => input.current?.click()}>
                Upload notes
            </Button>
            <input
                ref={input}
                type="file"
                accept="application/pdf,image/*"
                multiple
                hidden
                onChange={(e) => void upload(e.target.files)}
            />
        </section>
    );
}

export function HomeScreen() {
    const navigate = useNavigate();
    const location = useLocation();
    const { account } = useAccount();
    const home = useQuery({
        queryKey: ['home'],
        queryFn: async () => (await client.GET('/v1/home')).data!,
    });
    const courses = useQuery({
        queryKey: ['courses'],
        queryFn: async () => (await client.GET('/v1/me/courses')).data!.items,
    });
    const chats = useQuery({
        queryKey: ['conversations', 'recent'],
        queryFn: async () =>
            (await client.GET('/v1/conversations', { params: { query: { limit: 3 } } })).data!
                .items,
    });
    const fact = useQuery({
        queryKey: ['fact'],
        queryFn: async () => (await client.GET('/v1/facts/today')).data!,
        staleTime: 3_600_000,
    });
    const [remindersOpen, setRemindersOpen] = useState(false);

    useEffect(() => {
        if (!(location.state as { askReminders?: boolean } | null)?.askReminders) return;
        let asked: boolean;
        try {
            asked = localStorage.getItem(REMINDERS_ASKED) === '1';
            localStorage.setItem(REMINDERS_ASKED, '1');
        } catch {
            asked = false;
        }
        if (!asked && pushSupported() && Notification.permission === 'default')
            setRemindersOpen(true);
    }, [location.state]);

    const first = account?.displayName?.split(/\s+/)[0] ?? '';
    const h = home.data;
    const isNew = h?.variant === 'new_user' || h?.variant === 'chats_no_notes';
    const examWeek = h?.variant === 'exam_week' && h.exam;

    return (
        <div className={s.page}>
            <Header />
            <main className={s.body}>
                {home.isError ? (
                    <ErrorState onRetry={() => void home.refetch()} />
                ) : !h ? (
                    <div className={s.stack} aria-busy="true">
                        <Skeleton height={30} width="70%" />
                        <Skeleton height={200} radius={24} />
                        <Skeleton height={96} radius={24} />
                    </div>
                ) : (
                    <>
                        <div>
                            <h1 className={s.title}>
                                {isNew ? `Welcome, ${first}` : `${greeting()}, ${first}`}
                            </h1>
                            {!isNew && h.exam ? (
                                <p className={s.sub}>
                                    {examWeek
                                        ? `${days(h.exam.daysLeft)} to ${h.exam.courseCode} · ${examDay(h.exam.date)}`
                                        : `${days(h.exam.daysLeft)} to your first exam`}
                                </p>
                            ) : null}
                        </div>

                        {isNew ? <StartWithNotes /> : null}

                        {!isNew && examWeek && h.exam ? (
                            <section className={s.hero}>
                                <p className={s.heroLabel}>
                                    Exam in {days(h.exam.daysLeft)} · {h.exam.courseCode}
                                </p>
                                <h2 className={s.heroTitle}>Take a mock exam</h2>
                                <p className={s.heroBody}>
                                    40 questions · 60 minutes · like the real paper
                                </p>
                                <button
                                    type="button"
                                    className={s.heroButton}
                                    onClick={() => navigate('/prep')}
                                >
                                    Start mock exam
                                </button>
                            </section>
                        ) : null}

                        {!isNew && !examWeek && h.resume ? (
                            <section className={s.hero}>
                                <p className={s.heroLabel}>Continue Prep</p>
                                <h2 className={s.heroTitle}>
                                    {MODE_TITLE[h.resume.mode] ?? 'Quiz'}
                                </h2>
                                <p className={s.heroBody}>
                                    {h.resume.answered} of {h.resume.total} questions done
                                </p>
                                <div className={s.heroBar}>
                                    <span
                                        style={{
                                            width: `${(h.resume.answered / Math.max(1, h.resume.total)) * 100}%`,
                                        }}
                                    />
                                </div>
                                <button
                                    type="button"
                                    className={s.heroButton}
                                    onClick={() => navigate(`/prep/${h.resume!.sessionId}`)}
                                >
                                    Continue
                                </button>
                            </section>
                        ) : null}

                        {!isNew ? (
                            <div className={s.tiles}>
                                {h.exam ? (
                                    <div className={s.tile}>
                                        <p className={s.tileLabel}>Exam in</p>
                                        <p className={s.tileValue}>{days(h.exam.daysLeft)}</p>
                                    </div>
                                ) : null}
                                <div className={s.tile}>
                                    <p className={s.tileLabel}>Streak</p>
                                    <p className={s.tileValue}>{days(h.streak.current)}</p>
                                </div>
                            </div>
                        ) : null}

                        {isNew ? (
                            <button
                                type="button"
                                className={s.askCard}
                                onClick={() => navigate('/ask')}
                            >
                                <span className={s.askIcon}>
                                    <Icon name="chat" />
                                </span>
                                <span className={s.askText}>
                                    <span className={s.askTitle}>Or just ask Florence</span>
                                    <span className={s.askBody}>Any topic, step by step</span>
                                </span>
                                <Icon name="chevron" className={s.chevron} />
                            </button>
                        ) : null}

                        {(courses.data?.length ?? 0) > 0 ? (
                            <section className={s.section}>
                                <div className={s.sectionHead}>
                                    <h2 className={s.sectionTitle}>Your courses</h2>
                                    <button
                                        type="button"
                                        className={s.seeAll}
                                        onClick={() => navigate('/library')}
                                    >
                                        See all
                                    </button>
                                </div>
                                {courses.data!.slice(0, 3).map((e) => (
                                    <article key={e.course.id} className={s.course}>
                                        <div className={s.courseTop}>
                                            <span className={s.code}>{e.course.code}</span>
                                            <span className={s.courseMeta}>
                                                {e.fileCount} {e.fileCount === 1 ? 'note' : 'notes'}
                                            </span>
                                        </div>
                                        {e.course.title ? (
                                            <p className={s.courseTitle}>{e.course.title}</p>
                                        ) : null}
                                        <ProgressBar
                                            value={e.mastery ?? 0}
                                            label={`${e.course.code} mastery`}
                                        />
                                        <div className={s.courseFoot}>
                                            <span className={s.courseMeta}>
                                                {e.mastery ?? 0}% mastered
                                            </span>
                                            <button
                                                type="button"
                                                className={s.practise}
                                                onClick={() => navigate('/prep')}
                                            >
                                                Practise <Icon name="chevron" />
                                            </button>
                                        </div>
                                    </article>
                                ))}
                            </section>
                        ) : null}

                        {(chats.data?.length ?? 0) > 0 ? (
                            <section className={s.section}>
                                <div className={s.sectionHead}>
                                    <h2 className={s.sectionTitle}>Recent chats</h2>
                                </div>
                                <div className={s.chatList}>
                                    {chats.data!.map((c) => (
                                        <button
                                            key={c.id}
                                            type="button"
                                            className={s.chat}
                                            onClick={() => navigate('/ask')}
                                        >
                                            <Icon name="chat" className={s.chatIcon} />
                                            <span className={s.chatTitle}>
                                                {c.title ?? 'New chat'}
                                            </span>
                                            <Icon name="chevron" className={s.chevron} />
                                        </button>
                                    ))}
                                </div>
                            </section>
                        ) : null}

                        {fact.data ? (
                            <section className={s.fact}>
                                <p className={s.tileLabel}>Fact of the day</p>
                                <p className={s.factText}>{fact.data.text}</p>
                            </section>
                        ) : null}
                    </>
                )}
            </main>
            <Dock />
            <ReminderSheet open={remindersOpen} onClose={() => setRemindersOpen(false)} />
        </div>
    );
}
