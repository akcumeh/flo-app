import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist', 'node_modules', 'coverage', '.storage', '.pglite'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: { globals: { ...globals.node } },
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
            'no-console': 'off',
        },
    },
    {
        files: ['test/**/*.ts'],
        languageOptions: { globals: { ...globals.node, ...globals.vitest } },
        rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
    },
    prettier
);
