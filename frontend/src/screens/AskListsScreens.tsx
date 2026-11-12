import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listConversations, listSavedAnswers, setSaved } from '../api/chat';
import { AppBar } from '../components/AppBar';
import { Icon } from '../components/Icon';
import { Button, ErrorState, Skeleton, useToast } from '../components/ui';
import { plainText } from '../lib/answer';
import s from './Library.module.scss';

function Loading() {
    return (
        <div className={s.list} aria-busy="true">
            {[0, 1, 2].map((i) => (
                <div key={i} className={s.row}>
                    <Skeleton width={24} height={24} radius={12} />
                    <Skeleton height={14} />
                </div>
            ))}
        </div>
    );
}

export function ChatHistoryScreen() {
    const navigate = useNavigate();
    const [query, setQuery] = useState('');
    const chats = useQuery({ queryKey: ['conversations'], queryFn: listConversations });
    const needle = query.trim().toLowerCase();
    const shown = (chats.data ?? []).filter(
        (c) => !needle || (c.title ?? 'New chat').toLowerCase().includes(needle)
    );
    return (
        <div className={s.page}>
            <AppBar title="Chats" back="/ask" />
            <main className={s.content}>
                {chats.isError ? (
                    <ErrorState onRetry={() => void chats.refetch()} />
                ) : chats.data?.length === 0 ? (
                    <div className={s.empty}>
                        <h2 className={s.emptyTitle}>No chats yet</h2>
                        <p className={s.lead}>Questions you ask Florence show up here.</p>
                        <Button onClick={() => navigate('/ask')}>Ask a question</Button>
                    </div>
                ) : (
                    <>
                        <label className={s.search}>
                            <Icon name="search-small" />
                            <input
                                type="search"
                                placeholder="Search your chats"
                                aria-label="Search your chats"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                            />
                        </label>
                        {chats.isPending ? (
                            <Loading />
                        ) : shown.length > 0 ? (
                            <ul className={s.list}>
                                {shown.map((c) => (
                                    <li key={c.id}>
                                        <button
                                            type="button"
                                            className={s.row}
                                            onClick={() => navigate(`/ask/${c.id}`)}
                                        >
                                            <Icon name="chat-row" className={s.rowIcon} />
                                            <span className={s.rowName}>
                                                {c.title ?? 'New chat'}
                                            </span>
                                            <Icon name="caret-right" className={s.caret} />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className={s.lead}>No chats match "{query.trim()}".</p>
                        )}
                    </>
                )}
            </main>
        </div>
    );
}

function split(text: string): [string, string] {
    const plain = plainText(text).replace(/\s+/g, ' ').trim();
    const cut = plain.search(/[.?!:](\s|$)/);
    if (cut > 0 && cut < 90) return [plain.slice(0, cut + 1), plain.slice(cut + 2)];
    return [plain.slice(0, 60), plain.slice(60)];
}

const savedOn = (iso: string) =>
    new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export function SavedAnswersScreen() {
    const navigate = useNavigate();
    const toast = useToast();
    const queryClient = useQueryClient();
    const saved = useQuery({ queryKey: ['saved'], queryFn: listSavedAnswers });

    const unsave = async (id: string) => {
        try {
            await setSaved(id, false);
            await queryClient.invalidateQueries({ queryKey: ['saved'] });
            toast('Removed from saved');
        } catch {
            toast('Could not update. Try again.');
        }
    };

    return (
        <div className={s.page}>
            <AppBar title="Saved" back="/ask" />
            <main className={s.content}>
                {saved.isError ? (
                    <ErrorState onRetry={() => void saved.refetch()} />
                ) : saved.isPending ? (
                    <Loading />
                ) : saved.data.length === 0 ? (
                    <div className={s.empty}>
                        <h2 className={s.emptyTitle}>Nothing saved yet</h2>
                        <p className={s.lead}>Tap the bookmark on an answer to keep it here.</p>
                        <Button onClick={() => navigate('/ask')}>Ask a question</Button>
                    </div>
                ) : (
                    <ul className={s.cards}>
                        {saved.data.map((m) => {
                            const [head, rest] = split(m.text);
                            return (
                                <li key={m.id} className={s.savedCard}>
                                    <div className={s.savedTop}>
                                        <span className={s.label}>{savedOn(m.createdAt)}</span>
                                        <button
                                            type="button"
                                            className={s.savedMark}
                                            aria-label="Remove from saved"
                                            onClick={() => void unsave(m.id)}
                                        >
                                            <Icon name="bookmark-fill" />
                                        </button>
                                    </div>
                                    <p className={s.excerptTitle}>{head}</p>
                                    {rest ? <p className={s.savedBody}>{rest}</p> : null}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </main>
        </div>
    );
}
