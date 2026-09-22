// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      'prettier/prettier': [
        'error',
        {
          endOfLine: 'auto',
        },
      ],
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts'],
    rules: {
      // `expect(service.method)` is how jest asserts on a mock, and the rule
      // reads every one of them as an unbound `this` — on a jest.fn() there is
      // no `this` to lose. typescript-eslint's own docs point at the jest
      // plugin's variant for exactly this case.
      '@typescript-eslint/unbound-method': 'off',
      // `expect.objectContaining` and the other asymmetric matchers are typed
      // `any`, so every assertion built from one trips this.
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
);
