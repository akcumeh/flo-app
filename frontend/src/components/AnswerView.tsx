import { useState } from 'react';
import { Icon } from './Icon';
import { pagesLabel, parseAnswer } from '../lib/answer';
import type { Citation } from '../api';
import s from './AnswerView.module.scss';

interface AnswerViewProps {
    text: string;
    citations: Citation[];
    streaming: boolean;
    onStartQuiz?: () => void;
    quizSize?: number;
}

export function AnswerView({
    text,
    citations,
    streaming,
    onStartQuiz,
    quizSize = 5,
}: AnswerViewProps) {
    const [vote, setVote] = useState<'up' | 'down' | null>(null);
    const [copied, setCopied] = useState(false);
    const blocks = parseAnswer(text);

    const byFile = new Map<string, { label: string; pages: number[] }>();
    for (const c of citations) {
        const entry = byFile.get(c.fileId) ?? { label: c.label, pages: [] };
        if (c.page) entry.pages.push(c.page);
        byFile.set(c.fileId, entry);
    }
    const allPages = citations.flatMap((c) => (c.page ? [c.page] : []));

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(
                text.replace(/\[p\.\d+\]/g, '').replace(/^#\s*/gm, '')
            );
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            setCopied(false);
        }
    };

    return (
        <section className={s.answer} aria-busy={streaming}>
            <div className={s.who}>
                <span className={s.avatar}>
                    <Icon name="asterisk-avatar" />
                </span>
                <p className={s.name}>
                    Florence<span className={s.star}>*</span>
                </p>
            </div>

            {blocks.map((block, i) => {
                if (block.kind === 'headline') {
                    return (
                        <h2 key={i} className={s.headline}>
                            {block.text}
                        </h2>
                    );
                }
                if (block.kind === 'steps') {
                    return (
                        <ol key={i} className={s.steps}>
                            {block.steps.map((step, n) => (
                                <li key={n} className={s.step}>
                                    <span className={s.num}>{n + 1}</span>
                                    <p>
                                        {step.text}{' '}
                                        {step.pages.map((p) => (
                                            <button key={p} type="button" className={s.page}>
                                                p.{p}
                                            </button>
                                        ))}
                                    </p>
                                </li>
                            ))}
                        </ol>
                    );
                }
                if (block.kind === 'callout') {
                    return (
                        <div key={i} className={s.callout}>
                            <p className={s.calloutLabel}>{block.label.toUpperCase()}</p>
                            <p className={s.calloutText}>{block.text}</p>
                        </div>
                    );
                }
                return (
                    <p key={i} className={s.paragraph}>
                        {block.text}
                    </p>
                );
            })}

            {!streaming &&
                [...byFile.values()].map((file) => (
                    <button key={file.label} type="button" className={s.source}>
                        <span className={s.fileIcon}>
                            <Icon name="doc" />
                        </span>
                        <span className={s.sourceText}>
                            <span className={s.sourceName}>{file.label}</span>
                            {file.pages.length > 0 && (
                                <span className={s.sourcePages}>
                                    Cited on {pagesLabel(file.pages)}
                                </span>
                            )}
                        </span>
                        <Icon name="chevron" className={s.chevron} />
                    </button>
                ))}

            {!streaming && (
                <div className={s.feedback}>
                    <button
                        type="button"
                        aria-label={copied ? 'Copied' : 'Copy answer'}
                        onClick={copy}
                    >
                        <Icon name="copy" />
                    </button>
                    <button
                        type="button"
                        aria-label="Good answer"
                        aria-pressed={vote === 'up'}
                        onClick={() => setVote(vote === 'up' ? null : 'up')}
                    >
                        <Icon name="thumb-up" />
                    </button>
                    <button
                        type="button"
                        aria-label="Bad answer"
                        aria-pressed={vote === 'down'}
                        onClick={() => setVote(vote === 'down' ? null : 'down')}
                    >
                        <Icon name="thumb-down" className={s.flip} />
                    </button>
                </div>
            )}

            {!streaming && allPages.length > 0 && onStartQuiz && (
                <div className={s.quiz}>
                    <div className={s.quizText}>
                        <h3>Test yourself on this</h3>
                        <p>
                            {quizSize} quick questions from {pagesLabel(allPages)} · {quizSize}{' '}
                            tokens
                        </p>
                        <button type="button" className={s.start} onClick={onStartQuiz}>
                            Start <Icon name="arrow-right" />
                        </button>
                    </div>
                    <div className={s.stack} aria-hidden="true">
                        <span className={`${s.card} ${s.c1}`} />
                        <span className={`${s.card} ${s.c2}`} />
                        <span className={`${s.card} ${s.c3}`} />
                        <Icon name="asterisk-card" className={s.stackStar} />
                    </div>
                </div>
            )}
        </section>
    );
}
