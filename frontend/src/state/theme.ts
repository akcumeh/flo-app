import { useCallback, useSyncExternalStore } from 'react';

export type Appearance = 'light' | 'dark' | 'system';

const KEY = 'florence.appearance';
const listeners = new Set<() => void>();

function read(): Appearance {
    try {
        const v = localStorage.getItem(KEY);
        return v === 'light' || v === 'dark' ? v : 'system';
    } catch {
        return 'system';
    }
}

export function applyAppearance(value: Appearance = read()) {
    const root = document.documentElement;
    if (value === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', value);
    const dark =
        value === 'dark' ||
        (value === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', dark ? '#0a0a0a' : '#fafafa');
    const tone = dark ? 'dark' : 'light';
    const icons: Array<[string, string]> = [
        ['link[rel="apple-touch-icon"]', `/apple-touch-icon-${tone}.png`],
        ['link[rel="icon"][sizes="32x32"]', `/favicon-32x32-${tone}.png`],
        ['link[rel="icon"][sizes="16x16"]', `/favicon-16x16-${tone}.png`],
    ];
    for (const [selector, href] of icons) {
        document.querySelector(selector)?.setAttribute('href', href);
    }
}

export function followSystemTheme() {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    query?.addEventListener('change', () => {
        if (read() === 'system') applyAppearance('system');
    });
}

export function setAppearance(value: Appearance) {
    try {
        if (value === 'system') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, value);
    } catch {
        return;
    } finally {
        applyAppearance(value);
        for (const l of listeners) l();
    }
}

export function useAppearance(): [Appearance, (v: Appearance) => void] {
    const value = useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        read,
        () => 'system' as Appearance
    );
    return [value, useCallback((v: Appearance) => setAppearance(v), [])];
}
