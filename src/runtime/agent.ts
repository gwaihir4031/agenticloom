import { spawn } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { RollingWindow } from '../RollingWindow.js';
import { formatStreamEvent, formatApiRetry, extractPrimaryArg } from './stream.js';
import type { StreamEvent } from './stream.js';

/** Thrown by retry-shaped primitives when their author opted into hard-fail on
 *  exhaustion (`step.on_fail.on_max_exceeded: 'fail'`,
 *  `aggregate.on_max_exceeded: 'fail'`, or `review_loop.on_max_exceeded: 'fail'`).
 *  Downstream catch handlers (notably `foreach.on_iteration_fail: continue`)
 *  use `instanceof HaltPipelineError` to distinguish "the pipeline author
 *  explicitly chose to fail" from "a generic runtime error" — explicit halts
 *  propagate even through continue-mode handlers; generic errors can be
 *  caught and skipped. The class carries no extra fields beyond `.name` — the
 *  `instanceof` tag is the entire mechanism. */
export class HaltPipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HaltPipelineError';
  }
}

export type AgentCli = 'claude' | 'copilot';
export type AgentRole = 'step' | 'reviewer' | 'writer';

/** Per-call configuration for `runAgent`. The compiler bakes pipeline-level
 *  values (cli/agentDirs/defaultExtraArgs) into module-level constants and
 *  passes them via this options bag. Per-step overrides (yaml `extra_args:`)
 *  flow through as `extraArgs` and REPLACE the pipeline default (no concat). */
export interface RunAgentOpts {
  cli: AgentCli;
  /** Layered persona-file lookup directories — project layer first, global
   *  layer second. Layer convention is owned by the compiler (see
   *  `src/compile/index.ts:AGENT_DIR_DEFAULTS` for per-cli paths). Persona
   *  resolution at spawn time is delegated to the CLI via `--agent` (the CLI
   *  walks up from the spawn cwd to find the persona file), so the runtime no
   *  longer reads this list itself; it remains in the options bag because the
   *  compiler still emits it. Must be non-empty; each entry must be absolute
   *  or tilde-prefixed by the time the spawned child runs (`loom run` asserts
   *  this via the trip-wire in cli.ts). */
  agentDirs: string[];
  /** When set, runAgent takes the inline (general-agent) spawn form: there is
   *  no persona file to delegate to, so this baked prompt IS the agent's
   *  identity. It is prepended to the task (the `prompt` arg) with a
   *  blank-line/---/blank-line separator to form the `-p` value, and the spawn
   *  passes NO `--agent` flag (the agent runs with all tools). Its PRESENCE is
   *  the discriminator: undefined selects the persona form, where the CLI
   *  resolves `<name>`'s persona file via `--agent` and the `-p` value is the
   *  task alone. Compile bakes the YAML inline `prompt:` here as static text;
   *  persona steps leave it undefined. */
  inlinePrompt?: string;
  extraArgs: string[];
  role?: AgentRole;
  /** Per-call timeout in milliseconds. On expiry the child receives SIGTERM
   *  and the promise rejects with `agent '<name>' timed out after <ms>ms`.
   *
   *  YAML-sourced pipelines have this validated as a positive integer by the
   *  `StepItem` Zod schema at compile time. Programmatic callers (loom's own
   *  internal `reviewLoop` writerOpts/reviewerOpts, hand-written tests, future
   *  embedders) are responsible for passing a positive integer themselves —
   *  the runtime does not re-validate. Default when unset is 30 minutes
   *  (`30 * 60 * 1000` ms). */
  timeout?: number;
  /** Declared input file paths the agent reads BEFORE its spawn. The runtime
   *  validates each entry's existence via `requireFile` before the child
   *  spawns; a missing file loud-fails with the agent's name and the missing
   *  path so no agent runs against absent inputs. Pipeline-input bind values
   *  and literal-string args flow through here too — anything the compile
   *  classifies as path-shaped is included.
   *
   *  Populated by `computeInputPaths` in compile — the resolved set is
   *  emitted into every `runAgent(...)` call's options bag so the runtime
   *  enforces existence on the same data the compile already knows.
   *
   *  Undefined (or empty) skips the check — used for steps that declare no
   *  inputs. The pre-spawn check is the safety net that makes resumed runs
   *  loud-fail at the first downstream consumer instead of hallucinating
   *  mid-agent; on non-resumed runs the same check catches silent-empty /
   *  wrong-path failures that the post-spawn output check alone misses. */
  inputPaths?: string[];
}

/** Discriminator for the two file-consumption boundaries `requireFile` is
 *  wired into. The tag determines the thrown message wording:
 *  - `consuming-input`: pre-spawn input check (an agent is about to read a
 *    declared input it didn't produce). Message: "agent '<X>' requires input
 *    file '<path>' which does not exist".
 *  - `reading-output`: orchestrator-side read of an agent's expected output
 *    (e.g. `readAgentFile` consuming what an upstream producer was supposed
 *    to write). Message: "agent '<X>' did not write expected file: <path>".
 *  Both branches read identical existsSync semantics; only the diagnostic
 *  wording differs so failures surface with the right framing for the boundary
 *  that caught them. */
export type RequireFileContext =
  | { kind: 'consuming-input'; agent: string }
  | { kind: 'reading-output'; agent: string };

/** Validate that a path exists on disk, returning the absolute form. Used at
 *  every file-consumption boundary — the pre-spawn input check in `runAgent`,
 *  the agent-file read path in `readAgentFile` — to guarantee "no agent runs
 *  against a missing file."
 *
 *  Paths are resolved against the runtime cwd (the workspace dir for compiled
 *  pipelines) so relative path-literals from the emit (e.g. bind values like
 *  `"SPEC.md"`) become unambiguous absolute paths before the existsSync probe.
 *
 *  Fail-fast: throws on the first miss. Batching multiple-missing errors into
 *  a single throw is deferred. */
export function requireFile(filePath: string, context: RequireFileContext): string {
  const abs = path.resolve(filePath);
  if (!existsSync(abs)) {
    if (context.kind === 'consuming-input') {
      throw new Error(`agent '${context.agent}' requires input file '${abs}' which does not exist`);
    }
    throw new Error(`agent '${context.agent}' did not write expected file: ${abs}`);
  }
  return abs;
}

/** Generic step postscript. Agent writes whatever its output shape is to a
 *  path; downstream consumers read that path via their own tools. */
function stepPostscript(producesPath: string): string {
  return `\n\nWrite your output to: ${producesPath}\nOverwrite if the file already exists.`;
}

/** Writer-in-review-loop postscript. Pins the artifact format (prose
 *  Markdown, not an envelope) so writer agents can drop format-spec text
 *  from their prompt files. */
function writerPostscript(producesPath: string): string {
  return `\n\nWrite your artifact (Markdown prose) to: ${producesPath}\nOverwrite if the file already exists.\nDo not emit the artifact to stdout; the file at that path is the source of truth.`;
}

/** Reviewer-in-review-loop postscript. Owns the JSON shape spec so reviewer
 *  agents can drop it from their prompt files. */
function reviewerPostscript(producesPath: string): string {
  return `\n\nWrite your review to: ${producesPath}
Overwrite if the file already exists.

Use this JSON shape:
{
  "status": "pass" | "fail",
  "findings": [
    {
      "severity": "blocker" | "major" | "nit",
      "summary": "single-line one-sentence summary",
      "details_md": "Multi-paragraph Markdown with the full prose, code fences, etc."
    }
  ]
}

Emit "status": "pass" if there are no blocker or major findings (nit-only is a pass).
You MAY include additional top-level fields (e.g. "reviewer_notes").
Do not emit prose to stdout; the verdict lives in the JSON file's "status" field.`;
}

/** Extract the agent names claude reported loading from an init event's
 *  `agents` field. Returns null when the field is absent or not an array
 *  (older CLIs don't emit it), so callers skip enforcement entirely rather
 *  than conflating "unknown roster" with "empty roster". Entries are the
 *  frontmatter `name:` values — bare strings today, tolerated as
 *  `{name: string}` objects too; anything else is skipped. */
function loadedAgentNames(agents: unknown): string[] | null {
  if (!Array.isArray(agents)) return null;
  const names: string[] = [];
  for (const entry of agents) {
    if (typeof entry === 'string') {
      names.push(entry);
    } else if (typeof entry === 'object' && entry !== null) {
      const n = (entry as Record<string, unknown>).name;
      if (typeof n === 'string') names.push(n);
    }
  }
  return names;
}

/** Cap on the rolling stderr failure tail, in UTF-16 code units. The reader
 *  retains only the trailing slice so a runaway-chatty child can't blow memory,
 *  while a failed run still carries the death reason on its reject message. Same
 *  8K floor the interactive gate uses (STDERR_CAPTURE_CAP in human-gate.ts);
 *  duplicated, not shared, because the two capture sites are independent (this
 *  one reads readline-split lines; the gate reads StringDecoder-decoded chunks); the
 *  shared 8K is a convention the two may diverge from, not an enforced invariant.
 *  The unit is code units, not bytes — for non-BMP content the slice may split a
 *  surrogate pair, leaving a lone surrogate that renders as one U+FFFD glyph at
 *  the boundary, acceptable for a diagnostic memory floor. */
const STDERR_TAIL_CAP = 8 * 1024;

/** Spawn the configured CLI for this agent and stream its output through a
 *  RollingWindow renderer. Returns the producesPath when set, otherwise the
 *  trimmed text content the agent emitted.
 *
 *  Per-call options carry the pipeline's cli choice + agent persona-file
 *  location + the effective extra_args (pipeline default OR per-step
 *  override, REPLACED not merged so per-step overrides can drop every
 *  default cleanly) + optional per-call timeout.
 *
 *  Two spawn forms, discriminated by `opts.inlinePrompt`:
 *  - Persona (inlinePrompt undefined): the CLI resolves `<name>`'s persona
 *    file natively via `--agent <name>` (added to the argv) and applies its
 *    declared `tools:`; the `-p` value is the task alone.
 *  - Inline (inlinePrompt defined): there is no persona file, so the baked
 *    prompt is the agent's identity — prepended to the task with a
 *    blank-line/---/blank-line separator — and no `--agent` is passed, so the
 *    agent runs with all tools.
 *  In both forms `name` stays the display/log label, and the role postscript
 *  (step/writer/reviewer) is appended to the assembled `-p` value when
 *  `producesPath` is set.
 *
 *  Claude path: spawns with `--output-format stream-json --verbose
 *  --include-partial-messages`; the line handler routes each JSONL event
 *  through `formatStreamEvent` for display and captures the final `result`
 *  event's telemetry (turns, cost, stop_reason) for the RollingWindow's
 *  collapse line. Text deltas accumulate into the trimmed return value when
 *  `producesPath` is unset. Persona spawns additionally audit the init
 *  event's agent roster: claude exits 0 when `--agent <name>` doesn't
 *  resolve, so a roster that omits the requested name rejects mid-stream
 *  (child killed) instead of letting the run continue persona-less.
 *
 *  Copilot path: streams raw stdout line-by-line through the same
 *  RollingWindow; the trimmed accumulator is the return value when
 *  `producesPath` is unset.
 *
 *  TTY mode (default in real terminals): a 25-row scrolling window per agent
 *  collapses to `✓ <name> (...)` on success / `✗ <name> (...)` on failure.
 *  Non-TTY mode (CI / piped runs): plain line streaming to stdout.
 *
 *  Timeout: per-call `opts.timeout` (ms) defaults to 30 minutes. On expiry the
 *  child receives SIGTERM and the promise rejects with
 *  `agent '<name>' timed out after <ms>ms`.
 *
 *  SIGINT (parent Ctrl-C): forwarded as SIGTERM to the spawned child so it
 *  can clean up its terminal state. Signal-killed children (`code === null`)
 *  reject as "killed by signal" — interrupted runs do not silently consume.
 *
 *  Optional log tee: when `LOOM_SAVE_LOGS=1` is set in the environment (the
 *  `loom run --save-logs` flag exports this), the RollingWindow tees committed
 *  lines to `logs/<name>.log` in append mode.
 *
 *  When `producesPath` is set, the role-specific postscript (step / writer /
 *  reviewer) is appended to the prompt and the post-exit `existsSync` check
 *  loud-fails if the agent didn't write the expected file. The returned string
 *  is the path, not stdout — downstream agents read the file via their own
 *  tools; orchestrator primitives use `readAgentFile`. */
export async function runAgent(
  name: string,
  prompt: string,
  producesPath?: string,
  opts?: RunAgentOpts,
): Promise<string> {
  if (!opts) {
    throw new Error(
      `runAgent: opts is required (cli, agentDirs, extraArgs). ` +
        `This is a compile-time-guaranteed contract — the emit should always pass opts.`,
    );
  }
  // Defense at the runtime contract boundary: catch emit bugs where a
  // compile-time `??` collapsed an input expression away or a closure
  // forwarded an undefined revise-prompt as the prompt arg. The TS signature
  // already pins `prompt: string`, but the emitted JS is unchecked at
  // runtime — a bad emit silently passes `undefined` into the spawned
  // agent's args bag where it stringifies as the literal text "undefined".
  if (typeof prompt !== 'string') {
    throw new Error(
      `runAgent: prompt must be a string (got ${prompt === undefined ? 'undefined' : typeof prompt}) ` +
        `for agent '${name}'. This is a compile-time-guaranteed contract — the emit should always ` +
        `pass a defined string. A failure here points to a broken compile-time substitution.`,
    );
  }
  // Pre-spawn input check: validate every declared input path exists on disk
  // BEFORE spawning; fail-fast on first miss. Catches resumed-run pre-cursor
  // file gaps and silent-empty / wrong-path drift on every run.
  if (opts.inputPaths !== undefined) {
    for (const inputPath of opts.inputPaths) {
      requireFile(inputPath, { kind: 'consuming-input', agent: name });
    }
  }
  const role = opts.role ?? 'step';
  // Persona vs inline fork (see RunAgentOpts.inlinePrompt). Persona: the CLI
  // resolves <name>'s persona file natively via --agent (added to the argv
  // below), so the -p value is the task alone. Inline: no persona file exists,
  // so the baked prompt is the agent's identity, prepended to the task with the
  // blank-line/---/blank-line separator.
  let fullPrompt =
    opts.inlinePrompt === undefined ? prompt : `${opts.inlinePrompt}\n\n---\n\n${prompt}`;

  // Absolutify the produces path against the runtime's cwd (the workspace dir
  // set up by `cli.ts` via `cwd: workspaceCwd`). The bind value returned below
  // is the canonical file location, NOT a relative-to-cwd path; downstream
  // consumers (interactive humanGate, `Its output is at: ${refName}` prompts
  // built by compile/scope.ts's wrapPathRef, retry closures) interpolate the bind
  // value verbatim into prompts handed to spawned agents. Without
  // absolutification, those agents resolve the relative path against their
  // own spawn cwd — which under the LOOM_INVOCATION_CWD threading is the
  // user's invocation dir, NOT the workspace — and produce paths that land
  // outside the run's workspace. Modern claude CLI also refuses to read
  // absolute paths outside its cwd in both `-p` and `--agent` modes, so
  // any out-of-cwd reference needs to be both absolute and within the
  // claude-permitted tree; the absolutification here covers the first half,
  // and the cwd= argument on the spawn (set below) covers the second.
  const producesPathAbs = producesPath ? path.resolve(producesPath) : undefined;

  if (producesPathAbs) {
    if (role === 'reviewer') fullPrompt += reviewerPostscript(producesPathAbs);
    else if (role === 'writer') fullPrompt += writerPostscript(producesPathAbs);
    else fullPrompt += stepPostscript(producesPathAbs);
  }

  // Per-CLI base argv. Claude gets stream-JSON args so we can render its
  // progress in real time; copilot has no equivalent flag set, so it streams
  // raw stdout. Persona agents append `--agent <name>` so the CLI resolves the
  // persona file and its tools natively; inline agents add nothing (their
  // identity rides in the -p value above and they run with all tools).
  // extraArgs from per-step override (or pipeline default) flow through verbatim.
  const agentDelegation: string[] = opts.inlinePrompt === undefined ? ['--agent', name] : [];
  const base: Record<AgentCli, [string, string[]]> = {
    claude: [
      'claude',
      [
        '-p',
        fullPrompt,
        '--permission-mode',
        'acceptEdits',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        ...agentDelegation,
      ],
    ],
    copilot: ['copilot', ['-p', fullPrompt, '--allow-all-tools', '--no-color', ...agentDelegation]],
  };
  const [bin, args] = base[opts.cli];
  const finalArgs = [...args, ...opts.extraArgs];

  // The header label carries the cli suffix so logs from pipelines mixing
  // CLIs stay attributable; `RollingWindow.start()` renders it as `→ <label>`
  // (TTY mode) or as a plain line (non-TTY). `logPath` is sourced from the
  // `LOOM_SAVE_LOGS` env var that `loom run --save-logs` sets — a string path
  // when the flag was passed, null otherwise. Env-var threading (rather than
  // another option on RunAgentOpts) keeps the compile-time emit unchanged: the
  // flag is an orthogonal runtime-only concern that pipelines don't know
  // about. Path is per-agent-name (not per-(agent,cli)) so a re-run with a
  // different cli appends to the same audit-trail file.
  const logPath = process.env.LOOM_SAVE_LOGS === '1' ? `logs/${name}.log` : null;
  const window = new RollingWindow(`${name} (${opts.cli})`, logPath);
  window.start();

  // Agent's cwd is the invocation dir (where the user ran `loom run`),
  // NOT the workspace dir the surrounding runtime process runs from. This
  // lets the agent read files passed by the user (ticket inputs, etc.)
  // which live in/under the invocation dir — modern claude CLI refuses to
  // read absolute paths outside its cwd, so handing it the workspace dir
  // would break every pipeline whose first agent reads a user-supplied
  // file. Output `produces:` paths are absolutified upstream (see
  // `producesPathAbs` above) so writes still land in the workspace dir
  // regardless of cwd. `LOOM_INVOCATION_CWD` is set by `cli.ts:runChild`;
  // the `process.cwd()` fallback covers direct runtime imports (tests,
  // external embedders) where no cli was in the loop.
  const agentCwd = process.env.LOOM_INVOCATION_CWD ?? process.cwd();
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, finalArgs, { cwd: agentCwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    let textBuffer = '';
    // Run-scoped api_retry accumulator, folded into the window's result
    // telemetry on every retry event (not just at the terminal `result`) so the
    // summary survives a run that dies mid-retry-storm before any result event.
    // `retryCategory` is last-write-wins across retries; `retryExhausted` latches
    // true once an attempt reaches its ceiling and never reverts.
    let retryCount = 0;
    let retryCategory: string | undefined;
    let retryExhausted = false;
    // Rolling tail of the child's stderr — the last STDERR_TAIL_CAP UTF-16 code
    // units, reconstructed line-by-line in the stderr reader below. The THIRD
    // stderr sink (after the process.stderr echo and the --save-logs log tee);
    // surfaced on the agent/cli-death reject paths via withStderrTail so a
    // failed run always names why the child died, with or without --save-logs.
    // Deliberately separate from textBuffer: stderr is diagnostic, never part
    // of the no-producesPath work product.
    let stderrTail = '';
    // Append the captured tail (when it carries non-whitespace) under a
    // labelled delimiter so the death reason rides along with the base reject
    // message; return the base unchanged when nothing meaningful was captured
    // so clean errors stay clean. The trim-before-gate means a child that
    // printed only blank stderr lines (stderrTail = '\n') counts as "nothing
    // captured" — no bare `--- stderr (tail) ---` header over an empty body.
    // The appended tail's single trailing newline is stripped so the rendered
    // error ends on the last diagnostic line, not a dangling blank one.
    const withStderrTail = (base: string): string =>
      stderrTail.trim() === ''
        ? base
        : `${base}\n--- stderr (tail) ---\n${stderrTail.replace(/\n$/, '')}`;
    // Set when the parent receives SIGINT (Ctrl-C). Read in the exit handler:
    // even if the child exits with code 0 (claude can clean up gracefully on
    // SIGINT) AND the producesPath file exists, runAgent must REJECT — otherwise
    // the surrounding review_loop / parallel / pipeline keeps marching to the
    // next agent. Without this flag the previous code resolved on
    // graceful-SIGINT-exit, surprising users who expect Ctrl-C to stop the run.
    let interruptedBySigint = false;

    const onSigint = (): void => {
      interruptedBySigint = true;
      child.kill('SIGTERM');
    };
    process.once('SIGINT', onSigint);

    // Per-call timeout. The default (30 min) lives here, not in the emit, so
    // changing the default doesn't require recompiling pipelines. The handler
    // checks `settled` defensively — if a normal exit + the timer-firing
    // race, the first settler wins; `cleanup()` (called by both exit and
    // error handlers) clears the timer so a normal exit can't trigger a
    // late rejection on an already-resolved promise.
    const timeoutMs = opts.timeout ?? 30 * 60 * 1000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Inline the SIGINT-off step rather than calling cleanup(): cleanup()
      // also calls clearTimeout(timer), and we're inside the timer's own
      // handler — clearTimeout on a firing timer is a no-op but reads as
      // self-referential. Spelling out the SIGINT removal keeps intent clear.
      process.off('SIGINT', onSigint);
      child.kill('SIGTERM');
      window.finish('error');
      // Append whatever stderr was captured before the SIGTERM above — a
      // timed-out run still names the cause if the child printed one.
      reject(new Error(withStderrTail(`agent '${name}' timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    const cleanup = (): void => {
      process.off('SIGINT', onSigint);
      clearTimeout(timer);
    };

    // Mini-mode tool-call state machine. Each tool_use block enters at
    // `content_block_start`, streams its argument JSON via input_json_delta
    // fragments, and exits at `content_block_stop`. We accumulate fragments
    // until stop, then parse the JSON and pull the primary argument to show
    // alongside the tool name (e.g., the file_path for Read). Cleared per
    // tool block so different tools don't leak state into each other.
    let currentTool: { name: string; argsBuffer: string } | null = null;

    if (child.stdout) {
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', (line: string) => {
        if (opts.cli === 'claude') {
          // Parse the JSONL event; accumulate text deltas into textBuffer for
          // the no-producesPath return path; feed anything visible to the
          // rolling window via the formatter. `result` events carry telemetry
          // (turns, cost, stop reason) that surfaces on the collapsed
          // summary line; capture it via `setResult` rather than feeding it
          // as visible content.
          if (!line.trim()) return;
          let evt: StreamEvent;
          try {
            evt = JSON.parse(line) as StreamEvent;
          } catch {
            // Not JSON — emit verbatim so unparseable lines (stderr leak,
            // pre-flight notice, etc.) aren't silently dropped. Diverges from
            // `formatStreamEvent`'s null-on-invalid-JSON behavior: the
            // formatter suppresses non-JSON because content_block_delta
            // surrounding it would repaint the slot; the window's `feed` has
            // no such repaint, so passing the raw line through is the right
            // default for the no-block case.
            window.feed(line + '\n');
            return;
          }
          // JSON.parse-valid-but-not-an-object (scalar or array): treat like
          // the catch path — dereferencing `evt.type` on `null`/`42`/`[1,2]`
          // would throw inside the readline 'line' callback and escape as
          // `uncaughtException`. Same fall-through as the unparseable case.
          if (typeof evt !== 'object' || evt === null || Array.isArray(evt)) {
            window.feed(line + '\n');
            return;
          }
          // Persona-spawn init audit. claude (observed on 2.1.170) exits 0
          // with no stderr when `--agent <name>` doesn't resolve — it silently
          // runs the prompt persona-less with the full default toolset — so
          // the exit handler alone can never catch a dropped persona. The init
          // event's `agents` array names every agent claude actually loaded;
          // when the requested name is missing from a present roster, kill the
          // child and reject before the persona-less run does real work.
          // Enforcement is gated on the roster being a real array (older CLIs
          // that omit it stay tolerated) and on the persona spawn form (inline
          // spawns pass no --agent, so there is nothing to verify). On a
          // passing roster this branch falls through so the init event still
          // reaches the display paths below.
          if (evt.type === 'system' && evt.subtype === 'init' && opts.inlinePrompt === undefined) {
            const loaded = loadedAgentNames(evt.agents);
            if (loaded !== null && !loaded.includes(name)) {
              if (settled) return;
              settled = true;
              cleanup();
              child.kill('SIGTERM');
              window.finish('error');
              reject(
                new Error(
                  `claude did not load agent '${name}' — the spawn would run persona-less. ` +
                    `claude registers agents by their frontmatter 'name:' field, resolving ` +
                    `.claude/agents/ from the spawn cwd up to the git root, plus ` +
                    `~/.claude/agents. Check the persona file's 'name:' frontmatter matches ` +
                    `'${name}', that the file is visible from ${agentCwd}, and that its ` +
                    `frontmatter includes a description: (claude refuses to register agents ` +
                    `without one). ` +
                    `Agents claude loaded: ${loaded.length === 0 ? '(none)' : `[${loaded.join(', ')}]`}.`,
                ),
              );
              return;
            }
          }
          if (evt.type === 'result') {
            window.setResult({
              num_turns: evt.num_turns,
              total_cost_usd: evt.total_cost_usd,
              stop_reason: evt.stop_reason,
            });
            return;
          }
          if (
            evt.event?.type === 'content_block_delta' &&
            evt.event?.delta?.type === 'text_delta'
          ) {
            textBuffer += evt.event.delta.text ?? '';
          }
          // Capture api_retry telemetry mode-independently, BEFORE the
          // mini/full display split. Unlike the `result` branch above, this one
          // must NOT return: an api_retry still has to reach both render paths
          // below (full-mode formatStreamEvent in the else branch, mini-mode
          // mirror inside the isMini branch), so it falls through like the
          // text_delta check rather than short-circuiting. The setResult call
          // records the running summary now so it persists even if the run dies
          // before the terminal `result` event.
          if (evt.type === 'system' && evt.subtype === 'api_retry') {
            retryCount++;
            if (evt.error) retryCategory = evt.error;
            // max_retries > 0 keeps a degenerate 0/0 event from spuriously latching.
            if (
              evt.attempt != null &&
              evt.max_retries != null &&
              evt.max_retries > 0 &&
              evt.attempt >= evt.max_retries
            ) {
              retryExhausted = true;
            }
            window.setResult({
              retry_count: retryCount,
              retry_category: retryCategory,
              retry_exhausted: retryExhausted,
            });
          }
          // Display path differs by mode. In full mode (sequential agents)
          // the 25-row box has room for text deltas + tool args + everything
          // formatStreamEvent renders. In mini mode (parallel agents, 3
          // content rows), feeding the full stream fills the box with one
          // long input_json_delta blob — by the time the user identifies
          // the tool, the window has scrolled past. Show one line per
          // tool_use: `◇ <name>: <primary arg>` (e.g., `◇ Read: ACS.md`).
          // The primary arg is extracted from the accumulated JSON at
          // `content_block_stop`; tools not in the primary-arg table get
          // the bare name (`◇ <name>`).
          if (window.isMini) {
            // api_retry is a `system` event carrying no content_block, so it
            // sits outside the tool-call state machine below. Mirror full
            // mode's retry line through the same helper so the two display
            // modes never drift.
            if (evt.type === 'system' && evt.subtype === 'api_retry') {
              window.feed(formatApiRetry(evt));
              return;
            }
            const e = evt.event;
            if (e?.type === 'content_block_start' && e?.content_block?.type === 'tool_use') {
              currentTool = { name: e.content_block.name ?? '?', argsBuffer: '' };
            } else if (
              e?.type === 'content_block_delta' &&
              e?.delta?.type === 'input_json_delta' &&
              currentTool !== null
            ) {
              currentTool.argsBuffer += e.delta.partial_json ?? '';
            } else if (e?.type === 'content_block_stop' && currentTool !== null) {
              const primary = extractPrimaryArg(currentTool.name, currentTool.argsBuffer);
              const display =
                primary !== null
                  ? `  ◇ ${currentTool.name}: ${primary}\n`
                  : `  ◇ ${currentTool.name}\n`;
              window.feed(display);
              currentTool = null;
            }
          } else {
            const formatted = formatStreamEvent(line);
            if (formatted !== null) window.feed(formatted);
          }
        } else {
          // copilot: raw stdout. Accumulate for the no-producesPath text return; render live to the rolling window.
          textBuffer += line + '\n';
          window.feed(line + '\n');
        }
      });
    }

    // fd 2 is piped (not inherited), so read the child's stderr line by line
    // exactly as stdout is read above. Each line tees to its LIVE sinks:
    // (a) an echo back out on the parent's process.stderr — preserving
    // today's fd-2 destination, now line-oriented rather than the byte-shared
    // fd that `inherit` gave (immaterial for the diagnostic-only stderr of
    // loom's `-p` agents); (b) the window's marked --save-logs sink, itself a
    // silent no-op when --save-logs is off; (c) the rolling failure tail
    // (STDERR_TAIL_CAP-capped), surfaced on the agent/cli-death reject paths
    // via withStderrTail. stderr is deliberately kept OUT of `textBuffer`: the
    // no-producesPath return value is the agent's stdout work product alone.
    // readline flushes the final unterminated line on stream end, so a
    // newline-less last diagnostic still reaches all three sinks.
    if (child.stderr) {
      const errLines = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
      // Drop a low-level pipe read fault rather than let an unhandled stream
      // 'error' become an uncaughtException — that would bypass BOTH the
      // friendly-cli-errors surface and the stderr tail this reader exists to
      // provide. The guard MUST be on errLines, not child.stderr: readline
      // attaches its own input listener and RE-EMITS the input's 'error' onto
      // the interface, so a listener on child.stderr alone does NOT prevent the
      // crash (the re-emitted error lands on errLines with no handler). The
      // exit/error reject handlers below still report the death. (The
      // pre-existing child.stdout reader has the same latent gap; left as a
      // separate, out-of-scope follow-up.)
      errLines.on('error', () => {});
      errLines.on('line', (line: string) => {
        process.stderr.write(line + '\n');
        window.logStderrLine(line);
        // Third sink: append to the rolling failure tail, reconstructing the
        // newline readline stripped, then trim to the trailing cap.
        stderrTail += line + '\n';
        if (stderrTail.length > STDERR_TAIL_CAP) stderrTail = stderrTail.slice(-STDERR_TAIL_CAP);
      });
    }

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      window.finish('error');
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(
          new Error(
            withStderrTail(
              `'${opts.cli}' not found on PATH. Install the cli before running an agent.`,
            ),
          ),
        );
        return;
      }
      reject(new Error(withStderrTail(err.message), { cause: err }));
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      // SIGINT short-circuit: a user Ctrl-C must halt the entire pipeline,
      // regardless of how the child reported the exit. Claude (and other CLIs)
      // may handle SIGINT gracefully — cleaning up their TUI and exiting with
      // code 0 — which would otherwise look identical to a clean run and let
      // review_loop / parallel march on to the next agent.
      if (interruptedBySigint) {
        window.finish('error');
        reject(new Error(`${opts.cli} (${name}) interrupted by Ctrl-C`));
        return;
      }
      if (code !== 0 && code !== null) {
        window.finish('error');
        reject(new Error(withStderrTail(`${opts.cli} (${name}) exited with code ${code}`)));
        return;
      }
      // code === null typically means signal-killed (Ctrl-C). Treat as failure
      // so callers don't silently consume an interrupted run.
      if (code === null) {
        window.finish('error');
        reject(new Error(withStderrTail(`${opts.cli} (${name}) was killed by signal`)));
        return;
      }
      if (producesPathAbs) {
        if (!existsSync(producesPathAbs)) {
          window.finish('error');
          reject(
            new Error(
              withStderrTail(`agent '${name}' did not write expected file: ${producesPathAbs}`),
            ),
          );
          return;
        }
        window.finish('ok');
        resolve(producesPathAbs);
        return;
      }
      window.finish('ok');
      resolve(textBuffer.trim());
    });
  });
}

/** Pins the escaping rules an LLM most often gets wrong in prose-bearing
 *  fields. The prefix `"failed to parse as JSON"` is a load-bearing string:
 *  the test-broken-then-fixed-reviewer fixture matches it as the
 *  retry-detection signal that distinguishes a first call from a retry.
 *  Reword carefully. */
export function buildCorrectivePrompt(filePath: string, errorDetail: string): string {
  return `Your previous output at ${filePath} failed to parse as JSON. First error: ${errorDetail}.

Read your previous file with your Read tool, find the issue, and rewrite the file with valid JSON. Escape any literal " as \\" and any literal \\ as \\\\ inside string values.`;
}
