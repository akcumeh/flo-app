import { Inject, Injectable } from '@nestjs/common';
import { AI_PROVIDER, parseJson, type AiProvider } from '../ai/ai.provider.js';
import { AppError } from '../common/app-error.js';
import type { Queryable } from '../db/db.js';

export type StudyMode = 'quiz' | 'flashcards' | 'fill_blank' | 'mock_exam';
export type ItemType =
    'mcq' | 'true_false' | 'fill_gap' | 'short' | 'theory' | 'calculation' | 'flashcard';
export const MODES: StudyMode[] = ['quiz', 'flashcards', 'fill_blank', 'mock_exam'];

const MODE_TYPES: Record<StudyMode, ItemType[]> = {
    quiz: ['mcq', 'true_false', 'short', 'theory', 'calculation'],
    mock_exam: ['mcq', 'short', 'theory', 'calculation'],
    flashcards: ['flashcard'],
    fill_blank: ['fill_gap'],
};

const MODE_BRIEF: Record<StudyMode, string> = {
    quiz: 'Mix types to suit the material: mostly mcq with 4 options, some true_false, and a few short, theory or calculation questions where the notes support them. Calculation questions only where the notes contain numbers or formulas.',
    mock_exam:
        'Write them like a Nigerian university exam paper: mcq with 4 options, short answers, theory questions worth 5 to 10 marks, and calculations where the notes support them.',
    flashcards:
        'Every item is a flashcard: "prompt" is the front (a term, question or cue) and "answer" is the back, at most two sentences.',
    fill_blank:
        'Every item is a fill_gap sentence copied closely from the notes with one key term replaced by "____". "answer" is the missing term and "acceptable" lists other spellings or equivalent terms.',
};

const GENERATE_SYSTEM = `You are Florence, an exam-prep tutor for Nigerian university and polytechnic students.
You write study items strictly from the student's own notes. Never test facts that are not in the notes.
Each excerpt of the notes is tagged like [F2 p7], meaning file 2, page 7. Give the file number and page each item comes from.
Explanations teach: say why the right answer is right in one to three sentences, in plain English.`;

const MARK_SYSTEM = `You are Florence, marking a student's answer the way a fair Nigerian university examiner would.
Mark against the model answer and the notes. Give credit for correct points in the student's own words.
Be specific and encouraging in feedback, and never invent facts beyond the notes.`;

const ITEMS_SCHEMA = {
    type: 'object',
    properties: {
        items: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    type: {
                        type: 'string',
                        enum: [
                            'mcq',
                            'true_false',
                            'fill_gap',
                            'short',
                            'theory',
                            'calculation',
                            'flashcard',
                        ],
                    },
                    prompt: { type: 'string' },
                    options: { type: 'array', items: { type: 'string' } },
                    answer: { type: 'string' },
                    acceptable: { type: 'array', items: { type: 'string' } },
                    explanation: { type: 'string' },
                    wrongOptionReasons: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { option: { type: 'string' }, reason: { type: 'string' } },
                            required: ['option', 'reason'],
                            additionalProperties: false,
                        },
                    },
                    examTip: { type: 'string' },
                    marks: { type: 'integer' },
                    difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
                    topic: { type: 'string' },
                    fileRef: { type: 'integer' },
                    page: { type: 'integer' },
                },
                required: [
                    'type',
                    'prompt',
                    'options',
                    'answer',
                    'acceptable',
                    'explanation',
                    'wrongOptionReasons',
                    'examTip',
                    'marks',
                    'difficulty',
                    'topic',
                    'fileRef',
                    'page',
                ],
                additionalProperties: false,
            },
        },
    },
    required: ['items'],
    additionalProperties: false,
};

const MARK_SCHEMA = {
    type: 'object',
    properties: {
        awardedMarks: { type: 'integer' },
        feedback: { type: 'string' },
        whyRight: { type: 'string' },
        examTip: { type: 'string' },
    },
    required: ['awardedMarks', 'feedback', 'whyRight', 'examTip'],
    additionalProperties: false,
};

export interface MaterialFile {
    id: string;
    name: string;
    ref: number;
}

export interface Material {
    files: MaterialFile[];
    text: string;
}

export interface AnswerKey {
    answer: string;
    acceptable: string[];
    explanation: string;
    wrongOptionReasons: Array<{ option: string; reason: string }>;
    examTip: string;
    fileId: string | null;
    page: number | null;
}

export interface GeneratedItem {
    type: ItemType;
    prompt: string;
    options: string[] | null;
    back: string | null;
    key: AnswerKey;
    marks: number;
    difficulty: 'easy' | 'medium' | 'hard';
    topic: string;
    sourceLabel: string;
}

const MATERIAL_CHARS = 120_000;
export const MIN_MATERIAL_CHARS = 150;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const normalise = (s: string) =>
    s
        .trim()
        .toLowerCase()
        .replace(/[.,;:!?'"`]/g, '')
        .replace(/\s+/g, ' ');

function parsePages(pages: string | null): [number, number] | null {
    if (!pages) return null;
    const [a, b] = pages.split('-').map(Number);
    return Number.isInteger(a) ? [a, Number.isInteger(b) ? b : a] : null;
}

@Injectable()
export class GeneratorService {
    constructor(@Inject(AI_PROVIDER) private readonly ai: AiProvider) {}

    async material(
        q: Queryable,
        accountId: string,
        fileIds: string[],
        topicIds: string[] = []
    ): Promise<Material> {
        const ids = [...new Set(fileIds)];
        if (!ids.every((id) => UUID.test(id))) throw AppError.notFound('No such file.');
        const files = await q.query<{ id: string; name: string; status: string; kind: string }>(
            `select id, name, status, kind from stored_files
        where id = any($1::uuid[]) and account_id = $2 and deleted_at is null`,
            [ids, accountId]
        );
        if (files.length !== ids.length) throw AppError.notFound('No such file.');
        if (files.some((f) => f.status !== 'ready')) {
            throw AppError.conflict(
                'not_enough_material',
                'Florence is still reading one of these files. Try again in a moment.'
            );
        }
        if (files.every((f) => f.kind === 'audio')) {
            throw AppError.unprocessable(
                'mode_not_possible',
                'Voice notes cannot be turned into questions yet.'
            );
        }

        const ordered = ids.map((id, i) => ({
            ...(files.find((f) => f.id === id) as (typeof files)[number]),
            ref: i + 1,
        }));
        const chunks = await q.query<{ file_id: string; page: number | null; text: string }>(
            'select file_id, page, text from file_chunks where file_id = any($1::uuid[]) order by file_id, ord',
            [ids]
        );

        let ranges: Array<{ fileId: string; from: number; to: number }> | null = null;
        if (topicIds.length > 0) {
            const topics = await q.query<{ file_id: string; pages: string | null }>(
                `select file_id, pages from file_topics where file_id = any($1::uuid[]) and id::text = any($2::text[])`,
                [ids, topicIds]
            );
            ranges = topics.flatMap((t) => {
                const r = parsePages(t.pages);
                return r ? [{ fileId: t.file_id, from: r[0], to: r[1] }] : [];
            });
        }

        let text = '';
        for (const f of ordered) {
            for (const c of chunks.filter((x) => x.file_id === f.id)) {
                if (
                    ranges &&
                    !ranges.some(
                        (r) =>
                            r.fileId === f.id &&
                            c.page !== null &&
                            c.page >= r.from &&
                            c.page <= r.to
                    )
                )
                    continue;
                const block = `[F${f.ref} p${c.page ?? 1}] ${c.text}\n\n`;
                if (text.length + block.length > MATERIAL_CHARS) break;
                text += block;
            }
        }
        if (text.replace(/\[F\d+ p\d+\]/g, '').trim().length < MIN_MATERIAL_CHARS) {
            throw AppError.conflict(
                'not_enough_material',
                'There is not enough in this material for 2 questions. Add more notes.'
            );
        }
        return { files: ordered.map((f) => ({ id: f.id, name: f.name, ref: f.ref })), text };
    }

    async generate(
        material: Material,
        mode: StudyMode,
        count: number,
        focus?: string
    ): Promise<GeneratedItem[]> {
        const fileList = material.files.map((f) => `F${f.ref}: ${f.name}`).join('\n');
        const reply = await this.ai.complete({
            system: GENERATE_SYSTEM,
            messages: [
                {
                    role: 'user',
                    content: `Files:\n${fileList}\n\nNotes:\n${material.text}\n\nWrite exactly ${count} study items for ${mode.replace('_', ' ')} mode. ${MODE_BRIEF[mode]}
Allowed types: ${MODE_TYPES[mode].join(', ')}.
For mcq give 4 options and set "answer" to the full text of the correct option; give a reason for each wrong option in "wrongOptionReasons". For true_false set options to ["True", "False"].
For short, theory and calculation give a model answer in "answer". Use empty arrays and empty strings for fields that do not apply.
Set "marks" to 1 for mcq, true_false, fill_gap and flashcard, and 2 to 10 for written answers.
${focus ? `Focus on: ${focus}\n` : ''}Spread the items across the material and vary the difficulty.`,
                },
            ],
            maxTokens: 32000,
            effort: 'medium',
            jsonSchema: ITEMS_SCHEMA,
        });
        const { items = [] } = parseJson<{ items?: Array<Record<string, unknown>> }>(reply);
        return this.sanitise(items, material, mode).slice(0, count);
    }

    private sanitise(
        raw: Array<Record<string, unknown>>,
        material: Material,
        mode: StudyMode
    ): GeneratedItem[] {
        const allowed = new Set(MODE_TYPES[mode]);
        const out: GeneratedItem[] = [];
        for (const r of raw) {
            const type = String(r.type) as ItemType;
            const prompt = String(r.prompt ?? '').trim();
            const answer = String(r.answer ?? '').trim();
            if (!allowed.has(type) || !prompt || !answer) continue;

            let options: string[] | null = null;
            let key = answer;
            if (type === 'mcq') {
                options = (Array.isArray(r.options) ? r.options : [])
                    .map((o) => String(o).trim())
                    .filter(Boolean);
                const match = options.find((o) => normalise(o) === normalise(answer));
                if (options.length < 3 || !match) continue;
                key = match;
            }
            if (type === 'true_false') {
                options = ['True', 'False'];
                const t = normalise(answer);
                if (t !== 'true' && t !== 'false') continue;
                key = t === 'true' ? 'True' : 'False';
            }
            if (type === 'fill_gap' && !prompt.includes('____')) continue;

            const file =
                material.files.find((f) => f.ref === Number(r.fileRef)) ?? material.files[0];
            const page =
                Number.isInteger(r.page) && (r.page as number) >= 1 ? (r.page as number) : null;
            const isWritten = type === 'short' || type === 'theory' || type === 'calculation';
            const marks = isWritten
                ? Math.min(10, Math.max(1, Math.round(Number(r.marks) || 2)))
                : 1;
            out.push({
                type,
                prompt,
                options,
                back: type === 'flashcard' ? answer : null,
                key: {
                    answer: key,
                    acceptable: (Array.isArray(r.acceptable) ? r.acceptable : [])
                        .map((a) => String(a))
                        .filter(Boolean),
                    explanation: String(r.explanation ?? '').trim(),
                    wrongOptionReasons: (Array.isArray(r.wrongOptionReasons)
                        ? r.wrongOptionReasons
                        : []
                    )
                        .map((w) => w as { option?: unknown; reason?: unknown })
                        .filter((w) => w.option && w.reason)
                        .map((w) => ({ option: String(w.option), reason: String(w.reason) })),
                    examTip: String(r.examTip ?? '').trim(),
                    fileId: file.id,
                    page,
                },
                marks,
                difficulty: ['easy', 'medium', 'hard'].includes(String(r.difficulty))
                    ? (r.difficulty as GeneratedItem['difficulty'])
                    : 'medium',
                topic:
                    String(r.topic ?? '')
                        .trim()
                        .slice(0, 80) || 'General',
                sourceLabel: page ? `${file.name}, p. ${page}` : file.name,
            });
        }
        return out;
    }

    async mark(input: {
        prompt: string;
        marks: number;
        key: AnswerKey;
        notes: string;
        answer: string;
    }): Promise<{
        awardedMarks: number;
        feedback: string;
        whyRight: string;
        examTip: string;
    } | null> {
        const request = {
            system: MARK_SYSTEM,
            messages: [
                {
                    role: 'user' as const,
                    content: `Relevant notes:\n${input.notes || '(not available)'}\n\nQuestion (${input.marks} mark${input.marks === 1 ? '' : 's'}): ${input.prompt}\nModel answer: ${input.key.answer}\n\nStudent's answer:\n"""${input.answer}"""\n\nAward 0 to ${input.marks} marks. In "feedback", tell the student in one or two sentences what they got right and what was missing. In "whyRight", explain the correct answer. In "examTip", give one short tip for this kind of question.`,
                },
            ],
            maxTokens: 4000,
            effort: 'medium' as const,
            jsonSchema: MARK_SCHEMA,
        };
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const out = parseJson<{
                    awardedMarks: number;
                    feedback: string;
                    whyRight: string;
                    examTip: string;
                }>(await this.ai.complete(request));
                if (typeof out.awardedMarks !== 'number') continue;
                return {
                    awardedMarks: Math.max(0, Math.min(input.marks, Math.round(out.awardedMarks))),
                    feedback: String(out.feedback ?? ''),
                    whyRight: String(out.whyRight ?? ''),
                    examTip: String(out.examTip ?? ''),
                };
            } catch {
                continue;
            }
        }
        return null;
    }
}
