import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir, homedir } from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { compile } from './index.js';

// ESM-friendly equivalent of `__dirname`. `import.meta.url` is the only
// way to get the current module's URL in an ESM context; converting to a
// path lets us resolve the project's local tsc binary deterministically.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Ambient declarations covering every external symbol the emitted pipelines
 *  reference. Written to a per-invocation `ambient.d.ts` in the tsc tmp dir
 *  so the emit's `import { ... } from 'agenticloom/runtime'` resolves cleanly under
 *  tsc without depending on node_modules. Also declares the minimum `process`
 *  / `console` shape the emit's argv-guard + outer-catch use.
 *
 *  Mostly loose (`any`-typed args / returns) — the goal is closure-scope
 *  correctness (does every $ref resolve to a name in scope?), NOT runtime-
 *  type correctness, which is exercised by the existing string-matching
 *  tests. The deliberate exception is `runAgent.input: string` (rather than
 *  `any`): the branch-arm terminal threading emit must produce a non-null
 *  string input expression on the main pass — passing `undefined` to
 *  runAgent is a silent regression of CRIT-1's class. Pinning the type
 *  surfaces such regressions at compileAndTypeCheck rather than only via
 *  runtime assertions in Group I. */
const RUNTIME_AMBIENT_DTS = `declare module 'agenticloom/runtime' {
  export function runAgent(name: string, input: string, produces: string | undefined, opts: any): Promise<string>;
  export function reviewLoop(opts: any): Promise<string>;
  export function humanGate(opts?: any): Promise<void>;
  export function parallel<T extends readonly unknown[]>(fns: { [K in keyof T]: () => Promise<T[K]> }): Promise<T>;
  export function aggregate(opts: any): Promise<string>;
  export function retryGateZone(opts: any): Promise<string>;
  export function foreach(opts: any): Promise<any>;
  export function readJson(p: string): any;
  export function readText(p: string): string;
  export function fileExists(p: string): boolean;
  export class HaltPipelineError extends Error {}
}
declare const process: {
  argv: string[];
  exit(code?: number): never;
  env: Record<string, string | undefined>;
};
declare const console: {
  log(...args: any[]): void;
  error(...args: any[]): void;
};
`;

/** Path to the project's local tsc binary. `npx tsc` from a tmp dir refuses
 *  to run (no project tsc nearby); using the absolute path to the installed
 *  binary keeps the helper self-contained. The helper lives at
 *  `src/compile/test-helpers.ts`, so `../../node_modules/.bin/tsc` is the
 *  project's local install. */
const LOCAL_TSC = path.resolve(__dirname, '..', '..', 'node_modules', '.bin', 'tsc');

/** Compile + write emit to a tmp .ts file + run `tsc --noEmit` against a
 *  per-invocation tsconfig with `strictNullChecks` enabled (full
 *  `strict: true` is intentionally not used — see the tsconfig setup
 *  below for the per-flag rationale). Returns the emit string on
 *  success; throws with the tsc diagnostic on failure. This is the
 *  scope-correctness validator — if a closure body references an arm-internal
 *  bind from outer scope (broken seal), tsc fails with "Cannot find name."
 *  Use on every non-trivial composition test so the closure-shape's
 *  load-bearing seal is asserted by the type system, not just by string
 *  matching.
 *
 *  The tmp .ts file gets a per-invocation tsconfig pinning the selected
 *  strict flags + ES2022 + bundler module resolution. The ambient
 *  `runtime.d.ts` file provides the runtime imports without depending on
 *  node_modules / project tsconfig — which means this helper is
 *  self-contained and resilient to project tsconfig changes. */
export function compileAndTypeCheck(yamlPath: string, options?: { resumeFrom?: string }): string {
  const emit = compile(yamlPath, options);
  const tcDir = mkdtempSync(path.join(tmpdir(), 'loom-tsc-'));
  try {
    writeFileSync(path.join(tcDir, 'emit.ts'), emit);
    writeFileSync(path.join(tcDir, 'ambient.d.ts'), RUNTIME_AMBIENT_DTS);
    // tsconfig pinned to the minimum set of strict-mode checks that
    // exercise closure-scope correctness — primarily `strictNullChecks`
    // + name-resolution. Implicit-any / unused-locals / strict-function-types
    // are disabled because the emit deliberately omits parameter type
    // annotations and leans on inference; toggling them on would surface
    // false positives unrelated to the closure-scope invariant under test.
    const tsconfig = {
      compilerOptions: {
        // Explicit per-flag setup rather than `strict: true`: the goal
        // here is closure-scope correctness (name resolution + arity),
        // not full type strictness on the emit. The emit deliberately
        // omits parameter type annotations and leans on inference; flipping
        // noImplicitAny on would surface false positives unrelated to the
        // closure-scope invariant under test.
        strictNullChecks: true,
        noImplicitAny: false,
        target: 'es2022',
        module: 'es2022',
        // `bundler` matches the project's mode — no .js extension required
        // on relative imports (the emit doesn't use any), no extra deprecation
        // warnings under TS 6+.
        moduleResolution: 'bundler',
        noEmit: true,
        skipLibCheck: true,
        types: [],
        lib: ['es2022'],
      },
      include: ['*.ts'],
    };
    writeFileSync(path.join(tcDir, 'tsconfig.json'), JSON.stringify(tsconfig));
    const result = spawnSync(LOCAL_TSC, ['--noEmit', '-p', tcDir], { encoding: 'utf-8' });
    if (result.status !== 0) {
      throw new Error(
        `tsc --noEmit (strictNullChecks) failed on emit from ${yamlPath}:\n` +
          (result.error ? `SPAWN ERROR: ${result.error.message}\n` : '') +
          `STDOUT:\n${result.stdout}\n` +
          `STDERR:\n${result.stderr}\n` +
          `EMIT:\n${emit}`,
      );
    }
    return emit;
  } finally {
    rmSync(tcDir, { recursive: true, force: true });
  }
}

/** Set up the per-test compile environment: chdir to a fresh tmp directory
 *  and override `process.env.HOME` to point at the same directory. Returns
 *  a teardown closure that each test file's `afterEach` MUST invoke to
 *  restore the original cwd + HOME and remove the tmp dir.
 *
 *  Real fs + per-test temp directory rather than fs mocking — the compile
 *  module reads `agents.md` files at compile time via `existsSync`; mocking
 *  every `existsSync` path is more brittle than writing fixture files into
 *  a tmp dir and chdir'ing there. Vitest's default per-file serial execution
 *  keeps the chdir safe.
 *
 *  $HOME is overridden to a sandbox so the layered agent-file probe
 *  (project then global) can't fall through to a dev's real
 *  `~/.claude/agents/` or `~/.copilot/agents/` and silently mask a
 *  rejection assertion — if real
 *  $HOME happened to contain one of the fictional agent names the tests
 *  use, the validator would skip past it and the test would pass for the
 *  wrong reason.
 *
 *  Suite-scoped teardown pattern (REQUIRED):
 *  ```ts
 *  describe('<unit>', () => {
 *    let teardown: () => void;
 *    beforeEach(() => { teardown = setupCompileTestEnv(); });
 *    afterEach(() => { teardown(); });
 *    // ... tests ...
 *  });
 *  ```
 *  Do NOT write `const teardown = setupCompileTestEnv();` inside `beforeEach`
 *  — block-scoped, invisible to `afterEach`, leaks the tmp dir. */
export function setupCompileTestEnv(): () => void {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;

  const tmpDir = mkdtempSync(path.join(tmpdir(), 'loom-compile-test-'));
  process.chdir(tmpDir);
  process.env.HOME = tmpDir;

  // Sanity-check the override took: os.homedir() reads $HOME on POSIX but
  // falls back to userInfo() when $HOME is unset/empty. If this throws in
  // CI, fail loud at setup time rather than silently testing against the
  // user's real home dir.
  if (homedir() !== tmpDir) {
    throw new Error(`setupCompileTestEnv: HOME override failed (got ${homedir()}, want ${tmpDir})`);
  }

  return () => {
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  };
}

/** Write a pipeline YAML + its referenced persona files into the current
 *  working directory (the tmp dir set up by `setupCompileTestEnv`).
 *  Returns the absolute path to the YAML file for compile() to read. */
export function setupFixture(opts: {
  yaml: string;
  agents?: string[]; // persona names to create at .claude/agents/<name>.md
}): string {
  // Guard: setupFixture relies on cwd being the per-test tmpdir set up by
  // setupCompileTestEnv. If a test calls setupFixture before beforeEach (or
  // from a module top-level / describe body), we'd silently write fixture
  // files into the repo's working tree. Fail loud instead.
  const cwd = process.cwd();
  if (!cwd.includes('loom-compile-test-')) {
    throw new Error(
      `setupFixture: cwd ${cwd} is not the expected per-test tmpdir. ` +
        `Did you forget to call setupCompileTestEnv() in beforeEach?`,
    );
  }
  if (opts.agents && opts.agents.length > 0) {
    mkdirSync('.claude/agents', { recursive: true });
    for (const name of opts.agents) {
      writeFileSync(`.claude/agents/${name}.md`, `---\nname: ${name}\n---\nbody\n`);
    }
  }
  const yamlPath = path.join(cwd, 'pipeline.yaml');
  writeFileSync(yamlPath, opts.yaml);
  return yamlPath;
}
