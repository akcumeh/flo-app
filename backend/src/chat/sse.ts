import type { Request, Response } from 'express';

const HEARTBEAT_MS = 15_000;

export interface SseWriter {
    readonly signal: AbortSignal;
    readonly closed: boolean;
    event(name: string, data: unknown): void;
    end(): void;
}

export function openSse(req: Request, res: Response): SseWriter {
    const controller = new AbortController();
    let closed = false;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const heartbeat = setInterval(() => {
        if (!closed) res.write(': keep-alive\n\n');
    }, HEARTBEAT_MS);

    const stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
    };
    res.on('close', () => {
        if (!res.writableEnded) controller.abort();
        stop();
    });
    req.on('aborted', () => controller.abort());

    return {
        signal: controller.signal,
        get closed() {
            return closed;
        },
        event(name, data) {
            if (closed) return;
            res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        },
        end() {
            stop();
            if (!res.writableEnded) res.end();
        },
    };
}

const MARKER = /\s?\[S\d{1,2}(?:\s*,\s*S?\d{1,2})*\]/g;
const PARTIAL = /\[(?:S\d{0,2}(?:\s*,\s*S?\d{0,2})*)?$/;

export class CitationFilter {
    private pending = '';
    readonly used = new Set<number>();

    push(text: string): string {
        this.pending += text;
        this.pending = this.pending.replace(MARKER, (m) => {
            for (const n of m.match(/\d+/g) ?? []) this.used.add(Number(n));
            return '';
        });
        let cut = this.pending.length;
        const partial = PARTIAL.exec(this.pending);
        if (partial && this.pending.length - partial.index <= 24) cut = partial.index;
        const space = /[ \t]+$/.exec(this.pending.slice(0, cut));
        if (space) cut = space.index;
        const out = this.pending.slice(0, cut);
        this.pending = this.pending.slice(cut);
        return out;
    }

    flush(): string {
        const out = this.pending;
        this.pending = '';
        return out;
    }
}
