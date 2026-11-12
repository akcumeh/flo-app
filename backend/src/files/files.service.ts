import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { AppError } from '../common/app-error.js';
import { DB, type Db, type Queryable } from '../db/db.js';
import { STORAGE, type ObjectStorage } from '../storage/storage.js';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 20;
export const MAX_PARTS = 30;
export const READ_JOB = 'read_file';
const SIGNED_URL_SECONDS = 300;
const UNIQUE_VIOLATION = '23505';

const AUDIO_TYPES = new Set([
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/webm',
  'audio/wav',
  'audio/x-wav',
]);

export interface UploadPart {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

export type FileKind = 'image' | 'document' | 'audio';

export interface TopicView {
  id: string;
  name: string;
  pages?: string;
}

export interface StoredFileView {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  kind: FileKind;
  status: 'uploading' | 'reading' | 'ready' | 'failed';
  pageCount?: number;
  courseId: string | null;
  topics: TopicView[];
  error: string | null;
  createdAt: string;
}

interface FileRow {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: string | number;
  kind: FileKind;
  status: StoredFileView['status'];
  page_count: number | null;
  course_id: string | null;
  error: string | null;
  created_at: Date;
}

const FILE_COLUMNS = 'id, name, mime_type, size_bytes, kind, status, page_count, course_id, error, created_at';

export function sniffType(buffer: Buffer, declared: string): string | null {
  const head = buffer.subarray(0, 12);
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  const type = declared.toLowerCase().split(';')[0].trim();
  return AUDIO_TYPES.has(type) ? type : null;
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  const ext = extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

@Injectable()
export class FilesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STORAGE) private readonly storage: ObjectStorage
  ) {}

  static view(row: FileRow, topics: TopicView[]): StoredFileView {
    return {
      id: row.id,
      name: row.name,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      kind: row.kind,
      status: row.status,
      ...(row.page_count ? { pageCount: row.page_count } : {}),
      courseId: row.course_id,
      topics,
      error: row.error,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async views(q: Queryable, rows: FileRow[]): Promise<StoredFileView[]> {
    if (rows.length === 0) return [];
    const topics = await q.query<{ id: string; file_id: string; name: string; pages: string | null }>(
      'select id, file_id, name, pages from file_topics where file_id = any($1::uuid[]) order by name',
      [rows.map((r) => r.id)]
    );
    return rows.map((r) =>
      FilesService.view(
        r,
        topics
          .filter((t) => t.file_id === r.id)
          .map((t) => ({ id: t.id, name: t.name, ...(t.pages ? { pages: t.pages } : {}) }))
      )
    );
  }

  async list(accountId: string, courseId?: string): Promise<StoredFileView[]> {
    const rows = await this.db.query<FileRow>(
      `select ${FILE_COLUMNS} from stored_files
        where account_id = $1 and deleted_at is null and ($2::uuid is null or course_id = $2)
        order by created_at desc limit $3`,
      [accountId, courseId ?? null, MAX_FILES]
    );
    return this.views(this.db, rows);
  }

  private async owned(accountId: string, fileId: string, q: Queryable = this.db): Promise<FileRow> {
    const rows = await q.query<FileRow>(
      `select ${FILE_COLUMNS} from stored_files where id = $1 and account_id = $2 and deleted_at is null`,
      [fileId, accountId]
    );
    if (rows.length === 0) throw AppError.notFound('No such file.');
    return rows[0];
  }

  async get(accountId: string, fileId: string): Promise<StoredFileView> {
    const [view] = await this.views(this.db, [await this.owned(accountId, fileId)]);
    return view;
  }

  async upload(
    accountId: string,
    parts: UploadPart[],
    opts: { name?: string; courseId?: string }
  ): Promise<StoredFileView> {
    if (parts.length === 0) throw AppError.badRequest('no_pages', 'Add at least one page or file.');
    if (parts.length > MAX_PARTS) throw AppError.badRequest('too_many_pages', `Upload at most ${MAX_PARTS} pages at once.`);
    const total = parts.reduce((n, p) => n + p.buffer.length, 0);
    if (total > MAX_UPLOAD_BYTES) {
      throw new AppError(413, 'file_too_large', 'Too large', 'Files can be at most 20 MB in total.');
    }

    const types = parts.map((p) => sniffType(p.buffer, p.mimetype));
    let kind: FileKind;
    if (types.every((t) => t?.startsWith('image/'))) kind = 'image';
    else if (parts.length === 1 && types[0] === 'application/pdf') kind = 'document';
    else if (parts.length === 1 && types[0]?.startsWith('audio/')) kind = 'audio';
    else {
      throw new AppError(
        415,
        'unsupported_type',
        'Unsupported file',
        'Upload one PDF, one voice note, or photos of your pages (JPEG, PNG, WebP or GIF).'
      );
    }
    const mimeType = kind === 'image' && parts.length > 1 ? 'image/*' : (types[0] as string);

    if (opts.courseId) {
      const enrolled = await this.db.query('select 1 from enrolments where account_id = $1 and course_id = $2', [
        accountId,
        opts.courseId,
      ]);
      if (enrolled.length === 0) throw AppError.unprocessable('course_not_enrolled', 'Add this course to your profile first.');
    }

    const hash = createHash('sha256');
    for (const p of parts) hash.update(createHash('sha256').update(p.buffer).digest());
    const contentHash = hash.digest('hex');

    const fallbackName = kind === 'image' ? 'Photo notes' : kind === 'audio' ? 'Voice note' : 'Document.pdf';
    const base = (opts.name?.trim() || parts[0].originalname?.trim() || fallbackName).slice(0, 120);

    const created = await this.db.transaction(async (q) => {
      const existing = await q.query<FileRow>(
        `select ${FILE_COLUMNS} from stored_files
          where account_id = $1 and content_sha256 = $2 and deleted_at is null`,
        [accountId, contentHash]
      );
      if (existing.length > 0) return { row: existing[0], fresh: false };

      const [{ n }] = await q.query<{ n: number }>(
        'select count(*)::int as n from stored_files where account_id = $1 and deleted_at is null',
        [accountId]
      );
      if (n >= MAX_FILES) {
        throw AppError.conflict('library_full', 'Your library holds 20 files. Delete one to add another.');
      }

      const taken = await q.query<{ name: string }>(
        'select name from stored_files where account_id = $1 and deleted_at is null',
        [accountId]
      );
      const name = uniqueName(base, new Set(taken.map((t) => t.name)));
      try {
        const [row] = await q.query<FileRow>(
          `insert into stored_files (account_id, name, mime_type, size_bytes, kind, origin, status, course_id, content_sha256)
           values ($1, $2, $3, $4, $5, 'app', 'uploading', $6, $7) returning ${FILE_COLUMNS}`,
          [accountId, name, mimeType, total, kind, opts.courseId ?? null, contentHash]
        );
        return { row, fresh: true };
      } catch (error) {
        if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
        const [row] = await q.query<FileRow>(
          `select ${FILE_COLUMNS} from stored_files where account_id = $1 and content_sha256 = $2 and deleted_at is null`,
          [accountId, contentHash]
        );
        return { row, fresh: false };
      }
    });

    if (!created.fresh) return this.get(accountId, created.row.id);

    const fileId = created.row.id;
    const stored: string[] = [];
    try {
      for (const [i, p] of parts.entries()) {
        const path = `${accountId}/${fileId}/${i + 1}`;
        await this.storage.put(path, p.buffer, types[i] as string);
        stored.push(path);
      }
    } catch {
      await this.storage.delete(stored).catch(() => undefined);
      await this.db.query(`update stored_files set status = 'failed', error = $2 where id = $1`, [
        fileId,
        'The upload did not finish. Try again.',
      ]);
      throw AppError.unavailable('storage_unavailable', 'The upload did not finish. Try again.');
    }

    await this.db.transaction(async (q) => {
      for (const [i, p] of parts.entries()) {
        await q.query(
          'insert into file_parts (file_id, part, storage_path, mime_type, size_bytes) values ($1, $2, $3, $4, $5)',
          [fileId, i + 1, stored[i], types[i], p.buffer.length]
        );
      }
      await q.query(`update stored_files set status = 'reading', storage_path = $2 where id = $1`, [fileId, stored[0]]);
      await q.query('insert into jobs (kind, payload) values ($1, $2)', [READ_JOB, JSON.stringify({ fileId })]);
    });
    return this.get(accountId, fileId);
  }

  async remove(accountId: string, fileId: string): Promise<void> {
    await this.owned(accountId, fileId);
    const parts = await this.db.query<{ storage_path: string }>(
      'select storage_path from file_parts where file_id = $1',
      [fileId]
    );
    await this.storage.delete(parts.map((p) => p.storage_path));
    await this.db.transaction(async (q) => {
      await q.query('delete from file_chunks where file_id = $1', [fileId]);
      await q.query('delete from file_topics where file_id = $1', [fileId]);
      await q.query('delete from file_parts where file_id = $1', [fileId]);
      await q.query('update stored_files set deleted_at = now(), storage_path = null where id = $1', [fileId]);
    });
  }

  async contentUrl(accountId: string, fileId: string): Promise<string> {
    await this.owned(accountId, fileId);
    const [part] = await this.db.query<{ storage_path: string }>(
      'select storage_path from file_parts where file_id = $1 order by part limit 1',
      [fileId]
    );
    if (!part) throw AppError.notFound('This file has no stored content.');
    return this.storage.signedUrl(part.storage_path, SIGNED_URL_SECONDS);
  }
}
