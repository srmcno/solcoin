// Flat ESLint config for the Solcoin monorepo.
//
// The intent here is a small set of rules that protect invariants this codebase
// actually depends on, rather than a large stylistic ruleset that Prettier
// already settles. Everything below either catches a real defect class or
// guards a security property described in docs/security.md.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/drizzle/**',
      '**/*.d.ts',
      'packages/web/dist/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      // Unused code is usually a half-finished edit. Leading underscore is the
      // documented opt-out for a deliberately ignored binding.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // `any` is allowed at a handful of genuine boundaries (SDK interop, JSON
      // parsing) and each of those carries an inline disable with a reason.
      '@typescript-eslint/no-explicit-any': 'warn',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      // `+x` and `'' + x` are the coercion tricks worth catching; `1 * HOUR`
      // is arithmetic that reads as English and is allowed through.
      'no-implicit-coercion': ['error', { boolean: false, allow: ['*'] }],
      'no-return-await': 'error',
      'no-throw-literal': 'error',
    },
  },

  // Server: pino is the logger. A stray console call bypasses redaction and
  // can put a secret into stdout, so it is an error rather than a nit. The few
  // places whose entire job is writing to a terminal — the CLIs, the build
  // script, the startup banner — carry an inline disable at the call site,
  // which documents the intent better than a whole-directory exemption.
  {
    files: ['packages/server/src/**/*.ts', 'packages/server/build.mjs'],
    rules: {
      'no-console': 'error',
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'Use the HttpClient from providers/http.ts — it carries the rate limiter, circuit breaker, timeout and URL redaction.',
        },
      ],
    },
  },

  // Web: browser globals, hook rules, and a hard ban on the two APIs that turn
  // untrusted token metadata into script execution.
  {
    files: ['packages/web/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-properties': [
        'error',
        {
          property: 'dangerouslySetInnerHTML',
          message: 'Token names and social text are untrusted. Render them as text nodes.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
          message: 'Token names and social text are untrusted. Render them as text nodes.',
        },
        {
          selector: 'AssignmentExpression[left.property.name="innerHTML"]',
          message: 'Token names and social text are untrusted. Render them as text nodes.',
        },
      ],
    },
  },

  // Tests reach into internals deliberately and assert on shapes the compiler
  // cannot narrow, so the `any` nudge would be pure noise there.
  {
    files: ['tests/**/*.ts', '**/*.test.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
);
