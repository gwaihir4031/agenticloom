import { EventEmitter } from 'events';
import { Readable } from 'node:stream';

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
 *  feed) rather than `stderr`. Named for the same cross-file-contract reason
 *  as `FakeChild`. */
export type FakeRunAgentChild = EventEmitter & {
  stdin: { write: (s: string) => void; end: () => void };
  stdout: Readable;
  kill: (sig?: string) => void;
};

/** Build a fake spawned child for runAgent tests. `stdoutLines` are emitted as
 *  '\n'-terminated chunks on the child's stdout; the child fires 'exit' with the
 *  given code AFTER the stdout stream has finished, mirroring real Node
 *  child_process ordering (stdout flushes before the child exits, so the
 *  consumer's `'line'` events all fire before the `'exit'` handler resolves).
 *  The child exposes a writable-stub stdin matching the humanGate
 *  makeFakeChild shape for symmetry. */
export function makeFakeRunAgentChild(
  opts: {
    stdoutLines?: string[];
    exitCode?: number | null;
  } = {},
): FakeRunAgentChild {
  const stdout = new Readable({ read() {} });
  const child = new EventEmitter() as FakeRunAgentChild;
  child.stdin = { write() {}, end() {} };
  child.stdout = stdout;
  child.kill = () => undefined;
  // Push data on the next microtask so the consumer has time to attach
  // listeners; emit 'exit' only after the stream's 'end' has fired so the
  // line handler has fully drained.
  stdout.on('end', () => {
    queueMicrotask(() => child.emit('exit', opts.exitCode ?? 0));
  });
  queueMicrotask(() => {
    for (const line of opts.stdoutLines ?? []) {
      stdout.push(line.endsWith('\n') ? line : line + '\n');
    }
    stdout.push(null); // close the stream
  });
  return child;
}
