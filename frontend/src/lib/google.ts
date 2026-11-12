interface GoogleId {
    initialize(options: {
        client_id: string;
        callback: (r: { credential: string }) => void;
        ux_mode?: 'popup';
    }): void;
    renderButton(el: HTMLElement, options: Record<string, unknown>): void;
}

declare global {
    interface Window {
        google?: { accounts: { id: GoogleId } };
    }
}

export const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

let loading: Promise<GoogleId> | null = null;

export function loadGoogle(): Promise<GoogleId> {
    loading ??= new Promise((resolve, reject) => {
        if (window.google?.accounts?.id) {
            resolve(window.google.accounts.id);
            return;
        }
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.onload = () =>
            window.google
                ? resolve(window.google.accounts.id)
                : reject(new Error('Google sign-in did not load'));
        script.onerror = () => {
            loading = null;
            reject(new Error('Google sign-in did not load'));
        };
        document.head.appendChild(script);
    });
    return loading;
}
