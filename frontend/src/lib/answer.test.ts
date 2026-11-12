import { pagesLabel, parseAnswer } from './answer';

describe('parseAnswer', () => {
    const sample = [
        '# Ribosomes don’t make energy. They use it.',
        '1. Mitochondria make ATP. [p.14]',
        '2. Ribosomes use it. [p.17]',
        '> In one line: Less ATP, slower proteins.',
        'A closing sentence.',
    ].join('\n');

    it('splits headline, steps, callout and paragraph', () => {
        const blocks = parseAnswer(sample);
        expect(blocks.map((b) => b.kind)).toEqual(['headline', 'steps', 'callout', 'paragraph']);
    });

    it('pulls page citations out of step text', () => {
        const steps = parseAnswer(sample).find((b) => b.kind === 'steps');
        expect(steps).toEqual({
            kind: 'steps',
            steps: [
                { text: 'Mitochondria make ATP.', pages: [14] },
                { text: 'Ribosomes use it.', pages: [17] },
            ],
        });
    });

    it('handles a half-streamed answer without throwing', () => {
        expect(() => parseAnswer('# Ribo')).not.toThrow();
        expect(parseAnswer('')).toEqual([]);
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
