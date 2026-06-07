import { spawn } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import { StringDecoder } from 'string_decoder';
import { formatDuration, activateAltScreen, deactivateAltScreen } from '../RollingWindow.js';
import type { AgentCli } from './agent.js';

/** Options for the interactive `human_gate` mode. The plain y/N mode takes
 *  no arguments (call `humanGate()`); interactive mode is selected by passing
 *  an options object with `interactive: true`.
 *
 *  Caller contract: `opts.input` is treated as absolute or
 *  workspace-relative; `spawnInteractiveAgent` absolutifies it via
 *  `path.resolve(opts.input)` (against the runtime cwd = workspace dir)
 *  before handing it to the agent. The agent's Write tool, given an
 *  absolute path, overwrites that exact location regardless of the
 *  spawn cwd — which is the invocation dir, NOT the workspace dir, so
 *  the agent's READ side can see user-supplied project files. */
export interface InteractiveGateOpts {
  interactive: true;
  /** Cli choice from the pipeline header. Loom currently supports `claude`
   *  and `copilot`; the schema enum enforces this at compile time. */
  cli: AgentCli;
  /** Layered persona-file lookup directories — project layer first, global
   *  layer second. Layer convention is owned by the compiler (see
   *  `src/compile/index.ts:AGENT_DIR_DEFAULTS` for per-cli paths). Persona
   *  resolution at spawn time is delegated to the cli via `--agent <name>`
   *  (the cli resolves the persona file itself), so the runtime no longer
   *  reads this list; it remains in the options bag because the compiler
   *  still emits it. */
  agentDirs: string[];
  /** Extra args to pass to the spawned cli. Compile emits the pipeline-level
   *  `DEFAULT_EXTRA_ARGS` constant here by default; the YAML can override
   *  per-gate via `extra_args:` on the interactive `human_gate` (REPLACES the
   *  default, doesn't concat — mirrors `StepItem.extra_args` so per-gate
   *  overrides can drop every default cleanly). The field is required on
   *  this interface because the runtime always receives a concrete array
   *  from the emit; the optional/fallback shape lives at compile time. */
  extraArgs: string[];
  /** Agent name; passed to the cli as `--agent <name>`, which resolves the
   *  matching `<dir>/<agent>.md` persona file natively. */
  agent: string;
  /** Path to the artifact the agent edits. Loom auto-appends "The artifact
   *  is at: <input>" to the agent's initial message. Absolute or relative;
   *  relative paths are resolved against the runtime cwd (the workspace
   *  dir). Callers from compile-emitted code thread an already-absolute
   *  bind value; external embedders may pass either form. */
  input: string;
  /** Initial message sent to the spawned agent. Agent-facing only — the
   *  human deliberately ran the pipeline and already knows the stage; there
   *  is no human-facing prompt field (see cross-session memory
   *  `feedback_no_redundant_human_prompts`). */
  prompt: string;
}

/** Fail loud if either stdin or stdout isn't a TTY. Loom's human gate needs
 *  stdin to read user input AND stdout to render prompts; without both, the
 *  readline.question callback never fires (closed stdin) or its prompt is
 *  invisible (piped stdout). Same posture across plain-mode confirm and
 *  interactive-mode spawn — no silent fall-back. The optional `context`
 *  threads through the error message so users can tell which gate failed
 *  (e.g. the failing agent name in interactive mode). */
function requireTTYForHumanGate(context?: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const ctx = context !== undefined ? ` ${context}` : '';
    throw new Error(
      `human_gate${ctx} requires a TTY for both stdin and stdout. ` +
        'Run in a real terminal (or `docker run -it ...` inside a container).',
    );
  }
}

/** Ask y/N on stdin; throw if not y. Used both as the plain-mode gate and as
 *  the post-REPL confirmation step in interactive mode. */
async function confirmYesOrThrow(): Promise<void> {
  requireTTYForHumanGate();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise<string>((r) => rl.question(`⏸  Continue? [y/N] `, r));
  rl.close();
  if (!/^y/i.test(ans)) throw new Error('Pipeline halted by human gate.');
}

/** Spawn the interactive agent session for a `human_gate` with
 *  `interactive: true`. Both clis delegate persona resolution natively via
 *  `--agent <name>`: claude takes `--agent <name>` plus the initial message
 *  as a positional argv; copilot takes `--agent <name>` plus
 *  `-i/--interactive <prompt>` to open its TUI with the prompt pre-loaded as
 *  turn 1. Neither path bakes the persona body into the prompt — the cli
 *  reads the persona file itself, so the prompt value is the loom-built
 *  initial message alone.
 *
 *  TTY check first: if stdin or stdout isn't a TTY (e.g. CI, piped script,
 *  non-`-it` docker), throw with a clear remediation — silent fall-back
 *  would hide the gate's purpose, and compile-time refusal would add
 *  friction to every local run. */
async function spawnInteractiveAgent(opts: InteractiveGateOpts): Promise<void> {
  requireTTYForHumanGate(`interactive mode for agent '${opts.agent}'`);

  // The full initial message: loom-built prompt + the auto-appended path
  // pointer the spec calls for. Emitted exactly once (the compile-side YAML
  // doesn't include the "The artifact is at:" line — runtime owns it so the
  // shape is consistent across pipelines and agent prompt files).
  //
  // Absolutify defensively. Current callers thread `opts.input` from a
  // runAgent/reviewLoop bind value, which is already absolute (runAgent
  // resolves producesPath at entry), so this is a no-op for those callers.
  // The interactive REPL `claude --agent` resolves bare relative filenames
  // against $HOME rather than the inherited cwd; handing it an absolute path
  // removes that ambiguity for the agent's READ side. The WRITE side is also
  // safe via this absolutification: the agent's Write tool overwrites the
  // exact absolute path baked into the initial message regardless of the
  // child's cwd. The `cwd:` argument on the spawn calls below is for the
  // READ side only — the child is spawned in the invocation dir so the
  // agent can see user-supplied project files (see the comment block at
  // the spawn site, ~60 lines below).
  const inputAbs = path.resolve(opts.input);
  const initialMessage = `${opts.prompt}\n\nThe artifact is at: ${inputAbs}`;

  console.log(`⏸  HUMAN GATE: interactive session with ${opts.agent}`);

  // Stderr capture for both clis. The alt-screen wrapper below makes the
  // spawned cli's chat output ephemeral — but it also wipes any diagnostic
  // message the cli printed to stderr on a fast/early exit (auth required,
  // unknown model, missing entitlement, ...). Buffering stderr while the
  // child runs and replaying it after deactivateAltScreen() means those
  // messages survive into the user's main-buffer scrollback right above
  // the y/N confirm. Ring-buffer cap keeps the trailing portion if the
  // child is unusually chatty, so a runaway log can't blow memory.
  //
  // Cap unit nuance: `stderrCapture.length` and the `slice(-CAP)` below
  // are JS-string operations measured in UTF-16 code units, not bytes.
  // For the expected use case (CLI auth/model/entitlement diagnostics,
  // largely ASCII) units equal bytes. For non-BMP content (emoji, CJK
  // supplementary plane) the cap drifts and the slice could split a
  // surrogate pair, leaving a lone surrogate that renders as one U+FFFD
  // glyph at the boundary. Both acceptable for a memory-safety floor on
  // diagnostic output.
  let stderrCapture = '';
  const STDERR_CAPTURE_CAP = 8 * 1024; // 8K UTF-16 code units; see note above.

  // Wrap the spawn in the alt-screen buffer so the claude/copilot chat output
  // is ephemeral — the user's main-buffer scrollback stays clean. Without this,
  // the entire REPL transcript lands in main buffer and clutters post-pipeline
  // history. The shared depth counter in RollingWindow handles re-entry
  // correctly if the spawned cli also enters alt buffer (idempotent no-op).
  //
  // The deactivate is wrapped in try/finally so every failure path — ENOENT
  // from `child.on('error', ...)`, non-zero exit, the defensive
  // unreachable-cli reject — pairs symmetrically with the activate above.
  // Without finally, those rejection paths skipped deactivate and left
  // `altScreenDepth` incremented + the terminal in alt buffer until the
  // `'exit'` safety-net `forceDeactivateAltScreen` ran (or — worse — left a
  // depth mismatch that corrupted later agents' alt-buffer entry/exit pairs).
  // Mirrors `parallel()`'s `.finally(() => exitParallelContext())` shape.
  activateAltScreen();
  try {
    await new Promise<void>((resolve, reject) => {
      let child;
      // Agent's cwd is the invocation dir (where the user ran `loom run`),
      // NOT the workspace dir the surrounding runtime process runs from.
      // This lets the interactive REPL see user-supplied files (tickets,
      // sibling project files the user references mid-session) — modern
      // claude CLI refuses to read absolute paths outside its cwd, so
      // handing it the workspace dir would block the user from referencing
      // anything in their actual project tree. The WRITE side stays safe
      // because `inputAbs` (above) is already an absolute path; the agent's
      // Write tool overwrites the artifact at that absolute location
      // regardless of its cwd.
      //
      // `LOOM_INVOCATION_CWD` is set by `cli.ts:runChild`; the
      // `process.cwd()` fallback covers direct runtime imports (tests,
      // external embedders) where no cli was in the loop.
      const childCwd = process.env.LOOM_INVOCATION_CWD ?? process.cwd();
      if (opts.cli === 'claude') {
        // `claude --agent <name> "<prompt>"` opens the REPL with the prompt
        // pre-loaded as the first user turn. extra_args from the pipeline
        // header flow through. Stdio shape rationale lives in the
        // stderr-capture block above.
        const args = ['--agent', opts.agent, ...opts.extraArgs, initialMessage];
        child = spawn('claude', args, { stdio: ['inherit', 'inherit', 'pipe'], cwd: childCwd });
      } else if (opts.cli === 'copilot') {
        // `copilot --agent <name> --interactive <prompt>` resolves the persona
        // natively (the same delegation as the claude path) and opens the TUI
        // with the prompt pre-loaded as turn 1. The `--interactive` value is
        // the loom-built initial message alone — the cli reads the persona
        // file itself, so nothing is baked in. Piping to stdin enters
        // non-interactive scripting mode (equivalent to `-p <text>`) and exits
        // without opening the TUI, which is why the TUI must be opened via the
        // `--interactive` flag instead.
        const args = ['--agent', opts.agent, ...opts.extraArgs, '--interactive', initialMessage];
        child = spawn('copilot', args, { stdio: ['inherit', 'inherit', 'pipe'], cwd: childCwd });
      } else {
        // Unreachable — schema enum is ['claude', 'copilot']. Defensive only.
        reject(
          new Error(
            `human_gate interactive mode: cli '${opts.cli}' is not supported (agent '${opts.agent}'). ` +
              `Loom currently supports 'claude' and 'copilot'. (Schema validation should have caught this.)`,
          ),
        );
        return;
      }
      // Stderr listener. Decoder handles utf-8 codepoints that straddle
      // chunk boundaries; raw `chunk.toString('utf8')` would replay a
      // U+FFFD at every split. Ring-buffer slice keeps the trailing cap
      // so a chatty child can't blow memory. Capture is read only in the
      // finally below — every 'data' event between listener-attach and
      // 'exit' resolving ends up in capture before the replay fires.
      const stderrDecoder = new StringDecoder('utf8');
      child.stderr!.on('data', (chunk: Buffer) => {
        stderrCapture += stderrDecoder.write(chunk);
        if (stderrCapture.length > STDERR_CAPTURE_CAP) {
          stderrCapture = stderrCapture.slice(-STDERR_CAPTURE_CAP);
        }
      });
      child.stderr!.on('end', () => {
        const tail = stderrDecoder.end();
        if (tail.length > 0) {
          stderrCapture += tail;
          if (stderrCapture.length > STDERR_CAPTURE_CAP) {
            stderrCapture = stderrCapture.slice(-STDERR_CAPTURE_CAP);
          }
        }
      });
      // Forward parent Ctrl-C to the child so its TUI can clean up its own
      // terminal state before exiting. Without forwarding, a Ctrl-C in the
      // inherited-stdio case can leave the terminal in raw mode if the
      // child doesn't get the signal first.
      //
      // SIGINT semantics: same posture as runAgent in agent.ts — see the
      // `interruptedBySigint` flag + `onSigint` handler + the exit-handler
      // short-circuit. The flag distinguishes "user typed /exit or otherwise
      // ended the REPL cleanly" (resolve → fall through to y/N) from "user
      // hit Ctrl-C to halt the pipeline" (reject → propagates up, halts the
      // run).
      // Without the flag, both paths landed at code === 0 || null and
      // resolved indistinguishably — Ctrl-C silently became "session
      // ended" and the pipeline marched on through the y/N to the next
      // step, surprising users who expect Unix-conventional Ctrl-C to
      // stop the work. The REPL's normal exit channel (/exit, Ctrl-D)
      // still routes through the resolve path because no SIGINT fires.
      let interruptedBySigint = false;
      const onSigint = (): void => {
        interruptedBySigint = true;
        child.kill('SIGTERM');
      };
      process.once('SIGINT', onSigint);
      child.on('error', (err) => {
        process.off('SIGINT', onSigint);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new Error(
              `'${opts.cli}' not found on PATH. Install the cli before running an interactive gate.`,
            ),
          );
          return;
        }
        reject(err);
      });
      child.on('exit', (code) => {
        process.off('SIGINT', onSigint);
        if (interruptedBySigint) {
          reject(new Error(`${opts.cli} (${opts.agent}) interrupted by Ctrl-C`));
          return;
        }
        if (code === 0 || code === null) {
          // null typically means signal-killed without our SIGINT
          // (parent didn't get Ctrl-C, but the child exited via some
          // other signal — treat as session ended; the y/N confirm
          // below is the real gate).
          resolve();
          return;
        }
        reject(new Error(`${opts.cli} (${opts.agent}) exited with code ${code}`));
      });
    });
  } finally {
    // Exit alt-screen so the y/N confirm prompt + collapse line both land in
    // main buffer where they persist in post-pipeline scrollback. Runs on
    // both resolution and rejection so the activate above is always paired
    // with exactly one deactivate.
    deactivateAltScreen();
    // Replay captured stderr to main buffer AFTER alt-screen tear-down so
    // any diagnostic message the child printed (auth required, unknown
    // model, the trailing error before a non-zero exit, ...) ends up in
    // post-pipeline scrollback right above the y/N confirm rather than
    // flickering through the alt buffer and being lost. Empty buffer ⇒
    // no-op for the clean-session case.
    if (stderrCapture.length > 0) {
      process.stderr.write(stderrCapture);
    }
  }
}

/** Human pause point. Two modes:
 *
 *  - Plain y/N (`humanGate()` with no args): a generic "Continue? [y/N]"
 *    prompt on stdin. Used for the "pause for external work" case where the
 *    user has done something outside the pipeline and wants to confirm.
 *
 *  - Interactive (`humanGate({ interactive: true, agent, input, prompt })`):
 *    spawns the named agent with the artifact path injected into its initial
 *    message; the user types directly to the agent (who can edit the
 *    artifact in place). On REPL exit, falls through to the y/N confirm.
 *    The file is the artifact; the agent's edits flow downstream because
 *    the bind points at the same path. */
export async function humanGate(opts?: InteractiveGateOpts): Promise<void> {
  const start = Date.now();
  if (opts !== undefined && opts.interactive === true) {
    await spawnInteractiveAgent(opts);
  }
  await confirmYesOrThrow();
  // Collapse the gate to a single line in main-buffer scrollback. Two
  // main-buffer lines need clearing first (interactive mode only):
  //   line N-1 (above cursor): `⏸  Continue? [y/N] y` (the readline prompt)
  //   line N-2: `⏸  HUMAN GATE: interactive session with <agent>`
  // For plain y/N mode, only the y/N prompt needs clearing — no announcement
  // was printed. Non-TTY skips the rewrite (the prompt + announcement aren't
  // meaningful in CI / piped contexts anyway).
  const elapsed = formatDuration(Date.now() - start);
  const tag =
    opts?.interactive === true
      ? `human gate (${opts.agent} · ${elapsed})`
      : `human gate (${elapsed})`;
  if (process.stdout.isTTY) {
    const linesToClear = opts?.interactive === true ? 2 : 1;
    for (let i = 0; i < linesToClear; i++) {
      process.stdout.write('\x1b[1A\x1b[2K\r');
    }
  }
  process.stdout.write(`  ↪ ${tag}\n`);
}
