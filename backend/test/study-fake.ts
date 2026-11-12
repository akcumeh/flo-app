import type { AiRequest } from '../src/ai/ai.provider.js';

export const STUDY_NOTES = [
  'Osmosis is the movement of water across a semi-permeable membrane from a dilute solution to a concentrated one.\nIt needs no energy from the cell.',
  'Active transport moves ions against their concentration gradient using ATP.\nThe sodium-potassium pump moves 3 sodium ions out and 2 potassium ions in.',
];

function item(type: string, i: number) {
  const base = {
    type,
    options: [] as string[],
    acceptable: [] as string[],
    explanation: `Explanation ${i}.`,
    wrongOptionReasons: [] as Array<{ option: string; reason: string }>,
    examTip: 'Define the term first.',
    marks: 1,
    difficulty: 'easy',
    topic: i % 2 === 0 ? 'Osmosis' : 'Active transport',
    fileRef: 1,
    page: (i % 2) + 1,
  };
  switch (type) {
    case 'mcq':
      return {
        ...base,
        prompt: `Question ${i}: what does the sodium-potassium pump use?`,
        options: ['ATP', 'Light', 'Water', 'Glucose'],
        answer: 'ATP',
        wrongOptionReasons: [
          { option: 'Light', reason: 'Light drives photosynthesis, not the pump.' },
          { option: 'Water', reason: 'Water moves by osmosis.' },
        ],
      };
    case 'true_false':
      return { ...base, prompt: `Statement ${i}: osmosis needs ATP.`, options: ['True', 'False'], answer: 'False' };
    case 'theory':
      return { ...base, prompt: `Explain ${i}: compare osmosis and active transport.`, answer: 'Osmosis is passive, active transport uses ATP.', marks: 4 };
    case 'flashcard':
      return { ...base, prompt: `Card ${i}: osmosis`, answer: 'Water moving across a semi-permeable membrane.' };
    case 'fill_gap':
      return { ...base, prompt: `Gap ${i}: Active transport uses ____.`, answer: 'ATP', acceptable: ['adenosine triphosphate'] };
    default:
      return { ...base, prompt: `Short ${i}`, answer: 'answer' };
  }
}

export interface StudyFakeOptions {
  count?: number;
  quizTypes?: string[];
  awardedMarks?: number;
}

export function studyResponder(opts: StudyFakeOptions = {}) {
  return (req: AiRequest): string => {
    const props = (req.jsonSchema?.properties ?? {}) as Record<string, unknown>;
    if ('awardedMarks' in props) {
      return JSON.stringify({
        awardedMarks: opts.awardedMarks ?? 2,
        feedback: 'You named osmosis correctly but missed ATP.',
        whyRight: 'Active transport needs ATP; osmosis does not.',
        examTip: 'Use the word gradient.',
      });
    }
    if ('items' in props) {
      const text = String(req.messages[0].content);
      const requested = Number(/Write exactly (\d+) study items/.exec(text)?.[1] ?? 4);
      const mode = /for (quiz|flashcards|fill blank|mock exam) mode/.exec(text)?.[1] ?? 'quiz';
      const types =
        mode === 'flashcards' ? ['flashcard'] : mode === 'fill blank' ? ['fill_gap'] : (opts.quizTypes ?? ['mcq', 'true_false', 'theory']);
      const n = opts.count ?? requested;
      return JSON.stringify({ items: Array.from({ length: n }, (_, i) => item(types[i % types.length], i)) });
    }
    if ('topics' in props) return JSON.stringify({ topics: [{ name: 'Osmosis', firstPage: 1, lastPage: 1 }] });
    return 'ok';
  };
}
