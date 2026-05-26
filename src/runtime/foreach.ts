import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { HaltPipelineError } from './agent.js';

/** Options for the foreach runtime helper. */
export interface ForeachOpts {
  /** Resolved path to the JSONL file (absolute or relative-to-cwd). */
  over: string;
  /** Original YAML expression for `over:` (e.g. '$plan'), used in error
   *  messages so the user sees their intent, not the resolved path. */
  overLabel: string;
  /** YAML-supplied bind name. Unset when `foreach.bind:` was omitted; the
   *  helper falls back to `syntheticName` for the per-iteration dir layout. */
  bindName?: string;
  /** Fallback dir name when `bindName` is unset; also used by the retry
   *  callback to reproduce the same dir layout as the main pass. */
  syntheticName: string;
  /** Iteration error policy. */
  onIterationFail: 'abort' | 'continue';
  /** Per-iteration body callback. Receives the absolute path to the
   *  iteration's task.json plus the absolute iteration scratch directory
   *  (which is also process.cwd() while the body runs). Iteration index is
   *  intentionally NOT passed — agents read identifiers from task.json
   *  (e.g. task.id) rather than being handed the index. */
  body: (taskPath: string, iterScratchDir: string) => Promise<void>;
  /** Test-only override. Production emit never sets this; the runtime
   *  defaults to process.cwd(), which the CLI sets to the run dir
   *  (loom/runs/<id>/) before main() runs. */
  workspaceRoot?: string;
}

export interface ForeachResult {
  /** Absolute paths of the per-iteration scratch directories, in input
   *  order. Includes directories of iterations that failed under
   *  on_iteration_fail: continue. */
  iterDirs: readonly string[];
  /** Per-iteration failure messages, keyed by iteration index. Populated
   *  only when on_iteration_fail: continue caught a plain Error. Empty
   *  when every iteration succeeded or when abort mode re-threw. */
  failedIterations: Map<number, string>;
}

/** Iterate a JSONL file at runtime, running `body` once per non-empty line
 *  in a per-iteration scratch directory. The body callback runs with
 *  `process.cwd()` chdir'd to the iteration's scratch dir, so any relative
 *  `produces:` paths inside the body land there automatically.
 *
 *  Validation runs upfront: the entire file is read and every non-empty
 *  line is `JSON.parse`-checked at entry. A malformed line late in the
 *  file does not waste iteration spawns 0..K — the helper throws before
 *  iteration 0 starts. Empty/whitespace-only lines are skipped with a
 *  console warning (the trailing newline at EOF is silently ignored —
 *  splitting on '\n' produces a final empty token in the common case,
 *  which is not a "blank line" the user wrote).
 *
 *  `on_iteration_fail` controls the handler for body errors:
 *  - `'abort'` (default): re-throw, no further iterations run.
 *  - `'continue'`: catch the plain Error, warn, record it in
 *    `failedIterations`, and proceed to the next iteration.
 *
 *  `HaltPipelineError` ALWAYS propagates regardless of `on_iteration_fail`
 *  — an explicit fail from a nested step / aggregate / review_loop wins
 *  over the foreach's continue policy. */
export async function foreach(opts: ForeachOpts): Promise<ForeachResult> {
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  // Wrap the JSONL read with foreach context so a missing/unreadable file
  // surfaces with the user's `over:` expression instead of a bare ENOENT.
  let raw: string;
  try {
    raw = readFileSync(opts.over, 'utf-8');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `foreach over '${opts.overLabel}' (resolved to '${opts.over}'): cannot read JSONL file: ${msg}`,
      { cause: e instanceof Error ? e : undefined },
    );
  }
  const lines = raw.split('\n');
  const validLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') {
      // Suppress the warning for the trailing empty token that `split('\n')`
      // produces when the file ends with \n (the common case). A bare \n
      // at file end is not a "blank line" the user wrote.
      if (i === lines.length - 1) continue;
      console.warn(`⚠ foreach over '${opts.overLabel}': skipping line ${i + 1} (empty)`);
      continue;
    }
    try {
      JSON.parse(trimmed);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `foreach over '${opts.overLabel}': line ${i + 1} is not valid JSON: ${msg}.\n` +
          `The JSONL file must contain one JSON object per line; empty lines are allowed ` +
          `(skipped with a warning), but malformed JSON is not.`,
        { cause: e instanceof Error ? e : undefined },
      );
    }
    validLines.push(trimmed);
  }

  const dirName = opts.bindName ?? opts.syntheticName;
  const baseDir = resolve(workspaceRoot, dirName);
  const iterDirs: string[] = [];
  const failedIterations = new Map<number, string>();

  for (let n = 0; n < validLines.length; n++) {
    const iterDir = join(baseDir, `iter-${n}`);
    const taskPath = join(iterDir, 'task.json');
    // Wrap the scratch-dir setup with foreach context so an EACCES/ENOTDIR/
    // ENOSPC etc. surfaces with the user's `over:` expression instead of a
    // bare syscall trace. Both calls are infrastructure setup that should
    // atomically succeed before the iteration body runs; combining them under
    // one try mirrors the chdir wrap below — infrastructure failures bubble
    // regardless of onIterationFail, because attributing them to a per-
    // iteration body error would mask the syscall problem.
    try {
      mkdirSync(iterDir, { recursive: true });
      writeFileSync(taskPath, validLines[n]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `foreach over '${opts.overLabel}': cannot set up iteration ${n} scratch dir '${iterDir}': ${msg}`,
        { cause: e instanceof Error ? e : undefined },
      );
    }
    iterDirs.push(iterDir);

    // Mutates process.cwd() rather than threading cwd into runAgent calls
    // because step emit's runAgent + relative produces: paths anchor at
    // process.cwd() — sequential iteration makes the mutation safe, and
    // changing the spawn surface would touch every callsite. A future
    // concurrent-foreach variant would need cwd plumbing instead.
    const prevCwd = process.cwd();
    // The chdir into iterDir runs BEFORE the body's try-block so an
    // EACCES/ENOENT/etc on chdir bubbles regardless of onIterationFail —
    // a chdir failure attributed to a body error (via the catch below)
    // would surface as cryptic "iteration N failed: ENOENT, chdir ..."
    // and silently mask the syscall problem behind a per-iteration
    // continue. Wrap with foreach context so the user knows WHERE the
    // chdir failed.
    try {
      process.chdir(iterDir);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `foreach over '${opts.overLabel}': cannot chdir into iteration ${n} scratch dir '${iterDir}': ${msg}`,
        { cause: e instanceof Error ? e : undefined },
      );
    }
    try {
      await opts.body(taskPath, iterDir);
    } catch (e: unknown) {
      if (e instanceof HaltPipelineError) {
        throw e;
      }
      if (opts.onIterationFail === 'continue') {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`⚠ iteration ${n} failed: ${msg}; continuing`);
        failedIterations.set(n, msg);
        continue;
      }
      throw e;
    } finally {
      process.chdir(prevCwd);
    }
  }

  return { iterDirs, failedIterations };
}
