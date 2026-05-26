import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir, homedir } from 'os';
import * as path from 'path';
import { loadAgentSystemPrompt } from './agent.js';

const isRoot = process.getuid?.() === 0;

describe('loadAgentSystemPrompt — layered agent resolution (real fs)', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = mkdtempSync(path.join(tmpdir(), 'loom-home-'));
    tmpCwd = mkdtempSync(path.join(tmpdir(), 'loom-cwd-'));
    // Override $HOME so os.homedir() (which the runtime's expandHome
    // calls via the tilde branch) points at our throwaway tmpHome
    // instead of the user's real ~.
    process.env.HOME = tmpHome;
    // Sanity-check the override actually took effect. os.homedir() reads
    // $HOME on POSIX but falls back to userInfo().homedir if $HOME is
    // unset or empty — if this ever fires in CI, the test would silently
    // read from the user's real home dir instead of the sandbox. Fail
    // loud at setup time rather than letting the test silently pass
    // against the wrong fixture surface.
    expect(homedir()).toBe(tmpHome);
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('reads from project layer when both layers have the persona', () => {
    const projectDir = path.join(tmpCwd, '.claude', 'agents');
    const globalDir = path.join(tmpHome, '.claude', 'agents');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(path.join(projectDir, 'foo.md'), 'project content');
    writeFileSync(path.join(globalDir, 'foo.md'), 'global content');

    // Project layer arrives as absolute (matches the absolutifyAgentDirsInEmit
    // contract for `loom run`); global stays tilde-prefixed.
    const content = loadAgentSystemPrompt('foo', [projectDir, '~/.claude/agents/']);
    expect(content).toBe('project content');
  });

  it('falls back to global layer when project layer misses', () => {
    const globalDir = path.join(tmpHome, '.claude', 'agents');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(path.join(globalDir, 'foo.md'), 'global content');

    const content = loadAgentSystemPrompt('foo', [
      path.join(tmpCwd, '.claude', 'agents'),
      '~/.claude/agents/',
    ]);
    expect(content).toBe('global content');
  });

  it('reads from copilot project layer when both layers have the persona', () => {
    const projectDir = path.join(tmpCwd, '.github', 'agents');
    const globalDir = path.join(tmpHome, '.copilot', 'agents');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(path.join(projectDir, 'foo.md'), 'copilot project content');
    writeFileSync(path.join(globalDir, 'foo.md'), 'copilot global content');

    // Project layer arrives as absolute (matches the absolutifyAgentDirsInEmit
    // contract for `loom run`); global stays tilde-prefixed.
    const content = loadAgentSystemPrompt('foo', [projectDir, '~/.copilot/agents/']);
    expect(content).toBe('copilot project content');
  });

  it('falls back to copilot global layer when project layer misses', () => {
    const globalDir = path.join(tmpHome, '.copilot', 'agents');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(path.join(globalDir, 'foo.md'), 'copilot global content');

    const content = loadAgentSystemPrompt('foo', [
      path.join(tmpCwd, '.github', 'agents'),
      '~/.copilot/agents/',
    ]);
    expect(content).toBe('copilot global content');
  });

  it('loud-fails listing both expanded attempted paths when neither layer has the persona', () => {
    const projectDir = path.join(tmpCwd, '.claude', 'agents');
    const err = (): string => loadAgentSystemPrompt('missing', [projectDir, '~/.claude/agents/']);
    // The error names BOTH attempted paths AND has expanded the tilde
    // (debugging value depends on seeing the real path, not the source form).
    expect(err).toThrowError(/agent 'missing' persona file is missing at any of/);
    expect(err).toThrowError(
      new RegExp(path.join(projectDir, 'missing.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    expect(err).toThrowError(
      new RegExp(
        path
          .join(tmpHome, '.claude', 'agents', 'missing.md')
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      ),
    );
    // The tilde MUST be expanded in the error string — leaving '~' in
    // the message would mislead a debugging user.
    expect(err).not.toThrowError(/~\/\.claude\/agents/);
  });

  // chmodSync(0o000) is a no-op as root (root reads everything regardless
  // of mode bits). Skip the test in that case; the contract is exercised
  // for typical local-dev users.
  (isRoot ? it.skip : it)(
    'permission-denied at the matched (project) layer surfaces as an OS error, NOT a fallthrough',
    () => {
      const projectDir = path.join(tmpCwd, '.claude', 'agents');
      const globalDir = path.join(tmpHome, '.claude', 'agents');
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(globalDir, { recursive: true });
      const projectFile = path.join(projectDir, 'foo.md');
      writeFileSync(projectFile, 'project content');
      writeFileSync(path.join(globalDir, 'foo.md'), 'global content');

      chmodSync(projectFile, 0o000);
      try {
        // Read fails loud — does NOT silently fall through to global.
        expect(() => loadAgentSystemPrompt('foo', [projectDir, '~/.claude/agents/'])).toThrow();
        // And critically: even with global available, the result is NOT
        // 'global content'. (toThrow is sufficient since loadAgentSystemPrompt
        // wraps readFileSync's EACCES; but assert the fallthrough explicitly
        // by checking the error path mentions the project file path, not the
        // global one.)
        try {
          loadAgentSystemPrompt('foo', [projectDir, '~/.claude/agents/']);
        } catch (e: any) {
          expect(String(e.message ?? e)).toContain(projectFile);
          expect(String(e.message ?? e)).not.toContain(path.join(globalDir, 'foo.md'));
        }
      } finally {
        chmodSync(projectFile, 0o644);
      }
    },
  );
});
