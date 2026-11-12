import 'dotenv/config';
import { AnthropicProvider } from '../src/ai/ai.provider.js';
import { loadConfig } from '../src/config.js';
import { GeneratorService } from '../src/study/generator.service.js';

const config = loadConfig();
if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not set');
const generator = new GeneratorService(new AnthropicProvider(config.anthropicApiKey, config.aiModel));

const material = {
  files: [{ id: '00000000-0000-4000-8000-000000000001', name: 'BIO 102 transport.pdf', ref: 1 }],
  text: `[F1 p1] Osmosis is the movement of water molecules across a partially permeable membrane from a region of higher water potential to a region of lower water potential. It is passive and needs no ATP.

[F1 p2] Active transport moves substances against their concentration gradient. It needs energy from ATP and carrier proteins. The sodium-potassium pump moves 3 Na+ ions out of the cell and 2 K+ ions in for each ATP used.`,
};

const started = Date.now();
const items = await generator.generate(material, 'quiz', 4);
console.log('items', items.map((i) => `${i.type}:${i.marks}:${i.sourceLabel}`).join(' | '));
const written = items.find((i) => ['short', 'theory', 'calculation'].includes(i.type)) ?? items[0];
const marked = await generator.mark({
  prompt: written.prompt,
  marks: Math.max(written.marks, 2),
  key: written.key,
  notes: material.text,
  answer: 'Osmosis is water moving across a membrane. Active transport uses energy.',
});
console.log('marked', marked ? `${marked.awardedMarks}/${Math.max(written.marks, 2)} feedback ${marked.feedback.length} chars` : 'null');
console.log('seconds', ((Date.now() - started) / 1000).toFixed(1));
