export const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

const KEY = 'florence.google';

function random(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function googleRedirectUri(): string {
    return `${location.origin}/signin/google`;
}

export function googleSignInUrl(from: string): string {
    const nonce = random();
    const state = random();
    try {
        sessionStorage.setItem(KEY, JSON.stringify({ nonce, state, from }));
    } catch {
        return '';
    }
    const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: googleRedirectUri(),
        response_type: 'id_token',
        scope: 'openid email profile',
        nonce,
        state,
        prompt: 'select_account',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function payload(token: string): Record<string, unknown> | null {
    try {
        const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), '=')));
    } catch {
        return null;
    }
}

export type GoogleReturn =
    | { ok: true; idToken: string; from: string }
    | { ok: false; reason: 'cancelled' | 'mismatch' | 'missing'; from: string };

export function readGoogleReturn(hash: string): GoogleReturn {
    let saved: { nonce: string; state: string; from: string } | null;
    try {
        saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
        sessionStorage.removeItem(KEY);
    } catch {
        saved = null;
    }
    const from = saved?.from ?? '/home';
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    if (params.get('error')) return { ok: false, reason: 'cancelled', from };
    const idToken = params.get('id_token');
    if (!idToken || !saved) return { ok: false, reason: 'missing', from };
    if (params.get('state') !== saved.state || payload(idToken)?.nonce !== saved.nonce) {
        return { ok: false, reason: 'mismatch', from };
    }
    return { ok: true, idToken, from };
}
