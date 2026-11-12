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
  const dark = value === 'dark' || (value === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0a0a0a' : '#fafafa');
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
