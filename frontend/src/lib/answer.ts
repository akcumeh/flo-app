export type AnswerBlock =
  | { kind: 'headline'; text: string }
  | { kind: 'steps'; steps: Array<{ text: string; pages: number[] }> }
  | { kind: 'callout'; label: string; text: string }
  | { kind: 'paragraph'; text: string };

const CITE = /\s*\[p\.(\d+)\]/g;

function splitCitations(raw: string): { text: string; pages: number[] } {
  const pages: number[] = [];
  const text = raw.replace(CITE, (_m, p: string) => {
    pages.push(Number(p));
    return '';
  });
  return { text: text.trim(), pages };
}

export function parseAnswer(source: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('# ')) {
      blocks.push({ kind: 'headline', text: trimmed.slice(2) });
      continue;
    }

    const step = trimmed.match(/^\d+\.\s+(.*)$/);
    if (step) {
      const last = blocks[blocks.length - 1];
      const parsed = splitCitations(step[1]);
      if (last && last.kind === 'steps') last.steps.push(parsed);
      else blocks.push({ kind: 'steps', steps: [parsed] });
      continue;
    }

    const callout = trimmed.match(/^>\s*([^:]{2,24}):\s*(.*)$/);
    if (callout) {
      blocks.push({ kind: 'callout', label: callout[1], text: callout[2] });
      continue;
    }

    blocks.push({ kind: 'paragraph', text: trimmed });
  }
  return blocks;
}

export function pagesLabel(pages: number[]): string {
  const unique = [...new Set(pages)].sort((a, b) => a - b);
  if (unique.length === 0) return '';
  if (unique.length === 1) return `page ${unique[0]}`;
  const head = unique.slice(0, -1).join(', ');
  return `pages ${head} and ${unique[unique.length - 1]}`;
}
