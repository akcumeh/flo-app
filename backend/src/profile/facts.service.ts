import { Inject, Injectable, Logger } from '@nestjs/common';
import { AI_PROVIDER, parseJson, type AiProvider } from '../ai/ai.provider.js';
import { lagosDate } from '../common/lagos.js';
import { DB, type Db } from '../db/db.js';

export interface FactView {
  id: string;
  date: string;
  text: string;
  topic?: string;
}

const FALLBACK_FACTS: Array<{ text: string; topic: string }> = [
  { text: 'Honey found in Egyptian tombs over 3,000 years old was still safe to eat.', topic: 'Chemistry' },
  { text: 'An octopus has three hearts and blue blood.', topic: 'Biology' },
  { text: 'The Niger River flows for about 4,180 km and passes through five countries.', topic: 'Geography' },
  { text: 'A day on Venus is longer than a year on Venus.', topic: 'Astronomy' },
  { text: 'Bananas are slightly radioactive because they contain potassium-40.', topic: 'Physics' },
  { text: 'The human brain uses about 20% of the body’s energy while being about 2% of its weight.', topic: 'Biology' },
  { text: 'Zero as a number in its own right was first written about in India around the 7th century.', topic: 'Mathematics' },
];

const FACT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' }, topic: { type: 'string' } },
  required: ['text', 'topic'],
  additionalProperties: false,
};

@Injectable()
export class FactsService {
  private readonly logger = new Logger('Facts');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AI_PROVIDER) private readonly ai: AiProvider
  ) {}

  private async find(day: string): Promise<FactView | null> {
    const [row] = await this.db.query<{ id: string; text: string; topic: string | null }>(
      'select id, text, topic from facts where day = $1',
      [day]
    );
    return row ? { id: row.id, date: day, text: row.text, ...(row.topic ? { topic: row.topic } : {}) } : null;
  }

  async today(): Promise<FactView> {
    const day = lagosDate();
    const existing = await this.find(day);
    if (existing) return existing;

    let fact: { text: string; topic: string; source: string };
    try {
      const recent = await this.db.query<{ text: string }>('select text from facts order by day desc limit 20');
      const reply = await this.ai.complete({
        system: 'You write one short, true, surprising fact a day for Nigerian university students.',
        messages: [
          {
            role: 'user',
            content: `Write today's fact: one or two sentences, under 220 characters, accurate, from science, maths, history, economics or the humanities. Name its subject as the topic in one or two words. Do not repeat any of these:\n${recent.map((r) => `- ${r.text}`).join('\n') || '- (none yet)'}`,
          },
        ],
        maxTokens: 1000,
        effort: 'low',
        jsonSchema: FACT_SCHEMA,
      });
      const parsed = parseJson<{ text: string; topic: string }>(reply);
      if (!parsed.text?.trim()) throw new Error('empty fact');
      fact = { text: parsed.text.trim().slice(0, 400), topic: parsed.topic.trim().slice(0, 40), source: 'ai' };
    } catch (error) {
      this.logger.warn(`Fact generation failed: ${(error as Error).message}`);
      const dayNumber = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
      fact = { ...FALLBACK_FACTS[dayNumber % FALLBACK_FACTS.length], source: 'builtin' };
    }

    await this.db.query('insert into facts (day, text, topic, source) values ($1, $2, $3, $4) on conflict (day) do nothing', [
      day,
      fact.text,
      fact.topic,
      fact.source,
    ]);
    return (await this.find(day)) as FactView;
  }
}
