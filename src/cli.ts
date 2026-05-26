#!/usr/bin/env node
import { spawn } from 'child_process';
import {
  writeFileSync,
  existsSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  statSync,
} from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { z } from 'zod/v4';
import { compile, parseSpec, readRetryGateForCursorCheck } from './compile/index.js';
import { flattenZodIssues } from './cli/zod-error.js';
import { emitMermaid } from './mermaid.js';

/** Resolve a pipeline argument to a file path.
 *
 *  Rule: if the arg looks like a path (ends in .yaml/.yml OR contains a
 *  slash) treat it as one; otherwise resolve as a pipeline *name* against
 *  the layered set — project `loom/pipelines/<name>.yaml` first, then the
 *  user-global `~/.loom/pipelines/<name>.yaml` fallback. Matches the
 *  `npm run <script>` / `cargo run --bin <name>` idiom — short names by
 *  default, paths when needed. The two-layer model mirrors `git config`,
 *  eslint, npm, Claude Code's own subagent system; a future built-in
 *  stdlib tier shipped with loom itself is the natural third layer when
 *  there is stdlib content to ship. */
export function resolvePipeline(arg: string): string {
  const looksLikePath = arg.endsWith('.yaml') || arg.endsWith('.yml') || arg.includes('/');
  if (looksLikePath) {
    if (!existsSync(arg)) {
      throw new Error(`Pipeline file not found: ${arg}`);
    }
    return arg;
  }
  // Name-mode: layered discovery. Project layer first, global layer
  // second; .yaml-only at this branch (per spec — .yml is escape-hatch
  // only). Both attempted paths surface in the loud-fail message so the
  // user can see what was checked.
  const projectPath = path.join('loom', 'pipelines', `${arg}.yaml`);
  if (existsSync(projectPath)) return projectPath;

  const globalPath = path.join(os.homedir(), '.loom', 'pipelines', `${arg}.yaml`);
  if (existsSync(globalPath)) return globalPath;

  throw new Error(
    `Pipeline '${arg}' not found at either:\n` +
      `  ${projectPath} (project layer)\n` +
      `  ${globalPath} (global layer)\n` +
      `Pass a path ending in .yaml or .yml or containing '/' to bypass name resolution.`,
  );
}

/** Resolve a workspace ID from the run command's positional argv, honoring
 *  the precedence chain:
 *
 *    1. Explicit `--id <name>` CLI flag. Always wins. The flag and its value
 *       are stripped from the passthrough so they don't shift positional
 *       inputs into the spawned pipeline.
 *    2. First positional arg that resolves to an existing file under the
 *       given cwd → `path.basename(arg, path.extname(arg))`. Encourages the
 *       ticket-id-as-filename convention (e.g. `RATE-1.md` → `RATE-1`)
 *       without forcing it.
 *    3. `<pipeline>-<timestamp>` fallback. Safety net so `loom run` never
 *       silently writes into invocation cwd, even when the caller passes
 *       only literal/flag args.
 *
 *  Workspace IDs key the per-run output directory (`loom/runs/<id>/`); a
 *  meaningful identifier (ticket ID over timestamp) keeps repeated runs
 *  against the same input from overlapping under unrelated names. */
export function resolveWorkspaceId(opts: { argv: string[]; cwd: string; pipelineName: string }): {
  id: string;
  passthrough: string[];
} {
  const argv = [...opts.argv];

  const idFlagIdx = argv.indexOf('--id');
  if (idFlagIdx >= 0) {
    const value = argv[idFlagIdx + 1];
    // Reject a missing value AND a value that starts with `--`. Without the
    // latter check, `--id --save-logs` would consume `--save-logs` as the
    // workspace id and silently swallow the saveLogs intent.
    if (!value || value.startsWith('--')) {
      throw new Error('--id requires a value');
    }
    argv.splice(idFlagIdx, 2);
    return { id: value, passthrough: argv };
  }

  for (const arg of argv) {
    const abs = path.resolve(opts.cwd, arg);
    if (existsSync(abs)) {
      return {
        id: path.basename(arg, path.extname(arg)),
        passthrough: argv,
      };
    }
  }

  return {
    id: `${opts.pipelineName}-${Date.now()}`,
    passthrough: argv,
  };
}

/** Rewrite each arg that resolves to an existing file (from the invocation
 *  cwd) to its absolute form, leaving everything else untouched. The CLI
 *  `chdir`s into the workspace dir before spawning the compiled pipeline, so
 *  bare-relative file args from the caller would otherwise be re-resolved
 *  against the workspace (and miss the actual file). Non-file args — literal
 *  strings, ticket IDs, flags the pipeline knows about — pass through
 *  unchanged because we have no way to prove they're paths. */
export function absolutifyFileArgs(opts: { args: string[]; cwd: string }): string[] {
  return opts.args.map((arg) => {
    const abs = path.resolve(opts.cwd, arg);
    return existsSync(abs) ? abs : arg;
  });
}

/** Strip `--save-logs` from a pipeline-argv array.
 *
 *  The flag is environmental, not positional — it tells the runtime to tee
 *  each agent's full stream to `logs/<agent>.log` (via `LOOM_SAVE_LOGS=1` in
 *  the spawned child's env). It must not leak into the compiled pipeline's
 *  `process.argv.slice(2)` as a positional input, or it would shift the
 *  pipeline's declared `inputs:` slots by one.
 *
 *  Returns the cleaned argv (with the flag's index removed, preserving the
 *  remaining order so positional inputs aren't shifted) and a boolean
 *  indicating whether the flag was present. */
export function stripSaveLogsFlag(argv: string[]): { args: string[]; saveLogs: boolean } {
  // Filter (not indexOf+slice) so a duplicated flag doesn't leak the second
  // occurrence into the pipeline argv as a positional input — same silent
  // shift the rest of the CLI takes care to prevent.
  const saveLogs = argv.includes('--save-logs');
  return {
    args: argv.filter((a) => a !== '--save-logs'),
    saveLogs,
  };
}

/** Strip `--mermaid-only` from an argv array.
 *
 *  The flag is `compile`-only; it tells the CLI to skip the `.ts` write
 *  AND the agent-file existence check, emitting just the structural
 *  diagram. Mirrors `stripSaveLogsFlag`: the flag is environmental, not
 *  positional, so it must be removed from the array before the rest is
 *  destructured into `<pipeline> <output>` positionals.
 *
 *  Returns the cleaned argv and a boolean indicating the flag was present. */
export function stripMermaidOnlyFlag(argv: string[]): { args: string[]; mermaidOnly: boolean } {
  // Filter (not indexOf+slice) so a duplicated flag doesn't leak the second
  // occurrence as a positional — see `stripSaveLogsFlag` for the rationale.
  const mermaidOnly = argv.includes('--mermaid-only');
  return {
    args: argv.filter((a) => a !== '--mermaid-only'),
    mermaidOnly,
  };
}

/** Strip `--resume-from <bind>` from a pipeline-argv array.
 *
 *  The flag is environmental — it names a top-level bind in the resolved
 *  pipeline as the resumption cursor for `loom run`. The flag AND its
 *  value must be stripped from the passthrough before the rest is
 *  destructured into the pipeline's positional `inputs:` slots, mirroring
 *  the `--save-logs` and `--mermaid-only` strip posture. Duplicated
 *  occurrences are silently filtered; the first occurrence's value wins.
 *
 *  Loud-fail conditions handled here (the only site holding raw argv):
 *   - A missing value (the flag is the last token).
 *   - An empty-string value (`--resume-from ""`). Symmetric with
 *     `resolveWorkspaceId`'s `!value` check on `--id`: the empty token
 *     can't match any bind name and would otherwise sneak past as a
 *     degenerate "unknown cursor" rejection. Loud-fail at the strip
 *     layer where the user-error shape is clearest.
 *   - A value beginning with `--` (the flag is followed by another flag
 *     like `--id`, which would otherwise silently consume that flag as
 *     the cursor and swallow its intent — mirrors `resolveWorkspaceId`'s
 *     `--id` validation). */
export function stripResumeFromFlag(argv: string[]): {
  args: string[];
  resumeFrom: string | undefined;
} {
  let resumeFrom: string | undefined;
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--resume-from') {
      const value = argv[i + 1];
      if (resumeFrom === undefined) {
        if (value === undefined || value === '' || value.startsWith('--')) {
          throw new Error('--resume-from requires a non-empty value (a top-level bind name)');
        }
        resumeFrom = value;
      }
      i++; // skip the value alongside the flag (duplicate or first occurrence)
      continue;
    }
    out.push(argv[i]);
  }
  return { args: out, resumeFrom };
}

/** Extract the `bind:` field from any flow-item kind, mirroring
 *  `compile/flow-helpers.ts:getBindName`. The duplication keeps cli.ts free of the
 *  compile walker's scope state — a future bind-kind addition (e.g.
 *  `foreach`) must update both sites in lock-step. Branch's bind lives
 *  INSIDE the `branch:` block; parallel's bind lives at the wrapper
 *  level — match the schema shape, not a uniform convention. */
function getBindNameFromFlowItem(item: any): string | undefined {
  if ('step' in item) return item.bind;
  if ('review_loop' in item) return item.review_loop.bind;
  if ('aggregate' in item) return item.aggregate.bind;
  if ('parallel' in item) return item.bind;
  if ('branch' in item) return item.branch.bind;
  if ('foreach' in item) return item.foreach.bind;
  return undefined;
}

/** Walk a parsed pipeline's flow once and partition every declared bind
 *  into "top-level" (the outer-scope visible names that can serve as a
 *  `--resume-from` cursor) vs "nested" (declared inside a container body —
 *  parallel child, branch arm, review_loop reviewer subflow — not
 *  nameable as a cursor (nested cursors deferred — target the enclosing
 *  top-level container's bind instead)). Parallel children's binds are
 *  dual-written: into `topLevel` with kind `'parallel hoisted child'`
 *  (mirroring the compile-side hoist so a cursor naming a hoisted name
 *  accepts structurally), AND into `nested` with kind `'parallel'` (so
 *  any rejection message that names the declaration site can find it).
 *
 *  Also collects retry-zone ranges. A retry zone exists when a top-level
 *  step has `on_fail.retry_from` or a top-level aggregate has
 *  `retry_from`. Each entry is `{ retryFromIdx, gateIdx, gateLabel }`;
 *  cli.ts's cursor-inside-retry-zone check iterates these to reject a
 *  cursor that sits strictly between any zone's bounds. The compile-side
 *  resolution at `compile/retry-gate.ts:processRetryGate` is authoritative
 *  for same-scope / non-hoisted / file-bound semantics; this walker mirrors
 *  the same index resolution (including hoisted-child indices collapsing
 *  to the enclosing parallel) so the CLI rejection produces the right
 *  bounds.
 *
 *  Bind extraction follows the same rules as `compile/flow-helpers.ts:getBindName`.
 *  A future bind-kind addition must update both sites. */
export function enumerateTopLevelBinds(flow: any[]): {
  topLevel: Map<string, string>;
  nested: Map<string, string>;
  retryZones: Array<{ retryFromIdx: number; gateIdx: number; gateLabel: string }>;
} {
  const topLevel = new Map<string, string>();
  const nested = new Map<string, string>();
  const retryZones: Array<{ retryFromIdx: number; gateIdx: number; gateLabel: string }> = [];
  const indexByBind = new Map<string, number>();

  function recordNested(items: any[], enclosingKind: string): void {
    for (const item of items) {
      if ('step' in item && item.bind !== undefined) {
        nested.set(item.bind, enclosingKind);
      } else if ('review_loop' in item && item.review_loop.bind !== undefined) {
        nested.set(item.review_loop.bind, enclosingKind);
      } else if ('aggregate' in item && item.aggregate.bind !== undefined) {
        nested.set(item.aggregate.bind, enclosingKind);
      } else if ('parallel' in item) {
        if (item.bind !== undefined) nested.set(item.bind, enclosingKind);
        recordNested(item.parallel, 'parallel');
      } else if ('branch' in item) {
        // Branch's bind lives INSIDE the `branch:` block — match the
        // schema shape, not a uniform "bind at wrapper level" convention.
        if (item.branch.bind !== undefined) nested.set(item.branch.bind, enclosingKind);
        if (item.branch.then) recordNested(item.branch.then, 'branch');
        if (item.branch.else) recordNested(item.branch.else, 'branch');
      } else if ('foreach' in item) {
        // Foreach's bind lives INSIDE the `foreach:` block — same shape
        // as branch above. Body items recurse as nested; their declaration
        // scope is the foreach iteration closure, so they can never serve
        // as a `--resume-from` cursor.
        if (item.foreach.bind !== undefined) nested.set(item.foreach.bind, enclosingKind);
        if (item.foreach.body) recordNested(item.foreach.body, 'foreach');
      }
    }
  }

  for (let i = 0; i < flow.length; i++) {
    const item = flow[i];
    if ('step' in item && item.bind !== undefined) {
      topLevel.set(item.bind, 'step');
      indexByBind.set(item.bind, i);
    } else if ('review_loop' in item) {
      if (item.review_loop.bind !== undefined) {
        topLevel.set(item.review_loop.bind, 'review_loop');
        indexByBind.set(item.review_loop.bind, i);
      }
      if (Array.isArray(item.review_loop.reviewer)) {
        recordNested(item.review_loop.reviewer, 'review_loop reviewer subflow');
      }
    } else if ('aggregate' in item && item.aggregate.bind !== undefined) {
      topLevel.set(item.aggregate.bind, 'aggregate');
      indexByBind.set(item.aggregate.bind, i);
    } else if ('parallel' in item) {
      if (item.bind !== undefined) {
        topLevel.set(item.bind, 'parallel');
        indexByBind.set(item.bind, i);
      }
      // Hoisted parallel-child binds: dual-write to topLevel (so the cursor
      // lookup accepts a hoisted name) AND nested (so the declaration-site
      // label stays available for diagnostics). The hoisted child's outer-
      // scope position IS the parallel's index — used by retry-zone
      // resolution + cursor-inside-retry-zone bounds.
      for (const child of item.parallel) {
        const childBind = getBindNameFromFlowItem(child);
        if (childBind !== undefined) {
          topLevel.set(childBind, 'parallel hoisted child');
          indexByBind.set(childBind, i);
        }
      }
      recordNested(item.parallel, 'parallel');
    } else if ('branch' in item) {
      if (item.branch.bind !== undefined) {
        topLevel.set(item.branch.bind, 'branch');
        indexByBind.set(item.branch.bind, i);
      }
      if (item.branch.then) recordNested(item.branch.then, 'branch');
      if (item.branch.else) recordNested(item.branch.else, 'branch');
    } else if ('foreach' in item) {
      // Top-level foreach bind is a valid `--resume-from` cursor (replays
      // the whole foreach from iter-0). Interior body binds recurse into
      // nested with scope='foreach' so a cursor inside a foreach body gets
      // the right rejection-message context.
      if (item.foreach.bind !== undefined) {
        topLevel.set(item.foreach.bind, 'foreach');
        indexByBind.set(item.foreach.bind, i);
      }
      if (item.foreach.body) recordNested(item.foreach.body, 'foreach');
    }
    // human_gate has no bind: field — skip silently (the spec calls out
    // that naming a human_gate position as the cursor is structurally
    // impossible because there's no bind to name).
  }

  // Retry-zone bounds. A zone exists when a top-level step has
  // on_fail.retry_from or a top-level aggregate has retry_from. The
  // retry_from target is resolved against indexByBind — which includes
  // hoisted parallel children, mirroring the compile-side resolution. A
  // target that resolves to a non-strict-prior position is skipped (the
  // compile loud-fails it via processRetryGate); same for unresolvable
  // targets. Gate detection delegates to compile/retry-gate.ts's
  // `readRetryGate*` family — single source of truth for "is this item a
  // retry gate" across compile and cli, so a new gate-host kind needs one
  // change instead of two.
  for (let i = 0; i < flow.length; i++) {
    const gate = readRetryGateForCursorCheck(flow[i]);
    if (gate === undefined) continue;
    const retryFromIdx = indexByBind.get(gate.retryFrom);
    if (retryFromIdx === undefined || retryFromIdx >= i) continue;
    retryZones.push({ retryFromIdx, gateIdx: i, gateLabel: gate.label });
  }

  return { topLevel, nested, retryZones };
}

const cliFile = fileURLToPath(import.meta.url);
// In dev, tsx + .ts runtime + .ts temp; in prod, plain node + .js runtime
// + .mjs temp. LOOM_FORCE_RUNNER lets tests pin the runner ('tsx' or
// 'node') without rebuilding dist/ — the spawn-ENOENT subprocess test
// needs to exercise the node-runner branch while invoking src/cli.ts
// directly. Never depend on dist/ being fresh: pre-rename names in dist/
// have silently bypassed entire code paths before.
const forcedRunner = process.env.LOOM_FORCE_RUNNER;
// Loud-fail on unknown values rather than silent-fallthrough to extension
// auto-detect: an operator typo (e.g. 'bun', 'Tsx') would otherwise pick
// up whatever the extension check returned, masking the misconfiguration.
if (
  forcedRunner !== undefined &&
  forcedRunner !== '' &&
  forcedRunner !== 'tsx' &&
  forcedRunner !== 'node'
) {
  throw new Error(
    `LOOM_FORCE_RUNNER='${forcedRunner}' is not a recognized value. ` +
      `Valid values: 'tsx' or 'node'. This is a test-only escape hatch — ` +
      `unset it in production environments.`,
  );
}
const runningTypeScriptSource =
  forcedRunner === 'tsx' ? true : forcedRunner === 'node' ? false : cliFile.endsWith('.ts');
const runtimeFile = path.join(
  path.dirname(cliFile),
  'runtime',
  runningTypeScriptSource ? 'index.ts' : 'index.js',
);
const runtimeUrl = pathToFileURL(runtimeFile).href;

/** Spawn a child and resolve with its exit code.
 *
 *  On signal-kill (Ctrl-C, SIGTERM, OOM-killer) Node reports `code = null`
 *  and the signal name as the second arg; we map that to `128 + signum` per
 *  POSIX convention so shells and CI can distinguish "completed cleanly"
 *  from "cancelled mid-run." On Node v25.9.0 a real spawn-ENOENT fires only
 *  `error` (not `error` + `exit`); the `settled` flag is a defensive guard
 *  against a hypothetical future Node where both events could fire — it
 *  ensures `reject()` wins and `resolve()` doesn't double-settle. The test
 *  helper at `cli.test.ts:makeFakeEnoentChild` synthesizes the dual-fire to
 *  lock the dedupe behavior in regardless of which event order Node picks.
 *
 *  `tmpDir` is the per-run directory under `os.tmpdir()` that holds the
 *  compiled pipeline's temp `.mjs`/`.ts`. Cleanup `rmSync`'s the whole dir
 *  on exit so a single deletion catches the temp file plus anything the
 *  pipeline might leave next to it. `workspaceCwd` is the
 *  `loom/runs/<id>/` directory the child runs from — agent-produced files
 *  (`produces:` paths, `logs/<agent>.log`) land there instead of dirtying
 *  invocation cwd.
 *
 *  `saveLogs` injects `LOOM_SAVE_LOGS=1` into the child's env. The runtime
 *  reads that variable inside `runAgent` and tees each agent's stream to
 *  `logs/<agent>.log`. Env-var threading (rather than another argv slot)
 *  keeps the compile-time emit unchanged — the flag is an orthogonal
 *  runtime-only concern that pipelines don't know about.
 *
 *  `invocationCwd` is the directory where the user ran `loom run` —
 *  threaded through to the runtime via the `LOOM_INVOCATION_CWD` env var
 *  so agent spawns (`runtime/agent.ts` + `runtime/human-gate.ts`) can pin
 *  their child's cwd to the invocation dir rather than the workspace dir.
 *  This matters because modern claude CLI refuses to read absolute paths
 *  outside its cwd; user-supplied ticket files live in/under invocation
 *  cwd, not the workspace. Output `produces:` paths are absolutified
 *  upstream so writes still land in the workspace dir regardless of the
 *  spawn cwd. Env-var threading mirrors the `LOOM_SAVE_LOGS` /
 *  `LOOM_FORCE_RUNNER` pattern — keeps the compile-time emit unchanged. */
export function runChild(
  runner: string,
  args: string[],
  tmpDir: string,
  saveLogs = false,
  workspaceCwd: string = process.cwd(),
  invocationCwd: string = process.cwd(),
): Promise<number> {
  return new Promise((resolve, reject) => {
    const baseEnv = saveLogs ? { ...process.env, LOOM_SAVE_LOGS: '1' } : { ...process.env };
    const env = { ...baseEnv, LOOM_INVOCATION_CWD: invocationCwd };
    const child = spawn(runner, args, { stdio: 'inherit', cwd: workspaceCwd, env });
    let settled = false;
    const cleanup = (): void => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    };
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (signal) {
        const signum = os.constants.signals[signal as NodeJS.Signals];
        // Fall back to 1 if Node hands us a signal name not in the table.
        resolve(typeof signum === 'number' ? 128 + signum : 1);
      } else {
        // Defensive: `code === null` without a signal shouldn't happen for
        // a successfully-spawned child, but map to 1 (failure) rather than 0.
        resolve(code ?? 1);
      }
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
  });
}

/** Best-effort startup sweep for orphan temp directories left behind by
 *  prior runs that crashed before `runChild`'s cleanup could fire. macOS
 *  and Linux ship periodic `os.tmpdir()` cleaners that would eventually
 *  reclaim these, but Windows does not — without this sweep, hard crashes
 *  on Windows would accumulate `loom-*` dirs forever. Errors are swallowed
 *  on every layer (readdirSync, statSync, rmSync) so a permissions hiccup
 *  on one entry never blocks the actual run. */
export function sweepOrphanTmpDirs(): void {
  try {
    const tmpRoot = os.tmpdir();
    const entries = readdirSync(tmpRoot, { withFileTypes: true });
    const now = Date.now();
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('loom-')) continue;
      const full = path.join(tmpRoot, entry.name);
      try {
        const stat = statSync(full);
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          rmSync(full, { recursive: true, force: true });
        }
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}

/** Rewrite the emitted `const AGENT_DIRS = [...]` line so the project
 *  layer (index 0) is absolute when the source path was relative. The
 *  compiled pipeline is spawned with `cwd = workspaceCwd`, so the
 *  runtime's `loadAgentSystemPrompt` would resolve a relative project-
 *  layer dir against the workspace dir (where no `.claude/agents/`
 *  exists). Compile-time validation already ran from invocation cwd
 *  and confirmed every referenced persona file is present somewhere in
 *  the layered set; pinning the project literal to its absolute form
 *  preserves that resolution after the chdir.
 *
 *  The global layer (`~/.<cli>/agents/`, index 1) stays tilde-prefixed
 *  — `expandHome` in the runtime handles tilde expansion lazily, which
 *  keeps the compiled `.ts` portable across machines (the global layer
 *  is anchored to whatever home dir the script eventually runs against,
 *  not the build machine's home dir).
 *
 *  Convention: `agentDirs[0]` is the project layer (cwd-relative or
 *  absolute), and entries 1+ are home-relative (tilde-prefixed). The
 *  compile-side derivation in `src/compile/index.ts:compile()` is the
 *  source of truth for this ordering — if it adds a layer between project
 *  and global, this rewrite needs to know which indexes need absolutification.
 *
 *  Pass-through cases for the project layer:
 *   - Absolute path (`/home/me/agents/` or `C:\...\` on Windows).
 *   - `~/`-prefixed path — the runtime's `expandHome` handles it.
 *   - Anything not matching the expected emit shape — passes through
 *     unchanged.
 *
 *  Defense-in-depth against a future `AGENT_DIRS` rename in `compile/index.ts`
 *  lives in OTHER tests, not this function: `compile/index.test.ts` and the
 *  `module-level constants prologue` describe block in
 *  `compile/emit-walker.test.ts` pin the constant name in the emit shape,
 *  and `cli.test.ts`'s integration test asserts the rewritten absolute
 *  literal is present in the spawned `.mjs`. A rename would trip those
 *  guards; this function itself silently no-ops on shape mismatch. The
 *  `loom run` caller adds a trip-wire assertion AFTER calling this
 *  function so the silent no-op can't ship through to a spawned child
 *  reading the wrong path. */
export function absolutifyAgentDirsInEmit(emit: string, invocationCwd: string): string {
  return emit.replace(/^const AGENT_DIRS = (\[.*?\]);$/m, (whole, jsonArrayLiteral) => {
    const parsed: unknown = JSON.parse(jsonArrayLiteral);
    // Defensive narrowing: the regex above accepts anything that JSON-
    // parses as an array, but the compile-side emit only ever produces
    // `string[]`. If the shape ever drifts (a future emit including
    // numbers, objects, etc.), fall through to unchanged emit rather
    // than throwing a misleading TypeError downstream.
    if (!Array.isArray(parsed) || !parsed.every((x): x is string => typeof x === 'string')) {
      return whole;
    }
    const rewritten = parsed.map((dir, idx) => {
      // Only the project layer (index 0) needs absolutification.
      // The global layer (index 1+) is tilde-prefixed and handled by
      // the runtime's expandHome.
      if (idx !== 0) return dir;
      if (path.isAbsolute(dir) || dir.startsWith('~/') || dir === '~') return dir;
      const absolute = path.resolve(invocationCwd, dir);
      // Preserve the trailing separator if the source had one.
      const withSep =
        dir.endsWith('/') && !absolute.endsWith(path.sep) ? absolute + path.sep : absolute;
      return withSep;
    });
    return `const AGENT_DIRS = ${JSON.stringify(rewritten)};`;
  });
}

/** Derive the `.mermaid` companion path for a given TS-output path.
 *
 *  Strips `.ts` or `.mjs` (the two extensions emit can target today) and
 *  appends `.mermaid`. For any other extension (or no extension), appends
 *  `.mermaid` without stripping — defensive against weird user inputs:
 *  silently overwriting `build/p.out` as `build/p.mermaid` would surprise
 *  the user, but `build/p.out.mermaid` is unambiguous. */
export function mermaidPathFor(outputPath: string): string {
  if (outputPath.endsWith('.ts')) {
    return outputPath.slice(0, -3) + '.mermaid';
  }
  if (outputPath.endsWith('.mjs')) {
    return outputPath.slice(0, -4) + '.mermaid';
  }
  return outputPath + '.mermaid';
}

export async function main(): Promise<number> {
  const [, , cmd, ...rest] = process.argv;

  if (cmd === 'compile') {
    // `--resume-from` is a `loom run`-only flag; resume has no meaning at
    // compile time (the .ts file is static). Symmetric with the existing
    // `--mermaid-only` rejection on `run`.
    if (rest.includes('--resume-from')) {
      console.error(
        "Error: --resume-from is a 'loom run'-only flag; resume has no meaning at compile time.",
      );
      return 1;
    }
    const { args: compileArgs, mermaidOnly } = stripMermaidOnlyFlag(rest);
    const [input, output] = compileArgs;
    if (!input || !output) {
      console.error(
        'Usage: loom compile [--mermaid-only] <pipeline-name|pipeline.yaml> <output.ts>',
      );
      return 1;
    }
    const pipelinePath = resolvePipeline(input);
    const spec = parseSpec(pipelinePath);
    // The `<output.ts>` arg has the same meaning in both modes: it names
    // the compiled-script target. `mermaidPathFor` derives the diagram
    // path alongside it. `--mermaid-only` differs only in suppressing the
    // .ts write — the path semantic of the arg is unchanged.
    const mermaidPath = mermaidPathFor(output);

    if (mermaidOnly) {
      // Skip compile() (and its validateAgentFilesExist pass) entirely —
      // emitMermaid is purely structural and renders correctly for YAML
      // whose agent persona files don't yet exist.
      writeFileSync(mermaidPath, emitMermaid(spec));
      console.log(`✓ Wrote diagram for ${pipelinePath} → ${mermaidPath}`);
      return 0;
    }

    // Default dual-emit path. `compile` re-parses internally (running
    // validateAgentFilesExist + the scope walker) — a micro-cost we
    // accept rather than churning compile()'s public signature to take a
    // pre-parsed spec. `compile` emits the portable `'agenticloom/runtime'` form
    // so the user can read, version, and ship the output without any
    // absolute paths baked in.
    writeFileSync(output, compile(pipelinePath));
    try {
      writeFileSync(mermaidPath, emitMermaid(spec));
    } catch (err: any) {
      // Surface partial state: the .ts is already on disk by this point. A
      // generic `Error: ENOSPC` from the top-level wrapper would not tell
      // the user that the load-bearing artifact (the .ts) is present and
      // only the view is missing. Re-throw with context.
      throw new Error(
        `compiled ${output}, but failed to write diagram to ${mermaidPath}: ${err.message ?? err}`,
      );
    }
    console.log(`✓ Compiled ${pipelinePath} → ${output} (+ ${mermaidPath})`);
    return 0;
  }

  if (cmd === 'run') {
    // Best-effort sweep before the main run; safe to fail. Runs only on the
    // `run` path because `compile` doesn't create any temp dirs.
    sweepOrphanTmpDirs();

    // `--mermaid-only` is a compile-only flag. If it leaked into a `run`
    // invocation it would silently shift the pipeline's `inputs:` slots
    // (the flag would land as `process.argv[2]` for the spawned child).
    // Loud-fail early so the user catches the typo at the CLI boundary.
    if (rest.includes('--mermaid-only')) {
      console.error(
        "Error: --mermaid-only is a compile-only flag. Use 'loom compile --mermaid-only ...' instead.",
      );
      return 1;
    }

    const [pipeline, ...rawRest] = rest;
    if (!pipeline) {
      console.error(
        'Usage: loom run <pipeline-name|pipeline.yaml> [args...] [--id <name>] [--save-logs] [--resume-from <bind>]',
      );
      return 1;
    }

    const invocationCwd = process.cwd();

    // Two consecutive strip layers — `--save-logs` (env-var flag) and
    // `--resume-from` (cursor flag). `cleanedArgv` is the baton flowing
    // through workspace-ID resolution + file-arg absolutification; both
    // strips remove their environmental flags so positional pipeline
    // inputs aren't shifted by a flag's presence.
    const { args: afterSaveLogsStrip, saveLogs } = stripSaveLogsFlag(rawRest);
    const { args: cleanedArgv, resumeFrom } = stripResumeFromFlag(afterSaveLogsStrip);

    if (resumeFrom !== undefined && !cleanedArgv.includes('--id')) {
      console.error('Error: --resume-from requires --id <name>');
      return 1;
    }

    // Resolve the workspace ID BEFORE absolutifying so the filename-basename
    // inference matches against the user's original argv shape.
    const pipelineName = path.basename(pipeline, path.extname(pipeline));
    const { id, passthrough } = resolveWorkspaceId({
      argv: cleanedArgv,
      cwd: invocationCwd,
      pipelineName,
    });
    const workspaceDir = path.resolve(invocationCwd, 'loom', 'runs', id);
    if (resumeFrom !== undefined && !existsSync(workspaceDir)) {
      // Resumption with no prior workspace has nothing to resume from;
      // silently creating the dir and running from scratch would produce a
      // different run shape than the user asked for. Loud-fail instead.
      console.error(
        `Error: --resume-from '${resumeFrom}' requires the workspace dir to already exist; ` +
          `'${workspaceDir}' was not found. (Omit --resume-from for a fresh run, or use --id <existing-name> ` +
          `to point at the prior workspace.)`,
      );
      return 1;
    }
    if (resumeFrom !== undefined) {
      // parseSpec is the same call compile() makes; one extra parse buys us
      // cursor errors at the CLI boundary with full context (top-level bind
      // list, retry-zone bounds, container-kind label for nested cursors)
      // BEFORE any compile work happens.
      const pipelinePathForValidation = resolvePipeline(pipeline);
      const spec = parseSpec(pipelinePathForValidation);
      const { topLevel, nested, retryZones } = enumerateTopLevelBinds(spec.flow);
      if (!topLevel.has(resumeFrom)) {
        if (nested.has(resumeFrom)) {
          const enclosing = nested.get(resumeFrom)!;
          console.error(
            `Error: --resume-from cursor must name a top-level bind; ` +
              `'${resumeFrom}' is declared inside ${enclosing}. ` +
              `Nested cursors are deferred to a future release; target the enclosing top-level container's bind instead.`,
          );
          return 1;
        }
        const available = Array.from(topLevel.keys())
          .map((b) => `'${b}'`)
          .join(', ');
        console.error(
          `Error: --resume-from cursor '${resumeFrom}' does not name any bind in the pipeline. ` +
            `Available top-level binds: ${available || '(none)'}.`,
        );
        return 1;
      }
      // Resolve the cursor's top-level index via the same two-stage rule
      // emit() uses: direct top-level match, then hoisted-child fallback
      // collapsing to the enclosing parallel's position. topLevel.has
      // already accepted the cursor so this resolution must succeed; if
      // it doesn't, the structural check (`enumerateTopLevelBinds`) and
      // this lookup have drifted and we throw loud so the regression
      // surfaces on the next test run rather than silently letting the
      // cursor sneak past zone validation.
      let cursorIdx = -1;
      for (let i = 0; i < spec.flow.length; i++) {
        if (getBindNameFromFlowItem(spec.flow[i]) === resumeFrom) {
          cursorIdx = i;
          break;
        }
      }
      if (cursorIdx < 0) {
        for (let i = 0; i < spec.flow.length; i++) {
          const item = spec.flow[i] as any;
          if ('parallel' in item) {
            for (const child of item.parallel) {
              if (getBindNameFromFlowItem(child) === resumeFrom) {
                cursorIdx = i;
                break;
              }
            }
            if (cursorIdx >= 0) break;
          }
        }
      }
      if (cursorIdx < 0) {
        throw new Error(
          `Internal: enumerateTopLevelBinds/getBindNameFromFlowItem drifted; ` +
            `cursor '${resumeFrom}' accepted by structural check but no top-level index found.`,
        );
      }
      for (const zone of retryZones) {
        // Boundary inclusion rules:
        //   - cursorIdx === retryFromIdx → ALLOWED (the zone's resumption
        //     anchor; the rewrite emits the target's line as a `const`
        //     literal and the retry path's `let` doesn't collide on that
        //     own line).
        //   - retryFromIdx < cursorIdx ≤ gateIdx → REJECTED. The gate IS
        //     the last member of its zone; naming it (or any strictly-
        //     interior member) as the cursor would leave intermediate
        //     zone-member `let` slots undeclared by the pre-cursor rewrite
        //     (which emits `const`), breaking the retry callback's
        //     re-assignment contract.
        if (cursorIdx > zone.retryFromIdx && cursorIdx <= zone.gateIdx) {
          const retryFromName =
            getBindNameFromFlowItem(spec.flow[zone.retryFromIdx]) ?? '<unknown>';
          console.error(
            `Error: --resume-from cursor '${resumeFrom}' falls inside a retry zone ` +
              `(between '${retryFromName}' and the ${zone.gateLabel} gate). ` +
              `Cursor-inside-retry-zone is not yet supported; rerun without --resume-from, ` +
              `or pick a cursor outside the retry zone.`,
          );
          return 1;
        }
      }
    }
    mkdirSync(workspaceDir, { recursive: true });

    // Absolutify file-args (against invocation cwd) so the child's chdir
    // doesn't break their resolution.
    const absolutifiedArgs = absolutifyFileArgs({
      args: passthrough,
      cwd: invocationCwd,
    });

    const pipelinePath = resolvePipeline(pipeline);
    const tempExt = runningTypeScriptSource ? 'ts' : 'mjs';
    // Per-run tmp dir under os.tmpdir() — the compiled temp file lives
    // here, not in invocation cwd. Cleanup removes the whole dir on exit.
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'loom-'));
    const tmp = path.join(tmpDir, `pipeline.${tempExt}`);

    // For the throwaway temp file, inject an absolute file:// URL to the
    // runtime so resolution works regardless of the user's cwd / node_modules
    // layout (the cwd is theirs, not loom's, and may have no loom in scope).
    // Also rewrite the emitted `AGENT_DIRS` constant's project layer to
    // absolute, since the child runs from the workspace cwd and the runtime
    // resolves a relative layer entry relative to whatever cwd it's invoked
    // in. The global (tilde-prefixed) entry stays portable and is expanded
    // by the runtime's expandHome at lookup time.
    const emit = compile(pipelinePath, { runtimeImport: runtimeUrl, resumeFrom });
    const rewritten = absolutifyAgentDirsInEmit(emit, invocationCwd);
    // Trip-wire: absolutifyAgentDirsInEmit silently no-ops if the regex
    // doesn't match. Without this guard, a future emit-shape drift would
    // silently ship a `.mjs` with a relative project-layer entry that the
    // spawned child (chdir'd into the workspace) would then mis-resolve.
    // Fail loud at the loom-run boundary instead.
    {
      // Use matchAll to assert exactly ONE AGENT_DIRS declaration in the
      // emit. A future multi-pipeline emit producing two such lines would
      // leave the second unchecked by absolutifyAgentDirsInEmit (which uses
      // a non-global regex and rewrites only the first match); the trip-
      // wire catches that drift here.
      const matches = [...rewritten.matchAll(/^const AGENT_DIRS = (\[.*?\]);$/gm)];
      if (matches.length === 0) {
        throw new Error(
          `loom run: failed to locate AGENT_DIRS in compiled emit. ` +
            `This indicates the compile module and cli.ts have drifted out of sync — file a bug.`,
        );
      }
      if (matches.length > 1) {
        throw new Error(
          `loom run: found ${matches.length} AGENT_DIRS declarations in compiled emit (expected exactly 1). ` +
            `This indicates the emit shape has drifted; absolutifyAgentDirsInEmit rewrites only the first match. File a bug.`,
        );
      }
      const parsed = JSON.parse(matches[0][1]) as unknown;
      // Accept-condition mirrors absolutifyAgentDirsInEmit's pass-through:
      // an absolute path, OR any tilde-prefixed path (bare '~' and '~/...').
      // A future change must keep this in sync with the function's accept
      // set, otherwise the trip-wire either false-positives or false-negs.
      const isAcceptable = (d: unknown): boolean =>
        typeof d === 'string' && (path.isAbsolute(d) || d === '~' || d.startsWith('~/'));
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error(
          `loom run: AGENT_DIRS is empty or not an array after rewrite: ${JSON.stringify(parsed)}. ` +
            `The runtime has no layer to look up agents against; refusing to spawn.`,
        );
      }
      // Validate EVERY entry, not just parsed[0]. Today's compile module
      // only emits [project, global] where project is the candidate for
      // absolutification and global is tilde-prefixed; but a future addition
      // (e.g., a built-in stdlib layer at index 2) must also be absolute or
      // tilde-prefixed before the spawned child can resolve it after chdir
      // into the workspace dir. Generalizing the check now means the
      // trip-wire stays correct when new layers land, without a maintainer
      // having to remember to widen the index check.
      for (const [idx, entry] of parsed.entries()) {
        if (!isAcceptable(entry)) {
          throw new Error(
            `loom run: AGENT_DIRS entry ${idx} is still relative after rewrite: ${JSON.stringify(entry)} ` +
              `(full array: ${JSON.stringify(parsed)}). The runtime would resolve agents against the workspace dir; refusing to spawn.`,
          );
        }
      }
    }
    writeFileSync(tmp, rewritten);

    const runner = runningTypeScriptSource ? 'tsx' : 'node';
    return await runChild(
      runner,
      [tmp, ...absolutifiedArgs],
      tmpDir,
      saveLogs,
      workspaceDir,
      invocationCwd,
    );
  }

  console.error(
    'Usage:\n  loom compile [--mermaid-only] <pipeline-name|pipeline.yaml> <output.ts>\n  loom run <pipeline-name|pipeline.yaml> [args...] [--id <name>] [--save-logs]',
  );
  return 1;
}

/** Top-level error wrapper. Prints `error.message` cleanly for typed errors,
 *  with one expansion: a spawn-ENOENT (the runner binary isn't on PATH) gets
 *  a remediation hint, since the raw `spawn tsx ENOENT` text isn't actionable
 *  for users. `LOOM_DEBUG=1` bypasses all formatting.
 *
 *  Guarded by the standard ESM entry-point check so importing the module from
 *  a test file does not fire `main()` + `process.exit` at module-load. The
 *  guard is the ESM equivalent of `if (require.main === module)`. Both sides
 *  are realpath-resolved before comparison: `import.meta.url` already gives
 *  the resolved path, but `process.argv[1]` retains the user-typed form, so
 *  symlinked entry-points (most notably `npm link`'s bin shim, e.g.
 *  `/opt/homebrew/bin/loom` → `dist/cli.js`) would otherwise fail to match. */
const argv1 = process.argv[1];
let isEntryPoint = false;
if (argv1 !== undefined) {
  try {
    isEntryPoint = fileURLToPath(import.meta.url) === realpathSync(argv1);
  } catch (err) {
    // argv[1] points at a path we can't resolve (stale/deleted/symlink loop).
    // Treat as "not the entry point" so importers (e.g., tests) aren't
    // crashed at module load just because the harness's argv[1] doesn't
    // exist on disk. LOOM_DEBUG=1 surfaces the underlying error since the
    // outer main-error handler (which normally honors LOOM_DEBUG) never runs
    // when we swallow here.
    if (process.env.LOOM_DEBUG) {
      console.error('LOOM_DEBUG: realpathSync(process.argv[1]) failed:', err);
    }
    isEntryPoint = false;
  }
}
if (isEntryPoint) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      if (process.env.LOOM_DEBUG) {
        console.error(err);
      } else if (err instanceof z.ZodError) {
        console.error('Pipeline schema error:');
        // Walk via flattenZodIssues so union-member nested errors (the
        // field-specific failures hiding under "Invalid input") surface
        // instead of collapsing to the outer bullet. Path+message Set
        // de-dups symmetric members that produced identical issues.
        const seen = new Set<string>();
        for (const issue of flattenZodIssues(err.issues)) {
          const where = issue.path.length ? issue.path.join('.') : '(root)';
          const key = `${where}\0${issue.message}`;
          if (seen.has(key)) continue;
          seen.add(key);
          console.error(`  - ${where}: ${issue.message}`);
        }
        console.error('(set LOOM_DEBUG=1 to see the full stack)');
      } else if (
        err &&
        err.code === 'ENOENT' &&
        typeof err.syscall === 'string' &&
        err.syscall.startsWith('spawn')
      ) {
        const missing = err.path ?? 'the runner';
        console.error(`Error: command not found on PATH: ${missing}`);
        if (missing === 'tsx') {
          console.error(
            'Install it with `npm install -D tsx`, or use the built version (`npm run build`).',
          );
        } else if (missing === 'node') {
          console.error('Ensure Node.js is on PATH.');
        }
        console.error('(set LOOM_DEBUG=1 to see the full stack)');
      } else {
        console.error(`Error: ${err.message ?? err}`);
        console.error('(set LOOM_DEBUG=1 to see the full stack)');
      }
      process.exit(1);
    },
  );
}
