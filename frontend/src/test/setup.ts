import '@testing-library/jest-dom/vitest';

if (!globalThis.crypto?.randomUUID) {
    Object.defineProperty(globalThis, 'crypto', {
        value: { randomUUID: () => Math.random().toString(16).slice(2) + Date.now().toString(16) },
    });
}

window.HTMLElement.prototype.scrollIntoView = () => {};
window.scrollTo = () => {};
