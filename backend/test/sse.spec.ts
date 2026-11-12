import { CitationFilter } from '../src/chat/sse.js';

describe('citation filter', () => {
  function run(chunks: string[]) {
    const f = new CitationFilter();
    const out = chunks.map((c) => f.push(c)).join('') + f.flush();
    return { out, used: [...f.used] };
  }

  it('removes tags split across chunks and the space before them', () => {
    expect(run(['RuBisCO fixes CO2 ', '[S', '1], and it runs ', 'in the stroma [S2', '].'])).toEqual({
      out: 'RuBisCO fixes CO2, and it runs in the stroma.',
      used: [1, 2],
    });
  });

  it('handles tag lists and keeps ordinary brackets', () => {
    expect(run(['See [S1, S3] and [note] here.'])).toEqual({ out: 'See and [note] here.', used: [1, 3] });
    expect(run(['Array [', '0] stays'])).toEqual({ out: 'Array [0] stays', used: [] });
  });

  it('keeps spaces between words when no tag follows', () => {
    expect(run(['one ', 'two ', 'three'])).toEqual({ out: 'one two three', used: [] });
  });
});
