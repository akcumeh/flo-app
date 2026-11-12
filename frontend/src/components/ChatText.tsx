import { Fragment } from 'react';
import { parseChat, type Inline } from '../lib/answer';

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

export function ChatText({ text }: { text: string }) {
    return (
        <>
            {parseChat(text).map((block, i) =>
                block.kind === 'code' ? (
                    <pre key={i}>
                        <code>{block.text}</code>
                    </pre>
                ) : (
                    <p key={i}>
                        {block.lines.map((line, n) => (
                            <Fragment key={n}>
                                {n > 0 ? <br /> : null}
                                <InlineText parts={line} />
                            </Fragment>
                        ))}
                    </p>
                )
            )}
        </>
    );
}
