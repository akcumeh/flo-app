import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { extractText, getDocumentProxy } from 'unpdf';
import { AI_PROVIDER, parseJson, type AiProvider } from '../ai/ai.provider.js';
import { DB, type Db } from '../db/db.js';
import { JobsService } from '../jobs/jobs.service.js';
import { STORAGE, type ObjectStorage } from '../storage/storage.js';
import { READ_JOB, type FileKind } from './files.service.js';

export const MAX_PAGES = 300;
const CHUNK_CHARS = 1500;
const SCANNED_CHARS_PER_PAGE = 50;
const TOPIC_INPUT_CHARS = 150_000;

export class ReadFailure extends Error {}

const TRANSCRIPTION_SCHEMA = {
  type: 'object',
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: { page: { type: 'integer' }, text: { type: 'string' } },
        required: ['page', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['pages'],
  additionalProperties: false,
};

const TOPICS_SCHEMA = {
  type: 'object',
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, firstPage: { type: 'integer' }, lastPage: { type: 'integer' } },
        required: ['name', 'firstPage', 'lastPage'],
        additionalProperties: false,
      },
    },
  },
  required: ['topics'],
  additionalProperties: false,
};

const TRANSCRIBE_SYSTEM = `You transcribe study material for Nigerian university students.
Copy the text of each page exactly as written: headings, lists, tables as plain rows, and equations in LaTeX.
Do not summarise, correct or add anything. If a page has no readable text, give an empty string for it.`;

const TOPICS_SYSTEM = `You index a student's study notes so they can revise by topic.`;

export function cleanText(text: string): string {
  return text.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function chunkPages(pages: string[]): Array<{ page: number; text: string }> {
  const chunks: Array<{ page: number; text: string }> = [];
  pages.forEach((raw, index) => {
    const text = cleanText(raw);
    if (!text) return;
    let current = '';
    const flush = () => {
      if (current.trim()) chunks.push({ page: index + 1, text: current.trim() });
      current = '';
    };
    for (const paragraph of text.split(/\n\s*\n/)) {
      if (paragraph.length > CHUNK_CHARS) {
        flush();
        for (let i = 0; i < paragraph.length; i += CHUNK_CHARS) {
          chunks.push({ page: index + 1, text: paragraph.slice(i, i + CHUNK_CHARS) });
        }
        continue;
      }
      if (current.length + paragraph.length + 2 > CHUNK_CHARS) flush();
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
    flush();
  });
  return chunks;
}

@Injectable()
export class ReaderService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STORAGE) private readonly storage: ObjectStorage,
    @Inject(AI_PROVIDER) private readonly ai: AiProvider,
    @Inject(JobsService) private readonly jobs: JobsService
  ) {}

  onModuleInit() {
    this.jobs.register(READ_JOB, {
      run: (payload) => this.read(String(payload.fileId)),
      failed: (payload) => this.fail(String(payload.fileId), 'We could not read this file. Try again, or upload a clearer copy.'),
    });
  }

  private async fail(fileId: string, message: string) {
    await this.db.query(`update stored_files set status = 'failed', error = $2 where id = $1`, [fileId, message]);
  }

  async read(fileId: string): Promise<void> {
    const [file] = await this.db.query<{ kind: FileKind; status: string; account_id: string }>(
      'select kind, status, account_id from stored_files where id = $1 and deleted_at is null',
      [fileId]
    );
    if (!file || file.status === 'ready') return;

    const parts = await this.db.query<{ storage_path: string; mime_type: string }>(
      'select storage_path, mime_type from file_parts where file_id = $1 order by part',
      [fileId]
    );

    if (file.kind === 'audio') {
      await this.db.query(`update stored_files set status = 'ready', error = null where id = $1`, [fileId]);
      return;
    }

    let pages: string[];
    try {
      pages = file.kind === 'document' ? await this.readPdf(parts[0].storage_path) : await this.readImages(parts);
      if (pages.every((p) => !cleanText(p))) {
        throw new ReadFailure('We could not find any text in this file. Try a clearer photo or a PDF with selectable text.');
      }
    } catch (error) {
      if (error instanceof ReadFailure) {
        await this.fail(fileId, error.message);
        return;
      }
      throw error;
    }

    const chunks = chunkPages(pages);
    const topics = await this.findTopics(pages).catch(() => []);

    await this.db.transaction(async (q) => {
      const [{ alive }] = await q.query<{ alive: boolean }>(
        'select exists (select 1 from stored_files where id = $1 and deleted_at is null) as alive',
        [fileId]
      );
      if (!alive) return;
      await q.query('delete from file_chunks where file_id = $1', [fileId]);
      await q.query('delete from file_topics where file_id = $1', [fileId]);
      for (const [ord, c] of chunks.entries()) {
        await q.query('insert into file_chunks (file_id, account_id, page, ord, text) values ($1, $2, $3, $4, $5)', [
          fileId,
          file.account_id,
          c.page,
          ord,
          c.text,
        ]);
      }
      for (const t of topics) {
        await q.query('insert into file_topics (file_id, name, pages) values ($1, $2, $3) on conflict do nothing', [
          fileId,
          t.name,
          t.pages,
        ]);
      }
      await q.query(`update stored_files set status = 'ready', page_count = $2, error = null where id = $1`, [
        fileId,
        pages.length,
      ]);
    });
  }

  private async readPdf(path: string): Promise<string[]> {
    const data = await this.storage.get(path);
    let pages: string[];
    try {
      const pdf = await getDocumentProxy(new Uint8Array(data));
      ({ text: pages } = await extractText(pdf, { mergePages: false }));
    } catch {
      throw new ReadFailure('This PDF could not be opened. If it has a password, remove it and upload it again.');
    }
    if (pages.length > MAX_PAGES) {
      throw new ReadFailure(`This PDF has more than ${MAX_PAGES} pages. Split it into smaller parts and upload those.`);
    }
    const chars = pages.reduce((n, p) => n + cleanText(p).length, 0);
    if (chars / Math.max(pages.length, 1) >= SCANNED_CHARS_PER_PAGE) return pages;

    const transcribed = await this.transcribe(
      [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') } },
        { type: 'text', text: `Transcribe all ${pages.length} pages of this PDF.` },
      ],
      pages.length
    );
    return transcribed;
  }

  private async readImages(parts: Array<{ storage_path: string; mime_type: string }>): Promise<string[]> {
    const blocks = [];
    for (const p of parts) {
      const data = await this.storage.get(p.storage_path);
      blocks.push({
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: p.mime_type as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
          data: data.toString('base64'),
        },
      });
    }
    return this.transcribe(
      [
        ...blocks,
        { type: 'text', text: `Transcribe these ${parts.length} page photos. Page numbers follow the order given, from 1.` },
      ],
      parts.length
    );
  }

  private async transcribe(content: Parameters<AiProvider['complete']>[0]['messages'][number]['content'], count: number) {
    const reply = await this.ai.complete({
      system: TRANSCRIBE_SYSTEM,
      messages: [{ role: 'user', content }],
      maxTokens: 64000,
      effort: 'low',
      jsonSchema: TRANSCRIPTION_SCHEMA,
    });
    const { pages } = parseJson<{ pages?: Array<{ page: number; text: string }> }>(reply);
    const out = Array.from({ length: count }, () => '');
    for (const p of pages ?? []) {
      if (Number.isInteger(p.page) && p.page >= 1 && p.page <= count) out[p.page - 1] = p.text;
    }
    return out;
  }

  async findTopics(pages: string[]): Promise<Array<{ name: string; pages: string }>> {
    let text = '';
    for (const [i, p] of pages.entries()) {
      const block = `[Page ${i + 1}]\n${cleanText(p)}\n\n`;
      if (text.length + block.length > TOPIC_INPUT_CHARS) break;
      text += block;
    }
    const reply = await this.ai.complete({
      system: TOPICS_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `${text}\nList the main topics a student would revise from these notes: 3 to 12 of them, in the order they appear. Use short names a lecturer would use, such as "Cell membrane transport". For each, give the first and last page that cover it.`,
        },
      ],
      maxTokens: 4000,
      effort: 'low',
      jsonSchema: TOPICS_SCHEMA,
    });
    const { topics } = parseJson<{ topics?: Array<{ name: string; firstPage: number; lastPage: number }> }>(reply);
    const seen = new Set<string>();
    return (topics ?? [])
      .map((t) => {
        const first = Math.min(Math.max(1, t.firstPage), pages.length);
        const last = Math.min(Math.max(first, t.lastPage), pages.length);
        return { name: t.name.trim().slice(0, 80), pages: first === last ? String(first) : `${first}-${last}` };
      })
      .filter((t) => t.name && !seen.has(t.name.toLowerCase()) && seen.add(t.name.toLowerCase()))
      .slice(0, 12);
  }
}
