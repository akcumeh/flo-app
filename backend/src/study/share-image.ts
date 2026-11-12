import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import satori from 'satori';

const require = createRequire(import.meta.url);

let fonts: Array<{ name: string; data: Buffer; weight: 400 | 700; style: 'normal' }> | null = null;

function loadFonts() {
    fonts ??= [400, 700].map((weight) => ({
        name: 'Figtree',
        data: readFileSync(
            require.resolve(`@fontsource/figtree/files/figtree-latin-${weight}-normal.woff`)
        ),
        weight: weight as 400 | 700,
        style: 'normal' as const,
    }));
    return fonts;
}

type Node = { type: string; props: { style?: Record<string, unknown>; children?: unknown } };

const el = (type: string, style: Record<string, unknown>, children?: unknown): Node => ({
    type,
    props: { style, children },
});

const MODE_LABEL: Record<string, string> = {
    quiz: 'Quiz',
    flashcards: 'Flashcards',
    fill_blank: 'Fill in the blank',
    mock_exam: 'Mock exam',
};

export async function renderSessionCard(input: {
    mode: string;
    score: number;
    total: number;
    showScore: boolean;
    streak: number;
    topics: string[];
}): Promise<Buffer> {
    const topicLine = input.topics.slice(0, 3).join(' · ') || 'My own notes';
    const tree = el(
        'div',
        {
            width: 1080,
            height: 1350,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            padding: 96,
            background: '#017ffd',
            color: '#ffffff',
            fontFamily: 'Figtree',
        },
        [
            el('div', { display: 'flex', fontSize: 56, fontWeight: 700 }, 'Florence*'),
            el('div', { display: 'flex', flexDirection: 'column', gap: 32 }, [
                el(
                    'div',
                    { display: 'flex', fontSize: 44, opacity: 0.85 },
                    `${MODE_LABEL[input.mode] ?? 'Study'} session done`
                ),
                el(
                    'div',
                    {
                        display: 'flex',
                        fontSize: input.showScore ? 220 : 120,
                        fontWeight: 700,
                        lineHeight: 1,
                    },
                    input.showScore ? `${input.score}/${input.total}` : 'Finished'
                ),
                el('div', { display: 'flex', fontSize: 40, lineHeight: 1.3 }, topicLine),
            ]),
            el(
                'div',
                {
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: 40,
                },
                [
                    el(
                        'div',
                        { display: 'flex', fontWeight: 700 },
                        input.streak > 0 ? `${input.streak}-day streak` : 'Studying with Florence'
                    ),
                    el('div', { display: 'flex', opacity: 0.85 }, 'florence.ai'),
                ]
            ),
        ]
    );
    const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
        width: 1080,
        height: 1350,
        fonts: loadFonts(),
    });
    return Buffer.from(new Resvg(svg).render().asPng());
}
