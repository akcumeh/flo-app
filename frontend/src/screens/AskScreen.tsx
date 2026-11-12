import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, idempotencyKey, type Citation } from '../api';
import { AnswerView } from '../components/AnswerView';
import { Dock } from '../components/Dock';
import { Header } from '../components/Header';
import { Icon } from '../components/Icon';
import { useAccount } from '../state/AccountContext';
import s from './AskScreen.module.scss';

interface Turn {
    id: string;
    question: string;
    answer: string;
    citations: Citation[];
    streaming: boolean;
    error?: string;
}

interface FromPrep {
    question: number;
    prompt: string;
}

export function AskScreen() {
    const navigate = useNavigate();
    const location = useLocation();
    const { setBalance } = useAccount();
    const [turns, setTurns] = useState<Turn[]>([]);
    const [draft, setDraft] = useState('');
    const [fromPrep, setFromPrep] = useState<FromPrep | null>(null);
    const busy = useRef(false);
    const conversationId = useRef<string | null>(null);
    const endRef = useRef<HTMLDivElement>(null);
    const handledState = useRef(false);

    const send = useCallback(
        async (question: string) => {
            const text = question.trim();
            if (!text || busy.current) return;
            busy.current = true;
            const id = idempotencyKey();
            setTurns((prev) => [
                ...prev,
                { id, question: text, answer: '', citations: [], streaming: true },
            ]);

            const patch = (fn: (t: Turn) => Turn) =>
                setTurns((prev) => prev.map((t) => (t.id === id ? fn(t) : t)));

            try {
                for await (const event of api.sendMessage(conversationId.current, text, [])) {
                    if (event.type === 'message.start') {
                        conversationId.current = event.conversationId;
                        setBalance(event.balance);
                    }
                    if (event.type === 'delta')
                        patch((t) => ({ ...t, answer: t.answer + event.text }));
                    if (event.type === 'citation')
                        patch((t) => ({ ...t, citations: [...t.citations, event.citation] }));
                    if (event.type === 'message.end') {
                        setBalance(event.balance);
                        patch((t) => ({ ...t, streaming: false }));
                    }
                    if (event.type === 'error') {
                        setBalance(event.balance);
                        patch((t) => ({
                            ...t,
                            streaming: false,
                            error: event.refunded
                                ? 'Something went wrong. You were not charged.'
                                : 'Something went wrong.',
                        }));
                    }
                }
            } catch (err) {
                const code = err instanceof ApiError ? err.code : '';
                const message =
                    code === 'insufficient_tokens'
                        ? "You're out of tokens. Top up to keep asking."
                        : 'Could not reach Florence. Try again.';
                patch((t) => ({ ...t, streaming: false, error: message }));
            } finally {
                busy.current = false;
            }
        },
        [setBalance]
    );

    useEffect(() => {
        if (handledState.current) return;
        const q = new URLSearchParams(location.search).get('q')?.trim();
        if (!q) return;
        handledState.current = true;
        navigate('/ask', { replace: true });
        void send(q.slice(0, 2000));
    }, [location.search, navigate, send]);

    useEffect(() => {
        const state = location.state as { fromPrep?: FromPrep } | null;
        if (handledState.current || !state?.fromPrep) return;
        handledState.current = true;
        setFromPrep(state.fromPrep);
        void send(state.fromPrep.prompt);
    }, [location.state, send]);

    useEffect(() => {
        endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, [turns]);

    const submit = (e: FormEvent) => {
        e.preventDefault();
        const text = draft;
        setDraft('');
        void send(text);
    };

    const newChat = () => {
        conversationId.current = null;
        setTurns([]);
        setFromPrep(null);
    };

    return (
        <div className={s.page}>
            <Header onNewChat={newChat} />

            <main className={s.thread}>
                {fromPrep && (
                    <div className={s.fromPrep}>
                        <button type="button" className={s.chip} onClick={() => navigate(-1)}>
                            <Icon name="arrow-left" />
                            Back to Prep · Question {fromPrep.question}
                        </button>
                    </div>
                )}

                {turns.length === 0 && !fromPrep && (
                    <div className={s.empty}>
                        <h1>Ask anything about your course.</h1>
                        <p>Florence answers from your own notes and shows the page it used.</p>
                    </div>
                )}

                {turns.map((turn) => (
                    <div key={turn.id} className={s.turn}>
                        <div className={s.bubbleRow}>
                            <p className={s.bubble}>{turn.question}</p>
                        </div>
                        {turn.error ? (
                            <p role="alert" className={s.error}>
                                {turn.error}
                            </p>
                        ) : (
                            <AnswerView
                                text={turn.answer}
                                citations={turn.citations}
                                streaming={turn.streaming}
                                onStartQuiz={() => navigate('/prep')}
                            />
                        )}
                    </div>
                ))}
                <div ref={endRef} />
            </main>

            <Dock>
                <form className={s.composer} onSubmit={submit}>
                    <button
                        type="button"
                        className={s.add}
                        aria-label="Add a file"
                        onClick={() => navigate('/library')}
                    >
                        <Icon name="plus" />
                    </button>
                    <input
                        className={s.input}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder="Ask anything about your course"
                        aria-label="Message"
                        enterKeyHint="send"
                    />
                    <button
                        type="submit"
                        className={s.send}
                        aria-label="Send"
                        disabled={!draft.trim()}
                    >
                        <Icon name="arrow-up" />
                    </button>
                </form>
            </Dock>
        </div>
    );
}
