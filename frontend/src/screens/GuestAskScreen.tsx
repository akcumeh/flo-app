import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../api';
import { sendGuestMessage, startGuest } from '../api/chat';
import { AnswerCard, Composer, SavePrompt, UserBubble } from '../components/ask/Ask';
import { Icon } from '../components/Icon';
import { Button } from '../components/ui';
import s from './GuestAsk.module.scss';

interface Turn {
    key: string;
    question: string;
    answer: string;
    streaming: boolean;
    error: string | null;
    usedUp?: boolean;
}

const USED_UP =
    "Sorry, it looks like you've used up your 2 free questions. Create a free account to get more free questions.";

const usedUp = (key: string, question: string): Turn => ({
    key,
    question,
    answer: '',
    streaming: false,
    error: USED_UP,
    usedUp: true,
});

export function GuestAskScreen() {
    const navigate = useNavigate();
    const [params, setParams] = useSearchParams();
    const [turns, setTurns] = useState<Turn[]>([]);
    const [prompt, setPrompt] = useState(false);
    const token = useRef<string | null>(null);
    const left = useRef<number | null>(null);
    const busy = useRef(false);
    const handled = useRef(false);
    const endRef = useRef<HTMLDivElement>(null);

    const signUp = useCallback(() => navigate('/signin', { state: { from: '/ask' } }), [navigate]);

    const patch = (key: string, fn: (t: Turn) => Partial<Turn>) =>
        setTurns((prev) => prev.map((t) => (t.key === key ? { ...t, ...fn(t) } : t)));

    const send = useCallback(async (question: string) => {
        const text = question.trim();
        if (!text || busy.current) return;
        const key = `${Date.now()}-${Math.random()}`;
        if (left.current === 0) {
            setTurns((prev) => [...prev, usedUp(key, text)]);
            return;
        }
        busy.current = true;
        setTurns((prev) => [
            ...prev,
            { key, question: text, answer: '', streaming: true, error: null },
        ]);
        try {
            if (!token.current) {
                const g = await startGuest();
                token.current = g.token;
                left.current = g.questionsLeft;
            }
            if (left.current === 0) {
                patch(key, () => usedUp(key, text));
                return;
            }
            for await (const e of sendGuestMessage(token.current, text)) {
                if (e.type === 'delta') patch(key, (t) => ({ answer: t.answer + e.text }));
                if (e.type === 'end') {
                    left.current = e.questionsLeft;
                    patch(key, () => ({ streaming: false }));
                    if (e.questionsLeft === 0) setPrompt(true);
                }
                if (e.type === 'error') {
                    left.current = e.questionsLeft;
                    patch(key, () => ({
                        streaming: false,
                        error: "Something went wrong. This one didn't count.",
                    }));
                }
            }
        } catch (err) {
            if (err instanceof ApiError && err.code === 'guest_limit_reached') {
                left.current = 0;
                patch(key, () => usedUp(key, text));
            } else {
                patch(key, () => ({
                    streaming: false,
                    error:
                        err instanceof ApiError && err.status === 0
                            ? 'You seem to be offline. Try again.'
                            : 'Could not reach Florence. Try again.',
                }));
            }
        } finally {
            patch(key, () => ({ streaming: false }));
            busy.current = false;
        }
    }, []);

    useEffect(() => {
        if (handled.current) return;
        handled.current = true;
        const q = params.get('q');
        if (q) {
            setParams({}, { replace: true });
            void send(q);
        }
    }, [params, setParams, send]);

    useEffect(() => {
        endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
    }, [turns]);

    return (
        <div className={s.page}>
            <header className={s.bar}>
                <Icon name="logo-florence" className={s.logo} />
                <Link to="/signin" state={{ from: '/ask' }} className={s.login}>
                    Log in
                </Link>
            </header>
            <main className={s.thread}>
                {turns.length === 0 ? (
                    <section className={s.hello}>
                        <h1 className={s.title}>What do you want to understand?</h1>
                        <p className={s.lead}>
                            Ask Florence anything about your course. Two questions are free, no
                            account needed.
                        </p>
                    </section>
                ) : null}
                {turns.map((t) => (
                    <div key={t.key} className={s.turn}>
                        <UserBubble>{t.question}</UserBubble>
                        <AnswerCard
                            text={t.answer}
                            streaming={t.streaming}
                            error={t.error}
                            grounded={false}
                            guest
                            onPractise={() => setPrompt(true)}
                            onSave={() => setPrompt(true)}
                        />
                        {t.usedUp ? (
                            <Button block onClick={signUp}>
                                Create a free account
                            </Button>
                        ) : null}
                    </div>
                ))}
                <div ref={endRef} />
            </main>
            <div className={s.dock}>
                <Composer onSend={(t) => void send(t)} onCamera={() => setPrompt(true)} />
            </div>
            <SavePrompt open={prompt} onClose={() => setPrompt(false)} onContinue={signUp} />
        </div>
    );
}
