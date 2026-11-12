import 'dotenv/config';
import { AnthropicProvider } from '../src/ai/ai.provider.js';
import { loadConfig } from '../src/config.js';
import { ReaderService } from '../src/files/reader.service.js';
import { makePdf } from '../test/fixtures.js';

const config = loadConfig();
if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not set');
const ai = new AnthropicProvider(config.anthropicApiKey, config.aiModel);
const reader = new ReaderService(null as never, null as never, ai, {
    register: () => undefined,
} as never);

const pages = [
    'Enzymes are biological catalysts.\nThey lower the activation energy of reactions.\nThe active site binds the substrate.',
    'Factors affecting enzyme activity: temperature, pH and substrate concentration.\nAbove the optimum temperature enzymes denature.',
    'Competitive inhibitors bind the active site.\nNon-competitive inhibitors bind an allosteric site and change its shape.',
];
const pdf = makePdf(pages);

const started = Date.now();
const transcript = await (
    reader as unknown as { transcribe: (c: unknown, n: number) => Promise<string[]> }
).transcribe(
    [
        {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') },
        },
        { type: 'text', text: `Transcribe all ${pages.length} pages of this PDF.` },
    ],
    pages.length
);
console.log('model', config.aiModel);
console.log(
    'transcribed pages',
    transcript.map((t) => t.length)
);
console.log('page 3 starts', JSON.stringify(transcript[2].slice(0, 60)));
const topics = await reader.findTopics(transcript);
console.log('topics', JSON.stringify(topics));
console.log('seconds', ((Date.now() - started) / 1000).toFixed(1));
