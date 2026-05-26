import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  realpathSync,
  utimesSync,
} from 'fs';
import { tmpdir, homedir } from 'os';
import * as path from 'path';

// Mock child_process.spawn for runChild tests. cli.test.ts uses both the
// spawn-mock surface (runChild unit tests) and a real subprocess channel
// (top-level wrapper end-to-end tests) — the latter is obtained via
// vi.importActual('child_process').spawnSync inside the wrapper tests, which
// returns the unmocked module despite vi.mock('child_process') above.
const spawnMock = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: any[]) => spawnMock(...args),
}));

// Real fs in a per-test temp directory, mirroring `src/compile/test-helpers.ts`'s
// `setupCompileTestEnv()`. cli.ts' resolvePipeline calls existsSync on the
// candidate path, so fixturing real files (rather than mocking fs) keeps the
// test surface narrow.
let tmpDir: string;
let origCwd: string;

beforeEach(() => {
  // realpathSync normalizes macOS's /var/folders/... → /private/var/folders/...
  // so test expectations match what process.cwd() reports after the chdir.
  // Without this, assertions on the workspace dir + AGENT_DIRS absolutification
  // see a /var prefix while production code (which calls process.cwd()) sees
  // a /private/var prefix, and toMatchObject fails on a string mismatch.
  tmpDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'loom-cli-test-')));
  origCwd = process.cwd();
  process.chdir(tmpDir);
  spawnMock.mockReset();
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolvePipeline', () => {
  it('resolves a name to loom/pipelines/<name>.yaml when the file exists', async () => {
    mkdirSync(path.join('loom', 'pipelines'), { recursive: true });
    writeFileSync(path.join('loom', 'pipelines', 'multi-review.yaml'), 'pipeline: x\n');
    const { resolvePipeline } = await import('./cli.js');
    expect(resolvePipeline('multi-review')).toBe(
      path.join('loom', 'pipelines', 'multi-review.yaml'),
    );
  });

  it('treats a .yaml path arg as a file path (not a name)', async () => {
    mkdirSync('path', { recursive: true });
    writeFileSync('path/foo.yaml', 'pipeline: x\n');
    const { resolvePipeline } = await import('./cli.js');
    // The path-mode branch returns the arg verbatim (no `loom/pipelines/` join).
    expect(resolvePipeline('./path/foo.yaml')).toBe('./path/foo.yaml');
  });

  it('treats an arg containing a slash as a file path (no .yaml suffix needed)', async () => {
    mkdirSync('workflows', { recursive: true });
    writeFileSync('workflows/x', 'pipeline: x\n');
    const { resolvePipeline } = await import('./cli.js');
    expect(resolvePipeline('./workflows/x')).toBe('./workflows/x');
  });

  it('treats a .yml suffix as a file path (mirror of .yaml)', async () => {
    mkdirSync('workflows', { recursive: true });
    writeFileSync('workflows/x.yml', 'pipeline: x\n');
    const { resolvePipeline } = await import('./cli.js');
    expect(resolvePipeline('./workflows/x.yml')).toBe('./workflows/x.yml');
  });
});

describe('resolvePipeline — layered discovery', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalCwd: string;
  let tmpCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    tmpHome = mkdtempSync(path.join(tmpdir(), 'loom-home-'));
    tmpCwd = mkdtempSync(path.join(tmpdir(), 'loom-cwd-'));
    process.env.HOME = tmpHome;
    process.chdir(tmpCwd);
    // Sanity-check the override actually took. os.homedir() reads $HOME
    // on POSIX but falls back to userInfo() when $HOME is unset/empty —
    // fail loud at setup time rather than silently testing against the
    // user's real home dir.
    expect(homedir()).toBe(tmpHome);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('resolves from project layer when both layers have the pipeline', async () => {
    const { resolvePipeline } = await import('./cli.js');
    const projectDir = path.join(tmpCwd, 'loom', 'pipelines');
    const globalDir = path.join(tmpHome, '.loom', 'pipelines');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(path.join(projectDir, 'foo.yaml'), 'pipeline: foo\n');
    writeFileSync(path.join(globalDir, 'foo.yaml'), 'pipeline: foo\n');

    const resolved = resolvePipeline('foo');
    expect(resolved).toBe(path.join('loom', 'pipelines', 'foo.yaml'));
  });

  it('falls back to global layer when project layer misses', async () => {
    const { resolvePipeline } = await import('./cli.js');
    const globalDir = path.join(tmpHome, '.loom', 'pipelines');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(path.join(globalDir, 'foo.yaml'), 'pipeline: foo\n');

    const resolved = resolvePipeline('foo');
    expect(resolved).toBe(path.join(tmpHome, '.loom', 'pipelines', 'foo.yaml'));
  });

  it('loud-fails listing both attempted paths when neither layer has it', async () => {
    const { resolvePipeline } = await import('./cli.js');
    expect(() => resolvePipeline('missing')).toThrowError(/Pipeline 'missing' not found at either/);
    expect(() => resolvePipeline('missing')).toThrowError(
      new RegExp(
        path.join('loom', 'pipelines', 'missing.yaml').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      ),
    );
    expect(() => resolvePipeline('missing')).toThrowError(
      new RegExp(
        path
          .join(tmpHome, '.loom', 'pipelines', 'missing.yaml')
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      ),
    );
  });

  it('global layer silently no-ops when ~/.loom/ does not exist', async () => {
    const { resolvePipeline } = await import('./cli.js');
    // tmpHome exists but ~/.loom/ inside it does not. Both paths should
    // still appear in the error message — the global path is the
    // *attempted* path, even though the parent dir does not exist.
    expect(() => resolvePipeline('missing')).toThrowError(/Pipeline 'missing' not found at either/);
  });

  it('explicit-path escape hatch is unchanged (slash bypasses name resolution)', async () => {
    const { resolvePipeline } = await import('./cli.js');
    const projectDir = path.join(tmpCwd, 'custom');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, 'mine.yaml'), 'pipeline: mine\n');

    const resolved = resolvePipeline('custom/mine.yaml');
    expect(resolved).toBe('custom/mine.yaml');
  });

  it('explicit-path escape hatch accepts .yml suffix', async () => {
    const { resolvePipeline } = await import('./cli.js');
    const projectDir = path.join(tmpCwd, 'a');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, 'b.yml'), 'pipeline: b\n');

    const resolved = resolvePipeline('a/b.yml');
    expect(resolved).toBe('a/b.yml');
  });
});

describe('stripSaveLogsFlag', () => {
  it('strips --save-logs from passthrough args and returns saveLogs: true', async () => {
    // The CLI must filter --save-logs out of the pipeline-argv array so the
    // child's process.argv.slice(2) doesn't see it as a positional pipeline
    // input. The flag is environmental — it sets LOOM_SAVE_LOGS=1 in the
    // child's env, not a positional arg.
    const { stripSaveLogsFlag } = await import('./cli.js');
    const result = stripSaveLogsFlag(['multi-review', '--save-logs', 'TICKET-1']);
    expect(result.args).toEqual(['multi-review', 'TICKET-1']);
    expect(result.saveLogs).toBe(true);
  });

  it('returns saveLogs: false and unchanged args when flag is absent', async () => {
    const { stripSaveLogsFlag } = await import('./cli.js');
    const result = stripSaveLogsFlag(['multi-review', 'TICKET-1']);
    expect(result.args).toEqual(['multi-review', 'TICKET-1']);
    expect(result.saveLogs).toBe(false);
  });

  it('strips every occurrence so a duplicated flag does not leak as a positional', async () => {
    // indexOf-based stripping would have left the second --save-logs as a
    // positional input, silently shifting the pipeline's declared `inputs:`
    // slots by one — same failure mode the rest of the CLI avoids.
    const { stripSaveLogsFlag } = await import('./cli.js');
    const result = stripSaveLogsFlag(['multi-review', '--save-logs', '--save-logs', 'TICKET-1']);
    expect(result.args).toEqual(['multi-review', 'TICKET-1']);
    expect(result.saveLogs).toBe(true);
  });
});

describe('stripResumeFromFlag', () => {
  it('strips --resume-from and its value from args; returns the bind name', async () => {
    const { stripResumeFromFlag } = await import('./cli.js');
    expect(stripResumeFromFlag(['multi-review', '--resume-from', 'specOut', 'TICKET-1'])).toEqual({
      args: ['multi-review', 'TICKET-1'],
      resumeFrom: 'specOut',
    });
  });

  it('returns resumeFrom: undefined and unchanged args when flag absent', async () => {
    const { stripResumeFromFlag } = await import('./cli.js');
    expect(stripResumeFromFlag(['multi-review', 'TICKET-1'])).toEqual({
      args: ['multi-review', 'TICKET-1'],
      resumeFrom: undefined,
    });
  });

  it('strips every occurrence; first occurrence wins (mirrors stripSaveLogsFlag posture)', async () => {
    // A duplicated flag must not leak the second occurrence's value as a
    // positional input that shifts the pipeline's declared `inputs:` slots.
    const { stripResumeFromFlag } = await import('./cli.js');
    expect(
      stripResumeFromFlag(['p', '--resume-from', 'first', '--resume-from', 'second', 'x']),
    ).toEqual({
      args: ['p', 'x'],
      resumeFrom: 'first',
    });
  });

  it('throws when --resume-from value is missing (end-of-argv)', async () => {
    const { stripResumeFromFlag } = await import('./cli.js');
    expect(() => stripResumeFromFlag(['multi-review', '--resume-from'])).toThrow(
      /--resume-from requires a non-empty value/,
    );
  });

  it('throws when --resume-from value starts with -- (would silently swallow the next flag)', async () => {
    // Mirrors resolveWorkspaceId's --id validation: rejecting `-- prefix`
    // values prevents `--resume-from --id RATE-1` from consuming `--id`
    // as the cursor name.
    const { stripResumeFromFlag } = await import('./cli.js');
    expect(() => stripResumeFromFlag(['multi-review', '--resume-from', '--id', 'RATE-1'])).toThrow(
      /--resume-from requires a non-empty value/,
    );
  });

  it('throws when --resume-from value is the empty string', async () => {
    // Locks the empty-string-as-degenerate-input contract documented on
    // stripResumeFromFlag (loud-fail at the strip layer).
    const { stripResumeFromFlag } = await import('./cli.js');
    expect(() => stripResumeFromFlag(['multi-review', '--resume-from', '', 'TICKET-1'])).toThrow(
      /--resume-from requires a non-empty value/,
    );
  });
});

describe('enumerateTopLevelBinds', () => {
  it('captures top-level step.bind in the topLevel map', async () => {
    const { enumerateTopLevelBinds } = await import('./cli.js');
    const result = enumerateTopLevelBinds([
      { step: 'writer', input: '$x', produces: 'w.md', bind: 'writerOut' },
    ]);
    expect(result.topLevel.get('writerOut')).toBe('step');
    expect(result.nested.size).toBe(0);
  });

  it('captures parallel-child bind in BOTH topLevel (hoisted) and nested maps', async () => {
    // Mirrors the compile-side hoist. A hoisted-from-parallel bind named
    // as the cursor is accepted; the dual-write makes the cli.ts lookup
    // honor that structural acceptance.
    const { enumerateTopLevelBinds } = await import('./cli.js');
    const result = enumerateTopLevelBinds([
      {
        parallel: [
          { step: 'a', input: '$x', produces: 'a.md', bind: 'aOut' },
          { step: 'b', input: '$x', produces: 'b.md', bind: 'bOut' },
        ],
        bind: 'parOut',
      },
    ]);
    expect(result.topLevel.get('parOut')).toBe('parallel');
    expect(result.topLevel.get('aOut')).toBe('parallel hoisted child');
    expect(result.topLevel.get('bOut')).toBe('parallel hoisted child');
    // Inner-scope declaration site preserved so the nested-cursor rejection
    // message can still name the container kind (used by retry-zone
    // diagnostics, not by lookup which prefers topLevel).
    expect(result.nested.get('aOut')).toBe('parallel');
    expect(result.nested.get('bOut')).toBe('parallel');
  });

  it('captures review_loop subflow inner binds as nested', async () => {
    const { enumerateTopLevelBinds } = await import('./cli.js');
    const result = enumerateTopLevelBinds([
      {
        review_loop: {
          writer: 'w',
          input: '$x',
          writer_produces: 'w.md',
          verdict_field: 'status',
          bind: 'rlOut',
          reviewer: [
            { step: 'inner', input: '$rlOut', produces: 'i.json', bind: 'innerBind' },
            { aggregate: { inputs: { i: '$innerBind' }, verdict_field: 'status' } },
          ],
        },
      },
    ]);
    expect(result.topLevel.get('rlOut')).toBe('review_loop');
    expect(result.nested.get('innerBind')).toBe('review_loop reviewer subflow');
  });

  it('captures branch arm binds as nested', async () => {
    const { enumerateTopLevelBinds } = await import('./cli.js');
    const result = enumerateTopLevelBinds([
      {
        branch: {
          when: 'always',
          then: [{ step: 'then-step', input: '$x', produces: 't.md', bind: 'thenOut' }],
          else: [{ step: 'else-step', input: '$x', produces: 'e.md', bind: 'elseOut' }],
          bind: 'branchOut',
        },
      },
    ]);
    expect(result.topLevel.get('branchOut')).toBe('branch');
    expect(result.nested.get('thenOut')).toBe('branch');
    expect(result.nested.get('elseOut')).toBe('branch');
  });

  it('captures foreach bind as top-level + interior body binds as nested with scope=foreach', async () => {
    // Per Decision L: top-level foreach bind goes to `topLevel` (so
    // `--resume-from <bind>` resolves); interior binds inside the body
    // go to `nested` with the enclosing-kind label 'foreach' so the
    // "cursor inside a nested scope" rejection mentions where the bind
    // actually lives.
    const { enumerateTopLevelBinds } = await import('./cli.js');
    const result = enumerateTopLevelBinds([
      {
        foreach: {
          over: '$plan',
          as: 'task',
          body: [{ step: 'worker', input: '$task', produces: 'out.md', bind: 'w' }],
          bind: 'results',
        },
      },
    ]);
    expect(result.topLevel.get('results')).toBe('foreach');
    expect(result.nested.get('w')).toBe('foreach');
  });

  it('captures bindless foreach body binds as nested without polluting topLevel', async () => {
    const { enumerateTopLevelBinds } = await import('./cli.js');
    const result = enumerateTopLevelBinds([
      {
        foreach: {
          over: '$plan',
          as: 'task',
          body: [{ step: 'worker', input: '$task', produces: 'out.md', bind: 'w' }],
        },
      },
    ]);
    expect(result.topLevel.has('w')).toBe(false);
    expect(result.nested.get('w')).toBe('foreach');
  });

  it('captures aggregate.bind as top-level', async () => {
    const { enumerateTopLevelBinds } = await import('./cli.js');
    const result = enumerateTopLevelBinds([
      { step: 'a', input: '$x', produces: 'a.md', bind: 'aOut' },
      {
        aggregate: {
          inputs: { a: '$aOut' },
          verdict_field: 'status',
          bind: 'aggOut',
        },
      },
    ]);
    expect(result.topLevel.get('aggOut')).toBe('aggregate');
  });

  it('captures a step-host retry zone (on_fail.retry_from) in retryZones', async () => {
    const { enumerateTopLevelBinds } = await import('./cli.js');
    const result = enumerateTopLevelBinds([
      { step: 'writer', input: '$x', produces: 'w.md', bind: 'writerOut' },
      { step: 'mid', input: '$writerOut', produces: 'm.md', bind: 'midOut' },
      {
        step: 'rev',
        input: '$midOut',
        produces: 'r.json',
        bind: 'revOut',
        on_fail: {
          verdict_field: 'status',
          retry_from: 'writerOut',
          revise_with: { prompt: 'Retry.' },
        },
      },
    ]);
    expect(result.retryZones).toHaveLength(1);
    expect(result.retryZones[0]).toEqual({
      retryFromIdx: 0,
      gateIdx: 2,
      gateLabel: "step 'rev'",
    });
  });

  it('captures an aggregate-host retry zone (aggregate.retry_from) in retryZones', async () => {
    const { enumerateTopLevelBinds } = await import('./cli.js');
    // revise_with is schema-required when retry_from is set; include it so
    // the fixture matches what Zod would accept for a real pipeline (the
    // gate-detection helper normalizes revise_with eagerly).
    const result = enumerateTopLevelBinds([
      { step: 'writer', input: '$x', produces: 'w.md', bind: 'writerOut' },
      { step: 'rev', input: '$writerOut', produces: 'r.json', bind: 'revOut' },
      {
        aggregate: {
          inputs: { r: '$revOut' },
          verdict_field: 'status',
          retry_from: 'writerOut',
          bind: 'aggOut',
          revise_with: { prompt: 'Retry.' },
        },
      },
    ]);
    expect(result.retryZones).toHaveLength(1);
    expect(result.retryZones[0]).toEqual({
      retryFromIdx: 0,
      gateIdx: 2,
      gateLabel: "aggregate (bind 'aggOut')",
    });
  });
});

describe('stripMermaidOnlyFlag', () => {
  it('strips --mermaid-only from args and returns mermaidOnly: true', async () => {
    const { stripMermaidOnlyFlag } = await import('./cli.js');
    expect(stripMermaidOnlyFlag(['p', 'out.mermaid', '--mermaid-only'])).toEqual({
      args: ['p', 'out.mermaid'],
      mermaidOnly: true,
    });
  });

  it('returns mermaidOnly: false when flag absent', async () => {
    const { stripMermaidOnlyFlag } = await import('./cli.js');
    expect(stripMermaidOnlyFlag(['p', 'out.ts'])).toEqual({
      args: ['p', 'out.ts'],
      mermaidOnly: false,
    });
  });

  it('preserves positional order when flag is before positionals', async () => {
    const { stripMermaidOnlyFlag } = await import('./cli.js');
    expect(stripMermaidOnlyFlag(['--mermaid-only', 'p', 'out.mermaid'])).toEqual({
      args: ['p', 'out.mermaid'],
      mermaidOnly: true,
    });
  });

  it('strips every occurrence so a duplicated flag does not leak as a positional', async () => {
    const { stripMermaidOnlyFlag } = await import('./cli.js');
    expect(stripMermaidOnlyFlag(['--mermaid-only', 'p', '--mermaid-only', 'out.mermaid'])).toEqual({
      args: ['p', 'out.mermaid'],
      mermaidOnly: true,
    });
  });
});

describe('mermaidPathFor', () => {
  it('strips a .ts extension and appends .mermaid', async () => {
    const { mermaidPathFor } = await import('./cli.js');
    expect(mermaidPathFor('dist/p.ts')).toBe('dist/p.mermaid');
  });

  it('strips a .mjs extension and appends .mermaid', async () => {
    const { mermaidPathFor } = await import('./cli.js');
    expect(mermaidPathFor('out/p.mjs')).toBe('out/p.mermaid');
  });

  it('appends .mermaid when output has no extension', async () => {
    const { mermaidPathFor } = await import('./cli.js');
    expect(mermaidPathFor('build/p')).toBe('build/p.mermaid');
  });

  it('preserves a non-recognized extension and appends .mermaid', async () => {
    // Defensive: if a user passes a weird extension like .out, we don't
    // want to swallow it silently. Append rather than replace.
    const { mermaidPathFor } = await import('./cli.js');
    expect(mermaidPathFor('build/p.out')).toBe('build/p.out.mermaid');
  });
});

describe('resolveWorkspaceId', () => {
  // The resolution chain is explicit `--id` flag → first existing-file-arg
  // basename → `<pipeline>-<timestamp>` fallback. The contract is:
  //  - The flag wins regardless of whether any positional arg is a file.
  //  - Filename basename infers ticket-id-as-filename without forcing the
  //    convention (RATE-1.md → RATE-1; RATE-1.review.md → RATE-1.review).
  //  - The timestamp fallback is the safety net: no flag and no file arg
  //    means we still get a workspace dir under `loom/runs/`, never cwd.
  it('uses explicit --id flag value and strips it from passthrough', async () => {
    const { resolveWorkspaceId } = await import('./cli.js');
    const result = resolveWorkspaceId({
      argv: ['./scratch/ticket.md', '--id', 'RATE-1'],
      cwd: tmpDir,
      pipelineName: 'multi-review',
    });
    expect(result.id).toBe('RATE-1');
    expect(result.passthrough).toEqual(['./scratch/ticket.md']);
  });

  it('infers from existing-file arg basename when no --id flag', async () => {
    writeFileSync(path.join(tmpDir, 'RATE-1.md'), 'ticket');
    const { resolveWorkspaceId } = await import('./cli.js');
    const result = resolveWorkspaceId({
      argv: ['RATE-1.md'],
      cwd: tmpDir,
      pipelineName: 'multi-review',
    });
    expect(result.id).toBe('RATE-1');
    expect(result.passthrough).toEqual(['RATE-1.md']);
  });

  it('falls back to pipeline-timestamp when no flag and no file args', async () => {
    const { resolveWorkspaceId } = await import('./cli.js');
    const result = resolveWorkspaceId({
      argv: ['some-literal-string'],
      cwd: tmpDir,
      pipelineName: 'multi-review',
    });
    // Match the `<pipeline>-<timestamp>` shape rather than a specific value;
    // Date.now() returns a fresh integer each call.
    expect(result.id).toMatch(/^multi-review-\d+$/);
    expect(result.passthrough).toEqual(['some-literal-string']);
  });

  it('throws when --id has no value', async () => {
    const { resolveWorkspaceId } = await import('./cli.js');
    expect(() =>
      resolveWorkspaceId({
        argv: ['./ticket.md', '--id'],
        cwd: tmpDir,
        pipelineName: 'multi-review',
      }),
    ).toThrow(/--id requires a value/);
  });

  it('throws when --id is immediately followed by another flag', async () => {
    // Without this check, `--id --save-logs` would consume `--save-logs` as
    // the workspace id, silently swallowing the saveLogs intent. Treat any
    // `--` prefix on the value position as a missing-value condition.
    const { resolveWorkspaceId } = await import('./cli.js');
    expect(() =>
      resolveWorkspaceId({
        argv: ['--id', '--save-logs'],
        cwd: tmpDir,
        pipelineName: 'multi-review',
      }),
    ).toThrow(/--id requires a value/);
  });
});

describe('absolutifyFileArgs', () => {
  // The CLI chdirs into the workspace dir before spawning, so relative file
  // args from invocation cwd would otherwise resolve under the workspace
  // (and miss the actual file). Absolutify only args that resolve to an
  // existing file from invocation cwd; pass everything else through (literal
  // strings, ticket IDs, flags the pipeline knows about).
  it('absolutifies args that resolve to existing files; passes through others', async () => {
    writeFileSync(path.join(tmpDir, 'ticket.md'), 'content');
    const { absolutifyFileArgs } = await import('./cli.js');
    const result = absolutifyFileArgs({
      args: ['ticket.md', 'RATE-1', '--some-flag'],
      cwd: tmpDir,
    });
    expect(result).toEqual([path.join(tmpDir, 'ticket.md'), 'RATE-1', '--some-flag']);
  });

  it('leaves absolute paths to existing files unchanged', async () => {
    const abs = path.join(tmpDir, 'ticket.md');
    writeFileSync(abs, 'content');
    const { absolutifyFileArgs } = await import('./cli.js');
    const result = absolutifyFileArgs({ args: [abs], cwd: tmpDir });
    expect(result).toEqual([abs]);
  });
});

describe('entry-point guard (module load)', () => {
  it('does not throw when process.argv[1] is non-existent', async () => {
    // The guard at the bottom of cli.ts calls realpathSync(process.argv[1])
    // to compare against import.meta.url. If argv[1] points at a
    // stale/deleted/symlink-loop path, realpathSync throws — which would
    // crash any importer (vitest, a downstream consumer importing
    // `resolvePipeline`) at module load. The try/catch around the
    // comparison treats unresolvable argv[1] as "not the entry point" so
    // importing remains safe.
    const origArgv1 = process.argv[1];
    process.argv[1] = `/tmp/nonexistent-loom-test-${Math.random()}`;
    try {
      vi.resetModules();
      await expect(import('./cli.js')).resolves.toBeDefined();
    } finally {
      process.argv[1] = origArgv1;
    }
  });
});

/** Build a fake spawned child that fires 'exit' with the given (code, signal)
 *  pair on the next microtask. Mirrors the helper in runtime.test.ts but
 *  retains both arguments to 'exit' (signal-killed children pass code=null +
 *  signal name, which is the path runChild's POSIX 128+signum mapping
 *  exercises). */
function makeFakeChild(opts: { code?: number | null; signal?: string | null } = {}) {
  const child = new EventEmitter() as EventEmitter & { kill: (sig?: string) => void };
  child.kill = () => undefined;
  // `in` rather than `??` so callers can distinguish "omitted → default 0/null"
  // from "explicitly null". The (null, null) case is the defensive branch the
  // last runChild test exercises.
  const code = 'code' in opts ? opts.code : 0;
  const signal = 'signal' in opts ? opts.signal : null;
  queueMicrotask(() => child.emit('exit', code, signal));
  return child;
}

/** Build a fake child that fires an ENOENT 'error' with a synthesized
 *  (null, null) 'exit' afterward to exercise runChild's `settled` flag's
 *  role as a dedupe guard. On Node v25.9.0 a real spawn-ENOENT only fires
 *  'error' (not 'error' + 'exit'), but we synthesize the dual-fire here to
 *  lock in the dedupe behavior against any hypothetical future Node where
 *  both events might fire — the `settled` flag must ensure reject() wins
 *  and resolve() doesn't double-settle. */
function makeFakeEnoentChild(spawnPath: string) {
  const child = new EventEmitter() as EventEmitter & { kill: (sig?: string) => void };
  child.kill = () => undefined;
  queueMicrotask(() => {
    const err = new Error(`spawn ${spawnPath} ENOENT`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    err.syscall = `spawn ${spawnPath}`;
    err.path = spawnPath;
    child.emit('error', err);
    child.emit('exit', null, null);
  });
  return child;
}

describe('runChild', () => {
  it('resolves with the exit code on a clean exit and threads cwd to spawn', async () => {
    spawnMock.mockImplementation(() => makeFakeChild({ code: 0 }));
    const { runChild } = await import('./cli.js');
    // tmpDir path can be anything that exists or doesn't — runChild's cleanup
    // wraps rmSync in try/catch (recursive: true, force: true also swallows
    // ENOENT), so missing dirs don't perturb the resolution path. The
    // workspaceCwd arg threads through to spawn opts as `cwd`.
    const fakeTmpDir = path.join(tmpDir, 'tmp-nonexistent');
    const workspaceCwd = path.join(tmpDir, 'workspace-fake');
    const code = await runChild('node', ['ignored.mjs'], fakeTmpDir, false, workspaceCwd);
    expect(code).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toBe('node');
    expect(spawnMock.mock.calls[0][2]).toMatchObject({ stdio: 'inherit', cwd: workspaceCwd });
  });

  it('sets LOOM_INVOCATION_CWD on the spawned runner env', async () => {
    // Writer-side coverage for the cwd-fix env-var threading. Readers in
    // runtime/agent.ts + runtime/human-gate.ts have their own env-var-set +
    // fallback tests; this locks in the writer side so a regression dropping
    // the env-var set in runChild surfaces here rather than only via a smoke
    // run failing claude-CLI's "refuses to read paths outside cwd" check.
    spawnMock.mockImplementation(() => makeFakeChild({ code: 0 }));
    const { runChild } = await import('./cli.js');
    const fakeTmpDir = path.join(tmpDir, 'tmp-nonexistent');
    const workspaceCwd = path.join(tmpDir, 'workspace-fake');
    const invocationCwd = path.join(tmpDir, 'invocation-fake');
    await runChild('node', ['ignored.mjs'], fakeTmpDir, false, workspaceCwd, invocationCwd);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][2].env).toMatchObject({
      LOOM_INVOCATION_CWD: invocationCwd,
    });
  });

  it('maps SIGINT to 128 + signum (POSIX convention)', async () => {
    spawnMock.mockImplementation(() => makeFakeChild({ code: null, signal: 'SIGINT' }));
    const { runChild } = await import('./cli.js');
    const code = await runChild('node', [], path.join(tmpDir, 'tmpd'));
    // 130 = 128 + 2 on Linux/macOS — looked up via os.constants.signals.SIGINT.
    const os = await import('os');
    expect(code).toBe(128 + (os.constants.signals.SIGINT as number));
  });

  it('maps SIGTERM to 128 + signum', async () => {
    spawnMock.mockImplementation(() => makeFakeChild({ code: null, signal: 'SIGTERM' }));
    const { runChild } = await import('./cli.js');
    const code = await runChild('node', [], path.join(tmpDir, 'tmpd'));
    const os = await import('os');
    expect(code).toBe(128 + (os.constants.signals.SIGTERM as number));
  });

  it('resolves with 1 when both code and signal are null (defensive)', async () => {
    // The branch comment in cli.ts' runChild (look for "Defensive: `code ===
    // null` without a signal shouldn't happen") calls this out as "shouldn't
    // happen for a successfully-spawned child" — locking it in defends
    // against a future refactor that swaps the `code ?? 1` to plain `code`.
    spawnMock.mockImplementation(() => makeFakeChild({ code: null, signal: null }));
    const { runChild } = await import('./cli.js');
    const code = await runChild('node', [], path.join(tmpDir, 'tmpd'));
    expect(code).toBe(1);
  });

  it("rejects with the ENOENT error preserving err.path for the wrapper's hint", async () => {
    // The top-level catch reads err.path to decide tsx vs node remediation
    // text, so runChild must propagate the field unmodified rather than
    // wrap-and-rethrow. The `makeFakeEnoentChild` helper synthesizes a dual
    // 'error' + 'exit (null, null)' fire (real Node v25.9.0 fires only
    // 'error' — see the helper's docstring), which exercises the `settled`
    // flag's dedupe: reject() must win, resolve(1) must not override it.
    spawnMock.mockImplementation(() => makeFakeEnoentChild('tsx'));
    const { runChild } = await import('./cli.js');
    let caught: NodeJS.ErrnoException | undefined;
    try {
      await runChild('tsx', ['x.ts'], path.join(tmpDir, 'tmpd'));
    } catch (err) {
      caught = err as NodeJS.ErrnoException;
    }
    expect(caught).toBeDefined();
    expect(caught!.code).toBe('ENOENT');
    expect(caught!.path).toBe('tsx');
  });

  it('rmSyncs the whole tmpDir on exit (not just one file)', async () => {
    // Per the Step U12 contract: cleanup uses rmSync(tmpDir, { recursive,
    // force }), so a temp dir containing the compiled .mjs PLUS any
    // accidentally-leaked sibling files gets removed in one shot. Build a
    // tmp dir with two files, run the child, confirm both are gone.
    spawnMock.mockImplementation(() => makeFakeChild({ code: 0 }));
    const ourTmpDir = mkdtempSync(path.join(tmpdir(), 'loom-runchild-test-'));
    writeFileSync(path.join(ourTmpDir, 'pipeline.mjs'), '// stub');
    writeFileSync(path.join(ourTmpDir, 'sidecar.log'), 'noise');
    const { runChild } = await import('./cli.js');
    await runChild('node', [path.join(ourTmpDir, 'pipeline.mjs')], ourTmpDir);
    expect(existsSync(ourTmpDir)).toBe(false);
  });
});

describe('main() run command (workspace + spawn wiring)', () => {
  // Drive `main()` directly so we can stub process.argv + spawn and assert on
  // the workspace-dir + spawn-options surface. The end-to-end subprocess
  // tests below exercise the wrapper formatting; this one exercises the
  // workspace plumbing without paying for a real child process. The fake
  // child exits 0 immediately so runChild resolves cleanly.
  function writeMinimalPipeline(dir: string): void {
    mkdirSync(path.join(dir, '.claude/agents'), { recursive: true });
    writeFileSync(path.join(dir, '.claude/agents/w.md'), '---\nname: w\n---\nbody\n');
    writeFileSync(
      path.join(dir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: w',
        '    input: $x',
        '    produces: out.md',
        '',
      ].join('\n'),
    );
  }

  it('creates loom/runs/<id>/ workspace, spawns child with that as cwd, puts temp .mjs in os.tmpdir(), and cleans up', async () => {
    writeMinimalPipeline(tmpDir);
    writeFileSync(path.join(tmpDir, 'RATE-1.md'), 'ticket body');

    spawnMock.mockImplementation(() => makeFakeChild({ code: 0 }));

    const origArgv = process.argv;
    process.argv = ['node', 'cli.js', 'run', './p.yaml', 'RATE-1.md'];
    try {
      const { main } = await import('./cli.js');
      const code = await main();
      expect(code).toBe(0);
    } finally {
      process.argv = origArgv;
    }

    // Workspace dir under invocation cwd (tmpDir).
    const workspaceDir = path.join(tmpDir, 'loom', 'runs', 'RATE-1');
    expect(existsSync(workspaceDir)).toBe(true);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [runner, args, spawnOpts] = spawnMock.mock.calls[0];
    expect(runner).toMatch(/^(node|tsx)$/);
    expect(spawnOpts).toMatchObject({ cwd: workspaceDir, stdio: 'inherit' });

    // First arg is the temp pipeline path; it must live under os.tmpdir(),
    // NOT under invocation cwd (the whole point of moving the temp out of
    // cwd is to never dirty the user's project root).
    const tempPath = args[0] as string;
    expect(tempPath.startsWith(tmpdir())).toBe(true);
    expect(path.basename(path.dirname(tempPath))).toMatch(/^loom-/);

    // Positional ticket arg got absolutified (because it resolves to an
    // existing file from invocation cwd). After the child chdirs, the
    // relative form would resolve under loom/runs/RATE-1/, not tmpDir.
    expect(args).toContain(path.join(tmpDir, 'RATE-1.md'));

    // The temp directory containing the .mjs is cleaned up on exit; the
    // workspace dir is preserved (it's the user-visible output home).
    expect(existsSync(path.dirname(tempPath))).toBe(false);
    expect(existsSync(workspaceDir)).toBe(true);
  });

  it('honors explicit --id flag over filename inference', async () => {
    writeMinimalPipeline(tmpDir);
    writeFileSync(path.join(tmpDir, 'RATE-1.md'), 'ticket');

    spawnMock.mockImplementation(() => makeFakeChild({ code: 0 }));

    const origArgv = process.argv;
    process.argv = ['node', 'cli.js', 'run', './p.yaml', 'RATE-1.md', '--id', 'override'];
    try {
      const { main } = await import('./cli.js');
      const code = await main();
      expect(code).toBe(0);
    } finally {
      process.argv = origArgv;
    }

    expect(existsSync(path.join(tmpDir, 'loom', 'runs', 'override'))).toBe(true);
    expect(existsSync(path.join(tmpDir, 'loom', 'runs', 'RATE-1'))).toBe(false);

    // --id must not leak into the spawned child's argv as a positional arg —
    // it would shift the pipeline's declared `inputs:` slots by one.
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).not.toContain('--id');
    expect(args).not.toContain('override');
  });

  it('falls back to <pipeline>-<timestamp> when no file args and no flag', async () => {
    writeMinimalPipeline(tmpDir);

    spawnMock.mockImplementation(() => makeFakeChild({ code: 0 }));

    const origArgv = process.argv;
    // Positional arg is a literal string (not a path on disk), so the
    // filename-inference branch misses and the timestamp fallback fires.
    process.argv = ['node', 'cli.js', 'run', './p.yaml', 'literal-ticket-id'];
    try {
      const { main } = await import('./cli.js');
      const code = await main();
      expect(code).toBe(0);
    } finally {
      process.argv = origArgv;
    }

    const runs = path.join(tmpDir, 'loom', 'runs');
    expect(existsSync(runs)).toBe(true);
    // Exactly one workspace dir got created; its name matches `p-<ts>`.
    const entries = readdirSync(runs);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^p-\d+$/);
  });

  it('absolutifies the project layer of AGENT_DIRS in the emitted temp .mjs so personas resolve after chdir', async () => {
    // The compiled pipeline's `AGENT_DIRS` const is emitted as a JSON
    // array literal containing the project layer (relative) and the
    // global layer (tilde-prefixed). The runtime resolves the project
    // layer relative to the child's cwd. After chdir into the workspace,
    // that relative path would point at `<workspace>/.claude/agents/`
    // which doesn't exist. The CLI rewrites entry-0 of the emitted array
    // to an absolute path before writing the temp file so layered
    // resolution finds the project persona; the global entry stays
    // tilde-prefixed and is expanded lazily by the runtime.
    writeMinimalPipeline(tmpDir);
    writeFileSync(path.join(tmpDir, 'RATE-1.md'), 'ticket');

    let capturedTempPath: string | undefined;
    spawnMock.mockImplementation((_runner: string, args: string[]) => {
      capturedTempPath = args[0];
      return makeFakeChild({ code: 0 });
    });

    const origArgv = process.argv;
    process.argv = ['node', 'cli.js', 'run', './p.yaml', 'RATE-1.md'];
    try {
      const { main } = await import('./cli.js');
      await main();
    } finally {
      process.argv = origArgv;
    }

    expect(capturedTempPath).toBeDefined();
    // Read the emit BEFORE rmSync cleanup fires. Spawning is synchronous
    // here (fake child + queueMicrotask 'exit'), so capturing args inside
    // the spawn mock + reading immediately after main() returns is
    // technically racy with cleanup. Pin the assertion by reading the file
    // BEFORE the post-main cleanup ran by snapshotting inside the spawn
    // mock instead.
    //
    // To do that, re-run with a spawn mock that snapshots the content:
    let capturedContent: string | undefined;
    spawnMock.mockReset();
    spawnMock.mockImplementation((_runner: string, args: string[]) => {
      capturedContent = readFileSync(args[0], 'utf-8');
      return makeFakeChild({ code: 0 });
    });
    process.argv = ['node', 'cli.js', 'run', './p.yaml', 'RATE-1.md'];
    try {
      vi.resetModules();
      const { main } = await import('./cli.js');
      await main();
    } finally {
      process.argv = origArgv;
    }

    expect(capturedContent).toBeDefined();
    // AGENT_DIRS array in the emit must have entry-0 as an absolute path
    // (NOT the default relative `.claude/agents/`). Entry-1 stays
    // tilde-prefixed for runtime expansion. Match the assignment line.
    const match = capturedContent!.match(/const AGENT_DIRS = (\[.*?\]);/);
    expect(match).not.toBeNull();
    const agentDirsLiteral = JSON.parse(match![1]) as string[];
    expect(Array.isArray(agentDirsLiteral)).toBe(true);
    expect(agentDirsLiteral.length).toBe(2);
    expect(path.isAbsolute(agentDirsLiteral[0])).toBe(true);
    expect(agentDirsLiteral[0]).toBe(path.join(tmpDir, '.claude/agents/'));
    expect(agentDirsLiteral[1]).toBe('~/.claude/agents/');
  });
});

describe('main() --resume-from validation', () => {
  // Drive main() directly to exercise the cursor-validation chain — flag
  // strip → --id presence → workspace existence → top-level lookup → retry-
  // zone bounds. Each rejection path prints to stderr and returns 1; the
  // happy path threads resumeFrom into compile() and spawns the child.

  function writeMinimalPipeline(dir: string): void {
    mkdirSync(path.join(dir, '.claude/agents'), { recursive: true });
    writeFileSync(path.join(dir, '.claude/agents/writer.md'), '---\nname: writer\n---\nbody\n');
    writeFileSync(path.join(dir, '.claude/agents/rev.md'), '---\nname: rev\n---\nbody\n');
    writeFileSync(
      path.join(dir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: writer',
        '    input: $x',
        '    produces: w.md',
        '    bind: writerOut',
        '  - step: rev',
        '    input: $writerOut',
        '    produces: r.json',
        '    bind: revOut',
        '',
      ].join('\n'),
    );
  }

  function writeRetryZonePipeline(dir: string): void {
    // Step-host retry zone: gate is `rev`, retry_from target is
    // `writerOut`. `mid` sits strictly between → cursor naming midOut
    // must be rejected as cursor-inside-retry-zone.
    mkdirSync(path.join(dir, '.claude/agents'), { recursive: true });
    writeFileSync(path.join(dir, '.claude/agents/writer.md'), '---\nname: writer\n---\nbody\n');
    writeFileSync(path.join(dir, '.claude/agents/mid.md'), '---\nname: mid\n---\nbody\n');
    writeFileSync(path.join(dir, '.claude/agents/rev.md'), '---\nname: rev\n---\nbody\n');
    writeFileSync(path.join(dir, '.claude/agents/follower.md'), '---\nname: follower\n---\nbody\n');
    writeFileSync(
      path.join(dir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: writer',
        '    input: $x',
        '    produces: w.md',
        '    bind: writerOut',
        '  - step: mid',
        '    input: $writerOut',
        '    produces: m.md',
        '    bind: midOut',
        '  - step: rev',
        '    input: $midOut',
        '    produces: r.json',
        '    bind: revOut',
        '    on_fail:',
        '      verdict_field: status',
        '      retry_from: writerOut',
        '      revise_with:',
        '        prompt: Retry.',
        '  - step: follower',
        '    input: $revOut',
        '    produces: f.md',
        '    bind: followerOut',
        '',
      ].join('\n'),
    );
  }

  // Each test below runs main() with a stubbed process.argv. Console.error
  // is spied so the rejection message can be asserted without polluting
  // test output.

  it('rejects --resume-from without --id', async () => {
    writeMinimalPipeline(tmpDir);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const origArgv = process.argv;
    process.argv = ['node', 'cli.js', 'run', './p.yaml', '--resume-from', 'revOut'];
    let code: number | undefined;
    try {
      const { main } = await import('./cli.js');
      code = await main();
    } finally {
      process.argv = origArgv;
    }
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls[0][0] as string).toMatch(/--resume-from requires --id/);
    expect(spawnMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('rejects --resume-from with --id pointing at a non-existent workspace', async () => {
    writeMinimalPipeline(tmpDir);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const origArgv = process.argv;
    process.argv = [
      'node',
      'cli.js',
      'run',
      './p.yaml',
      '--id',
      'NOWHERE',
      '--resume-from',
      'revOut',
    ];
    let code: number | undefined;
    try {
      const { main } = await import('./cli.js');
      code = await main();
    } finally {
      process.argv = origArgv;
    }
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls[0][0] as string).toMatch(
      /requires the workspace dir to already exist/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('rejects --resume-from with an unknown cursor; lists available top-level binds', async () => {
    writeMinimalPipeline(tmpDir);
    mkdirSync(path.join(tmpDir, 'loom', 'runs', 'RATE-1'), { recursive: true });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const origArgv = process.argv;
    process.argv = [
      'node',
      'cli.js',
      'run',
      './p.yaml',
      '--id',
      'RATE-1',
      '--resume-from',
      'noSuchBind',
    ];
    let code: number | undefined;
    try {
      const { main } = await import('./cli.js');
      code = await main();
    } finally {
      process.argv = origArgv;
    }
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls[0][0] as string).toMatch(
      /cursor 'noSuchBind' does not name any bind.*Available top-level binds:.*writerOut.*revOut/s,
    );
    expect(spawnMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('rejects --resume-from naming a nested bind (review_loop subflow)', async () => {
    mkdirSync(path.join(tmpDir, '.claude/agents'), { recursive: true });
    writeFileSync(path.join(tmpDir, '.claude/agents/writer.md'), '---\nname: writer\n---\nbody\n');
    writeFileSync(path.join(tmpDir, '.claude/agents/inner.md'), '---\nname: inner\n---\nbody\n');
    writeFileSync(
      path.join(tmpDir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - review_loop:',
        '      writer: writer',
        '      input: $x',
        '      writer_produces: w.md',
        '      bind: rlOut',
        '      reviewer:',
        '        - step: inner',
        '          input: $rlOut',
        '          produces: i.json',
        '          bind: innerBind',
        '        - aggregate:',
        '            inputs: { i: $innerBind }',
        '            verdict_field: status',
        '',
      ].join('\n'),
    );
    mkdirSync(path.join(tmpDir, 'loom', 'runs', 'RATE-1'), { recursive: true });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const origArgv = process.argv;
    process.argv = [
      'node',
      'cli.js',
      'run',
      './p.yaml',
      '--id',
      'RATE-1',
      '--resume-from',
      'innerBind',
    ];
    let code: number | undefined;
    try {
      const { main } = await import('./cli.js');
      code = await main();
    } finally {
      process.argv = origArgv;
    }
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls[0][0] as string).toMatch(
      /cursor must name a top-level bind; 'innerBind' is declared inside review_loop reviewer subflow/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('accepts --resume-from naming a hoisted parallel-child bind', async () => {
    // Parallel-child binds hoist into the outer scope, so the cursor
    // accepts on the hoisted name. The cursor resolves to the enclosing
    // parallel's index — main() doesn't directly observe that, but the
    // run reaches compile() and the spawn fires, locking in the happy
    // path.
    mkdirSync(path.join(tmpDir, '.claude/agents'), { recursive: true });
    writeFileSync(
      path.join(tmpDir, '.claude/agents/pre-step.md'),
      '---\nname: pre-step\n---\nbody\n',
    );
    writeFileSync(
      path.join(tmpDir, '.claude/agents/child-a.md'),
      '---\nname: child-a\n---\nbody\n',
    );
    writeFileSync(
      path.join(tmpDir, '.claude/agents/child-b.md'),
      '---\nname: child-b\n---\nbody\n',
    );
    writeFileSync(
      path.join(tmpDir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: pre-step',
        '    input: $x',
        '    produces: pre.md',
        '    bind: preOut',
        '  - parallel:',
        '      - step: child-a',
        '        input: $preOut',
        '        produces: a.md',
        '        bind: aOut',
        '      - step: child-b',
        '        input: $preOut',
        '        produces: b.md',
        '        bind: bOut',
        '    bind: parOut',
        '',
      ].join('\n'),
    );
    mkdirSync(path.join(tmpDir, 'loom', 'runs', 'RATE-1'), { recursive: true });
    spawnMock.mockImplementation(() => makeFakeChild({ code: 0 }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const origArgv = process.argv;
    process.argv = ['node', 'cli.js', 'run', './p.yaml', '--id', 'RATE-1', '--resume-from', 'aOut'];
    try {
      const { main } = await import('./cli.js');
      const code = await main();
      expect(code).toBe(0);
    } finally {
      process.argv = origArgv;
      errSpy.mockRestore();
    }
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('rejects --resume-from cursor inside a step-host retry zone (strictly between target and gate)', async () => {
    writeRetryZonePipeline(tmpDir);
    mkdirSync(path.join(tmpDir, 'loom', 'runs', 'RATE-1'), { recursive: true });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const origArgv = process.argv;
    process.argv = [
      'node',
      'cli.js',
      'run',
      './p.yaml',
      '--id',
      'RATE-1',
      '--resume-from',
      'midOut',
    ];
    let code: number | undefined;
    try {
      const { main } = await import('./cli.js');
      code = await main();
    } finally {
      process.argv = origArgv;
    }
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls[0][0] as string).toMatch(
      /cursor 'midOut' falls inside a retry zone.*between 'writerOut' and the step 'rev' gate/s,
    );
    expect(spawnMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('rejects --resume-from cursor inside an aggregate-host retry zone', async () => {
    mkdirSync(path.join(tmpDir, '.claude/agents'), { recursive: true });
    writeFileSync(path.join(tmpDir, '.claude/agents/writer.md'), '---\nname: writer\n---\nbody\n');
    writeFileSync(path.join(tmpDir, '.claude/agents/mid.md'), '---\nname: mid\n---\nbody\n');
    writeFileSync(
      path.join(tmpDir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: writer',
        '    input: $x',
        '    produces: w.md',
        '    bind: writerOut',
        '  - step: mid',
        '    input: $writerOut',
        '    produces: m.md',
        '    bind: midOut',
        '  - aggregate:',
        '      inputs: { m: $midOut }',
        '      verdict_field: status',
        '      bind: aggOut',
        '      retry_from: writerOut',
        '      revise_with:',
        '        prompt: Retry.',
        '',
      ].join('\n'),
    );
    mkdirSync(path.join(tmpDir, 'loom', 'runs', 'RATE-1'), { recursive: true });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const origArgv = process.argv;
    process.argv = [
      'node',
      'cli.js',
      'run',
      './p.yaml',
      '--id',
      'RATE-1',
      '--resume-from',
      'midOut',
    ];
    let code: number | undefined;
    try {
      const { main } = await import('./cli.js');
      code = await main();
    } finally {
      process.argv = origArgv;
    }
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls[0][0] as string).toMatch(
      /cursor 'midOut' falls inside a retry zone.*aggregate \(bind 'aggOut'\) gate/s,
    );
    expect(spawnMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('accepts --resume-from naming the retry_from target itself (boundary: cursor AT retryFromIdx)', async () => {
    // The retry_from target is itself the zone's resumption anchor, so
    // naming it as the cursor is structurally equivalent to resuming where
    // the retry would re-start.
    writeRetryZonePipeline(tmpDir);
    mkdirSync(path.join(tmpDir, 'loom', 'runs', 'RATE-1'), { recursive: true });
    spawnMock.mockImplementation(() => makeFakeChild({ code: 0 }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const origArgv = process.argv;
    process.argv = [
      'node',
      'cli.js',
      'run',
      './p.yaml',
      '--id',
      'RATE-1',
      '--resume-from',
      'writerOut',
    ];
    try {
      const { main } = await import('./cli.js');
      const code = await main();
      expect(code).toBe(0);
    } finally {
      process.argv = origArgv;
      errSpy.mockRestore();
    }
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('rejects --resume-from naming the gate itself (boundary: cursor AT gateIdx)', async () => {
    // The gate IS the last member of its zone; the pre-cursor rewrite
    // would turn intermediate-zone members into `const` literals while
    // the pre-pass implies `let`. Reject.
    writeRetryZonePipeline(tmpDir);
    mkdirSync(path.join(tmpDir, 'loom', 'runs', 'RATE-1'), { recursive: true });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const origArgv = process.argv;
    process.argv = [
      'node',
      'cli.js',
      'run',
      './p.yaml',
      '--id',
      'RATE-1',
      '--resume-from',
      'revOut',
    ];
    let code: number | undefined;
    try {
      const { main } = await import('./cli.js');
      code = await main();
    } finally {
      process.argv = origArgv;
    }
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls[0][0] as string).toMatch(/cursor 'revOut' falls inside a retry zone/);
    expect(spawnMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('rejects --resume-from on loom compile', async () => {
    writeMinimalPipeline(tmpDir);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const origArgv = process.argv;
    process.argv = ['node', 'cli.js', 'compile', './p.yaml', 'out.ts', '--resume-from', 'revOut'];
    let code: number | undefined;
    try {
      const { main } = await import('./cli.js');
      code = await main();
    } finally {
      process.argv = origArgv;
    }
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls[0][0] as string).toMatch(/--resume-from is a 'loom run'-only flag/);
    errSpy.mockRestore();
  });

  it('happy path: valid cursor + existing workspace dir threads through to spawn', async () => {
    writeMinimalPipeline(tmpDir);
    mkdirSync(path.join(tmpDir, 'loom', 'runs', 'RATE-1'), { recursive: true });
    spawnMock.mockImplementation(() => makeFakeChild({ code: 0 }));
    const origArgv = process.argv;
    process.argv = [
      'node',
      'cli.js',
      'run',
      './p.yaml',
      '--id',
      'RATE-1',
      '--resume-from',
      'revOut',
    ];
    try {
      const { main } = await import('./cli.js');
      const code = await main();
      expect(code).toBe(0);
    } finally {
      process.argv = origArgv;
    }
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // --resume-from + its value must NOT leak into the spawned child's argv.
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).not.toContain('--resume-from');
    expect(args).not.toContain('revOut');
  });

  it('rejects --resume-from naming a bind inside a top-level branch arm', async () => {
    // Symmetric with the review_loop subflow test above. A branch arm's
    // interior bind is nested by enumerateTopLevelBinds' walker; the
    // outer-scope lookup misses; the rejection message names the
    // container kind ('branch') so the user can distinguish "typo" from
    // "deferred nested-cursor capability."
    mkdirSync(path.join(tmpDir, '.claude/agents'), { recursive: true });
    writeFileSync(
      path.join(tmpDir, '.claude/agents/pre-step.md'),
      '---\nname: pre-step\n---\nbody\n',
    );
    writeFileSync(path.join(tmpDir, '.claude/agents/inner.md'), '---\nname: inner\n---\nbody\n');
    writeFileSync(
      path.join(tmpDir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: pre-step',
        '    input: $x',
        '    produces: pre.md',
        '    bind: preOut',
        '  - branch:',
        '      when: always',
        '      then:',
        '        - step: inner',
        '          input: $preOut',
        '          produces: i.md',
        '          bind: armInternalBind',
        '      bind: branchOut',
        '',
      ].join('\n'),
    );
    mkdirSync(path.join(tmpDir, 'loom', 'runs', 'RATE-1'), { recursive: true });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const origArgv = process.argv;
    process.argv = [
      'node',
      'cli.js',
      'run',
      './p.yaml',
      '--id',
      'RATE-1',
      '--resume-from',
      'armInternalBind',
    ];
    let code: number | undefined;
    try {
      const { main } = await import('./cli.js');
      code = await main();
    } finally {
      process.argv = origArgv;
    }
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls[0][0] as string).toMatch(
      /cursor must name a top-level bind; 'armInternalBind' is declared inside branch/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('accepts --resume-from naming a top-level aggregate (non-anchored cursor)', async () => {
    // A non-anchored cursor (the aggregate's verdict-string bind, not a
    // path) is a valid cursor target. Verify the structural-validation
    // chain accepts it and spawn proceeds — the runtime decides what the
    // aggregate actually does, but cli.ts's job ends at "cursor accepted,
    // --resume-from threaded into compile, spawn fires."
    //
    // The aggregate is placed last in the flow so no downstream step
    // $refs its non-anchored bind (checkConsume rejects $refs to
    // non-file-bound producers). This matches the realistic shape: the
    // aggregate's verdict either gates a retry zone (Draft 5 shape, not
    // exercised here) or is the terminal "pass/fail" of the pipeline.
    mkdirSync(path.join(tmpDir, '.claude/agents'), { recursive: true });
    writeFileSync(path.join(tmpDir, '.claude/agents/writer.md'), '---\nname: writer\n---\nbody\n');
    writeFileSync(path.join(tmpDir, '.claude/agents/rev.md'), '---\nname: rev\n---\nbody\n');
    writeFileSync(
      path.join(tmpDir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: writer',
        '    input: $x',
        '    produces: w.md',
        '    bind: writerOut',
        '  - step: rev',
        '    input: $writerOut',
        '    produces: r.json',
        '    bind: revOut',
        '  - aggregate:',
        '      inputs: { r: $revOut }',
        '      verdict_field: status',
        '      bind: aggOut',
        '',
      ].join('\n'),
    );
    mkdirSync(path.join(tmpDir, 'loom', 'runs', 'RATE-1'), { recursive: true });
    spawnMock.mockImplementation(() => makeFakeChild({ code: 0 }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const origArgv = process.argv;
    process.argv = [
      'node',
      'cli.js',
      'run',
      './p.yaml',
      '--id',
      'RATE-1',
      '--resume-from',
      'aggOut',
    ];
    try {
      const { main } = await import('./cli.js');
      const code = await main();
      expect(code).toBe(0);
    } finally {
      process.argv = origArgv;
      errSpy.mockRestore();
    }
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).not.toContain('--resume-from');
    expect(args).not.toContain('aggOut');
  });

  it('accepts --resume-from naming a top-level parallel block', async () => {
    // Naming the outer parallel's bind (NOT an internal child) is the
    // supported shape — cli accepts it and threads through to spawn. The
    // parallel itself is the cursor and runs normally; internal child
    // binds are rejected separately as nested-cursor by the existing
    // "rejects nested cursor" tests above.
    mkdirSync(path.join(tmpDir, '.claude/agents'), { recursive: true });
    writeFileSync(path.join(tmpDir, '.claude/agents/writer.md'), '---\nname: writer\n---\nbody\n');
    writeFileSync(
      path.join(tmpDir, '.claude/agents/child-a.md'),
      '---\nname: child-a\n---\nbody\n',
    );
    writeFileSync(
      path.join(tmpDir, '.claude/agents/child-b.md'),
      '---\nname: child-b\n---\nbody\n',
    );
    writeFileSync(
      path.join(tmpDir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: writer',
        '    input: $x',
        '    produces: w.md',
        '    bind: writerOut',
        '  - parallel:',
        '      - step: child-a',
        '        input: $writerOut',
        '        produces: a.md',
        '        bind: aOut',
        '      - step: child-b',
        '        input: $writerOut',
        '        produces: b.md',
        '        bind: bOut',
        '    bind: parOut',
        '',
      ].join('\n'),
    );
    mkdirSync(path.join(tmpDir, 'loom', 'runs', 'RATE-1'), { recursive: true });
    spawnMock.mockImplementation(() => makeFakeChild({ code: 0 }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const origArgv = process.argv;
    process.argv = [
      'node',
      'cli.js',
      'run',
      './p.yaml',
      '--id',
      'RATE-1',
      '--resume-from',
      'parOut',
    ];
    try {
      const { main } = await import('./cli.js');
      const code = await main();
      expect(code).toBe(0);
    } finally {
      process.argv = origArgv;
      errSpy.mockRestore();
    }
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).not.toContain('--resume-from');
    expect(args).not.toContain('parOut');
  });

  it('accepts --resume-from naming a top-level branch block', async () => {
    // Per spec observable-behavior table: cursor may name any kind of
    // top-level item that carries a `bind:`. Mirrors the parallel-block
    // acceptance above; branch's bind lives INSIDE the branch: block
    // (different shape from parallel) so this exercises the
    // getBindNameFromFlowItem branch-path explicitly.
    mkdirSync(path.join(tmpDir, '.claude/agents'), { recursive: true });
    writeFileSync(path.join(tmpDir, '.claude/agents/writer.md'), '---\nname: writer\n---\nbody\n');
    writeFileSync(
      path.join(tmpDir, '.claude/agents/then-step.md'),
      '---\nname: then-step\n---\nbody\n',
    );
    writeFileSync(
      path.join(tmpDir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: writer',
        '    input: $x',
        '    produces: w.md',
        '    bind: writerOut',
        '  - branch:',
        '      when: always',
        '      then:',
        '        - step: then-step',
        '          input: $writerOut',
        '          produces: t.md',
        '          bind: thenOut',
        '      bind: brOut',
        '',
      ].join('\n'),
    );
    mkdirSync(path.join(tmpDir, 'loom', 'runs', 'RATE-1'), { recursive: true });
    spawnMock.mockImplementation(() => makeFakeChild({ code: 0 }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const origArgv = process.argv;
    process.argv = [
      'node',
      'cli.js',
      'run',
      './p.yaml',
      '--id',
      'RATE-1',
      '--resume-from',
      'brOut',
    ];
    try {
      const { main } = await import('./cli.js');
      const code = await main();
      expect(code).toBe(0);
    } finally {
      process.argv = origArgv;
      errSpy.mockRestore();
    }
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).not.toContain('--resume-from');
    expect(args).not.toContain('brOut');
  });

  it('accepts --resume-from naming the FIRST top-level item (empty pre-cursor set)', async () => {
    // Per spec observable-behavior table: "the pre-cursor set is empty;
    // the rewrite is a no-op; every top-level item (including the cursor)
    // runs normally." Edge case for the pre-cursor walk — without the
    // empty-set handling, an off-by-one could trip here.
    writeMinimalPipeline(tmpDir);
    mkdirSync(path.join(tmpDir, 'loom', 'runs', 'RATE-1'), { recursive: true });
    spawnMock.mockImplementation(() => makeFakeChild({ code: 0 }));
    const origArgv = process.argv;
    process.argv = [
      'node',
      'cli.js',
      'run',
      './p.yaml',
      '--id',
      'RATE-1',
      '--resume-from',
      'writerOut',
    ];
    try {
      const { main } = await import('./cli.js');
      const code = await main();
      expect(code).toBe(0);
    } finally {
      process.argv = origArgv;
    }
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).not.toContain('--resume-from');
    expect(args).not.toContain('writerOut');
  });

  it('rejects --resume-from naming an agent name that is not a bind', async () => {
    // The cursor is matched against bind names, not agent (persona)
    // names. A step with NO bind: field contributes nothing to the
    // top-level bind map even though its agent name is visible in the
    // YAML. Naming the agent ('writer') as the cursor must fall into
    // the "unknown bind" path and surface available top-level binds
    // (which here are the OTHER step's bind, not the agent name).
    mkdirSync(path.join(tmpDir, '.claude/agents'), { recursive: true });
    writeFileSync(path.join(tmpDir, '.claude/agents/writer.md'), '---\nname: writer\n---\nbody\n');
    writeFileSync(path.join(tmpDir, '.claude/agents/rev.md'), '---\nname: rev\n---\nbody\n');
    writeFileSync(
      path.join(tmpDir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        // First step intentionally has NO bind: — its agent name is
        // 'writer' but no bind by that name is declared.
        '  - step: writer',
        '    input: $x',
        '    produces: w.md',
        '  - step: rev',
        '    input: w.md',
        '    produces: r.json',
        '    bind: revOut',
        '',
      ].join('\n'),
    );
    mkdirSync(path.join(tmpDir, 'loom', 'runs', 'RATE-1'), { recursive: true });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const origArgv = process.argv;
    process.argv = [
      'node',
      'cli.js',
      'run',
      './p.yaml',
      '--id',
      'RATE-1',
      '--resume-from',
      'writer',
    ];
    let code: number | undefined;
    try {
      const { main } = await import('./cli.js');
      code = await main();
    } finally {
      process.argv = origArgv;
    }
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    const msg = errSpy.mock.calls[0][0] as string;
    expect(msg).toMatch(/cursor 'writer' does not name any bind/);
    // Available list names the bind ('revOut'), not the agent ('writer').
    expect(msg).toMatch(/Available top-level binds:.*'revOut'/);
    expect(msg).not.toMatch(/Available top-level binds:[^.]*'writer'/);
    expect(spawnMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('happy path: --save-logs combined with --resume-from threads both through', async () => {
    // Flag composition: --save-logs sets LOOM_SAVE_LOGS=1 in the spawned
    // child's env; --resume-from threads the cursor through to compile().
    // The two strip layers run consecutively (stripSaveLogsFlag, then
    // stripResumeFromFlag) so a regression that swapped them or coupled
    // their handling could silently drop one signal. Verify both make it
    // through: env carries LOOM_SAVE_LOGS=1 AND argv is stripped of
    // --resume-from/value.
    writeMinimalPipeline(tmpDir);
    mkdirSync(path.join(tmpDir, 'loom', 'runs', 'RATE-1'), { recursive: true });
    spawnMock.mockImplementation(() => makeFakeChild({ code: 0 }));
    const origArgv = process.argv;
    process.argv = [
      'node',
      'cli.js',
      'run',
      './p.yaml',
      '--save-logs',
      '--resume-from',
      'revOut',
      '--id',
      'RATE-1',
    ];
    try {
      const { main } = await import('./cli.js');
      const code = await main();
      expect(code).toBe(0);
    } finally {
      process.argv = origArgv;
    }
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args, spawnOpts] = spawnMock.mock.calls[0];
    // --resume-from + value stripped from spawned argv.
    expect(args).not.toContain('--resume-from');
    expect(args).not.toContain('revOut');
    // --save-logs stripped too (it's an env signal, not a positional).
    expect(args).not.toContain('--save-logs');
    // --id stripped (workspace dir was resolved from it).
    expect(args).not.toContain('--id');
    expect(args).not.toContain('RATE-1');
    // LOOM_SAVE_LOGS=1 threaded into the child's env (proves --save-logs
    // wasn't silently masked by --resume-from).
    expect(spawnOpts.env.LOOM_SAVE_LOGS).toBe('1');
  });

  it('--id pointing at a file (not a directory) trips mkdirSync EEXIST — documented known limitation', async () => {
    // The CLI's workspace-dir-exists check uses existsSync, which returns
    // true for files AND directories. A user who passes --id <name> where
    // loom/runs/<name> happens to be a regular file (e.g., a stray file
    // dropped into loom/runs/) passes the existsSync precondition but
    // then trips EEXIST on mkdirSync(workspaceDir, { recursive: true })
    // because mkdir refuses to create a dir on top of a regular file.
    //
    // The current behavior is "the run aborts with a confusing
    // ENOENT-like EEXIST stack rather than a clean precondition error."
    // Hardening this would require either statSync().isDirectory() in
    // the resume precondition OR catching EEXIST around mkdirSync; both
    // are currently out of scope per the spec's "Wrong-shape input
    // paths" out-of-scope entry. This test documents the limitation so
    // a future hardening commit's intent is clear (the test would flip
    // from "EEXIST surfaces" to "loud-fail precondition" without
    // exercising new behavior elsewhere).
    writeMinimalPipeline(tmpDir);
    // Create a file (NOT a dir) at the workspace path the resume
    // precondition will look up.
    mkdirSync(path.join(tmpDir, 'loom', 'runs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'loom', 'runs', 'FAKE-FILE'), 'not a dir');
    // existsSync returns true for the file path, so resume precondition
    // accepts. The run then trips on mkdirSync.
    const origArgv = process.argv;
    process.argv = [
      'node',
      'cli.js',
      'run',
      './p.yaml',
      '--id',
      'FAKE-FILE',
      '--resume-from',
      'writerOut',
    ];
    let caught: unknown;
    try {
      const { main } = await import('./cli.js');
      await main();
    } catch (err) {
      caught = err;
    } finally {
      process.argv = origArgv;
    }
    // The current code path surfaces an EEXIST from mkdirSync. Lock the
    // shape (NodeJS.ErrnoException.code === 'EEXIST') rather than the
    // message text so a future Node version's wording change doesn't
    // flap. spawn must NOT have fired — the failure happens before the
    // child is launched.
    expect(caught).toBeDefined();
    expect((caught as NodeJS.ErrnoException).code).toBe('EEXIST');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('sweepOrphanTmpDirs', () => {
  // The sweep runs at the top of `loom run` against `os.tmpdir()` to reclaim
  // orphan `loom-*` dirs older than 24h. macOS/Linux ship periodic cleaners
  // that would eventually reclaim these; Windows does not, so without this,
  // hard crashes there would accumulate orphans forever.
  it('rms loom-* dirs older than 24h; preserves recent ones; leaves non-loom dirs alone', async () => {
    // Build three controlled dirs in the real os.tmpdir(): an old loom-*
    // dir, a recent loom-* dir, and a non-loom-* dir. The sweep should
    // delete the old and preserve the other two.
    const realTmp = realpathSync(tmpdir());
    const oldDir = mkdtempSync(path.join(realTmp, 'loom-sweep-old-'));
    const recentDir = mkdtempSync(path.join(realTmp, 'loom-sweep-recent-'));
    // Non-loom prefix — sweep must skip these even when ancient.
    const nonLoomDir = mkdtempSync(path.join(realTmp, 'something-else-'));

    // Backdate oldDir's mtime to 25h ago.
    const past = Date.now() - 25 * 60 * 60 * 1000;
    utimesSync(oldDir, past / 1000, past / 1000);

    try {
      const { sweepOrphanTmpDirs } = await import('./cli.js');
      sweepOrphanTmpDirs();
      expect(existsSync(oldDir)).toBe(false);
      expect(existsSync(recentDir)).toBe(true);
      expect(existsSync(nonLoomDir)).toBe(true);
    } finally {
      // Cleanup leftovers — defensive even though the test should have
      // removed oldDir already.
      rmSync(oldDir, { recursive: true, force: true });
      rmSync(recentDir, { recursive: true, force: true });
      rmSync(nonLoomDir, { recursive: true, force: true });
    }
  });
});

describe('absolutifyAgentDirsInEmit', () => {
  // The CLI rewrites the emitted `const AGENT_DIRS = [...]` line so the
  // project layer (index 0) is absolute. The runtime resolves entries
  // against the child's cwd, and the child runs from `loom/runs/<id>/`
  // where no `.claude/` directory exists. The global layer (tilde-prefixed)
  // is expanded lazily by the runtime's expandHome.
  it('absolutifies the project layer (index 0) against invocation cwd', async () => {
    const { absolutifyAgentDirsInEmit } = await import('./cli.js');
    const emit = [
      '// AUTO-GENERATED',
      'import {} from "x";',
      '',
      'const CLI = "claude";',
      'const AGENT_DIRS = [".claude/agents/","~/.claude/agents/"];',
      'const DEFAULT_EXTRA_ARGS = [];',
    ].join('\n');
    const out = absolutifyAgentDirsInEmit(emit, '/some/cwd');
    expect(out).toContain('const AGENT_DIRS = ["/some/cwd/.claude/agents/","~/.claude/agents/"];');
  });

  it('leaves the global layer (index 1) tilde-prefixed unchanged', async () => {
    const { absolutifyAgentDirsInEmit } = await import('./cli.js');
    const emit = 'const AGENT_DIRS = [".claude/agents/","~/.claude/agents/"];';
    const out = absolutifyAgentDirsInEmit(emit, '/some/cwd');
    const match = out.match(/const AGENT_DIRS = (\[.*?\]);/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]) as string[];
    expect(parsed[1]).toBe('~/.claude/agents/');
  });

  it('preserves an absolute project layer unchanged', async () => {
    const { absolutifyAgentDirsInEmit } = await import('./cli.js');
    const emit = 'const AGENT_DIRS = ["/abs/path/to/agents/","~/.claude/agents/"];';
    expect(absolutifyAgentDirsInEmit(emit, '/some/cwd')).toBe(emit);
  });

  it('preserves a ~/-prefixed project layer unchanged (runtime handles via expandHome)', async () => {
    const { absolutifyAgentDirsInEmit } = await import('./cli.js');
    const emit = 'const AGENT_DIRS = ["~/.claude/agents/","~/.claude/agents/"];';
    expect(absolutifyAgentDirsInEmit(emit, '/some/cwd')).toBe(emit);
  });

  it('passes through unchanged when the AGENT_DIRS line is not present', async () => {
    // Defensive: a `compile/index.ts` refactor that renames AGENT_DIRS must
    // fail in tests (the workspace test asserts the rewritten content + the
    // loom-run trip-wire asserts post-rewrite shape) rather than silently
    // bypass the rewrite path here.
    const { absolutifyAgentDirsInEmit } = await import('./cli.js');
    const emit = 'const SOMETHING_ELSE = [".claude/agents/"];';
    expect(absolutifyAgentDirsInEmit(emit, '/some/cwd')).toBe(emit);
  });
});

describe('top-level error wrapper (end-to-end via subprocess)', () => {
  // The wrapper at the bottom of cli.ts is a fire-and-forget side effect at
  // module load (guarded by an entry-point check so test imports don't
  // trigger it). We can't unit-test the wrapper's inline lambda directly
  // without extracting it; instead, exercise it end-to-end via a real
  // child process and assert on stderr + exit code.
  let realSpawnSync: typeof import('child_process').spawnSync;
  let repoRoot: string;

  beforeEach(async () => {
    const real = await vi.importActual<typeof import('child_process')>('child_process');
    realSpawnSync = real.spawnSync;
    // tmpDir is the cwd; cli.ts lives in the repo root. Compute the absolute
    // path to src/cli.ts via the test file's own URL so the subprocess can
    // find the entry point regardless of where the test is invoked.
    repoRoot = path.resolve(origCwd);
  });

  /** Invoke cli.ts as a child process under the tsx loader (so we hit the
   *  dev-mode path: cli.ts file extension → runner='tsx'). All paths are
   *  absolute so the test does not depend on the child's PATH for resolving
   *  node, tsx, or the cli script itself — only the inner spawn() in
   *  runChild needs PATH, which the missing-binary tests deliberately
   *  override. */
  function runCli(args: string[], env: Record<string, string | undefined> = {}) {
    return realSpawnSync(
      process.execPath,
      [
        '--import',
        path.join(repoRoot, 'node_modules/tsx/dist/loader.mjs'),
        path.join(repoRoot, 'src/cli.ts'),
        ...args,
      ],
      {
        cwd: tmpDir,
        encoding: 'utf-8',
        env: { ...process.env, ...env },
      },
    );
  }

  it('formats ZodError as a bulleted issue list', () => {
    // A YAML that passes YAML.parse but fails the Pipeline schema (missing
    // required `cli` and `flow` fields) triggers a ZodError from `compile()`.
    writeFileSync(path.join(tmpDir, 'bad.yaml'), 'pipeline: missing-required-fields\n');
    const result = runCli(['compile', './bad.yaml', './out.ts']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Pipeline schema error:');
    // The bullet format `  - <path>: <message>` is what the wrapper renders
    // for each ZodIssue. Verify the shape rather than a specific message.
    expect(result.stderr).toMatch(/ {2}- \w+: /);
    expect(result.stderr).toContain('(set LOOM_DEBUG=1 to see the full stack)');
  });

  /** Build a minimal-but-compilable pipeline fixture in tmpDir so the CLI can
   *  reach the runChild spawn step without short-circuiting on a ZodError or
   *  a missing-persona-file compile error. The agent file body is irrelevant
   *  for the spawn-ENOENT path. */
  function writeRunnablePipeline(): void {
    mkdirSync(path.join(tmpDir, '.claude/agents'), { recursive: true });
    writeFileSync(path.join(tmpDir, '.claude/agents/w.md'), '---\nname: w\n---\nbody\n');
    writeFileSync(
      path.join(tmpDir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: w',
        '    input: $x',
        '    produces: out.md',
        '',
      ].join('\n'),
    );
  }

  it('formats spawn-ENOENT with install hint when missing = tsx', () => {
    // Run cli.ts under the tsx loader so cli.ts' runningTypeScriptSource
    // check (file extension === '.ts') picks runner='tsx'. PATH='' in the
    // child env makes the inner spawn('tsx', ...) fail with ENOENT,
    // hitting the tsx-specific install-hint branch in the wrapper.
    writeRunnablePipeline();
    const tsxLoader = path.join(repoRoot, 'node_modules/tsx/dist/loader.mjs');
    const result = realSpawnSync(
      process.execPath,
      ['--import', tsxLoader, path.join(repoRoot, 'src/cli.ts'), 'run', './p.yaml'],
      { cwd: tmpDir, encoding: 'utf-8', env: { ...process.env, PATH: '' } },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('command not found on PATH: tsx');
    expect(result.stderr).toContain('npm install -D tsx');
    expect(result.stderr).toContain('(set LOOM_DEBUG=1 to see the full stack)');
  });

  it('formats spawn-ENOENT with PATH hint when missing = node', () => {
    // LOOM_FORCE_RUNNER=node forces cli.ts to pick runner='node' regardless
    // of its file-extension auto-detect, so we can invoke src/cli.ts via
    // tsx (instead of the compiled output) and still exercise the
    // node-runner branch. PATH='' in the child env makes the inner
    // spawn('node', ...) fail with ENOENT, hitting the node-specific
    // PATH-hint branch. We invoke the parent node via process.execPath
    // (absolute) so the empty PATH only affects the cli's own child.
    // Avoiding the compiled output here is deliberate: any test that
    // depends on a fresh build is one stale rebuild away from silently
    // exercising the wrong code path.
    writeRunnablePipeline();
    const tsxLoader = path.join(repoRoot, 'node_modules/tsx/dist/loader.mjs');
    const result = realSpawnSync(
      process.execPath,
      ['--import', tsxLoader, path.join(repoRoot, 'src/cli.ts'), 'run', './p.yaml'],
      {
        cwd: tmpDir,
        encoding: 'utf-8',
        env: { ...process.env, PATH: '', LOOM_FORCE_RUNNER: 'node' },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('command not found on PATH: node');
    expect(result.stderr).toContain('Ensure Node.js is on PATH.');
  });

  it("LOOM_FORCE_RUNNER='tsx' forces the tsx-runner branch on a working compile", () => {
    // Symmetric coverage for the LOOM_FORCE_RUNNER='node' test above: both
    // valid values must thread through module-load without throwing. With
    // 'tsx' set, cli.ts picks runningTypeScriptSource=true and the temp
    // file (in `run`) would get a `.ts` suffix with runner 'tsx'. We
    // exercise `compile` rather than `run` here — the cli's module-load
    // branch is what we're testing, and `compile` succeeds without
    // spawning a child (which would otherwise require a real agent on
    // PATH). The 'node' test above does exercise the spawn branch by
    // forcing PATH='' and asserting on the friendly ENOENT message; doing
    // the same for 'tsx' would duplicate the existing tsx-ENOENT test.
    writeRunnablePipeline();
    const tsxLoader = path.join(repoRoot, 'node_modules/tsx/dist/loader.mjs');
    const compileResult = realSpawnSync(
      process.execPath,
      ['--import', tsxLoader, path.join(repoRoot, 'src/cli.ts'), 'compile', './p.yaml', './out.ts'],
      {
        cwd: tmpDir,
        encoding: 'utf-8',
        env: { ...process.env, LOOM_FORCE_RUNNER: 'tsx' },
      },
    );
    expect(compileResult.status).toBe(0);
    expect(compileResult.stdout).toContain('Compiled');
    // Confirm the compiled emit is present and looks like generated code.
    const compiled = readFileSync(path.join(tmpDir, 'out.ts'), 'utf-8');
    expect(compiled).toContain('AUTO-GENERATED');
    expect(compiled).toContain('from "agenticloom/runtime"');
  });

  it('compile command emits .mermaid alongside the .ts output', () => {
    writeRunnablePipeline();
    const result = runCli(['compile', './p.yaml', './out.ts']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Compiled');
    expect(result.stdout).toContain('out.mermaid');
    // Both files exist in tmpDir (cwd of the spawned cli).
    expect(existsSync(path.join(tmpDir, 'out.ts'))).toBe(true);
    expect(existsSync(path.join(tmpDir, 'out.mermaid'))).toBe(true);
    const mermaid = readFileSync(path.join(tmpDir, 'out.mermaid'), 'utf-8');
    expect(mermaid.startsWith('flowchart TD\n')).toBe(true);
    expect(mermaid).toContain('n'); // contains node IDs
  });

  it('compile command derives the .mermaid path from .mjs output', () => {
    writeRunnablePipeline();
    const result = runCli(['compile', './p.yaml', './out.mjs']);
    expect(result.status).toBe(0);
    expect(existsSync(path.join(tmpDir, 'out.mjs'))).toBe(true);
    expect(existsSync(path.join(tmpDir, 'out.mermaid'))).toBe(true);
    // No .mjs.mermaid (would mean we appended instead of replaced).
    expect(existsSync(path.join(tmpDir, 'out.mjs.mermaid'))).toBe(false);
  });

  it('compile command appends .mermaid when output has no extension', () => {
    writeRunnablePipeline();
    const result = runCli(['compile', './p.yaml', './out']);
    expect(result.status).toBe(0);
    expect(existsSync(path.join(tmpDir, 'out'))).toBe(true);
    expect(existsSync(path.join(tmpDir, 'out.mermaid'))).toBe(true);
  });

  it('compile --mermaid-only writes ONLY the .mermaid (no .ts), derived from <output.ts> arg', () => {
    // The output arg is `<output.ts>` in both modes (same path semantic);
    // --mermaid-only differs only in suppressing the .ts write. The .mermaid
    // path is derived via mermaidPathFor (strip .ts → append .mermaid).
    writeRunnablePipeline();
    const result = runCli(['compile', '--mermaid-only', './p.yaml', './diagram.ts']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Wrote diagram');
    expect(result.stdout).toContain('diagram.mermaid');
    expect(existsSync(path.join(tmpDir, 'diagram.mermaid'))).toBe(true);
    expect(existsSync(path.join(tmpDir, 'diagram.ts'))).toBe(false);
    const mermaidContent = readFileSync(path.join(tmpDir, 'diagram.mermaid'), 'utf-8');
    expect(mermaidContent.startsWith('flowchart TD\n')).toBe(true);
  });

  it('compile --mermaid-only works on a YAML with missing agent files (skips validation)', () => {
    // The default compile path rejects this at validateAgentFilesExist;
    // --mermaid-only bypasses that check by skipping compile() entirely.
    writeFileSync(
      path.join(tmpDir, 'broken.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: missing-agent',
        '    input: $x',
        '    produces: out.md',
        '',
      ].join('\n'),
    );
    const result = runCli(['compile', '--mermaid-only', './broken.yaml', './diagram.ts']);
    expect(result.status).toBe(0);
    expect(existsSync(path.join(tmpDir, 'diagram.mermaid'))).toBe(true);
    expect(existsSync(path.join(tmpDir, 'diagram.ts'))).toBe(false);
  });

  it('compile --mermaid-only flag works in trailing position too', () => {
    writeRunnablePipeline();
    const result = runCli(['compile', './p.yaml', './diagram.ts', '--mermaid-only']);
    expect(result.status).toBe(0);
    expect(existsSync(path.join(tmpDir, 'diagram.mermaid'))).toBe(true);
    expect(existsSync(path.join(tmpDir, 'diagram.ts'))).toBe(false);
    expect(existsSync(path.join(tmpDir, 'p.ts'))).toBe(false);
  });

  it('run rejects --mermaid-only with a clear error (compile-only flag)', () => {
    // Without the guard, --mermaid-only would land as a positional input to
    // the spawned pipeline and silently shift declared `inputs:` slots. The
    // CLI loud-fails at the boundary so the typo surfaces immediately.
    writeRunnablePipeline();
    const result = runCli(['run', '--mermaid-only', './p.yaml']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--mermaid-only is a compile-only flag');
  });

  it('LOOM_FORCE_RUNNER throws on unknown values', () => {
    // The validator fires at module load (top-level throw), so even an
    // unknown argument like `--help` — which the cli would otherwise
    // dispatch to the generic usage message — never reaches main().
    // Invoke via subprocess so the throw surfaces on stderr rather than
    // crashing the test runner.
    const tsxLoader = path.join(repoRoot, 'node_modules/tsx/dist/loader.mjs');
    const result = realSpawnSync(
      process.execPath,
      ['--import', tsxLoader, path.join(repoRoot, 'src/cli.ts'), '--help'],
      {
        cwd: tmpDir,
        encoding: 'utf-8',
        env: { ...process.env, LOOM_FORCE_RUNNER: 'bun' },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("LOOM_FORCE_RUNNER='bun' is not a recognized value");
    expect(result.stderr).toContain("Valid values: 'tsx' or 'node'");
  });

  it('LOOM_DEBUG=1 bypasses formatting and shows the full error', () => {
    // Easiest error to trigger: an unknown pipeline name. The friendly
    // wrapper would render `Error: Pipeline 'nonexistent' not found at ...`
    // followed by the LOOM_DEBUG hint. With LOOM_DEBUG=1, the wrapper
    // dumps the raw Error via console.error(err) — Node's default rendering
    // includes the error name + message + stack frames, which the friendly
    // path strips. Assert on the stack-trace signature.
    const result = runCli(['run', 'nonexistent-pipeline-name'], { LOOM_DEBUG: '1' });
    expect(result.status).toBe(1);
    // The full-error path renders a stack trace; the friendly path does not.
    // Match on `\n    at ` which is Node's stack-frame separator.
    expect(result.stderr).toMatch(/\n\s+at /);
    // And it does NOT print the friendly "(set LOOM_DEBUG=1 ...)" footer.
    expect(result.stderr).not.toContain('(set LOOM_DEBUG=1 to see the full stack)');
  });
});

describe('Draft 5 CLI-layer rejection coverage (auto-revise on retry_from + aggregate retry gate)', () => {
  // Draft 5's schema/compile rejections are exhaustively covered at their
  // respective layers (types.test.ts, src/compile/retry-gate.test.ts +
  // revise.test.ts). This block locks
  // in what the END USER sees on stderr when `loom run` is invoked against
  // a YAML that trips each Draft 5 refine — i.e. the wording produced by
  // cli.ts's top-level error wrapper (the `isEntryPoint` rejection branch),
  // which formats ZodError as a `Pipeline schema error:` bulleted list and
  // other thrown Errors as `Error: <message>`. The unit layer can't
  // observe that wording (it
  // throws the raw ZodError up to the test) — only the subprocess wrapper
  // surfaces the friendly user message.
  //
  // Symmetric with the existing 'top-level error wrapper (end-to-end via
  // subprocess)' block above. Each test writes a minimal pipeline YAML to
  // tmpDir and invokes cli.ts as a child via the tsx loader; assertions
  // pin the exact friendly wording so a refine-message refactor cannot
  // silently drift the user-facing text.
  let realSpawnSync: typeof import('child_process').spawnSync;
  let repoRoot: string;

  beforeEach(async () => {
    const real = await vi.importActual<typeof import('child_process')>('child_process');
    realSpawnSync = real.spawnSync;
    repoRoot = path.resolve(origCwd);
  });

  function runCli(args: string[], env: Record<string, string | undefined> = {}) {
    return realSpawnSync(
      process.execPath,
      [
        '--import',
        path.join(repoRoot, 'node_modules/tsx/dist/loader.mjs'),
        path.join(repoRoot, 'src/cli.ts'),
        ...args,
      ],
      {
        cwd: tmpDir,
        encoding: 'utf-8',
        env: { ...process.env, ...env },
      },
    );
  }

  /** Write a writer agent persona file so validateAgentFilesExist doesn't
   *  short-circuit the test before the schema/compile layer is reached.
   *  Pipelines under test below all use 'writer' as their first agent.
   *  Add more names via `extra`. */
  function writePersonas(names: string[] = ['writer']): void {
    mkdirSync(path.join(tmpDir, '.claude/agents'), { recursive: true });
    for (const n of names) {
      writeFileSync(path.join(tmpDir, `.claude/agents/${n}.md`), `---\nname: ${n}\n---\nbody\n`);
    }
  }

  it('rejects on_fail with retry_from but no revise_with (OnFail.revise_with unconditionally required)', () => {
    // Schema refine: OnFail makes revise_with required (no conditional).
    // FlowItemSchema is a z.union, so a StepItem failure inside the union
    // surfaces with `code: 'invalid_union'` and the per-member failure
    // tucked under `issue.errors[]` (v4's `$ZodIssue[][]` — one inner
    // array per union member; v3 had `unionErrors: ZodError[]`). The
    // wrapper's flattenZodIssues helper recurses into those nested issue
    // arrays and picks the deepest member-relative path (StepItem at
    // `on_fail.revise_with`, depth 2, surfaced absolute as
    // `flow.0.on_fail.revise_with` via the path-prefix prepend) over
    // the shallow sibling-variant noise (e.g. `review_loop: Required`
    // at member-relative depth 1, or root-level `Unrecognized key(s)`
    // at depth 0) — so the user sees the field-specific bullet.
    //
    // Aggregate refines (see the tests below for max_retries / revise_with
    // requires retry_from) take a different path: they fail INSIDE the
    // AggregateItem.aggregate subobject AFTER the union member-parse
    // succeeded on the `aggregate` key, so the refine-emitted issue is at
    // `flow.<i>.aggregate` and the wrapper renders it without needing
    // union recursion.
    writePersonas(['writer']);
    writeFileSync(
      path.join(tmpDir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: writer',
        '    input: $x',
        '    produces: w.json',
        '    bind: writerOut',
        '    on_fail:',
        '      verdict_field: status',
        '      retry_from: writerOut',
        // NO revise_with → schema rejects.
        '',
      ].join('\n'),
    );
    const result = runCli(['run', './p.yaml', '--id', 'RATE-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Pipeline schema error:');
    // The field-specific bullet surfaces directly — no collapsed
    // `flow.0: Invalid input` shadowing the real issue.
    // Zod's default issue message for a missing required field changed from
    // 'Required' (v3) to 'Invalid input: expected <type>, received undefined'
    // (v4). The path is the load-bearing assertion — wording is incidental.
    expect(result.stderr).toMatch(
      /^ {2}- flow\.0\.on_fail\.revise_with: (Required|Invalid input: expected object, received undefined)$/m,
    );
    expect(result.stderr).not.toMatch(/^ {2}- flow\.0: Invalid input$/m);
    expect(result.stderr).toContain('(set LOOM_DEBUG=1 to see the full stack)');
  });

  it('surfaces every nested union issue (multi-field StepItem failure)', () => {
    // Locks in the union-error recursion behavior the wrapper relies on:
    // when a single union member produces MULTIPLE distinct field-level
    // failures (here, the StepItem variant fails parse on all three
    // required OnFail fields), every nested issue must surface as its own
    // bullet with the full field path — no collapsing under "Invalid
    // input", no sibling-variant noise from other union members.
    //
    // The 6-member FlowItem union produces a single outer
    // `flow.0: Invalid input` issue with `errors: $ZodIssue[][]` holding
    // one inner array per union member's per-variant failure (v4's
    // flattened shape; v3 used `unionErrors: ZodError[]`).
    // flattenZodIssues picks the StepItem member (deepest member-relative
    // path) and surfaces its three issues at absolute paths via the
    // path-prefix prepend; sibling members complaining `review_loop:
    // Required` (member-relative depth 1) are discarded as cross-variant
    // noise.
    writePersonas(['writer']);
    writeFileSync(
      path.join(tmpDir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: writer',
        '    input: $x',
        '    produces: w.md',
        '    bind: writerOut',
        '    on_fail: {}', // All three required OnFail fields missing.
        '',
      ].join('\n'),
    );
    const result = runCli(['run', './p.yaml', '--id', 'RATE-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Pipeline schema error:');
    // All three field-specific bullets present, each on its own line.
    // Zod default-message rephrase (v3 'Required' → v4 'Invalid input:
    // expected <type>, received undefined'); path is load-bearing.
    expect(result.stderr).toMatch(
      /^ {2}- flow\.0\.on_fail\.verdict_field: (Required|Invalid input: expected string, received undefined)$/m,
    );
    expect(result.stderr).toMatch(
      /^ {2}- flow\.0\.on_fail\.retry_from: (Required|Invalid input: expected string, received undefined)$/m,
    );
    expect(result.stderr).toMatch(
      /^ {2}- flow\.0\.on_fail\.revise_with: (Required|Invalid input: expected object, received undefined)$/m,
    );
    // And NO collapsed union bullet shadowing them.
    expect(result.stderr).not.toMatch(/^ {2}- flow\.0: Invalid input$/m);
    // And NO sibling-variant noise (the union has 5 other members that
    // each complain `flow.0.<key>: Required` — those must not bleed
    // through, otherwise the user has to wade through 11 bullets per
    // failure).
    expect(result.stderr).not.toMatch(/^ {2}- flow\.0\.review_loop: Required$/m);
    expect(result.stderr).not.toMatch(/^ {2}- flow\.0\.aggregate: Required$/m);
    expect(result.stderr).not.toMatch(/^ {2}- flow\.0\.parallel: Required$/m);
    expect(result.stderr).not.toMatch(/^ {2}- flow\.0\.branch: Required$/m);
    expect(result.stderr).not.toMatch(/^ {2}- flow\.0\.human_gate: Required$/m);
  });

  it('rejects aggregate with max_retries but no retry_from', () => {
    // Schema refine on AggregateItem: 'max_retries' requires 'retry_from'.
    // The refine message is custom (cli.ts wrapper renders it verbatim
    // after the path bullet), so assert on both the path and the message
    // body.
    writePersonas(['writer']);
    writeFileSync(
      path.join(tmpDir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: writer',
        '    input: $x',
        '    produces: w.json',
        '    bind: writerOut',
        '  - aggregate:',
        '      inputs: { w: $writerOut }',
        '      verdict_field: status',
        '      max_retries: 3', // NO retry_from → refine rejects.
        '',
      ].join('\n'),
    );
    const result = runCli(['run', './p.yaml', '--id', 'RATE-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Pipeline schema error:');
    expect(result.stderr).toMatch(
      /flow\.1\.aggregate: aggregate: 'max_retries' requires 'retry_from'/,
    );
  });

  it('rejects aggregate with on_max_exceeded but no retry_from', () => {
    // Symmetric refine: 'on_max_exceeded' requires 'retry_from'.
    writePersonas(['writer']);
    writeFileSync(
      path.join(tmpDir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: writer',
        '    input: $x',
        '    produces: w.json',
        '    bind: writerOut',
        '  - aggregate:',
        '      inputs: { w: $writerOut }',
        '      verdict_field: status',
        '      on_max_exceeded: continue', // NO retry_from → refine rejects.
        '',
      ].join('\n'),
    );
    const result = runCli(['run', './p.yaml', '--id', 'RATE-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Pipeline schema error:');
    expect(result.stderr).toMatch(
      /flow\.1\.aggregate: aggregate: 'on_max_exceeded' requires 'retry_from'/,
    );
  });

  it('rejects aggregate with revise_with but no retry_from', () => {
    // Symmetric refine: 'revise_with' requires 'retry_from'.
    writePersonas(['writer']);
    writeFileSync(
      path.join(tmpDir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: writer',
        '    input: $x',
        '    produces: w.json',
        '    bind: writerOut',
        '  - aggregate:',
        '      inputs: { w: $writerOut }',
        '      verdict_field: status',
        '      revise_with:',
        '        prompt: Retry.',
        // NO retry_from → refine rejects.
        '',
      ].join('\n'),
    );
    const result = runCli(['run', './p.yaml', '--id', 'RATE-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Pipeline schema error:');
    expect(result.stderr).toMatch(
      /flow\.1\.aggregate: aggregate: 'revise_with' requires 'retry_from'/,
    );
  });

  it('rejects aggregate with retry_from but no revise_with (mirrors OnFail refine)', () => {
    // Symmetric to test 1 on the aggregate host. The refine wording is
    // distinct from OnFail's "Required" path-only error — aggregate uses a
    // custom message naming both fields.
    writePersonas(['writer']);
    writeFileSync(
      path.join(tmpDir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: writer',
        '    input: $x',
        '    produces: w.json',
        '    bind: writerOut',
        '  - aggregate:',
        '      inputs: { w: $writerOut }',
        '      verdict_field: status',
        '      retry_from: writerOut',
        // NO revise_with → refine rejects.
        '',
      ].join('\n'),
    );
    const result = runCli(['run', './p.yaml', '--id', 'RATE-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Pipeline schema error:');
    expect(result.stderr).toMatch(
      /flow\.1\.aggregate: aggregate: 'retry_from' requires 'revise_with'/,
    );
  });

  it('rejects revise_with.inputs with a non-$-prefixed entry', () => {
    // Schema regex on revise_with.inputs items: /^\$/. The message points
    // the user at the required `$ref` shape with an explicit example.
    writePersonas(['writer']);
    writeFileSync(
      path.join(tmpDir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: writer',
        '    input: $x',
        '    produces: w.json',
        '    bind: writerOut',
        '    on_fail:',
        '      verdict_field: status',
        '      retry_from: writerOut',
        '      revise_with:',
        '        inputs: [unprefixed]', // Missing $ — schema regex rejects.
        '',
      ].join('\n'),
    );
    const result = runCli(['run', './p.yaml', '--id', 'RATE-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Pipeline schema error:');
    // Path is flow.0.on_fail.revise_with.inputs.0 (zod renders array
    // indices in the path). Message is the regex's custom error.
    expect(result.stderr).toMatch(
      /flow\.0\.on_fail\.revise_with\.inputs\.0: revise_with\.inputs entries must be \$-prefixed bind refs/,
    );
  });

  it('rejects revise_with: { prompt: "" } (Zod .min(1) before the at-least-one refine)', () => {
    // Spec § "Refines on ReviseWith": prompt must be non-empty. The .min(1)
    // refine fires INSTEAD OF the at-least-one refine (zod evaluates the
    // string's own .min(1) at field parse, before the object-level refine
    // runs). The wrapper formats the Zod default message for too_small as
    // "String must contain at least 1 character(s)". Assert the issue path
    // pins the right refine, and accept zod's default text.
    writePersonas(['writer']);
    writeFileSync(
      path.join(tmpDir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: writer',
        '    input: $x',
        '    produces: w.json',
        '    bind: writerOut',
        '    on_fail:',
        '      verdict_field: status',
        '      retry_from: writerOut',
        '      revise_with:',
        "        prompt: ''", // Empty-string — .min(1) rejects.
        '',
      ].join('\n'),
    );
    const result = runCli(['run', './p.yaml', '--id', 'RATE-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Pipeline schema error:');
    // Path bullet pins the prompt field; the .min(1) message itself is
    // zod's default (v3: "at least 1 character"; v4: ">=1 characters").
    // Asserting the path is the load-bearing check — it confirms the
    // prompt-specific refine fired (not the at-least-one refine, which
    // would name the object root).
    expect(result.stderr).toMatch(/ {2}- flow\.0\.on_fail\.revise_with\.prompt: /);
    expect(result.stderr).toMatch(/at least 1 character|>=1 characters/);
  });

  it('rejects intermediate review_loop between retry_from target and aggregate-gate (carve-out is parallel-only)', () => {
    // Compile-time rejection (not schema). The carve-out for aggregate-
    // gate retry zones admits ONLY parallel-feeding-aggregate intermediate
    // compounds; non-parallel intermediates (review_loop here) remain
    // rejected with the existing intermediate-compound message naming the
    // offending kind. (Branch intermediates are admitted under the
    // explicit-rejoin rule; review_loop intermediates remain deferred.)
    writePersonas(['writer', 'rl-writer', 'rl-rev']);
    writeFileSync(
      path.join(tmpDir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: writer',
        '    input: $x',
        '    produces: w.md',
        '    bind: writerOut',
        '  - review_loop:',
        '      writer: rl-writer',
        '      reviewer: rl-rev',
        '      input: $writerOut',
        '      writer_produces: rl.md',
        '      reviewer_produces: rev.json',
        '      verdict_field: status',
        '      bind: rlOut',
        '  - aggregate:',
        '      inputs: { w: $writerOut }',
        '      verdict_field: status',
        '      bind: overall',
        '      retry_from: writerOut',
        '      revise_with:',
        '        prompt: Retry.',
        '',
      ].join('\n'),
    );
    const result = runCli(['run', './p.yaml', '--id', 'RATE-1']);
    expect(result.status).toBe(1);
    // Compile errors flow through the wrapper's generic `Error: <msg>`
    // branch (not the ZodError formatter), so the friendly stderr starts
    // with `Error: Compile error: ...` and ends with the LOOM_DEBUG hint.
    expect(result.stderr).toMatch(
      /Error: Compile error: retry zone gated by aggregate \(bind 'overall'\) contains a review_loop at position 1/,
    );
    expect(result.stderr).toContain('(set LOOM_DEBUG=1 to see the full stack)');
  });

  it("rejects revise_with.inputs self-reference to the aggregate-gate's own bind (aggregate is non-file-bound)", () => {
    // checkConsume rejection at the aggregate's compile site. The error
    // path names the offending revise_with.inputs index and surfaces the
    // remedy ("That producer cannot be made file-bound; restructure...").
    writePersonas(['writer', 'rev']);
    writeFileSync(
      path.join(tmpDir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: writer',
        '    input: $x',
        '    produces: w.md',
        '    bind: writerOut',
        '  - step: rev',
        '    input: $writerOut',
        '    produces: r.json',
        '    bind: revOut',
        '  - aggregate:',
        '      inputs: { r: $revOut }',
        '      verdict_field: status',
        '      bind: overall',
        '      retry_from: writerOut',
        '      revise_with:',
        '        inputs: [$overall]', // Self-ref to aggregate bind.
        '',
      ].join('\n'),
    );
    const result = runCli(['run', './p.yaml', '--id', 'RATE-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /Error: Compile error: aggregate \(bind 'overall'\)\.revise_with\.inputs\[0\] references '\$overall', whose producer .* has no file-bound output/,
    );
  });

  it('rejects parallel-feeding-aggregate-gate with a review_loop child (carve-out admits step children only)', () => {
    // Iter-2 cleanup tightened isParallelFeedingAggregateGate to reject
    // non-step children. Without this guard, the carve-out would admit
    // the parallel (bind-set match) but emitParallelRetry would silently
    // skip the review_loop on retry.
    writePersonas(['writer', 'rl-writer', 'rl-reviewer', 'sec-rev']);
    writeFileSync(
      path.join(tmpDir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: writer',
        '    input: $x',
        '    produces: w.md',
        '    bind: writerOut',
        '  - parallel:',
        '      - review_loop:',
        '          writer: rl-writer',
        '          reviewer: rl-reviewer',
        '          input: $writerOut',
        '          writer_produces: rl.md',
        '          reviewer_produces: rev.json',
        '          verdict_field: status',
        '          bind: rl',
        '      - step: sec-rev',
        '        input: $writerOut',
        '        produces: sec.json',
        '        bind: sec',
        '  - aggregate:',
        '      inputs: { r: $rl, s: $sec }',
        '      verdict_field: status',
        '      bind: overall',
        '      retry_from: writerOut',
        '      revise_with:',
        '        prompt: Retry.',
        '',
      ].join('\n'),
    );
    const result = runCli(['run', './p.yaml', '--id', 'RATE-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /Error: Compile error: retry zone gated by aggregate \(bind 'overall'\) contains a parallel at position 1 whose binds feed the aggregate gate but which has a review_loop child/,
    );
  });

  it('rejects a downstream step consuming an aggregate bind as $ref (aggregate is non-file-bound)', () => {
    // checkConsume on a step.input — the aggregate's bind is in scope but
    // not file-bound (its verdict is an in-memory string, not a path), so
    // consuming it via `$ref` fails compile. Locks in the existing
    // wording surfaces through the CLI's friendly wrapper for the
    // post-Draft 5 aggregate shape (where aggregate now carries retry
    // fields — the rejection wording itself is unchanged but the bind is
    // adjacent to the new schema surface).
    writePersonas(['writer', 'rev', 'downstream']);
    writeFileSync(
      path.join(tmpDir, 'p.yaml'),
      [
        'pipeline: p',
        'cli: claude',
        'inputs: [x]',
        'flow:',
        '  - step: writer',
        '    input: $x',
        '    produces: w.md',
        '    bind: writerOut',
        '  - step: rev',
        '    input: $writerOut',
        '    produces: r.json',
        '    bind: revOut',
        '  - aggregate:',
        '      inputs: { r: $revOut }',
        '      verdict_field: status',
        '      bind: overall',
        '  - step: downstream',
        '    input: $overall', // Consuming aggregate bind — checkConsume rejects.
        '    produces: d.md',
        '',
      ].join('\n'),
    );
    const result = runCli(['run', './p.yaml', '--id', 'RATE-1']);
    expect(result.status).toBe(1);
    // The consume label uses `step '<name>'` (the `stepLabel` form
    // emitted by checkConsume) — NOT the human-readable `agent '<name>'`
    // style. Lock in the exact label so a refactor that conflates the
    // two doesn't slip past tests.
    expect(result.stderr).toMatch(
      /Error: Compile error: step 'downstream'\.input references '\$overall', whose producer aggregate \(bind 'overall'\) has no file-bound output/,
    );
  });
});
