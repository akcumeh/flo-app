import { shuffle } from '../src/study/generator.service.js';

describe('mcq option order', () => {
    it('puts the correct option in every position over many questions', () => {
        const seen = new Set<number>();
        for (let i = 0; i < 200; i += 1) {
            seen.add(shuffle(['right', 'w1', 'w2', 'w3']).indexOf('right'));
        }
        expect([...seen].sort()).toEqual([0, 1, 2, 3]);
        expect(shuffle(['a', 'b', 'c', 'd']).sort()).toEqual(['a', 'b', 'c', 'd']);
    });
});
