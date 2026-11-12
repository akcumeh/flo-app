import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, uploadFiles, type Citation } from '../api';
import {
    claimGuestChat,
    deleteConversation,
    listConversations,
    listMessages,
    setSaved,
    type Message,
} from '../api/chat';
import { AppBar, AppBarButton } from '../components/AppBar';
import { ActionsSheet, AnswerCard, Composer, SourceSheet, UserBubble } from '../components/ask/Ask';
import { Dock } from '../components/Dock';
import { Icon } from '../components/Icon';
import { Button, Dialog, Sheet, useToast } from '../components/ui';
import { plainText } from '../lib/answer';
import { useAccount } from '../state/AccountContext';
import s from './AskScreen.module.scss';

interface Turn {
    key: string;
    question: string;
    answer: string;
    citations: Citation[];
    grounded: boolean;
    streaming: boolean;
    error: string | null;
    messageId: string | null;
    saved: boolean;
}

interface FromPrep {
    question: number;
    prompt: string;
}

const SUGGESTIONS = [
    'Explain active transport simply',
    'Compare mitosis and meiosis',
    'Solve: pH of 0.01 M HCl',
];

function toTurns(messages: Message[]): Turn[] {
    const turns: Turn[] = [];
    for (const m of messages) {
        if (m.role === 'user') {
            turns.push({
                key: m.id,
                question: m.text,
                answer: '',
                citations: [],
                grounded: true,
                streaming: false,
                error: null,
                messageId: null,
                saved: false,
            });
            continue;
        }
        const last = turns[turns.length - 1];
        const answer = {
            answer: m.text,
            citations: m.citations,
            grounded: m.grounded,
            messageId: m.id,
            saved: m.saved,
        };
        if (last && !last.messageId) Object.assign(last, answer);
        else
            turns.push({
                key: m.id,
                question: '',
                streaming: false,
                error: null,
                ...answer,
            });
    }
    return turns;
}

function failure(err: unknown): string {
    const code = err instanceof ApiError ? err.code : '';
    if (code === 'insufficient_tokens') return "You're out of tokens. Top up to keep asking.";
    if (err instanceof ApiError && err.status === 0) return 'You seem to be offline. Try again.';
    return 'Could not reach Florence. Try again.';
}

export function AskScreen() {
    const { conversationId: routeId } = useParams();
    const navigate = useNavigate();
    const location = useLocation();
    const [params, setParams] = useSearchParams();
    const queryClient = useQueryClient();
    const toast = useToast();
    const { setBalance } = useAccount();
    const [turns, setTurns] = useState<Turn[]>([]);
    const [fromPrep, setFromPrep] = useState<FromPrep | null>(null);
    const [source, setSource] = useState<Citation | null>(null);
    const [actionsFor, setActionsFor] = useState<Turn | null>(null);
    const [menu, setMenu] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [photo, setPhoto] = useState<{ id: string; name: string } | null>(null);
    const [addingPhoto, setAddingPhoto] = useState(false);
    const busy = useRef(false);
    const conversationId = useRef<string | null>(routeId ?? null);
    const ownThread = useRef<string | null>(null);
    const handled = useRef(false);
    const endRef = useRef<HTMLDivElement>(null);
    const photoInput = useRef<HTMLInputElement>(null);

    const files = useQuery({ queryKey: ['files'], queryFn: () => api.listFiles() });
    const conversations = useQuery({ queryKey: ['conversations'], queryFn: listConversations });
    const hasNotes = (files.data ?? []).some((f) => (f.status ?? 'ready') === 'ready');
    const title =
        conversations.data?.find((c) => c.id === routeId)?.title ??
        (turns[0]?.question ? turns[0].question.slice(0, 40) : 'Ask');

    const history = useQuery({
        queryKey: ['messages', routeId],
        queryFn: () => listMessages(routeId!),
        enabled: Boolean(routeId) && ownThread.current !== routeId,
    });

    useEffect(() => {
        conversationId.current = routeId ?? null;
        if (!routeId) {
            if (!busy.current) setTurns([]);
            return;
        }
        if (ownThread.current === routeId) return;
        if (history.data) setTurns(toTurns(history.data));
    }, [routeId, history.data]);

    const patch = (key: string, fn: (t: Turn) => Partial<Turn>) =>
        setTurns((prev) => prev.map((t) => (t.key === key ? { ...t, ...fn(t) } : t)));

    const send = useCallback(
        async (question: string) => {
            const text = question.trim();
            if (!text || busy.current) return;
            busy.current = true;
            const key = `${Date.now()}-${Math.random()}`;
            const attached = photo;
            setPhoto(null);
            setTurns((prev) => [
                ...prev,
                {
                    key,
                    question: text,
                    answer: '',
                    citations: [],
                    grounded: true,
                    streaming: true,
                    error: null,
                    messageId: null,
                    saved: false,
                },
            ]);
            try {
                for await (const event of api.sendMessage(
                    conversationId.current,
                    text,
                    attached ? [attached.id] : []
                )) {
                    if (event.type === 'message.start') {
                        setBalance(event.balance);
                        patch(key, () => ({ messageId: event.messageId }));
                        if (conversationId.current !== event.conversationId) {
                            conversationId.current = event.conversationId;
                            ownThread.current = event.conversationId;
                            navigate(`/ask/${event.conversationId}`, {
                                replace: true,
                                state: location.state,
                            });
                        }
                    }
                    if (event.type === 'delta')
                        patch(key, (t) => ({ answer: t.answer + event.text }));
                    if (event.type === 'citation')
                        patch(key, (t) => ({ citations: [...t.citations, event.citation] }));
                    if (event.type === 'message.end') {
                        setBalance(event.balance);
                        patch(key, () => ({
                            streaming: false,
                            grounded: event.grounded ?? true,
                            messageId: event.messageId,
                        }));
                    }
                    if (event.type === 'error') {
                        setBalance(event.balance);
                        patch(key, () => ({
                            streaming: false,
                            error: event.refunded
                                ? 'Something went wrong. You were not charged.'
                                : 'Something went wrong.',
                        }));
                    }
                }
                void queryClient.invalidateQueries({ queryKey: ['conversations'] });
            } catch (err) {
                patch(key, () => ({ streaming: false, error: failure(err) }));
            } finally {
                patch(key, () => ({ streaming: false }));
                busy.current = false;
            }
        },
        [setBalance, navigate, location.state, queryClient, photo]
    );

    useEffect(() => {
        if (handled.current) return;
        handled.current = true;
        const state = location.state as { fromPrep?: FromPrep } | null;
        const q = params.get('q');
        if (state?.fromPrep) {
            setFromPrep(state.fromPrep);
            void send(state.fromPrep.prompt);
        } else if (q) {
            setParams({}, { replace: true });
            void send(q);
        } else if (!routeId) {
            void claimGuestChat().then((id) => {
                if (id) navigate(`/ask/${id}`, { replace: true });
            });
        }
    }, [location.state, params, setParams, send, routeId, navigate]);

    useEffect(() => {
        endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
    }, [turns]);

    const toggleSave = async (turn: Turn) => {
        if (!turn.messageId) return;
        const next = !turn.saved;
        patch(turn.key, () => ({ saved: next }));
        try {
            await setSaved(turn.messageId, next);
            toast(next ? 'Saved' : 'Removed from saved');
            void queryClient.invalidateQueries({ queryKey: ['saved'] });
        } catch {
            patch(turn.key, () => ({ saved: !next }));
            toast('Could not save. Try again.');
        }
    };

    const practise = async (turn: Turn) => {
        const ids = [...new Set(turn.citations.map((c) => c.fileId))];
        if (ids.length === 0) {
            toast('Add your notes first. Florence makes questions from them.');
            navigate('/library/add');
            return;
        }
        try {
            const session = await api.createPrepSession(ids, 10);
            navigate(`/prep/${session.id}`);
        } catch (err) {
            toast(err instanceof ApiError ? err.message : 'Could not start a session.');
        }
    };

    const copy = async (turn: Turn) => {
        try {
            await navigator.clipboard.writeText(plainText(turn.answer));
            toast('Copied');
        } catch {
            toast('Could not copy. Select the text instead.');
        }
    };

    const addPhoto = async (list: FileList | null) => {
        const file = list?.[0];
        if (!file) return;
        setAddingPhoto(true);
        try {
            const stored = await uploadFiles([file]);
            setPhoto({ id: stored.id, name: 'Photo added' });
        } catch (err) {
            toast(err instanceof ApiError ? err.message : 'Could not add that photo.');
        } finally {
            setAddingPhoto(false);
        }
    };

    const newChat = () => {
        setMenu(false);
        ownThread.current = null;
        conversationId.current = null;
        setTurns([]);
        setFromPrep(null);
        navigate('/ask');
    };

    const removeChat = async () => {
        if (!routeId) return;
        try {
            await deleteConversation(routeId);
            void queryClient.invalidateQueries({ queryKey: ['conversations'] });
            setConfirmDelete(false);
            toast('Chat deleted');
            newChat();
        } catch {
            toast('Could not delete this chat.');
        }
    };

    const empty = turns.length === 0 && !routeId && !fromPrep;

    return (
        <div className={s.page}>
            {empty ? (
                <header className={s.titleBar}>
                    <h1 className={s.titleBig}>Ask</h1>
                    <AppBarButton label="Chats" onClick={() => navigate('/ask/history')}>
                        <Icon name="search-line" />
                    </AppBarButton>
                </header>
            ) : (
                <AppBar
                    title={title}
                    back="/ask/history"
                    action={
                        <AppBarButton label="Chat options" onClick={() => setMenu(true)}>
                            <Icon name="dots" />
                        </AppBarButton>
                    }
                />
            )}

            <main className={s.thread}>
                {fromPrep ? (
                    <button type="button" className={s.backChip} onClick={() => navigate(-1)}>
                        <Icon name="arrow-left" />
                        Back to Prep · Question {fromPrep.question}
                    </button>
                ) : null}

                {empty ? (
                    <section className={s.hello}>
                        <Icon name="asterisk-app" className={s.helloStar} />
                        <h2 className={s.helloTitle}>What do you want to understand?</h2>
                        <p className={s.lead}>
                            Florence answers from your notes when it can, and tells you when it
                            can't.
                        </p>
                        <ul className={s.suggestions}>
                            {SUGGESTIONS.map((q) => (
                                <li key={q}>
                                    <button
                                        type="button"
                                        className={s.suggestion}
                                        onClick={() => void send(q)}
                                    >
                                        <Icon name="sparkle" className={s.sparkle} />
                                        {q}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </section>
                ) : null}

                {routeId && history.isPending && turns.length === 0 ? (
                    <p className={s.lead} role="status">
                        Loading this chat…
                    </p>
                ) : null}

                {turns.map((turn) => (
                    <div key={turn.key} className={s.turn}>
                        {turn.question ? <UserBubble>{turn.question}</UserBubble> : null}
                        <AnswerCard
                            text={turn.answer}
                            citations={turn.citations}
                            streaming={turn.streaming}
                            grounded={turn.grounded}
                            saved={turn.saved}
                            error={turn.error}
                            onSource={setSource}
                            onPractise={() => void practise(turn)}
                            onSave={() => void toggleSave(turn)}
                            onMore={() => setActionsFor(turn)}
                        />
                    </div>
                ))}
                <div ref={endRef} />
            </main>

            <Dock>
                <Composer
                    onSend={(t) => void send(t)}
                    onCamera={() => photoInput.current?.click()}
                    scope={hasNotes ? 'From my notes' : null}
                    attachment={addingPhoto ? 'Adding photo…' : photo ? photo.name : null}
                    onClearAttachment={photo ? () => setPhoto(null) : undefined}
                    disabled={addingPhoto}
                />
            </Dock>
            <input
                ref={photoInput}
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                data-testid="ask-photo"
                onChange={(e) => {
                    void addPhoto(e.target.files);
                    e.target.value = '';
                }}
            />

            <SourceSheet citation={source} onClose={() => setSource(null)} />
            <ActionsSheet
                open={actionsFor !== null}
                onClose={() => setActionsFor(null)}
                rows={
                    actionsFor
                        ? [
                              {
                                  icon: 'cards-row',
                                  label: 'Make practice questions from this',
                                  brand: true,
                                  run: () => void practise(actionsFor),
                              },
                              {
                                  icon: 'bookmark-row',
                                  label: actionsFor.saved ? 'Remove from saved' : 'Save answer',
                                  run: () => void toggleSave(actionsFor),
                              },
                              {
                                  icon: 'copy-row',
                                  label: 'Copy',
                                  run: () => void copy(actionsFor),
                              },
                          ]
                        : []
                }
            />
            <Sheet open={menu} onClose={() => setMenu(false)} title="Ask">
                <div className={s.menu}>
                    <Button block onClick={newChat}>
                        New chat
                    </Button>
                    <Button variant="secondary" block onClick={() => navigate('/ask/history')}>
                        Chats
                    </Button>
                    <Button variant="secondary" block onClick={() => navigate('/ask/saved')}>
                        Saved
                    </Button>
                    {routeId ? (
                        <Button
                            variant="ghost"
                            block
                            onClick={() => {
                                setMenu(false);
                                setConfirmDelete(true);
                            }}
                        >
                            Delete this chat
                        </Button>
                    ) : null}
                </div>
            </Sheet>
            <Dialog
                open={confirmDelete}
                onClose={() => setConfirmDelete(false)}
                title="Delete this chat?"
            >
                <p className={s.lead}>Its messages go too. Your notes stay in Library.</p>
                <div className={s.menu}>
                    <Button block onClick={() => void removeChat()}>
                        Delete chat
                    </Button>
                    <Button variant="ghost" block onClick={() => setConfirmDelete(false)}>
                        Cancel
                    </Button>
                </div>
            </Dialog>
        </div>
    );
}
