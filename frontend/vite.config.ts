import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

const api = process.env.FLORENCE_API ?? 'http://localhost:3560';
const backendEnv = loadEnv('development', '../backend', '');
const googleClientId = process.env.VITE_GOOGLE_CLIENT_ID ?? backendEnv.GOOGLE_CLIENT_ID ?? '';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
    define: {
        'import.meta.env.VITE_GOOGLE_CLIENT_ID': JSON.stringify(googleClientId),
    },
    server: {
        port: 5180,
        strictPort: true,
        allowedHosts: ['.*'],
        proxy: {
            '/v1': { target: api, changeOrigin: false },
            '/storage': { target: api, changeOrigin: false },
        },
    },
    preview: {
        port: 5180,
        proxy: {
            '/v1': { target: api, changeOrigin: false },
            '/storage': { target: api, changeOrigin: false },
        },
    },
    plugins: [
        react(),
        VitePWA({
            registerType: 'autoUpdate',
            includeAssets: [
                'favicon.ico',
                'favicon-16x16.png',
                'favicon-32x32.png',
                'apple-touch-icon.png',
            ],
            manifest: {
                name: 'Florence',
                short_name: 'Florence',
                description: 'Exam prep and answers from your own course notes.',
                start_url: '/',
                scope: '/',
                display: 'standalone',
                orientation: 'portrait',
                background_color: '#1e6bf0',
                theme_color: '#fafafa',
                icons: [
                    { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
                    { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
                    {
                        src: 'icon-maskable-512.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'maskable',
                    },
                ],
            },
            workbox: {
                navigateFallback: '/index.html',
                navigateFallbackDenylist: [/^\/v1\//, /^\/storage\//],
                importScripts: ['push-sw.js'],
                globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
            },
        }),
    ],
    test: {
        environment: 'jsdom',
        globals: true,
        setupFiles: ['./src/test/setup.ts'],
        css: false,
    },
});
