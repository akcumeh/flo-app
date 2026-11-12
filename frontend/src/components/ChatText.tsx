import { Fragment } from 'react';
import { parseChat, parseInline, type Inline } from '../lib/answer';
import s from './ChatText.module.scss';

const STEP = /^\s*(\d{1,2})[.)]\s+(.*)$/;

function InlineText({ parts }: { parts: Inline[] }) {
    return (
        <>
            {parts.map((p, i) => {
                if (p.kind === 'bold') return <strong key={i}>{p.text}</strong>;
                if (p.kind === 'italic') return <em key={i}>{p.text}</em>;
                if (p.kind === 'code') return <code key={i}>{p.text}</code>;
                return <Fragment key={i}>{p.text}</Fragment>;
            })}
        </>
    );
}

function flat(parts: Inline[]): string {
    return parts
        .map((p) =>
            p.kind === 'bold'
                ? `*${p.text}*`
                : p.kind === 'italic'
                  ? `_${p.text}_`
                  : p.kind === 'code'
                    ? `\`${p.text}\``
                    : p.text
        )
        .join('');
}

type Group =
    { kind: 'lines'; lines: Inline[][] } | { kind: 'steps'; steps: Array<[string, Inline[]]> };

function group(lines: Inline[][]): Group[] {
    const out: Group[] = [];
    for (const line of lines) {
        const m = STEP.exec(flat(line));
        const last = out[out.length - 1];
        if (m) {
            const step: [string, Inline[]] = [m[1], parseInline(m[2])];
            if (last?.kind === 'steps') last.steps.push(step);
            else out.push({ kind: 'steps', steps: [step] });
        } else if (last?.kind === 'lines') last.lines.push(line);
        else out.push({ kind: 'lines', lines: [line] });
    }
    return out;
}

export function ChatText({ text }: { text: string }) {
    return (
        <div className={s.text}>
            {parseChat(text).map((block, i) =>
                block.kind === 'code' ? (
                    <pre key={i}>
                        <code>{block.text}</code>
                    </pre>
                ) : (
                    group(block.lines).map((g, k) =>
                        g.kind === 'steps' ? (
                            <ol key={`${i}-${k}`} className={s.steps}>
                                {g.steps.map(([n, parts]) => (
                                    <li key={n} className={s.step}>
                                        <span className={s.badge} aria-hidden="true">
                                            {n}
                                        </span>
                                        <span className={s.stepText}>
                                            <InlineText parts={parts} />
                                        </span>
                                    </li>
                                ))}
                            </ol>
                        ) : (
                            <p key={`${i}-${k}`}>
                                {g.lines.map((line, n) => (
                                    <Fragment key={n}>
                                        {n > 0 ? <br /> : null}
                                        <InlineText parts={line} />
                                    </Fragment>
                                ))}
                            </p>
                        )
                    )
                )
            )}
        </div>
    );
}
