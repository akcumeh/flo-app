import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Citation } from '../../api';
import { plainText } from '../../lib/answer';
import { ChatText } from '../ChatText';
import { Icon, type IconName } from '../Icon';
import { Button, Sheet, useToast } from '../ui';
import s from './Ask.module.scss';

export function UserBubble({ children }: { children: ReactNode }) {
    return (
        <div className={s.bubbleRow}>
            <p className={s.bubble}>{children}</p>
        </div>
    );
}

export function sourceLabel(c: Citation): string {
    const name = c.label.replace(/\.(pdf|png|jpe?g|webp)$/i, '');
    return c.page ? `${name} · p. ${c.page}` : name;
}

function uniqueSources(citations: Citation[]): Citation[] {
    const seen = new Set<string>();
    return citations.filter((c) => {
        const key = `${c.fileId}:${c.page ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export interface AnswerCardProps {
    text: string;
    citations?: Citation[];
    streaming?: boolean;
    grounded?: boolean;
    guest?: boolean;
    saved?: boolean;
    error?: string | null;
    onSource?: (c: Citation) => void;
    onPractise?: () => void;
    onSave?: () => void;
    onMore?: () => void;
}

export function AnswerCard({
    text,
    citations = [],
    streaming,
    grounded = true,
    guest,
    saved,
    error,
    onSource,
    onPractise,
    onSave,
    onMore,
}: AnswerCardProps) {
    const toast = useToast();
    const sources = uniqueSources(citations);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(plainText(text));
            toast('Copied');
        } catch {
            toast('Could not copy. Select the text instead.');
        }
    };
    const done = !streaming && !error;
    return (
        <section className={s.card} aria-busy={streaming || undefined}>
            <div className={s.who}>
                <Icon name="asterisk-app" className={s.whoStar} />
                <span className={s.whoName}>Florence</span>
            </div>
            {done && !grounded && !guest ? (
                <p className={s.notice}>
                    <Icon name="info" className={s.noticeIcon} />
                    <span>This isn't in your notes, so this is a general answer.</span>
                </p>
            ) : null}
            {text ? <ChatText text={text} /> : null}
            {streaming && !text ? (
                <p className={s.thinking} role="status">
                    <span className={s.dot} />
                    <span className={s.dot} />
                    <span className={s.dot} />
                    <span className={s.srOnly}>Florence is writing</span>
                </p>
            ) : null}
            {error ? (
                <p className={s.error} role="alert">
                    {error}
                </p>
            ) : null}
            {done && sources.length > 0 ? (
                <div className={s.sources}>
                    {sources.map((c) => (
                        <button
                            key={`${c.fileId}:${c.page ?? ''}`}
                            type="button"
                            className={s.source}
                            onClick={() => onSource?.(c)}
                        >
                            <Icon name="file-text-small" className={s.sourceIcon} />
                            {sourceLabel(c)}
                        </button>
                    ))}
                </div>
            ) : null}
            {done && guest ? (
                <p className={s.footnote}>
                    General answer. Add your notes to get answers from your own course material.
                </p>
            ) : null}
            {done ? (
                <div className={s.actions}>
                    <button type="button" className={s.practise} onClick={onPractise}>
                        <Icon name="cards" />
                        Practise this
                    </button>
                    <button
                        type="button"
                        className={s.action}
                        aria-label="Copy answer"
                        onClick={() => void copy()}
                    >
                        <Icon name="copy-line" />
                    </button>
                    <button
                        type="button"
                        className={`${s.action} ${saved ? s.on : ''}`}
                        aria-label={saved ? 'Remove from saved' : 'Save answer'}
                        aria-pressed={saved ?? false}
                        onClick={onSave}
                    >
                        <Icon name={saved ? 'bookmark-fill' : 'bookmark'} />
                    </button>
                    {onMore ? (
                        <button
                            type="button"
                            className={s.action}
                            aria-label="More about this answer"
                            onClick={onMore}
                        >
                            <Icon name="flag" />
                        </button>
                    ) : null}
                </div>
            ) : null}
        </section>
    );
}

export function Composer({
    onSend,
    onCamera,
    disabled,
    scope,
    attachment,
    onClearAttachment,
}: {
    onSend: (text: string) => void;
    onCamera?: () => void;
    disabled?: boolean;
    scope?: string | null;
    attachment?: string | null;
    onClearAttachment?: () => void;
}) {
    const [draft, setDraft] = useState('');
    const input = useRef<HTMLInputElement>(null);
    const submit = (e: FormEvent) => {
        e.preventDefault();
        const text = draft.trim();
        if (!text || disabled) return;
        setDraft('');
        onSend(text);
    };
    const ready = draft.trim().length > 0 && !disabled;
    return (
        <form className={s.composer} onSubmit={submit}>
            {scope || attachment ? (
                <div className={s.chips}>
                    {scope ? (
                        <span className={s.scope}>
                            <Icon name="book" />
                            {scope}
                        </span>
                    ) : null}
                    {attachment ? (
                        <span className={s.scope}>
                            <Icon name="camera-line" className={s.small} />
                            {attachment}
                            {onClearAttachment ? (
                                <button
                                    type="button"
                                    className={s.clear}
                                    aria-label="Remove photo"
                                    onClick={onClearAttachment}
                                >
                                    <Icon name="x" />
                                </button>
                            ) : null}
                        </span>
                    ) : null}
                </div>
            ) : null}
            <div className={s.row}>
                <button
                    type="button"
                    className={s.round}
                    aria-label="Ask about a photo"
                    onClick={onCamera}
                >
                    <Icon name="camera-line" />
                </button>
                <input
                    ref={input}
                    className={s.input}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Ask about any topic…"
                    aria-label="Message"
                    enterKeyHint="send"
                    maxLength={2000}
                />
                <button
                    type="submit"
                    className={`${s.round} ${ready ? s.send : ''}`}
                    aria-label="Send"
                    disabled={!ready}
                >
                    <Icon name="send" />
                </button>
            </div>
        </form>
    );
}

export function SourceSheet({
    citation,
    onClose,
}: {
    citation: Citation | null;
    onClose: () => void;
}) {
    const navigate = useNavigate();
    const name = citation?.label.replace(/\.(pdf|png|jpe?g|webp)$/i, '') ?? '';
    return (
        <Sheet
            open={citation !== null}
            onClose={onClose}
            title={citation?.page ? `${name} · page ${citation.page}` : name}
        >
            <p className={s.sheetLead}>{citation?.label}</p>
            {citation?.snippet ? (
                <div className={s.passage}>
                    <p className={s.highlight}>{citation.snippet}</p>
                </div>
            ) : null}
            <div className={s.sheetActions}>
                <Button
                    block
                    onClick={() => {
                        onClose();
                        if (citation) navigate(`/library/${citation.fileId}`);
                    }}
                >
                    Open the full notes
                </Button>
                <Button variant="ghost" block onClick={onClose}>
                    Close
                </Button>
            </div>
        </Sheet>
    );
}

interface ActionRow {
    icon: IconName;
    label: string;
    brand?: boolean;
    run: () => void;
}

export function ActionsSheet({
    open,
    onClose,
    rows,
}: {
    open: boolean;
    onClose: () => void;
    rows: ActionRow[];
}) {
    return (
        <Sheet open={open} onClose={onClose} title="This answer">
            <ul className={s.rows}>
                {rows.map((r) => (
                    <li key={r.label}>
                        <button
                            type="button"
                            className={`${s.rowButton} ${r.brand ? s.rowBrand : ''}`}
                            onClick={() => {
                                onClose();
                                r.run();
                            }}
                        >
                            <Icon name={r.icon} />
                            <span className={s.rowLabel}>{r.label}</span>
                            <Icon name="caret-right" className={s.caret} />
                        </button>
                    </li>
                ))}
            </ul>
            <div className={s.sheetActions}>
                <Button variant="ghost" block onClick={onClose}>
                    Cancel
                </Button>
            </div>
        </Sheet>
    );
}

export function SavePrompt({
    open,
    onClose,
    onContinue,
}: {
    open: boolean;
    onClose: () => void;
    onContinue: () => void;
}) {
    return (
        <Sheet open={open} onClose={onClose} title="Save this and keep going?">
            <p className={s.sheetLead}>
                Make a free account to keep this answer and turn it into practice questions from
                your own notes.
            </p>
            <div className={s.sheetActions}>
                <Button block onClick={onContinue}>
                    Continue with phone number
                </Button>
                <Button variant="ghost" block onClick={onClose}>
                    Not now
                </Button>
            </div>
        </Sheet>
    );
}
