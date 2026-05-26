import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Disable base rule in favor of the TS-aware version
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Permitted but flagged for incremental cleanup
      '@typescript-eslint/no-explicit-any': 'warn',

      // --- Project-specific allowances ---

      // Loom strips ANSI escape codes from agent terminal output via
      // \x1b-containing regexes. Disabling the rule project-wide because
      // this pattern recurs intentionally, not as a one-off.
      'no-control-regex': 'off',

      // Best-effort cleanup catches (e.g. `try { rmSync(tmp) } catch {}`)
      // are loom's documented pattern for non-critical teardown. Allow
      // empty catches; still error on empty {if,while,for} blocks.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // Loom's error-handling style is to catch low-level Node errors at
      // boundaries and rethrow with loom-specific context (e.g. "agent
      // 'X' matched at <path> but read failed: <inner>"). Preserving
      // `cause` would bury the contextual message users actually need.
      'preserve-caught-error': 'off',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', '**/*.config.js', 'example_script.mts'],
  },
);
