import { Inject, Injectable, Logger } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { AI_PROVIDER, type AiMessage, type AiProvider } from '../ai/ai.provider.js';
import { ASK_SYSTEM, NOTES_RULES, NO_NOTES_RULES } from '../ai/prompts.js';
import { AppError } from '../common/app-error.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { DB, type Db, type Queryable } from '../db/db.js';
import { STORAGE, type ObjectStorage } from '../storage/storage.js';
import { StreakService } from '../study/streak.service.js';
import { TokensService } from '../tokens/tokens.service.js';
import { CitationFilter, type SseWriter } from './sse.js';

export const ASK_COST = 1;
export const ASK_WITH_FILES_COST = 2;

export function askCost(fileIds: string[] = []): number {
  return fileIds.length > 0 ? ASK_WITH_FILES_COST : ASK_COST;
}
const HISTORY_MESSAGES = 10;
const TOP_CHUNKS = 6;
const RANK_THRESHOLD = 0.01;
const WHOLE_FILE_CHARS = 24_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Citation {
  fileId: string;
  label: string;
  page?: number;
  snippet?: string;
}

interface Source {
  fileId: string;
  name: string;
  page: number | null;
  text: string;
}

interface MessageRow {
  id: string;
  role: 'user' | 'assistant';
  content: { text: string };
  citations: Citation[];
  grounded: boolean;
  charged: number;
  created_at: Date;
  saved?: boolean;
}

export interface SendInput {
  text?: string;
  voiceFileId?: string;
  fileIds?: string[];
  context?: { sessionId: string; itemId: number };
}

export type Prepared = { replay: ReturnType<typeof messageView> } | { run: (writer: SseWriter) => Promise<void> };

export function messageView(m: MessageRow) {
  return {
    id: m.id,
    role: m.role,
    text: m.content?.text ?? '',
    citations: m.citations ?? [],
    grounded: m.grounded,
    saved: Boolean(m.saved),
    charged: m.charged,
    createdAt: new Date(m.created_at).toISOString(),
  };
}

function conversationView(c: { id: string; title: string | null; mode: 'ask' | 'prep'; last_message_at: Date | null }) {
  return {
    id: c.id,
    title: c.title,
    mode: c.mode,
    lastMessageAt: c.last_message_at ? new Date(c.last_message_at).toISOString() : null,
  };
}

function cursorOf(at: Date, id: string) {
  return Buffer.from(`${new Date(at).toISOString()}|${id}`, 'utf8').toString('base64url');
}

function parseCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!at || !UUID.test(id ?? '') || Number.isNaN(Date.parse(at))) {
    throw AppError.badRequest('invalid_cursor', 'The cursor is not valid.');
  }
  return { at, id };
}

export function tsQuery(question: string): string | null {
  const words = [...new Set(question.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])].slice(0, 24);
  return words.length > 0 ? words.join(' | ') : null;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger('Chat');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AI_PROVIDER) private readonly ai: AiProvider,
    @Inject(STORAGE) private readonly storage: ObjectStorage,
    @Inject(TokensService) private readonly tokens: TokensService,
    @Inject(StreakService) private readonly streaks: StreakService
  ) {}

  private async owned(q: Queryable, accountId: string, conversationId: string) {
    if (!UUID.test(conversationId)) throw AppError.notFound('No such conversation.');
    const [c] = await q.query<{ id: string; title: string | null; mode: 'ask' | 'prep'; last_message_at: Date | null }>(
      'select id, title, mode, last_message_at from conversations where id = $1 and account_id = $2 and deleted_at is null',
      [conversationId, accountId]
    );
    if (!c) throw AppError.notFound('No such conversation.');
    return c;
  }

  async list(accountId: string, cursor: string | undefined, limit: number) {
    const before = parseCursor(cursor);
    const rows = await this.db.query<{
      id: string;
      title: string | null;
      mode: 'ask' | 'prep';
      last_message_at: Date | null;
      sort_at: Date;
    }>(
      `select id, title, mode, last_message_at, coalesce(last_message_at, created_at) as sort_at from conversations
        where account_id = $1 and deleted_at is null
          and ($2::timestamptz is null or (coalesce(last_message_at, created_at), id) < ($2::timestamptz, $3::uuid))
        order by coalesce(last_message_at, created_at) desc, id desc limit $4`,
      [accountId, before?.at ?? null, before?.id ?? null, limit + 1]
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map(conversationView), nextCursor: rows.length > limit ? cursorOf(last.sort_at, last.id) : null };
  }

  async create(accountId: string, mode: 'ask' | 'prep' = 'ask') {
    const [c] = await this.db.query<{ id: string; title: null; mode: 'ask' | 'prep'; last_message_at: null }>(
      'insert into conversations (account_id, mode) values ($1, $2) returning id, title, mode, last_message_at',
      [accountId, mode]
    );
    return conversationView(c);
  }

  async rename(accountId: string, conversationId: string, title: string) {
    await this.owned(this.db, accountId, conversationId);
    const [c] = await this.db.query<{ id: string; title: string; mode: 'ask' | 'prep'; last_message_at: Date | null }>(
      'update conversations set title = $2 where id = $1 returning id, title, mode, last_message_at',
      [conversationId, title.trim().slice(0, 120)]
    );
    return conversationView(c);
  }

  async remove(accountId: string, conversationId: string) {
    await this.owned(this.db, accountId, conversationId);
    await this.db.transaction(async (q) => {
      await q.query('delete from messages where conversation_id = $1', [conversationId]);
      await q.query('update conversations set deleted_at = now() where id = $1', [conversationId]);
    });
  }

  async messages(accountId: string, conversationId: string, cursor: string | undefined, limit: number) {
    await this.owned(this.db, accountId, conversationId);
    const after = parseCursor(cursor);
    const rows = await this.db.query<MessageRow>(
      `select m.id, m.role, m.content, m.citations, m.grounded, m.charged, m.created_at,
              exists (select 1 from saved_answers s where s.message_id = m.id and s.account_id = $2) as saved
         from messages m
        where m.conversation_id = $1 and ($3::timestamptz is null or (m.created_at, m.id) > ($3::timestamptz, $4::uuid))
        order by m.created_at, m.id limit $5`,
      [conversationId, accountId, after?.at ?? null, after?.id ?? null, limit + 1]
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map(messageView), nextCursor: rows.length > limit ? cursorOf(last.created_at, last.id) : null };
  }

  async setSaved(accountId: string, messageId: string, saved: boolean) {
    const [m] = await this.db.query<{ id: string }>(
      `select m.id from messages m join conversations c on c.id = m.conversation_id
        where m.id = $1 and c.account_id = $2 and c.deleted_at is null and m.role = 'assistant'`,
      [messageId, accountId]
    );
    if (!m) throw AppError.notFound('No such answer.');
    if (saved) {
      await this.db.query('insert into saved_answers (account_id, message_id) values ($1, $2) on conflict do nothing', [
        accountId,
        messageId,
      ]);
    } else {
      await this.db.query('delete from saved_answers where account_id = $1 and message_id = $2', [accountId, messageId]);
    }
  }

  async savedAnswers(accountId: string, cursor: string | undefined, limit: number) {
    const before = parseCursor(cursor);
    const rows = await this.db.query<MessageRow & { saved_at: Date }>(
      `select m.id, m.role, m.content, m.citations, m.grounded, m.charged, m.created_at, true as saved, s.saved_at
         from saved_answers s join messages m on m.id = s.message_id
        where s.account_id = $1 and ($2::timestamptz is null or (s.saved_at, m.id) < ($2::timestamptz, $3::uuid))
        order by s.saved_at desc, m.id desc limit $4`,
      [accountId, before?.at ?? null, before?.id ?? null, limit + 1]
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map(messageView), nextCursor: rows.length > limit ? cursorOf(last.saved_at, last.id) : null };
  }

  private async attachedFiles(accountId: string, fileIds: string[]) {
    const ids = [...new Set(fileIds)];
    if (ids.length === 0) return [];
    const files = await this.db.query<{ id: string; name: string; kind: string; status: string }>(
      'select id, name, kind, status from stored_files where id = any($1::uuid[]) and account_id = $2 and deleted_at is null',
      [ids, accountId]
    );
    if (files.length !== ids.length) throw AppError.notFound('No such file.');
    if (files.some((f) => f.status !== 'ready')) {
      throw AppError.conflict('file_not_ready', 'Florence is still reading one of these files. Try again in a moment.');
    }
    return files;
  }

  async retrieve(q: Queryable, accountId: string, question: string, fileIds: string[]): Promise<Source[]> {
    if (fileIds.length > 0) {
      const [{ chars }] = await q.query<{ chars: number }>(
        'select coalesce(sum(length(text)), 0)::int as chars from file_chunks where file_id = any($1::uuid[])',
        [fileIds]
      );
      if (chars > 0 && chars <= WHOLE_FILE_CHARS) {
        return q.query<Source>(
          `select c.file_id as "fileId", f.name, c.page, c.text from file_chunks c join stored_files f on f.id = c.file_id
            where c.file_id = any($1::uuid[]) order by array_position($1::uuid[], c.file_id), c.ord`,
          [fileIds]
        );
      }
    }
    const query = tsQuery(question);
    if (!query) return [];
    const rows = await q.query<Source & { rank: number }>(
      `select c.file_id as "fileId", f.name, c.page, c.text, ts_rank(c.tsv, query) as rank
         from file_chunks c join stored_files f on f.id = c.file_id, to_tsquery('english', $2) query
        where c.account_id = $1 and f.deleted_at is null and c.tsv @@ query
          and ($3::uuid[] is null or c.file_id = any($3::uuid[]))
        order by rank desc, c.ord limit $4`,
      [accountId, query, fileIds.length > 0 ? fileIds : null, TOP_CHUNKS]
    );
    return rows.filter((r) => r.rank >= RANK_THRESHOLD).map(({ rank: _rank, ...s }) => s);
  }

  async prepare(accountId: string, conversationId: string, key: string, input: SendInput): Promise<Prepared> {
    const conversation = await this.owned(this.db, accountId, conversationId);
    if (input.voiceFileId && !input.text) {
      throw AppError.unprocessable('voice_not_available', 'Voice questions are not available yet. Type your question instead.');
    }
    const files = await this.attachedFiles(accountId, input.fileIds ?? []);
    const text = (input.text ?? '').trim();
    const cost = askCost(files.map((f) => f.id));
    if (!text) throw AppError.unprocessable('empty_message', 'Type a question first.');

    const started = await this.db.transaction(async (q) => {
      let [request] = await q.query<{ id: string; attempts: number }>(
        `insert into requests (account_id, idempotency_key, kind) values ($1, $2, 'chat')
         on conflict (account_id, idempotency_key) do nothing returning id, attempts`,
        [accountId, key]
      );
      if (!request) {
        const [existing] = await q.query<{ id: string; status: string; attempts: number }>(
          'select id, status, attempts from requests where account_id = $1 and idempotency_key = $2 for update',
          [accountId, key]
        );
        if (existing.status === 'completed') {
          const [m] = await q.query<MessageRow>(
            `select id, role, content, citations, grounded, charged, created_at from messages
              where request_id = $1 and role = 'assistant'`,
            [existing.id]
          );
          if (m) return { replay: messageView(m) };
        }
        if (existing.status === 'in_flight') {
          throw AppError.conflict('request_in_progress', 'This question is still being answered.');
        }
        [request] = await q.query<{ id: string; attempts: number }>(
          `update requests set status = 'in_flight', attempts = attempts + 1, finished_at = null
            where id = $1 returning id, attempts`,
          [existing.id]
        );
      }

      const { balance } = await this.tokens.debit(q, accountId, cost, 'chat_charge', {
        idempotencyKey: `chat:${request.id}:${request.attempts}`,
        refType: 'request',
        refId: `${request.id}:${request.attempts}`,
      });
      await q.query('update requests set charged = $2 where id = $1', [request.id, cost]);
      const userMessage = await q.query<{ id: string }>(
        "select id from messages where request_id = $1 and role = 'user'",
        [request.id]
      );
      if (userMessage.length === 0) {
        await q.query(
          `insert into messages (conversation_id, role, content, request_id, charged) values ($1, 'user', $2, $3, $4)`,
          [conversationId, JSON.stringify({ text, fileIds: files.map((f) => f.id) }), request.id, cost]
        );
      }
      await q.query('update conversations set last_message_at = now() where id = $1', [conversationId]);
      return { request, balance };
    });

    if ('replay' in started) return { replay: started.replay as ReturnType<typeof messageView> };
    const { request, balance } = started;
    return {
      run: (writer) => this.answer(writer, { accountId, conversation, request, balance, cost, text, files, context: input.context }),
    };
  }

  private async history(conversationId: string, requestId: string): Promise<AiMessage[]> {
    const rows = await this.db.query<{ role: 'user' | 'assistant'; content: { text: string } }>(
      `select role, content from (
         select role, content, created_at, id from messages
          where conversation_id = $1 and (request_id is null or request_id <> $2)
          order by created_at desc, id desc limit $3) recent
       order by created_at, id`,
      [conversationId, requestId, HISTORY_MESSAGES]
    );
    const out: AiMessage[] = rows.map((r) => ({ role: r.role, content: r.content.text }));
    while (out.length > 0 && out[0].role !== 'user') out.shift();
    return out;
  }

  private async sessionContext(accountId: string, context?: { sessionId: string; itemId: number }): Promise<string> {
    if (!context) return '';
    const [row] = await this.db.query<{ prompt: string; verdict: { correctAnswer?: string } | null; answer: string | null }>(
      `select i.prompt, a.verdict, a.answer from study_sessions s
         join session_items i on i.session_id = s.id and i.round = 1 and i.idx = $3
         left join session_answers a on a.session_id = s.id and a.round = 1 and a.item_idx = i.idx
        where s.id = $1 and s.account_id = $2`,
      [context.sessionId, accountId, context.itemId]
    );
    if (!row) return '';
    return `\n\nThe student is asking about this question from their study session:\nQuestion: ${row.prompt}\nTheir answer: ${row.answer ?? '(none)'}\nCorrect answer: ${row.verdict?.correctAnswer ?? '(not shown yet)'}`;
  }

  private async imageBlocks(files: Array<{ id: string; kind: string }>): Promise<Anthropic.Beta.BetaContentBlockParam[]> {
    const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const f of files.filter((x) => x.kind === 'image')) {
      const parts = await this.db.query<{ storage_path: string; mime_type: string }>(
        'select storage_path, mime_type from file_parts where file_id = $1 order by part limit 5',
        [f.id]
      );
      for (const p of parts) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: p.mime_type as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
            data: (await this.storage.get(p.storage_path)).toString('base64'),
          },
        });
      }
    }
    return blocks;
  }

  private async answer(
    writer: SseWriter,
    ctx: {
      accountId: string;
      conversation: { id: string; title: string | null };
      request: { id: string; attempts: number };
      balance: number;
      cost: number;
      text: string;
      files: Array<{ id: string; name: string; kind: string }>;
      context?: { sessionId: string; itemId: number };
    }
  ) {
    const messageId = randomUUID();
    writer.event('message.start', { messageId, charged: ctx.cost, balance: ctx.balance });
    const filter = new CitationFilter();
    let sources: Source[] = [];
    let full = '';
    try {
      sources = await this.retrieve(this.db, ctx.accountId, ctx.text, ctx.files.map((f) => f.id));
      const [{ ready }] = await this.db.query<{ ready: number }>(
        `select count(*)::int as ready from stored_files where account_id = $1 and status = 'ready' and deleted_at is null`,
        [ctx.accountId]
      );
      const notes =
        sources.length > 0
          ? `${NOTES_RULES}\n\n${sources.map((s, i) => `[S${i + 1}] ${s.name}${s.page ? `, page ${s.page}` : ''}\n${s.text}`).join('\n\n')}`
          : ready > 0
            ? NO_NOTES_RULES
            : '';
      const images = await this.imageBlocks(ctx.files);
      const question = `${ctx.text}${await this.sessionContext(ctx.accountId, ctx.context)}`;
      const messages: AiMessage[] = [
        ...(await this.history(ctx.conversation.id, ctx.request.id)),
        { role: 'user', content: images.length > 0 ? [...images, { type: 'text', text: question }] : question },
      ];

      await this.ai.stream(
        { system: notes ? `${ASK_SYSTEM}\n\n${notes}` : ASK_SYSTEM, messages, maxTokens: 16000, effort: 'medium', signal: writer.signal },
        (delta) => {
          const out = filter.push(delta);
          if (out) {
            full += out;
            writer.event('delta', { text: out });
          }
        }
      );
      const tail = filter.flush();
      if (tail) {
        full += tail;
        writer.event('delta', { text: tail });
      }
      if (writer.signal.aborted) throw new Error('aborted');
    } catch (error) {
      await this.failRequest(ctx.accountId, ctx.request);
      if (!writer.closed) {
        writer.event('error', {
          code: writer.signal.aborted ? 'aborted' : 'answer_failed',
          refunded: true,
          balance: await this.tokens.balance(ctx.accountId),
        });
      }
      this.logger.warn(`Answer failed: ${(error as Error).message}`);
      writer.end();
      return;
    }

    const grounded = sources.length > 0;
    const used = [...filter.used].filter((n) => n >= 1 && n <= sources.length);
    const cited = (used.length > 0 ? used : grounded ? [1] : []).map((n) => sources[n - 1]);
    const citations: Citation[] = [];
    for (const s of cited) {
      if (citations.some((c) => c.fileId === s.fileId && c.page === (s.page ?? undefined))) continue;
      citations.push({
        fileId: s.fileId,
        label: s.name,
        ...(s.page ? { page: s.page } : {}),
        snippet: s.text.slice(0, 200),
      });
    }

    const balance = await this.db.transaction(async (q) => {
      await q.query(
        `insert into messages (id, conversation_id, role, content, citations, grounded, request_id, charged)
         values ($1, $2, 'assistant', $3, $4, $5, $6, $7)`,
        [messageId, ctx.conversation.id, JSON.stringify({ text: full }), JSON.stringify(citations), grounded, ctx.request.id, ctx.cost]
      );
      await q.query(`update requests set status = 'completed', finished_at = now() where id = $1`, [ctx.request.id]);
      await q.query('update conversations set last_message_at = now() where id = $1', [ctx.conversation.id]);
      await this.streaks.recordEvent(q, ctx.accountId, { kind: 'ask_question', source: 'app', occurredAt: this.clock.now() });
      return this.tokens.balance(ctx.accountId, q);
    });
    for (const c of citations) writer.event('citation', c);
    writer.event('message.end', { messageId, balance, grounded });

    if (!ctx.conversation.title) await this.nameConversation(ctx.conversation.id, ctx.text, full);
    writer.end();
  }

  private async failRequest(accountId: string, request: { id: string; attempts: number }) {
    await this.db.transaction(async (q) => {
      const [{ charged }] = await q.query<{ charged: number }>('select charged from requests where id = $1', [request.id]);
      await this.tokens.credit(q, accountId, charged || ASK_COST, 'refund', {
        refType: 'request',
        refId: `${request.id}:${request.attempts}`,
        idempotencyKey: `refund:chat:${request.id}:${request.attempts}`,
      });
      await q.query(`update requests set status = 'failed', finished_at = now() where id = $1`, [request.id]);
    });
  }

  private async nameConversation(conversationId: string, question: string, answer: string) {
    let title = question.replace(/\s+/g, ' ').slice(0, 60);
    try {
      const reply = await this.ai.complete({
        messages: [
          {
            role: 'user',
            content: `Write a title of at most 6 words for this study chat. Reply with the title only, no quotes.\n\nQuestion: ${question.slice(0, 1000)}\n\nAnswer: ${answer.slice(0, 1000)}`,
          },
        ],
        maxTokens: 200,
        effort: 'low',
      });
      const clean = reply.replace(/["*#]/g, '').replace(/\s+/g, ' ').trim();
      if (clean && clean.length <= 80) title = clean;
    } catch (error) {
      this.logger.warn(`Title failed: ${(error as Error).message}`);
    }
    await this.db.query('update conversations set title = $2 where id = $1 and title is null', [conversationId, title]);
  }
}
