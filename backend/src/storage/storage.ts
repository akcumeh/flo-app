import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { hmac, safeEqual } from '../common/crypto.js';

export interface ObjectStorage {
    readonly live: boolean;
    put(path: string, data: Buffer, mimeType: string): Promise<void>;
    get(path: string): Promise<Buffer>;
    delete(paths: string[]): Promise<void>;
    signedUrl(path: string, ttlSeconds: number): Promise<string>;
}

export const STORAGE = Symbol('STORAGE');

export class LocalDiskStorage implements ObjectStorage {
    readonly live = false;
    private readonly root: string;

    constructor(
        root: string,
        private readonly publicUrl: string,
        private readonly secret: string
    ) {
        this.root = resolve(root);
    }

    private file(path: string): string {
        const full = resolve(join(this.root, path));
        if (!full.startsWith(this.root + sep)) throw new Error('Path escapes the storage root');
        return full;
    }

    async put(path: string, data: Buffer, mimeType: string): Promise<void> {
        const full = this.file(path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, data);
        await writeFile(`${full}.meta`, JSON.stringify({ mimeType }));
    }

    async get(path: string): Promise<Buffer> {
        return readFile(this.file(path));
    }

    async read(path: string): Promise<{ data: Buffer; mimeType: string }> {
        const full = this.file(path);
        const meta = JSON.parse(await readFile(`${full}.meta`, 'utf8')) as { mimeType: string };
        return { data: await readFile(full), mimeType: meta.mimeType };
    }

    async delete(paths: string[]): Promise<void> {
        for (const path of paths) {
            const full = this.file(path);
            await rm(full, { force: true });
            await rm(`${full}.meta`, { force: true });
        }
    }

    async signedUrl(path: string, ttlSeconds: number): Promise<string> {
        const body = Buffer.from(
            JSON.stringify({ p: path, e: Math.floor(Date.now() / 1000) + ttlSeconds })
        ).toString('base64url');
        return `${this.publicUrl}/storage/${body}.${hmac(this.secret, `storage:${body}`)}`;
    }

    verify(token: string): string | null {
        const [body, sig] = token.split('.');
        if (!body || !sig || !safeEqual(sig, hmac(this.secret, `storage:${body}`))) return null;
        try {
            const { p, e } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
                p: string;
                e: number;
            };
            return e >= Math.floor(Date.now() / 1000) ? p : null;
        } catch {
            return null;
        }
    }
}

export class SupabaseStorage implements ObjectStorage {
    readonly live = true;

    constructor(
        private readonly url: string,
        private readonly serviceKey: string,
        private readonly bucket: string,
        private readonly fetchImpl: typeof fetch = fetch
    ) {}

    private headers(extra: Record<string, string> = {}) {
        return { Authorization: `Bearer ${this.serviceKey}`, apikey: this.serviceKey, ...extra };
    }

    private object(path: string): string {
        return `${this.url}/storage/v1/object/${this.bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;
    }

    async put(path: string, data: Buffer, mimeType: string): Promise<void> {
        const res = await this.fetchImpl(this.object(path), {
            method: 'POST',
            headers: this.headers({ 'Content-Type': mimeType, 'x-upsert': 'true' }),
            body: new Uint8Array(data),
        });
        if (!res.ok) throw new Error(`Storage upload answered ${res.status}`);
    }

    async get(path: string): Promise<Buffer> {
        const res = await this.fetchImpl(this.object(path), { headers: this.headers() });
        if (!res.ok) throw new Error(`Storage download answered ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
    }

    async delete(paths: string[]): Promise<void> {
        if (paths.length === 0) return;
        const res = await this.fetchImpl(`${this.url}/storage/v1/object/${this.bucket}`, {
            method: 'DELETE',
            headers: this.headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ prefixes: paths }),
        });
        if (!res.ok) throw new Error(`Storage delete answered ${res.status}`);
    }

    async signedUrl(path: string, ttlSeconds: number): Promise<string> {
        const res = await this.fetchImpl(
            `${this.url}/storage/v1/object/sign/${this.bucket}/${path.split('/').map(encodeURIComponent).join('/')}`,
            {
                method: 'POST',
                headers: this.headers({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ expiresIn: ttlSeconds }),
            }
        );
        if (!res.ok) throw new Error(`Storage sign answered ${res.status}`);
        const { signedURL } = (await res.json()) as { signedURL: string };
        return `${this.url}/storage/v1${signedURL}`;
    }
}
