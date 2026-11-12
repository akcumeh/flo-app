import { API_URL, ApiError, client, refreshAccessToken, session, type Problem } from './http';
import type { StoredFile } from './types';

export interface UploadOptions {
    courseId?: string;
    onProgress?: (sent: number, total: number) => void;
    signal?: AbortSignal;
}

function send(form: FormData, token: string | null, opts: UploadOptions) {
    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_URL}/v1/files`);
        xhr.withCredentials = true;
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) opts.onProgress?.(e.loaded, e.total);
        };
        xhr.onload = () => {
            let body: unknown;
            try {
                body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
            } catch {
                body = null;
            }
            resolve({ status: xhr.status, body });
        };
        xhr.onerror = () => reject(new ApiError(0, null, 'You seem to be offline.'));
        xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
        opts.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
        xhr.send(form);
    });
}

export async function uploadFiles(files: File[], opts: UploadOptions = {}): Promise<StoredFile> {
    const form = new FormData();
    for (const f of files) form.append('pages', f, f.name);
    if (opts.courseId) form.append('courseId', opts.courseId);
    let res = await send(form, session.token, opts);
    if (res.status === 401) {
        const token = await refreshAccessToken();
        if (token) res = await send(form, token, opts);
    }
    if (res.status < 200 || res.status >= 300) {
        throw new ApiError(res.status, res.body as Problem | null, 'Could not upload that file.');
    }
    return res.body as StoredFile;
}

export async function getFile(fileId: string): Promise<StoredFile> {
    const res = await client.GET('/v1/files/{fileId}', { params: { path: { fileId } } });
    return res.data as StoredFile;
}

export async function deleteFile(fileId: string): Promise<void> {
    await client.DELETE('/v1/files/{fileId}', { params: { path: { fileId } } });
}

export async function listCourses() {
    return (await client.GET('/v1/me/courses')).data!.items;
}

export function formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
