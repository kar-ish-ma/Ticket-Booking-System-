/**
 * eslint.config.js
 *
 * Owns lint rules for the whole workspace (server, client, shared) via ESLint's flat config —
 * the format ESLint 9 uses by default. There is no `.eslintrc.json` in this repo; that filename
 * is the legacy config format and would silently not apply these rules under ESLint 9.
 *
 * Does NOT own formatting. `eslint-config-prettier` (last in the array, so it wins) turns off
 * every ESLint rule that would otherwise fight Prettier over style — Prettier owns style,
 * ESLint owns correctness and documentation.
 *
 * Invariant: JSDoc enforcement (`eslint-plugin-jsdoc`) applies only to `server/src/**` and
 * `shared/**`, not `client/**`. Those are the modules CLAUDE.md's commenting standard targets
 * (raw SQL, transaction boundaries, concurrency assumptions) — client gets its own React-aware
 * config in P7-1, and JSX components don't follow the same documentation convention.
 */
import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';
import prettierConfig from 'eslint-config-prettier';

// WHY explicit globals instead of an `env` block:
// Flat config has no `env` key (that was legacy .eslintrc). Node's ambient globals must be
// listed directly under languageOptions.globals or ESLint reports `process`/`console`/etc as
// undefined.
const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearTimeout: 'readonly',
  clearInterval: 'readonly',
};

export default [
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/*.min.js'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: nodeGlobals,
    },
  },
  {
    // WHY `contexts` instead of the blanket require-jsdoc default:
    // The default flags every function, including small private helpers, which would make the
    // rule noise instead of signal. Scoping to exported declarations matches CLAUDE.md's actual
    // rule: "every exported function gets JSDoc" — internal helpers are exempt.
    files: ['server/src/**/*.js', 'shared/**/*.js'],
    plugins: { jsdoc },
    rules: {
      'jsdoc/require-jsdoc': [
        'warn',
        {
          contexts: [
            'ExportNamedDeclaration > FunctionDeclaration',
            'ExportDefaultDeclaration > FunctionDeclaration',
          ],
        },
      ],
      'jsdoc/require-param': 'warn',
      'jsdoc/require-returns': 'warn',
      'jsdoc/check-param-names': 'warn',
      'jsdoc/check-tag-names': 'warn',
    },
  },
  prettierConfig,
];
