import { EventEmitter } from 'events';
import { Readable } from 'node:stream';
import { vi } from 'vitest';

/** Shape of the fake child returned by `makeFakeChild`. Named so that the
 *  inferred return type doesn't drift across the multiple sibling test files
 *  (e.g. `human-gate.test.ts`) that consume the helper — the inferred shape
 *  would otherwise become an implicit cross-file contract. */
export type FakeChild = EventEmitter & {
  stdin: { write: (s: string) => void; end: () => void };
  stderr: Readable;
  kill: (sig?: string) => void;
};

/** Build a fake spawned child that fires 'exit' with the given code on next
 *  microtask. The child exposes a writable-stub stdin and a readable stderr
 *  stream. When `stderrData` is provided, those chunks are pushed onto stderr
 *  and the stream is closed before 'exit' fires — stderr 'end' precedes
 *  'exit' so production's listener finishes capturing before the resolve
 *  callback runs. When `stderrData` is omitted, stderr stays open and silent
 *  for the lifetime of the fake child. */
export function makeFakeChild(
  opts: { exitCode?: number | null; stderrData?: string[] } = {},
): FakeChild {
  const stderr = new Readable({ read() {} });
  const child = new EventEmitter() as FakeChild;
  // Stub stdin to satisfy the EventEmitter cast; the runtime no longer
  // writes to copilot's stdin (replaced by `--interactive <prompt>` argv
  // in commit 3cefd95) so these are pure no-ops.
  child.stdin = { write() {}, end() {} };
  child.stderr = stderr;
  child.kill = () => undefined;
  if (opts.stderrData !== undefined && opts.stderrData.length > 0) {
    stderr.on('end', () => {
      queueMicrotask(() => child.emit('exit', opts.exitCode ?? 0));
    });
    queueMicrotask(() => {
      for (const chunk of opts.stderrData!) {
        stderr.push(chunk);
      }
      stderr.push(null);
    });
  } else {
    queueMicrotask(() => child.emit('exit', opts.exitCode ?? 0));
  }
  return child;
}

/** Shape of the fake child returned by `makeFakeRunAgentChild`. Distinct
 *  from `FakeChild` because runAgent consumes `stdout` (the stream-json line
 *  feed); it now also captures `stderr` (the piped fd-2 line feed). Named for
 *  the same cross-file-contract reason as `FakeChild`. */
export type FakeRunAgentChild = EventEmitter & {
  stdin: { write: (s: string) => void; end: () => void };
  stdout: Readable;
  stderr: Readable;
  kill: (sig?: string) => void;
};

/** Build a fake spawned child for runAgent tests. `stdoutLines` are emitted as
 *  '\n'-terminated chunks on the child's stdout (a forced newline per line).
 *  `stderrLines` are pushed VERBATIM onto the child's stderr — no forced
 *  newline — so a newline-less final line is exercisable downstream (runAgent's
 *  readline must flush that unterminated remainder on stream end). The stderr
 *  stream is always created and closed via `push(null)`, even when
 *  `stderrLines` is omitted, so the exit barrier below still fires.
 *
 *  The child fires 'exit' only AFTER BOTH the stdout and stderr streams have
 *  ended — a two-stream barrier, unlike the single-stream ordering
 *  `makeFakeChild` uses. Real Node child_process flushes both pipes before the
 *  child exits; the barrier reproduces that so both readline `'line'` handlers
 *  fully drain before the `'exit'` handler resolves/rejects. Each stream emits
 *  'end' only once a consumer reads it, so this presumes runAgent reads both
 *  fds (it does). The child exposes a writable-stub stdin matching the humanGate
 *  makeFakeChild shape for symmetry.
 *
 *  `exitCode` defaults to 0 when omitted; an explicit `null` is emitted
 *  verbatim (the signal-killed / code === null case), not collapsed to 0. */
export function makeFakeRunAgentChild(
  opts: {
    stdoutLines?: string[];
    stderrLines?: string[];
    exitCode?: number | null;
  } = {},
): FakeRunAgentChild {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const child = new EventEmitter() as FakeRunAgentChild;
  child.stdin = { write() {}, end() {} };
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => undefined;
  // Two-stream barrier: emit 'exit' only after BOTH streams' 'end' events have
  // fired, so neither readline handler is still draining when the exit handler
  // runs. Emitting on the first 'end' would race the second stream's tail
  // line.
  let stdoutEnded = false;
  let stderrEnded = false;
  const emitExitWhenBothEnded = (): void => {
    if (stdoutEnded && stderrEnded) {
      // `?? 0` would collapse an explicit null (signal-kill) to 0; emit verbatim.
      queueMicrotask(() => child.emit('exit', opts.exitCode === undefined ? 0 : opts.exitCode));
    }
  };
  stdout.on('end', () => {
    stdoutEnded = true;
    emitExitWhenBothEnded();
  });
  stderr.on('end', () => {
    stderrEnded = true;
    emitExitWhenBothEnded();
  });
  // Push data on the next microtask so the consumers have time to attach
  // listeners before the streams flow and close.
  queueMicrotask(() => {
    for (const line of opts.stdoutLines ?? []) {
      stdout.push(line.endsWith('\n') ? line : line + '\n');
    }
    stdout.push(null); // close the stream
    for (const chunk of opts.stderrLines ?? []) {
      stderr.push(chunk); // verbatim — no forced newline (contrast stdout above)
    }
    stderr.push(null); // close the stream so the both-ended gate fires
  });
  return child;
}

/** Spy on process.stdout.write, capturing each written chunk as a string into
 *  the returned array. Centralizes the one awkwardness process.stdout.write's
 *  overloaded signature otherwise forces at each call site: typing the
 *  parameter as the full `string | Uint8Array` union (rather than the narrower
 *  `string` the call sites used) lets the implementation type-check without an
 *  `as any` cast. Restored by the suite's existing afterEach restoreAllMocks. */
export function captureStdoutWrites(): string[] {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}
