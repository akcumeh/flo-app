import { pagesLabel, parseChat, parseInline, plainText } from './answer';

describe('parseChat', () => {
    it('reads bot-style bold, italic and code, as Telegram shows them', () => {
        expect(parseInline('*The rules* and _a constant_ with `ln a`')).toEqual([
            { kind: 'bold', text: 'The rules' },
            { kind: 'text', text: ' and ' },
            { kind: 'italic', text: 'a constant' },
            { kind: 'text', text: ' with ' },
            { kind: 'code', text: 'ln a' },
        ]);
    });

    it('leaves maths like log_a x and 3x * 2 alone', () => {
        expect(parseInline('d/dx log_a x = 1/(x ln a)')).toEqual([
            { kind: 'text', text: 'd/dx log_a x = 1/(x ln a)' },
        ]);
        expect(parseInline("u = 3x² + 1, u' = 6x")).toEqual([
            { kind: 'text', text: "u = 3x² + 1, u' = 6x" },
        ]);
    });

    it('keeps one line per step and splits paragraphs on blank lines', () => {
        const blocks = parseChat('*Why it works*\n\nd/dx ln x = 1/x\nd/dx log₁₀ x = 1/(x ln 10)');
        expect(blocks).toHaveLength(2);
        expect(blocks[1]).toMatchObject({ kind: 'paragraph' });
        expect(blocks[1].kind === 'paragraph' && blocks[1].lines).toHaveLength(2);
    });

    it('keeps code blocks as they are and drops # heading marks', () => {
        const blocks = parseChat('## Steps\n\n```python\nprint(1)\n```');
        expect(blocks[0]).toEqual({
            kind: 'paragraph',
            lines: [[{ kind: 'text', text: 'Steps' }]],
        });
        expect(blocks[1]).toEqual({ kind: 'code', text: 'print(1)' });
    });

    it('copies as plain text without the marks', () => {
        expect(plainText('*Rule*: _note_ `x`')).toBe('Rule: note x');
    });
});

describe('pagesLabel', () => {
    it('formats one, two and many pages', () => {
        expect(pagesLabel([14])).toBe('page 14');
        expect(pagesLabel([17, 14, 14])).toBe('pages 14 and 17');
        expect(pagesLabel([3, 9, 12])).toBe('pages 3, 9 and 12');
        expect(pagesLabel([])).toBe('');
    });
});
