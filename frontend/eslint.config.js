import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist', 'dev-dist', 'node_modules', 'coverage', 'src/api/schema.d.ts', 'public'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['**/*.{ts,tsx}'],
        languageOptions: { globals: { ...globals.browser } },
        plugins: { 'react-hooks': reactHooks },
        rules: {
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'warn',
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
        },
    },
    {
        files: ['**/*.test.{ts,tsx}', 'src/test/**'],
        languageOptions: { globals: { ...globals.browser, ...globals.vitest } },
    },
    {
        files: ['scripts/**/*.mjs', 'vite.config.ts'],
        languageOptions: { globals: { ...globals.node } },
    },
    prettier
);
