import { applyAppearance } from './theme';

describe('app icon follows the theme', () => {
    beforeEach(() => {
        document.head.innerHTML = `
            <meta name="theme-color" content="#0a0a0a" />
            <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
            <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
            <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />`;
    });

    const href = (selector: string) => document.querySelector(selector)?.getAttribute('href');

    it('uses the black icons in dark mode and the white ones in light mode', () => {
        applyAppearance('dark');
        expect(href('link[rel="apple-touch-icon"]')).toBe('/apple-touch-icon-dark.png');
        expect(href('link[sizes="32x32"]')).toBe('/favicon-32x32-dark.png');
        expect(href('link[sizes="16x16"]')).toBe('/favicon-16x16-dark.png');

        applyAppearance('light');
        expect(href('link[rel="apple-touch-icon"]')).toBe('/apple-touch-icon-light.png');
        expect(href('link[sizes="32x32"]')).toBe('/favicon-32x32-light.png');
        expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
            '#fafafa'
        );
    });
});
