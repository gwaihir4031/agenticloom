import { createWriteStream, mkdirSync, type WriteStream } from 'fs';
import * as path from 'path';

const WINDOW_ROWS = 25;

// Prefix stamped on every stderr line teed into the per-agent log by
// `logStderrLine`, so a post-mortem reader can tell stderr apart from the
// stdout lines `commitLine` writes into the same merged `logs/<agent>.log`.
// The separator is the box-drawing light vertical U+2502 (│), not an ASCII
// pipe '|', so the marker stays visually distinct from the pipe characters
// that routinely appear in agent stderr (shell commands, tracebacks, tables).
const STDERR_LOG_MARKER = 'stderr│ ';

// Module-level alt-screen state. The terminal alt-screen buffer is entered
// per agent (on each `start()` in TTY mode) and exited per agent (on each
// `finish()`). A depth counter handles parallel cases where multiple agents
// are active simultaneously — depth>0 means alt is active. The collapse
// line each agent writes lands in the main buffer (after `finish()` has
// exited alt), so post-pipeline the user sees a clean timeline of agent
// invocations and human-gate events in their scrollback.
let altScreenDepth = 0;

// The `'exit'` safety-net listener registration is gated on a flag stored on
// `process` itself, keyed by an interned `Symbol.for(...)`. This survives
// `vi.resetModules()` (which the test suite uses for clean per-test module
// state): the JS runtime guarantees `Symbol.for('loom.altScreenExitHook')`
// returns the same symbol across re-imports, and the flag we set on
// `process` persists across module re-loads. Without this guard the test
// suite — which calls `vi.resetModules()` in many beforeEach blocks — would
// register a new `forceDeactivateAltScreen` listener per test (each
// re-import produces a fresh closure), trip Node's MaxListeners threshold
// (default 10), and emit a `MaxListenersExceededWarning` on stderr.
const EXIT_HOOK_KEY = Symbol.for('loom.altScreenExitHook');

// Collapse lines that finished WHILE alt-screen depth > 0 are buffered here
// instead of written directly. They flush to stdout when depth hits 0 (the
// LAST parallel sibling exits alt). Without this, parallel agents A and B
// that finish while sibling C is still running would have their collapse
// lines written into the alt buffer (lost when alt is deactivated) — only
// C's collapse line would survive in main scrollback. The buffer preserves
// finish-order across parallel siblings.
const pendingCollapseLines: string[] = [];

// Module-level parallel-context state. `runtime/parallel.ts`'s `parallel()` helper
// increments `parallelDepth` before kicking off tasks and decrements after
// they all resolve/reject. When `RollingWindow.start()` runs while
// `parallelDepth > 0`, the window switches to mini layout (4 rows: 1 header
// + 3 content, no box, absolute cursor positioning) so siblings render to
// distinct row ranges without colliding. `parallel()` cannot nest in loom
// (compile-time forbidden), so depth is always 0 or 1.
let parallelDepth = 0;

/** Total rows per mini-window: 1 header line + 3 content rows. 4 stacks 3
 *  parallel agents in 12 rows; fits any reasonable terminal. */
const MINI_ROW_COUNT = 4;

/** Row-range coordinator for mini-mode windows. Each parallel agent's
 *  `start()` calls `allocateMiniRows(this, MINI_ROW_COUNT)` to claim a
 *  contiguous row range starting at `nextStartRow`; `finish()` calls
 *  `releaseMiniRows(this)` to free it. When the last agent releases (active
 *  becomes empty), the cursor resets to row 1 so the next parallel block
 *  starts fresh.
 *
 *  Stacked layout: agents allocate sequentially as they start (first parallel
 *  agent at row 1, second at row 5, etc.). No compaction when a middle agent
 *  finishes — its rows stay frozen at the last rendered content until the
 *  whole block ends (no writer touches them after release; the alt buffer
 *  retains the pixels). Resize is not handled at row-range granularity in
 *  v1: if the terminal shrinks past the last row, content overflows the alt
 *  buffer (it's still there, just not visible). */
const miniLayout: {
  nextStartRow: number;
  active: Map<RollingWindow, { startRow: number; rowCount: number }>;
} = {
  nextStartRow: 1,
  active: new Map(),
};

function allocateMiniRows(window: RollingWindow, rowCount: number): number {
  const startRow = miniLayout.nextStartRow;
  miniLayout.active.set(window, { startRow, rowCount });
  miniLayout.nextStartRow += rowCount;
  return startRow;
}

function releaseMiniRows(window: RollingWindow): void {
  // Loud-fail on a release for a window that was never allocated. The current
  // `RollingWindow.finish()` already gates the call on `miniStartRow !==
  // undefined`, so this throw is unreachable today — but a future code path
  // that calls `releaseMiniRows` without the matching `allocateMiniRows`
  // would otherwise silently corrupt sibling allocations: the unconditional
  // `delete` is a no-op, but the `if (active.size === 0)` branch still fires
  // and resets `nextStartRow` to 1, so any later sibling-`start()` reuses a
  // row range already in use. Throw instead so the contract violation
  // surfaces at the call site rather than as scrambled output downstream.
  if (!miniLayout.active.has(window)) {
    throw new Error('miniLayout.releaseMiniRows: window not allocated');
  }
  miniLayout.active.delete(window);
  if (miniLayout.active.size === 0) {
    miniLayout.nextStartRow = 1;
  }
}

/** Increment the parallel-context depth counter. Called by `runtime/parallel.ts`'s
 *  `parallel()` helper before kicking off tasks. Public so the runtime can
 *  toggle the flag without re-importing the entire module state. */
export function enterParallelContext(): void {
  parallelDepth++;
}

/** Decrement the parallel-context depth counter. Called by `runtime/parallel.ts`'s
 *  `parallel()` after Promise.all settles (success or failure). */
export function exitParallelContext(): void {
  if (parallelDepth > 0) parallelDepth--;
}

/** Enter the terminal alt-screen buffer for the duration of an agent run.
 *
 *  Writing `\x1b[?1049h` switches the terminal to a separate display with no
 *  scrollback; the previous main-buffer content is preserved by the terminal
 *  and restored when we exit via `\x1b[?1049l`. Hiding the cursor
 *  (`\x1b[?25l`) keeps a blinking cursor from showing inside the box during
 *  rendering.
 *
 *  Per-agent (not per-process) for two reasons: (1) each agent's box only
 *  exists during its run, so alt-buffer ownership maps naturally to agent
 *  lifecycle; (2) writing the collapse line `✓ name (...)` AFTER exiting
 *  alt lands the line in main-buffer scrollback so the post-pipeline
 *  timeline is visible after loom exits.
 *
 *  Trade-off: the live agent content during the run is in the alt buffer
 *  and discarded by the terminal on exit. Persistent record is `--save-logs`
 *  (each agent's full stream tees to `logs/<agent>.log`). */
export function activateAltScreen(): void {
  if (altScreenDepth === 0) {
    process.stdout.write('\x1b[?1049h');
    process.stdout.write('\x1b[?25l');
    if (!(process as unknown as Record<symbol, unknown>)[EXIT_HOOK_KEY]) {
      // 'exit' is a final-safety cleanup: if a process exits with depth>0
      // (e.g., an exception during render before the matching `finish()`
      // could decrement), we still leave the terminal in main buffer.
      // Stored on `process` (not a module-local flag) so re-imports across
      // `vi.resetModules()` see the same flag and don't multi-register.
      process.on('exit', forceDeactivateAltScreen);
      (process as unknown as Record<symbol, unknown>)[EXIT_HOOK_KEY] = true;
    }
  }
  altScreenDepth++;
}

/** Exit the alt-screen buffer one level. When the last agent's `finish()`
 *  calls this and `altScreenDepth` reaches 0, the terminal returns to its
 *  main buffer (with whatever scrollback we'd written there — including
 *  earlier agents' collapse lines). */
export function deactivateAltScreen(): void {
  if (altScreenDepth === 0) return;
  altScreenDepth--;
  if (altScreenDepth === 0) {
    process.stdout.write('\x1b[?25h');
    process.stdout.write('\x1b[?1049l');
    // Flush any collapse lines that were deferred because depth was > 0
    // when their owners finished (parallel siblings still alive). Order
    // preserves finish-order, since `pendingCollapseLines.push` was called
    // by finish() in completion order.
    if (pendingCollapseLines.length > 0) {
      for (const line of pendingCollapseLines) process.stdout.write(line);
      pendingCollapseLines.length = 0;
    }
  }
}

/** Final-safety cleanup invoked on `'exit'`. If the per-agent decrement
 *  flow ran cleanly, depth is already 0 and this is a no-op. If an
 *  exception or hard error left depth>0, this restores the terminal so the
 *  user doesn't have to `reset` their terminal afterward. */
function forceDeactivateAltScreen(): void {
  if (altScreenDepth > 0) {
    process.stdout.write('\x1b[?25h');
    process.stdout.write('\x1b[?1049l');
    altScreenDepth = 0;
  }
}

/** Elapsed-time formatter shared between RollingWindow.finish() and
 *  humanGate (which writes its own `↪ human gate (...)` collapse line into
 *  the same timeline). */
export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/** Telemetry captured for the summary line, from two sources merged into one
 *  record by `setResult`: the terminal `result` event (turns, cost, stop
 *  reason) and the incremental retry summary accumulated as API retries
 *  happen (count, category, exhausted flag). `finish` renders it into the
 *  collapsed status line. */
export interface ResultMeta {
  num_turns?: number;
  total_cost_usd?: number;
  stop_reason?: string;
  retry_count?: number;
  retry_category?: string;
  // Recorded purely as structured data for a future auto-resume consumer:
  // never rendered and never branched on. The budget-exhausted case wants a
  // typed flag a later stage can read, not a visible signal in this run.
  retry_exhausted?: boolean;
}

/** 25-row rolling window for one agent's streaming output. New lines scroll in
 *  from the bottom; the oldest fall off the top. On `finish()` the window
 *  collapses to a single status line carrying elapsed time and (when set via
 *  `setResult`) telemetry from the `result` event. Optionally tees the full
 *  stream to a per-agent log file when `logPath` is non-null; callers that
 *  don't want a log file pass `null`. Falls back to plain line streaming when
 *  stdout is not a TTY (CI, piped output, redirects) so non-interactive
 *  contexts still see every line without ANSI clutter. */
export class RollingWindow {
  private lines: string[] = [];
  private currentLine = '';
  private logStream: WriteStream | null = null;
  private startTime = 0;
  private isTTY: boolean;
  private finished = false;
  private onResize?: () => void;
  private resultMeta?: ResultMeta;
  /** Set in `start()` when `parallelDepth > 0`. Mini mode uses absolute cursor
   *  positioning to a coordinator-assigned row range so siblings don't
   *  collide. `undefined` means the window is in full-box mode. */
  private miniStartRow?: number;

  /** True when this window is rendering in mini mode (parallel context).
   *  Public so the runAgent stream handler can choose what to feed: in mini
   *  mode it skips text deltas and JSON arguments and shows only one-line
   *  tool-name markers (`◇ Read`, `◇ Write`, etc.) — the 3-row content area
   *  is too small for full streaming. Full mode feeds everything as before. */
  get isMini(): boolean {
    return this.miniStartRow !== undefined;
  }

  constructor(
    private agentName: string,
    logPath: string | null,
  ) {
    if (logPath !== null) {
      mkdirSync(path.dirname(logPath), { recursive: true });
      this.logStream = createWriteStream(logPath, { flags: 'a' });
      // Async stream errors (EACCES, ENOSPC, EROFS, FS quota, NFS hiccup)
      // would otherwise escape as uncaughtException. Convert to a visible
      // diagnostic and disable further teeing — the agent run continues
      // via stdout, degraded but functional, instead of crashing.
      this.logStream.on('error', (err) => {
        console.error(`[loom] log tee error for ${this.agentName}: ${err.message}`);
        this.logStream = null;
      });
    }
    this.isTTY = !!process.stdout.isTTY;
  }

  start(): void {
    this.startTime = Date.now();
    this.logStream?.write(`\n=== ${this.agentName} started at ${new Date().toISOString()} ===\n`);

    if (this.isTTY) {
      activateAltScreen();
      if (parallelDepth > 0) {
        // Mini mode: coordinator assigns a contiguous row range; we render
        // only at those absolute positions so siblings don't collide.
        this.miniStartRow = allocateMiniRows(this, MINI_ROW_COUNT);
        // Render the header line once at the top of our range. Content rows
        // (rows startRow+1 .. startRow+MINI_ROW_COUNT-1) fill in via feed().
        process.stdout.write(`\x1b[${this.miniStartRow};1H`);
        process.stdout.write(`\x1b[2K`);
        process.stdout.write(`  ↪ ${this.agentName}`);
      } else {
        // Full mode: 25-row box at the current cursor position.
        const inner = this.innerWidth();
        process.stdout.write(`\n  → ${this.agentName}\n`);
        process.stdout.write(`  ┌${'─'.repeat(inner)}┐\n`);
        for (let i = 0; i < WINDOW_ROWS; i++) {
          process.stdout.write(`  │${' '.repeat(inner)}│\n`);
        }
        process.stdout.write(`  └${'─'.repeat(inner)}┘\n`);
      }
      // Repaint on terminal resize so widths track the new column count.
      // In mini mode `handleResize` just calls `render` (no box to repaint);
      // in full mode it re-emits header + borders + content.
      this.onResize = () => this.handleResize();
      process.stdout.on('resize', this.onResize);
    } else {
      process.stdout.write(`\n  → ${this.agentName}\n`);
    }
  }

  feed(text: string): void {
    if (!text) return;
    // Drop late feeds after finish() — readline events can still arrive
    // after a timeout fires `finish('error')` + ends the log stream;
    // writing to an ended stream raises `ERR_STREAM_WRITE_AFTER_END` as
    // an unhandled 'error' event. `commitLine()` writes the log stream
    // and is only reachable from here (and from `finish()` itself, which
    // already gates on `this.finished`), so this guard suffices.
    if (this.finished) return;
    let i = 0;
    while (i < text.length) {
      const nl = text.indexOf('\n', i);
      if (nl === -1) {
        this.currentLine += text.substring(i);
        break;
      }
      this.currentLine += text.substring(i, nl);
      this.commitLine();
      i = nl + 1;
    }
    if (this.isTTY) this.render();
  }

  /** Write one stderr line into the per-agent log stream, marked with
   *  `STDERR_LOG_MARKER` so a post-mortem reader can tell it apart from the
   *  stdout lines `commitLine` tees into the same file — the marked sibling of
   *  that stdout tee. Log-only by design: the live stderr echo and the failure
   *  tail are the caller's (runAgent's) responsibility, so this never touches
   *  `this.lines`/`this.currentLine`, stdout, or the collapse line. Callers
   *  pass readline-split lines carrying no trailing newline; the newline is
   *  appended here, in the same single write as the marker.
   *
   *  Two guards mirror the stdout path in `feed`/`commitLine`: the `finished`
   *  check drops late lines (finish() ends the log stream, so a stderr line
   *  arriving after a timeout race must not write-after-end), and the optional
   *  chain makes the method a no-op when `--save-logs` is off (logStream null). */
  logStderrLine(line: string): void {
    if (this.finished) return;
    this.logStream?.write(`${STDERR_LOG_MARKER}${line}\n`);
  }

  /** Sink for the collapsed summary line's telemetry, fed by two independent
   *  callers: the terminal `result` event (turns, cost, stop reason) and the
   *  incremental retry summary set as API retries happen (count, category,
   *  exhausted flag). Both write through this method at different times, so the
   *  provided fields are MERGED onto the existing record rather than replacing
   *  it — a retry-summary call must not clobber an earlier result event, and
   *  vice versa. The agent's prose verdict already streamed via text_delta and
   *  was fed into the window; this only keeps session-level metadata that
   *  `finish` surfaces in the icon line. */
  setResult(meta: ResultMeta): void {
    this.resultMeta = { ...this.resultMeta, ...meta };
  }

  finish(status: 'ok' | 'error'): void {
    if (this.finished) return;
    this.finished = true;
    if (this.onResize) {
      process.stdout.off('resize', this.onResize);
      this.onResize = undefined;
    }
    if (this.currentLine.length > 0) this.commitLine();

    const elapsed = formatDuration(Date.now() - this.startTime);
    this.logStream?.write(`\n=== ${this.agentName} finished: ${status} (${elapsed}) ===\n`);
    this.logStream?.end();

    const meta: string[] = [elapsed];
    if (this.resultMeta) {
      if (this.resultMeta.num_turns != null) meta.push(`${this.resultMeta.num_turns} turns`);
      if (this.resultMeta.total_cost_usd != null)
        meta.push(`$${this.resultMeta.total_cost_usd.toFixed(4)}`);
      if (this.resultMeta.stop_reason) meta.push(this.resultMeta.stop_reason);
      // Retry summary renders on both 'ok' and 'error': the budget-exhausted
      // path can die before a clean result event, but the incremental
      // setResult calls already populated retry_count here regardless.
      if (this.resultMeta.retry_count != null && this.resultMeta.retry_count > 0) {
        meta.push(
          this.resultMeta.retry_category
            ? `retried ${this.resultMeta.retry_count}× (${this.resultMeta.retry_category})`
            : `retried ${this.resultMeta.retry_count}×`,
        );
      }
    }
    const icon = status === 'ok' ? '✓' : '✗';
    const summary = `${icon} ${this.agentName} (${meta.join(' · ')})`;

    if (this.isTTY) {
      // Buffer the collapse line, then exit alt-screen one level. The
      // deactivate flushes the buffer iff depth hits 0 — so sequential
      // agents (depth was 1) write their line immediately, while parallel
      // siblings (depth was > 1) defer until the last sibling exits alt.
      pendingCollapseLines.push(`  ${summary}\n`);
      deactivateAltScreen();
      // Release the mini layout slot LAST (no-op in full mode where
      // miniStartRow is undefined). Order matters because
      // `releaseMiniRows` is loud-fail on contract violation: if a future
      // caller ever lands on the throw path, the push + deactivate above
      // have already run, so the collapse line still lands in scrollback
      // and `altScreenDepth` is still decremented — no second-order
      // silent-failure precursor. `releaseMiniRows` mutates only
      // `miniLayout.active` + `miniLayout.nextStartRow`; it does not
      // write to stdout, so reordering is invisible in normal operation.
      if (this.miniStartRow !== undefined) {
        releaseMiniRows(this);
        this.miniStartRow = undefined;
      }
    } else {
      process.stdout.write(`  ${summary}\n`);
    }
  }

  private commitLine(): void {
    const line = this.currentLine;
    this.currentLine = '';
    this.lines.push(line);
    if (this.lines.length > WINDOW_ROWS) this.lines.shift();
    this.logStream?.write(line + '\n');
    if (!this.isTTY) process.stdout.write(line + '\n');
  }

  private innerWidth(): number {
    const cols = process.stdout.columns ?? 80;
    return Math.max(20, cols - 4);
  }

  /** Compute up to `rowCount` visual rows to display, each padded to
   *  `inner` chars. Logical lines longer than `inner` wrap to multiple visual
   *  rows; the oldest visible logical line may show only its trailing rows
   *  when total wrap count exceeds `rowCount`. Under-fill pads blanks at
   *  the BOTTOM so content appears starting at the top of the window.
   *  ANSI codes are stripped for both wrap math and display (color codes
   *  are lost in the rendered window but preserved in the log file). */
  private computeVisibleRows(rowCount: number, inner: number): string[] {
    const allLines = [...this.lines];
    if (this.currentLine.length > 0) allLines.push(this.currentLine);

    const rows: string[] = [];
    for (let i = allLines.length - 1; i >= 0; i--) {
      const stripped = stripAnsi(allLines[i]);
      const wrapped: string[] = [];
      if (stripped.length === 0) {
        wrapped.push(' '.repeat(inner));
      } else {
        for (let off = 0; off < stripped.length; off += inner) {
          wrapped.push(stripped.substring(off, off + inner).padEnd(inner, ' '));
        }
      }
      rows.unshift(...wrapped);
      if (rows.length >= rowCount) {
        while (rows.length > rowCount) rows.shift();
        return rows;
      }
    }
    while (rows.length < rowCount) rows.push(' '.repeat(inner));
    return rows;
  }

  private render(): void {
    if (this.miniStartRow !== undefined) {
      this.renderMini();
    } else {
      this.renderFull();
    }
  }

  /** Full-box render: 25 content rows inside `│ │` borders, repainted via
   *  relative cursor-up. Cursor invariant: one line below the bottom border
   *  when render() is entered and when it exits. */
  private renderFull(): void {
    const inner = this.innerWidth();
    const rows = this.computeVisibleRows(WINDOW_ROWS, inner);
    process.stdout.write(`\x1b[${WINDOW_ROWS + 1}A`);
    for (const row of rows) {
      process.stdout.write(`\r\x1b[2K  │${row}│\n`);
    }
    process.stdout.write(`\r\x1b[2K  └${'─'.repeat(inner)}┘\n`);
  }

  /** Mini render: 3 content rows at absolute terminal rows
   *  `miniStartRow+1` .. `miniStartRow+3`. Uses `\x1b[r;cH` absolute
   *  positioning so parallel siblings rendering concurrently don't collide.
   *  The header (`↪ name` at row `miniStartRow`) was written once at
   *  `start()` and isn't repainted here — `renderMini` only touches the
   *  content rows. */
  private renderMini(): void {
    const contentRowCount = MINI_ROW_COUNT - 1;
    const inner = this.innerWidth();
    const rows = this.computeVisibleRows(contentRowCount, inner);
    for (let i = 0; i < contentRowCount; i++) {
      process.stdout.write(`\x1b[${this.miniStartRow! + 1 + i};1H`);
      process.stdout.write(`\x1b[2K`);
      process.stdout.write(`    ${rows[i]}`);
    }
  }

  /** Full repaint on terminal resize. */
  private handleResize(): void {
    if (this.finished || !this.isTTY) return;
    if (this.miniStartRow !== undefined) {
      // Mini mode: re-render the content rows at the new width. The header
      // line was set at start() and stays put (it's at the assigned row;
      // a horizontal resize doesn't move it).
      this.renderMini();
      return;
    }
    // Full mode: re-emit header + borders + content at the new width.
    const inner = this.innerWidth();
    process.stdout.write(`\x1b[${WINDOW_ROWS + 3}A\x1b[0J`);
    process.stdout.write(`  → ${this.agentName}\n`);
    process.stdout.write(`  ┌${'─'.repeat(inner)}┐\n`);
    const rows = this.computeVisibleRows(WINDOW_ROWS, inner);
    for (const row of rows) {
      process.stdout.write(`  │${row}│\n`);
    }
    process.stdout.write(`  └${'─'.repeat(inner)}┘\n`);
  }
}
