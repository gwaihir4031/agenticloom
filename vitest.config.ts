import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      // Exclude .claude/ (local config + any git worktrees the user has
      // checked out underneath). Without this, vitest scans into worktree
      // directories and picks up duplicate (potentially stale-branch) test
      // files — pollutes the test count and produces phantom failures when
      // the worktree branch is on different code than HEAD.
      '**/.claude/**',
      // scratch/ is gitignored but contains smoke-test fixture YAMLs and
      // historical artifacts, not tests. Exclude defensively.
      '**/scratch/**',
    ],
  },
});
