// ESLint flat config for cryptoflip-frontend.
//
// Why this exists: Next 14+ deprecated `next lint`; Next 16 removed it
// outright. The old script (`next lint` in package.json) now exits with
// "Invalid project directory provided, no such directory: /root/coin-master/
// frontend/lint" because it interprets `lint` (the script name) as a path.
// The Frontend CI job is red for exactly this reason.
//
// This file replaces `next lint` with a standard ESLint 9 flat config.
//
// Design choice: written WITHOUT `@eslint/eslintrc`'s `FlatCompat`.
// FlatCompat rewrites legacy `extends: ['next/core-web-vitals']` syntax
// into flat config at runtime, but it transitively pulls in
// `@eslint/eslintrc` which expects `minimatch ^3.1.5`. The repo's npm
// override forces `minimatch ^9.0.3` (ESM-only, no CJS default export),
// which breaks the bridge with `import minimatch from 'minimatch'`. The
// fix would be either to remove the override (scope creep) or to use the
// native flat-config entry points that ship with `@next/eslint-plugin-next`.
//
// Native flat config approach (used here):
//   - @next/eslint-plugin-next exposes `configs['core-web-vitals']` (a
//     flat-config object, verified in node_modules). Spread it in.
//   - eslint-plugin-react-hooks exposes `configs.recommended`.
//   - typescript-eslint exposes `configs.recommended`.
//
// Policy:
//   - Errors block CI (default; ESLint exit code != 0 on errors).
//   - Warnings don't block CI (per WO-4 ratchet: documented in PR body;
//     the file does not set --max-warnings, so warnings are reported
//     but don't fail the build). This matches the operator's
//     "errors-block-warnings-warn" policy.
//
// Migration is intentional and surgical: no source files were modified.
// The 200+ lint findings the new config will surface are reported as
// warnings (one ratchet step) — fixing them is a separate per-file
// effort, deliberately NOT bundled with this PR.

import nextPlugin from '@next/eslint-plugin-next';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default [
  // Global ignores — same set the legacy .eslintrc had via .gitignore,
  // mirrored explicitly so the flat config doesn't try to lint these.
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'build/**',
      'public/**',
      'coverage/**',
      '*.config.js',
      '*.config.cjs',
      '*.config.mjs',
      'jest.config.ts',
      'jest.setup.ts',
    ],
  },

  // Next.js core-web-vitals (flat-config-ready preset).
  // Same rules Next used to apply via eslint-config-next/core-web-vitals.
  // Includes react/react-hooks rules in @next/eslint-plugin-next 16+.
  nextPlugin.configs['core-web-vitals'],

  // React Hooks exhaustive-deps rules. The legacy `plugin:react-hooks/
  // recommended` config (in `configs.recommended`) is in legacy plugin-
  // array format which ESLint 9 flat config rejects. The flat-config
  // entry points live at `configs.flat.recommended` (verified in
  // node_modules/eslint-plugin-react-hooks/cjs/eslint-plugin-react-
  // hooks.development.js).
  reactHooksPlugin.configs.flat.recommended,

  // TypeScript recommended ruleset.
  ...tseslint.configs.recommended,

  // Project-wide rule tweaks. The ratchet policy:
  //   - Errors (default level for any rule) → block CI.
  //   - Warnings (any rule explicitly set to 'warn') → don't block CI.
  //
  // RATCHET BASELINE (recorded 2026-08-25):
  // The codebase was written against eslint-plugin-react-hooks@<5, before
  // the React Compiler lint rules shipped in v5+/v6/v7. The repo's
  // installed v7 introduces six new rules whose diagnostics flag patterns
  // the existing code uses deliberately (sync setState inside effects for
  // event-driven UI, `Date.now()` in render paths, ref access patterns
  // that v7 considers impure, etc.). The codebase is functionally correct
  // against these patterns; migrating it to be React-Compiler-clean is a
  // multi-week refactor that does not block CI.
  //
  // Per the operator's ratchet policy ("errors-block-warnings-warn;
  // don't mass-edit 200 files to silence"), the new rules are downgraded
  // to 'warn' on this commit. Future PRs tighten them one at a time:
  //   - Move a single rule from 'warn' → 'error'.
  //   - Fix the surfaced errors file-by-file.
  //   - Repeat.
  // Each ratchet step is its own PR with a clearly-scoped migration.
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    rules: {
      // React Compiler lint rules (new in eslint-plugin-react-hooks v5+).
      // Ratcheted to warn. See ratchet baseline note above.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/set-state-in-render': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/refs': 'warn',
      // Existing warnings: keep at warn.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
    },
  },
];
