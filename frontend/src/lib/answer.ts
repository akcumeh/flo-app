export type Inline =
    | { kind: 'text'; text: string }
    | { kind: 'bold'; text: string }
    | { kind: 'italic'; text: string }
    | { kind: 'code'; text: string };

export type ChatBlock = { kind: 'code'; text: string } | { kind: 'paragraph'; lines: Inline[][] };

const INLINE = /(\*\*[^*\n]+\*\*|\*[^*\s][^*\n]*\*|`[^`\n]+`|(?<![\w\\])_[^_\s][^_\n]*_(?!\w))/g;

export function parseInline(line: string): Inline[] {
    const out: Inline[] = [];
    let last = 0;
    for (const m of line.matchAll(INLINE)) {
        const token = m[0];
        const at = m.index ?? 0;
        if (at > last) out.push({ kind: 'text', text: line.slice(last, at) });
        if (token.startsWith('**')) out.push({ kind: 'bold', text: token.slice(2, -2) });
        else if (token.startsWith('*')) out.push({ kind: 'bold', text: token.slice(1, -1) });
        else if (token.startsWith('`')) out.push({ kind: 'code', text: token.slice(1, -1) });
        else out.push({ kind: 'italic', text: token.slice(1, -1) });
        last = at + token.length;
    }
    if (last < line.length) out.push({ kind: 'text', text: line.slice(last) });
    return out;
}

export function parseChat(source: string): ChatBlock[] {
    const blocks: ChatBlock[] = [];
    const parts = source.replace(/\r\n/g, '\n').split(/```[^\n]*\n?/);
    parts.forEach((part, i) => {
        if (i % 2 === 1) {
            blocks.push({ kind: 'code', text: part.replace(/\n$/, '') });
            return;
        }
        for (const para of part.split(/\n{2,}/)) {
            const lines = para
                .split('\n')
                .map((l) => l.replace(/^#{1,6}\s+/, ''))
                .filter((l) => l.trim().length > 0);
            if (lines.length > 0) blocks.push({ kind: 'paragraph', lines: lines.map(parseInline) });
        }
    });
    return blocks;
}

export function plainText(source: string): string {
    return source
        .replace(/```[^\n]*\n?/g, '')
        .replace(/\*\*([^*\n]+)\*\*/g, '$1')
        .replace(/\*([^*\s][^*\n]*)\*/g, '$1')
        .replace(/(?<![\w\\])_([^_\s][^_\n]*)_(?!\w)/g, '$1')
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/^#{1,6}\s+/gm, '');
}

export function pagesLabel(pages: number[]): string {
    const unique = [...new Set(pages)].sort((a, b) => a - b);
    if (unique.length === 0) return '';
    if (unique.length === 1) return `page ${unique[0]}`;
    const head = unique.slice(0, -1).join(', ');
    return `pages ${head} and ${unique[unique.length - 1]}`;
}
