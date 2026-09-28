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
      // `jest.Mock.mock.calls` is `any[][]`, so reaching into it to assert on
      // what a collaborator was called with trips both of these on every
      // `calls[0][1]`. The `any` originates in Jest's own types, not in the
      // code under test — which is what these rules exist to catch. Off here,
      // and on everywhere else.
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Joi types a validated value as `any` whatever the schema's generic
      // says, so every assertion about a default trips it.
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);
