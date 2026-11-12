import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { DB, type Db } from '../db/db.js';

export interface JobHandler {
  run(payload: Record<string, unknown>): Promise<void>;
  failed?(payload: Record<string, unknown>, error: Error): Promise<void>;
}

interface JobRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
}

const MAX_ATTEMPTS = 3;
const STALE_MINUTES = 10;

@Injectable()
export class JobsService implements OnModuleDestroy {
  private readonly logger = new Logger('Jobs');
  private readonly handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(@Inject(DB) private readonly db: Db) {}

  register(kind: string, handler: JobHandler) {
    this.handlers.set(kind, handler);
  }

  async enqueue(kind: string, payload: Record<string, unknown>): Promise<void> {
    await this.db.query('insert into jobs (kind, payload) values ($1, $2)', [kind, JSON.stringify(payload)]);
  }

  async runOnce(): Promise<boolean> {
    const [job] = await this.db.query<JobRow>(
      `update jobs set status = 'running', locked_at = now(), attempts = attempts + 1
        where id = (select id from jobs where status = 'queued' and run_after <= now()
                     order by id limit 1 for update skip locked)
        returning id::text as id, kind, payload, attempts`
    );
    if (!job) return false;

    const handler = this.handlers.get(job.kind);
    try {
      if (!handler) throw new Error(`No handler for job kind ${job.kind}`);
      await handler.run(job.payload);
      await this.db.query(`update jobs set status = 'done', finished_at = now(), error = null where id = $1`, [job.id]);
    } catch (error) {
      const err = error as Error;
      const final = job.attempts >= MAX_ATTEMPTS || !handler;
      this.logger.warn(`Job ${job.id} (${job.kind}) attempt ${job.attempts} failed: ${err.message}`);
      await this.db.query(
        `update jobs set status = $2, error = $3, locked_at = null,
                run_after = now() + make_interval(secs => $4), finished_at = case when $2 = 'failed' then now() end
          where id = $1`,
        [job.id, final ? 'failed' : 'queued', err.message.slice(0, 500), 15 * job.attempts]
      );
      if (final && handler?.failed) await handler.failed(job.payload, err);
    }
    return true;
  }

  async drain(): Promise<void> {
    for (;;) {
      await this.db.query(`update jobs set run_after = now() where status = 'queued' and run_after > now()`);
      if (!(await this.runOnce())) return;
    }
  }

  start(intervalMs = 2000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.db.query(
        `update jobs set status = 'queued', locked_at = null
          where status = 'running' and locked_at < now() - make_interval(mins => $1)`,
        [STALE_MINUTES]
      );
      while (await this.runOnce());
    } catch (error) {
      this.logger.error(`Job loop failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
