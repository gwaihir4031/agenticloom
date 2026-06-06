import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable } from 'node:stream';
import * as nodePath from 'node:path';
import { makeFakeRunAgentChild, captureStdoutWrites } from './test-helpers.js';

// Mock child_process.spawn — runAgent spawns the cli per agent. Tests
// assert the argv shape + stdio config + stream-event consumption. The
// mocked child uses makeFakeRunAgentChild to emit stdout lines + 'exit'
// in the same ordering real Node child_process produces.
const spawnMock = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: any[]) => spawnMock(...args),
}));

// Mock readline — runAgent uses createInterface({ input: child.stdout,
// crlfDelay: Infinity }) to consume stream-json JSONL lines. The mock
// wires up an EventEmitter-backed line splitter so tests can push synthetic
// lines onto the fake child's stdout and observe the parse path. The y/N
// gate shape isn't exercised by runAgent tests, but the shape-dispatch
// branch is kept intact in case a future runAgent test depends on it.
const readlineCloseMock = vi.fn();
let questionAnswer = 'y';
vi.mock('readline', () => ({
  createInterface: (opts: any) => {
    if (opts && opts.input && opts.input !== process.stdin && typeof opts.input.on === 'function') {
      const emitter = new EventEmitter() as EventEmitter & { close: () => void };
      let buf = '';
      opts.input.on('data', (chunk: Buffer | string) => {
        buf += chunk.toString();
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
          emitter.emit('line', buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf('\n');
        }
      });
      opts.input.on('end', () => {
        if (buf.length > 0) emitter.emit('line', buf);
        emitter.emit('close');
      });
      // Mirror real readline: a 'error' on the input stream is RE-EMITTED onto
      // the interface (not left on the raw stream). Production guards the
      // interface (errLines.on('error', ...)) precisely because of this
      // re-emission, so the mock must reproduce it for the guard test to bite.
      opts.input.on('error', (err: Error) => emitter.emit('error', err));
      emitter.close = () => undefined;
      return emitter;
    }
    return {
      question: (_q: string, cb: (a: string) => void) => cb(questionAnswer),
      close: readlineCloseMock,
    };
  },
}));

// Mock fs — loom reads agent persona files at `<agentDirs[i]>/<name>.md`.
// `promptFileBody = null` simulates "persona file missing on disk" (a
// runtime contract violation that the runtime asserts against loudly).
// `fakeFs` is the per-test path → content map used by runAgent's pre-spawn
// inputPaths check, post-spawn producesPath existence check, and requireFile.
let promptFileBody: string | null = '---\nname: test-agent\n---\nSYS PROMPT BODY\n';
let fakeFs: Record<string, string> = {};
const looksLikePersonaPath = (p: string): boolean => /(?:^|\/)agents\/[^/]+\.md$/.test(p);
const fakeFsLookup = (p: string): string | undefined => {
  if (Object.prototype.hasOwnProperty.call(fakeFs, p)) return fakeFs[p];
  if (nodePath.isAbsolute(p)) {
    const rel = nodePath.relative(process.cwd(), p);
    if (Object.prototype.hasOwnProperty.call(fakeFs, rel)) return fakeFs[rel];
  }
  return undefined;
};

vi.mock('fs', () => ({
  existsSync: (p: string) => {
    if (looksLikePersonaPath(p)) return promptFileBody !== null;
    return fakeFsLookup(p) !== undefined;
  },
  readFileSync: (p: string, _enc?: string) => {
    if (looksLikePersonaPath(p)) return promptFileBody ?? '';
    const v = fakeFsLookup(p);
    if (v !== undefined) return v;
    const err = new Error(
      `ENOENT: no such file or directory, open '${p}'`,
    ) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  },
}));

beforeEach(async () => {
  vi.resetModules();
  spawnMock.mockReset();
  readlineCloseMock.mockReset();
  questionAnswer = 'y';
  promptFileBody = '---\nname: test-agent\n---\nSYS PROMPT BODY\n';
  fakeFs = {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runAgent', () => {
  let originalIsTTY: boolean;
  beforeEach(() => {
    originalIsTTY = process.stdout.isTTY;
    // Non-TTY for these tests — RollingWindow falls back to plain line
    // streaming when stdout isn't a TTY, so spawn-argv + textBuffer-return
    // assertions hold without mocking out the window's ANSI cursor moves.
    // (TTY-mode rendering is exercised directly in RollingWindow.test.ts.)
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
    // Belt-and-suspenders: if a test that flips on fake timers throws before
    // its inline `vi.useRealTimers()` (e.g. an assertion regression), fake
    // timers would leak into later tests in this describe block and they'd
    // silently pass under leaked fakes. `useRealTimers()` is idempotent —
    // a no-op when fake timers aren't installed.
    vi.useRealTimers();
  });

  it('throws when opts is missing (contract violation)', async () => {
    const { runAgent } = await import('./agent.js');
    await expect(runAgent('a', 'prompt')).rejects.toThrow(/opts is required/);
  });

  it('dispatches to claude binary with stream-json flags', async () => {
    spawnMock.mockImplementation(() => makeFakeRunAgentChild());
    const { runAgent } = await import('./agent.js');
    await runAgent('ac-writer', 'prompt', undefined, {
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      extraArgs: [],
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toContain('-p');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('acceptEdits');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--include-partial-messages');
  });

  it('dispatches to copilot binary WITHOUT stream-json flags', async () => {
    spawnMock.mockImplementation(() => makeFakeRunAgentChild());
    const { runAgent } = await import('./agent.js');
    await runAgent('ac-writer', 'prompt', undefined, {
      cli: 'copilot',
      agentDirs: ['.github/agents/', '~/.copilot/agents/'],
      extraArgs: [],
    });
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe('copilot');
    expect(args).toContain('--allow-all-tools');
    expect(args).toContain('--no-color');
    expect(args).not.toContain('--output-format');
  });

  it('threads extraArgs through to the spawn argv', async () => {
    spawnMock.mockImplementation(() => makeFakeRunAgentChild());
    const { runAgent } = await import('./agent.js');
    await runAgent('ac-writer', 'prompt', undefined, {
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      extraArgs: ['--model', 'haiku'],
    });
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('--model');
    expect(args).toContain('haiku');
  });

  it('uses stdio: pipe-stdout-pipe-stderr (fd 2 captured, not inherited)', async () => {
    spawnMock.mockImplementation(() => makeFakeRunAgentChild());
    const { runAgent } = await import('./agent.js');
    await runAgent('a', 'prompt', undefined, {
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      extraArgs: [],
    });
    const options = spawnMock.mock.calls[0][2];
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  describe('spawn cwd threading via LOOM_INVOCATION_CWD', () => {
    // The smoke fix at e3d03d0 spawns agents with `cwd: agentCwd`, where
    // `agentCwd = process.env.LOOM_INVOCATION_CWD ?? process.cwd()`. These
    // two tests pin the env-var-driven path (set + unset). A regression
    // that drops the `cwd: agentCwd` argument from the spawn call would
    // pass every other test (since none of them assert on cwd) and only
    // fail at the next smoke run; these tests close that gap.
    let originalInvocationCwd: string | undefined;
    beforeEach(() => {
      originalInvocationCwd = process.env.LOOM_INVOCATION_CWD;
    });
    afterEach(() => {
      if (originalInvocationCwd === undefined) delete process.env.LOOM_INVOCATION_CWD;
      else process.env.LOOM_INVOCATION_CWD = originalInvocationCwd;
    });

    it('passes LOOM_INVOCATION_CWD as cwd when set', async () => {
      process.env.LOOM_INVOCATION_CWD = '/some/invocation/dir';
      spawnMock.mockImplementation(() => makeFakeRunAgentChild());
      const { runAgent } = await import('./agent.js');
      await runAgent('a', 'prompt', undefined, {
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        extraArgs: [],
      });
      expect(spawnMock.mock.calls[0][2]).toMatchObject({ cwd: '/some/invocation/dir' });
    });

    it('falls back to process.cwd() when LOOM_INVOCATION_CWD is unset', async () => {
      delete process.env.LOOM_INVOCATION_CWD;
      spawnMock.mockImplementation(() => makeFakeRunAgentChild());
      const { runAgent } = await import('./agent.js');
      await runAgent('a', 'prompt', undefined, {
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        extraArgs: [],
      });
      expect(spawnMock.mock.calls[0][2]).toMatchObject({ cwd: process.cwd() });
    });
  });

  it('accumulates text_delta events into returned stdout (no producesPath)', async () => {
    const events = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } },
      }),
      JSON.stringify({
        type: 'result',
        num_turns: 1,
        total_cost_usd: 0.001,
        stop_reason: 'end_turn',
      }),
    ];
    spawnMock.mockImplementation(() => makeFakeRunAgentChild({ stdoutLines: events }));
    const { runAgent } = await import('./agent.js');
    const result = await runAgent('a', 'prompt', undefined, {
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      extraArgs: [],
    });
    expect(result).toBe('Hello world');
  });

  describe('mini-mode api_retry mirror (parallel agents)', () => {
    // Mini mode is reachable ONLY under TTY + an active parallel context:
    // RollingWindow.start() allocates a mini row (flipping isMini true) solely
    // inside its `if (this.isTTY)` branch when parallelDepth > 0. The parent
    // describe forces isTTY=false, so this block re-enables it and brackets the
    // run with enter/exitParallelContext. That setup is what makes the
    // assertion non-vacuous: with isMini true the `if (window.isMini)` branch
    // runs and the full-mode formatStreamEvent `else` is bypassed, so the
    // asserted retry line can come ONLY from the mini mirror. Run non-TTY and
    // the full-mode branch would render the identical line, passing green even
    // with the mirror broken or absent.
    beforeEach(() => {
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    });

    // Drive a single claude run inside a TTY + parallel context (so the window
    // is mini) feeding `events` as stdout lines, and return everything written
    // to process.stdout. enter/exitParallelContext mutate module-level
    // parallelDepth in the same RollingWindow module instance agent.js imports
    // (shared post-resetModules registry), so the window runAgent creates
    // allocates a mini row.
    const runMini = async (events: string[]): Promise<string> => {
      const writes = captureStdoutWrites();
      const { enterParallelContext, exitParallelContext } = await import('../RollingWindow.js');
      const { runAgent } = await import('./agent.js');
      spawnMock.mockImplementation(() => makeFakeRunAgentChild({ stdoutLines: events }));
      enterParallelContext();
      try {
        await runAgent('p-agent', 'prompt', undefined, {
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: [],
        });
      } finally {
        exitParallelContext();
      }
      return writes.join('');
    };

    it('feeds the formatApiRetry line on an api_retry event', async () => {
      const writes = captureStdoutWrites();

      // enter/exitParallelContext mutate module-level parallelDepth in the same
      // RollingWindow module instance agent.js imports (shared post-resetModules
      // registry), so the window runAgent creates allocates a mini row.
      const { enterParallelContext, exitParallelContext } = await import('../RollingWindow.js');
      const { runAgent } = await import('./agent.js');

      const events = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: 3,
          max_retries: 20,
          error: 'overloaded',
          retry_delay_ms: 8000,
        }),
        JSON.stringify({
          type: 'result',
          num_turns: 1,
          total_cost_usd: 0.001,
          stop_reason: 'end_turn',
        }),
      ];
      spawnMock.mockImplementation(() => makeFakeRunAgentChild({ stdoutLines: events }));

      enterParallelContext();
      try {
        await runAgent('p-agent', 'prompt', undefined, {
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: [],
        });
      } finally {
        exitParallelContext();
      }

      expect(writes.join('')).toContain('⟳ retry 3/20 — overloaded');
    });

    it('reuses the full formatApiRetry line including the waiting clause', async () => {
      // The mirror must feed the SAME line full mode shows, helper-verbatim —
      // including the `, waiting Ns` clause derived from retry_delay_ms — so the
      // two display modes never drift.
      const all = await runMini([
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: 3,
          max_retries: 20,
          error: 'overloaded',
          retry_delay_ms: 8000,
        }),
        JSON.stringify({
          type: 'result',
          num_turns: 1,
          total_cost_usd: 0.001,
          stop_reason: 'end_turn',
        }),
      ]);
      expect(all).toContain('⟳ retry 3/20 — overloaded, waiting 8s');
    });

    it('renders the placeholder form when attempt and max_retries are absent', async () => {
      // The mirror passes the raw event straight through formatApiRetry, so a
      // retry event missing attempt/max_retries still surfaces as `⟳ retry ?/?`
      // rather than being dropped.
      const all = await runMini([
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
        JSON.stringify({ type: 'system', subtype: 'api_retry', error: 'rate_limit' }),
        JSON.stringify({
          type: 'result',
          num_turns: 1,
          total_cost_usd: 0.001,
          stop_reason: 'end_turn',
        }),
      ]);
      expect(all).toContain('⟳ retry ?/? — rate_limit');
    });

    it('renders the retry line without disturbing the tool-call state machine', async () => {
      // An api_retry arriving mid tool-call block must be handled as an
      // independent branch (carrying no content_block) and leave currentTool
      // intact — the in-flight Read tool still resolves its primary arg at
      // content_block_stop while the retry line also renders.
      const all = await runMini([
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } },
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: 1,
          max_retries: 5,
          error: 'overloaded',
        }),
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{"file_path":"ACS.md"}' },
          },
        }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop' } }),
        JSON.stringify({
          type: 'result',
          num_turns: 1,
          total_cost_usd: 0.001,
          stop_reason: 'end_turn',
        }),
      ]);
      expect(all).toContain('⟳ retry 1/5 — overloaded');
      expect(all).toContain('◇ Read: ACS.md');
    });
  });

  describe('api_retry capture folded into result telemetry (non-TTY)', () => {
    it('merges the running retry summary into the collapse line and still renders each retry', async () => {
      const writes = captureStdoutWrites();

      const events = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: 1,
          max_retries: 20,
          error: 'overloaded',
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: 2,
          max_retries: 20,
          error: 'overloaded',
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: 3,
          max_retries: 20,
          error: 'overloaded',
        }),
        JSON.stringify({
          type: 'result',
          num_turns: 4,
          total_cost_usd: 0.0123,
          stop_reason: 'end_turn',
        }),
      ];
      spawnMock.mockImplementation(() => makeFakeRunAgentChild({ stdoutLines: events }));
      const { runAgent } = await import('./agent.js');
      await runAgent('a', 'prompt', undefined, {
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        extraArgs: [],
      });

      const out = writes.join('');
      // The collapse line carries the accumulated retry summary alongside the
      // turns/cost the terminal `result` event supplied — proof the retry
      // setResult merged with (did not clobber) the result-event setResult.
      expect(out).toContain('retried 3× (overloaded)');
      expect(out).toContain('4 turns');
      expect(out).toContain('$0.0123');
      // Seam guard: in full (non-mini) mode commitLine tees every fed line to
      // stdout, so the per-event retry render line is present ONLY if the
      // capture branch fell THROUGH to the full-mode render. A stray `return`
      // in the capture branch (like the result branch) would suppress this
      // while the collapse-line assertions above stayed green.
      expect(out).toContain('⟳ retry 3/20');
    });

    it('completes the run when the final retry exhausts the budget (attempt === max_retries)', async () => {
      captureStdoutWrites();

      const events = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: 19,
          max_retries: 20,
          error: 'overloaded',
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: 20,
          max_retries: 20,
          error: 'overloaded',
        }),
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'done' } },
        }),
        JSON.stringify({
          type: 'result',
          num_turns: 1,
          total_cost_usd: 0.001,
          stop_reason: 'end_turn',
        }),
      ];
      spawnMock.mockImplementation(() => makeFakeRunAgentChild({ stdoutLines: events }));
      const { runAgent } = await import('./agent.js');
      // Budget exhaustion (attempt === max_retries) is captured as structured
      // data only — loom never branches on it — so the run resolves normally
      // with its accumulated text product.
      await expect(
        runAgent('a', 'prompt', undefined, {
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: [],
        }),
      ).resolves.toBe('done');
    });

    it('reflects the most recent error category (last-write-wins) on the collapse line', async () => {
      const writes = captureStdoutWrites();

      const events = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: 1,
          max_retries: 20,
          error: 'overloaded',
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: 2,
          max_retries: 20,
          error: 'rate_limit',
        }),
        JSON.stringify({
          type: 'result',
          num_turns: 1,
          total_cost_usd: 0.001,
          stop_reason: 'end_turn',
        }),
      ];
      spawnMock.mockImplementation(() => makeFakeRunAgentChild({ stdoutLines: events }));
      const { runAgent } = await import('./agent.js');
      await runAgent('a', 'prompt', undefined, {
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        extraArgs: [],
      });

      // The category is last-write-wins across retries: two events with
      // different categories collapse to the SECOND one's category, never the
      // first.
      const out = writes.join('');
      expect(out).toContain('retried 2× (rate_limit)');
      expect(out).not.toContain('(overloaded)');
    });

    it('keeps the prior error category when a later api_retry omits error', async () => {
      const writes = captureStdoutWrites();

      const events = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: 1,
          max_retries: 20,
          error: 'overloaded',
        }),
        // Second retry carries no `error` field — the accumulator must leave
        // the prior category in place rather than overwriting it with
        // undefined.
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: 2,
          max_retries: 20,
        }),
        JSON.stringify({
          type: 'result',
          num_turns: 1,
          total_cost_usd: 0.001,
          stop_reason: 'end_turn',
        }),
      ];
      spawnMock.mockImplementation(() => makeFakeRunAgentChild({ stdoutLines: events }));
      const { runAgent } = await import('./agent.js');
      await runAgent('a', 'prompt', undefined, {
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        extraArgs: [],
      });

      // Count advances to 2 while the category stays 'overloaded' from the
      // first event — proof the missing `error` did not blank it out.
      expect(writes.join('')).toContain('retried 2× (overloaded)');
    });

    it('records the retry summary on the collapse line even when no result event arrives', async () => {
      const writes = captureStdoutWrites();

      // No terminal `result` event — the child just exits cleanly after the
      // retries. The summary can only reach the collapse line if setResult was
      // called on each api_retry rather than waiting for the (absent) result
      // event; this is the survives-an-early-death guarantee.
      const events = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: 1,
          max_retries: 20,
          error: 'overloaded',
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: 2,
          max_retries: 20,
          error: 'overloaded',
        }),
      ];
      spawnMock.mockImplementation(() => makeFakeRunAgentChild({ stdoutLines: events }));
      const { runAgent } = await import('./agent.js');
      await runAgent('a', 'prompt', undefined, {
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        extraArgs: [],
      });

      expect(writes.join('')).toContain('retried 2× (overloaded)');
    });
  });

  describe('api_retry accumulator state via setResult capture', () => {
    // The exhausted latch is not rendered anywhere (rendering is the retry-line
    // helper's job, which only shows attempt/max_retries), so observe the
    // accumulator directly by swapping in a RollingWindow whose setResult
    // records every meta object it receives. afterEach undoes the doMock so it
    // doesn't leak into sibling tests.
    afterEach(() => {
      vi.doUnmock('../RollingWindow.js');
    });

    it('latches retry_exhausted at the ceiling and keeps it true on a later sub-ceiling retry', async () => {
      const setResultCalls: Array<Record<string, unknown>> = [];
      vi.doMock('../RollingWindow.js', () => ({
        RollingWindow: class {
          constructor(_name: string, _logPath: string | null) {}
          start(): void {}
          feed(): void {}
          setResult(meta: Record<string, unknown>): void {
            setResultCalls.push(meta);
          }
          finish(): void {}
          get isMini(): boolean {
            return false;
          }
        },
      }));
      vi.resetModules();

      const events = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
        // Below the ceiling — not yet exhausted.
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: 1,
          max_retries: 20,
          error: 'overloaded',
        }),
        // Reaches the ceiling — exhausted latches true.
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: 20,
          max_retries: 20,
          error: 'overloaded',
        }),
        // Drops back below the ceiling — exhausted must STAY true (monotonic).
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: 5,
          max_retries: 20,
          error: 'overloaded',
        }),
        JSON.stringify({
          type: 'result',
          num_turns: 1,
          total_cost_usd: 0.001,
          stop_reason: 'end_turn',
        }),
      ];
      spawnMock.mockImplementation(() => makeFakeRunAgentChild({ stdoutLines: events }));
      const { runAgent } = await import('./agent.js');
      await runAgent('a', 'prompt', undefined, {
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        extraArgs: [],
      });

      // One retry-bearing setResult per api_retry event, with an incrementing
      // count; the result event's setResult carries no retry_count, so filter
      // to the retry calls.
      const retryCalls = setResultCalls.filter((m) => 'retry_count' in m);
      expect(retryCalls.map((m) => m.retry_count)).toEqual([1, 2, 3]);
      // Latch transitions false -> true at the ceiling, then never reverts even
      // though the third retry's attempt (5) is below max_retries.
      expect(retryCalls.map((m) => m.retry_exhausted)).toEqual([false, true, true]);
    });
  });

  it('resolves without throwing when claude emits JSON-valid non-object lines', async () => {
    // JSON.parse accepts `null`/`42`/`"text"`/`[1,2]`; without the
    // typeof-object gate in the inline parser, `evt.type` on any of those
    // would throw inside the readline 'line' callback and escape as
    // uncaughtException — the runAgent promise would never settle. This
    // run pushes two such lines through the child's stdout and asserts
    // the promise resolves cleanly. The producesPath path is exercised
    // so the run has something to resolve to.
    fakeFs['out.json'] = '{}';
    spawnMock.mockImplementation(() =>
      makeFakeRunAgentChild({
        stdoutLines: ['null', '42'],
      }),
    );
    const { runAgent } = await import('./agent.js');
    // Bind value is the absolutified produces path (the canonical file
    // location), not the raw relative literal — see runAgent's `path.resolve`
    // at function entry for the rationale.
    await expect(
      runAgent('a', 'prompt', 'out.json', {
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        extraArgs: [],
      }),
    ).resolves.toBe(nodePath.resolve('out.json'));
  });

  it('returns trimmed raw stdout for copilot (no producesPath, no stream-json parsing)', async () => {
    spawnMock.mockImplementation(() =>
      makeFakeRunAgentChild({
        stdoutLines: ['  some copilot output  '],
      }),
    );
    const { runAgent } = await import('./agent.js');
    const result = await runAgent('a', 'prompt', undefined, {
      cli: 'copilot',
      agentDirs: ['.github/agents/', '~/.copilot/agents/'],
      extraArgs: [],
    });
    expect(result).toBe('some copilot output');
  });

  it('returns producesPath when set AND file exists post-exit', async () => {
    fakeFs['out.json'] = '{"foo":1}';
    spawnMock.mockImplementation(() => makeFakeRunAgentChild());
    const { runAgent } = await import('./agent.js');
    const result = await runAgent('a', 'prompt', 'out.json', {
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      extraArgs: [],
    });
    expect(result).toBe(nodePath.resolve('out.json'));
  });

  it("throws when producesPath is set but file doesn't exist post-exit", async () => {
    spawnMock.mockImplementation(() => makeFakeRunAgentChild());
    const { runAgent } = await import('./agent.js');
    // Error message carries the absolutified path — runAgent resolves
    // producesPath up-front so the bind value and diagnostics match.
    const expectedAbs = nodePath.resolve('missing-out.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(
      runAgent('a', 'prompt', 'missing-out.json', {
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        extraArgs: [],
      }),
    ).rejects.toThrow(new RegExp(`did not write expected file: ${expectedAbs}`));
  });

  it('throws on non-zero exit code (loud-fail)', async () => {
    spawnMock.mockImplementation(() => makeFakeRunAgentChild({ exitCode: 2 }));
    const { runAgent } = await import('./agent.js');
    await expect(
      runAgent('a', 'prompt', undefined, {
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        extraArgs: [],
      }),
    ).rejects.toThrow(/exited with code 2/);
  });

  it('throws on spawn ENOENT with remediation', async () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { stdin: any; stdout: any; kill: any };
      child.stdin = { write() {}, end() {} };
      child.stdout = new Readable({ read() {} });
      child.kill = () => undefined;
      queueMicrotask(() => {
        const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        child.emit('error', err);
      });
      return child;
    });
    const { runAgent } = await import('./agent.js');
    await expect(
      runAgent('a', 'prompt', undefined, {
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        extraArgs: [],
      }),
    ).rejects.toThrow(/'claude' not found on PATH/);
  });

  it('appends reviewer postscript when role: reviewer', async () => {
    fakeFs['r.json'] = '{}';
    spawnMock.mockImplementation(() => makeFakeRunAgentChild());
    const { runAgent } = await import('./agent.js');
    await runAgent('reviewer', 'review this', 'r.json', {
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      extraArgs: [],
      role: 'reviewer',
    });
    // The full prompt is the value passed after `-p` in the argv.
    const args = spawnMock.mock.calls[0][1] as string[];
    const promptIdx = args.indexOf('-p');
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    const prompt = args[promptIdx + 1];
    expect(prompt).toContain(`Write your review to: ${nodePath.resolve('r.json')}`);
    expect(prompt).toMatch(/Use this JSON shape:/);
  });

  it('appends writer postscript when role: writer', async () => {
    fakeFs['out.md'] = '...';
    spawnMock.mockImplementation(() => makeFakeRunAgentChild());
    const { runAgent } = await import('./agent.js');
    await runAgent('writer', 'write this', 'out.md', {
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      extraArgs: [],
      role: 'writer',
    });
    const args = spawnMock.mock.calls[0][1] as string[];
    const prompt = args[args.indexOf('-p') + 1];
    expect(prompt).toContain(
      `Write your artifact (Markdown prose) to: ${nodePath.resolve('out.md')}`,
    );
  });

  it('appends generic step postscript when role is omitted', async () => {
    fakeFs['out.json'] = '{}';
    spawnMock.mockImplementation(() => makeFakeRunAgentChild());
    const { runAgent } = await import('./agent.js');
    await runAgent('a', 'do this', 'out.json', {
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      extraArgs: [],
    });
    const args = spawnMock.mock.calls[0][1] as string[];
    const prompt = args[args.indexOf('-p') + 1];
    expect(prompt).toContain(`Write your output to: ${nodePath.resolve('out.json')}`);
  });

  it('strips frontmatter from persona file before prepending', async () => {
    promptFileBody = '---\nname: test\n---\nPERSONA BODY';
    spawnMock.mockImplementation(() => makeFakeRunAgentChild());
    const { runAgent } = await import('./agent.js');
    await runAgent('a', 'user prompt', undefined, {
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      extraArgs: [],
    });
    const args = spawnMock.mock.calls[0][1] as string[];
    const prompt = args[args.indexOf('-p') + 1];
    expect(prompt).toContain('PERSONA BODY');
    expect(prompt).not.toMatch(/^---/);
    expect(prompt).toContain('---\n\nuser prompt');
  });

  it('throws when persona file missing (contract violation)', async () => {
    promptFileBody = null;
    const { runAgent } = await import('./agent.js');
    await expect(
      runAgent('a', 'prompt', undefined, {
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        extraArgs: [],
      }),
    ).rejects.toThrow(/persona file is missing|This should have been caught at compile time/);
  });

  describe('inputPaths pre-spawn input check', () => {
    // The pre-spawn check fires BEFORE spawn — its purpose is to prevent
    // any agent from running against a missing input. The check is the
    // safety net for resumed runs (pre-cursor bind values become path
    // literals; if the prior run's file is missing, the first downstream
    // consumer must loud-fail with full context). On non-resumed runs the
    // same check catches silent-empty / wrong-path drift the post-spawn
    // output check alone misses.
    it('throws BEFORE spawn when an inputPaths entry is missing', async () => {
      const { runAgent } = await import('./agent.js');
      const expectedAbs = nodePath.resolve('missing.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await expect(
        runAgent('rev', 'prompt', undefined, {
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: [],
          inputPaths: ['missing.md'],
        }),
      ).rejects.toThrow(
        new RegExp(`agent 'rev' requires input file '${expectedAbs}' which does not exist`),
      );
      // No spawn occurred — the check fired before runAgent reached spawn.
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('allows spawn when all inputPaths exist', async () => {
      fakeFs['existing.md'] = 'content';
      spawnMock.mockImplementation(() => makeFakeRunAgentChild());
      const { runAgent } = await import('./agent.js');
      await runAgent('rev', 'prompt', undefined, {
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        extraArgs: [],
        inputPaths: ['existing.md'],
      });
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it('skips the check when inputPaths is undefined (no migration burden on existing callers)', async () => {
      spawnMock.mockImplementation(() => makeFakeRunAgentChild());
      const { runAgent } = await import('./agent.js');
      await runAgent('a', 'prompt', undefined, {
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        extraArgs: [],
        // inputPaths intentionally omitted — existing callers continue
        // to spawn without the pre-spawn check firing.
      });
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it('throws on the FIRST miss in declared order; subsequent entries are not checked', async () => {
      // When multiple input paths to the same agent are missing, fail
      // fast on the first miss in declared order — the runtime walks
      // inputPaths in array order. Locks in the YAML-iteration-order
      // contract that the compile-side computeInputPaths produces.
      const { runAgent } = await import('./agent.js');
      await expect(
        runAgent('rev', 'prompt', undefined, {
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: [],
          inputPaths: ['first-missing.md', 'second-missing.md'],
        }),
      ).rejects.toThrow(/first-missing\.md/);
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });

  it('rejects with timeout message when child exceeds timeout', async () => {
    vi.useFakeTimers();
    let killed = false;
    spawnMock.mockImplementation(() => {
      const stdout = new Readable({ read() {} });
      const child = new EventEmitter() as EventEmitter & {
        stdin: any;
        stdout: Readable;
        kill: any;
      };
      child.stdin = { write() {}, end() {} };
      child.stdout = stdout;
      // The timeout handler calls child.kill('SIGTERM'); simulate the real
      // OS by emitting `exit` with code === null (signal-killed) on the next
      // microtask. runAgent's `settled` guard means the exit handler runs
      // AFTER the timeout's settle, so its rejection branch never fires —
      // the timeout's reject message is what propagates.
      child.kill = (sig?: string) => {
        killed = sig === 'SIGTERM';
        queueMicrotask(() => {
          stdout.push(null);
          child.emit('exit', null);
        });
      };
      return child;
    });
    const { runAgent } = await import('./agent.js');
    const p = runAgent('slow-agent', 'prompt', undefined, {
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      extraArgs: [],
      timeout: 1000,
    });
    // Attach the rejection assertion BEFORE advancing time. With fake timers,
    // the setTimeout handler fires synchronously inside advanceTimersByTimeAsync;
    // if no `.catch` is attached yet, node emits a PromiseRejectionHandledWarning
    // when the assertion later catches it. Pre-attaching the matcher avoids
    // the warning without sacrificing the assertion.
    const assertion = expect(p).rejects.toThrow(/slow-agent.*timed out after 1000ms/);
    await vi.advanceTimersByTimeAsync(1500);
    await assertion;
    expect(killed).toBe(true);
    vi.useRealTimers();
  });

  it('does not fire timeout when child exits normally', async () => {
    // The child exits cleanly via makeFakeRunAgentChild's microtask path
    // BEFORE any timer fires. Without explicit timer advancement, the
    // setTimeout never invokes its handler — proves the timer is cleared on
    // normal exit (otherwise a later timer would still fire and reject the
    // already-resolved promise, surfacing as an unhandled rejection).
    fakeFs['out.json'] = '{}';
    spawnMock.mockImplementation(() => makeFakeRunAgentChild({ exitCode: 0 }));
    const { runAgent } = await import('./agent.js');
    const result = await runAgent('fast-agent', 'prompt', 'out.json', {
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      extraArgs: [],
      timeout: 1000,
    });
    expect(result).toBe(nodePath.resolve('out.json'));
  });

  it('uses default timeout (30 min) when not specified', async () => {
    // The 30-min default is enforced inside runAgent via
    // `opts.timeout ?? 30 * 60 * 1000`. Observable proof here is that a
    // child that exits normally does NOT trigger any timeout, even with no
    // `opts.timeout` set. A direct 30-min default test would need to
    // advance 30 min of fake-timer time without any gain in coverage.
    fakeFs['out.json'] = '{}';
    spawnMock.mockImplementation(() => makeFakeRunAgentChild({ exitCode: 0 }));
    const { runAgent } = await import('./agent.js');
    const result = await runAgent('a', 'prompt', 'out.json', {
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      extraArgs: [],
    });
    expect(result).toBe(nodePath.resolve('out.json'));
  });

  describe('--save-logs env var threading', () => {
    // Use vi.doMock + vi.resetModules to swap RollingWindow per-test with a
    // spy class capturing constructor args. The parent describe's beforeEach
    // already calls vi.resetModules(); we re-do it after vi.doMock so the
    // next import('./agent.js') picks up the mocked RollingWindow. afterEach
    // calls vi.doUnmock so the doMock doesn't leak into tests below this
    // describe block.
    afterEach(() => {
      vi.doUnmock('../RollingWindow.js');
      delete process.env.LOOM_SAVE_LOGS;
    });

    it('passes logs/<agent>.log to RollingWindow when LOOM_SAVE_LOGS=1', async () => {
      process.env.LOOM_SAVE_LOGS = '1';
      const ctorSpy = vi.fn();
      vi.doMock('../RollingWindow.js', () => ({
        RollingWindow: class {
          constructor(name: string, logPath: string | null) {
            ctorSpy(name, logPath);
          }
          start(): void {}
          feed(): void {}
          setResult(): void {}
          finish(): void {}
        },
      }));
      vi.resetModules();
      spawnMock.mockImplementation(() => makeFakeRunAgentChild());
      const { runAgent } = await import('./agent.js');
      await runAgent('ac-writer', 'prompt', undefined, {
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        extraArgs: [],
      });
      // Label includes the cli suffix so logs from pipelines mixing CLIs stay
      // attributable; logPath omits it because the file name is per-agent-name,
      // not per-(agent,cli).
      expect(ctorSpy).toHaveBeenCalledWith('ac-writer (claude)', 'logs/ac-writer.log');
    });

    it('passes null logPath to RollingWindow when LOOM_SAVE_LOGS is unset', async () => {
      delete process.env.LOOM_SAVE_LOGS;
      const ctorSpy = vi.fn();
      vi.doMock('../RollingWindow.js', () => ({
        RollingWindow: class {
          constructor(name: string, logPath: string | null) {
            ctorSpy(name, logPath);
          }
          start(): void {}
          feed(): void {}
          setResult(): void {}
          finish(): void {}
        },
      }));
      vi.resetModules();
      spawnMock.mockImplementation(() => makeFakeRunAgentChild());
      const { runAgent } = await import('./agent.js');
      await runAgent('ac-writer', 'prompt', undefined, {
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        extraArgs: [],
      });
      expect(ctorSpy).toHaveBeenCalledWith('ac-writer (claude)', null);
    });
  });

  it('forwards SIGINT to the spawned child and rejects with the SIGINT-specific message', async () => {
    let killed = false;
    spawnMock.mockImplementation(() => {
      const stdout = new Readable({ read() {} });
      const child = new EventEmitter() as EventEmitter & {
        stdin: any;
        stdout: Readable;
        kill: any;
      };
      child.stdin = { write() {}, end() {} };
      child.stdout = stdout;
      child.kill = (sig?: string) => {
        killed = sig === 'SIGTERM';
      };
      queueMicrotask(() => {
        // Synthesize Ctrl-C from the parent. runAgent's `process.once('SIGINT')`
        // handler must fire and call child.kill('SIGTERM').
        process.emit('SIGINT');
        queueMicrotask(() => {
          stdout.push(null);
          child.emit('exit', null);
        });
      });
      return child;
    });
    const { runAgent } = await import('./agent.js');
    // Reject with the SIGINT-specific message ("interrupted by Ctrl-C"), NOT
    // the generic signal-killed message. The distinction is load-bearing:
    // graceful-SIGINT-exit (code 0 + file written) would otherwise look
    // identical to a clean run, and review_loop / parallel would keep
    // marching to the next agent on Ctrl-C.
    await expect(
      runAgent('a', 'prompt', undefined, {
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        extraArgs: [],
      }),
    ).rejects.toThrow(/interrupted by Ctrl-C/);
    expect(killed).toBe(true);
  });

  it('rejects with the SIGINT message even when child exits 0 after Ctrl-C (graceful-SIGINT path)', async () => {
    // The bug this guards against: claude can clean up its TUI on SIGINT and
    // exit code 0; if producesPath happens to exist (file written before the
    // signal), the prior exit-handler logic resolved successfully and the
    // pipeline marched on. Setting interruptedBySigint inside the SIGINT
    // handler must short-circuit BEFORE the code-0-success branch.
    fakeFs['ACS.md'] = '# RATE-1: ...';
    let killed = false;
    spawnMock.mockImplementation(() => {
      const stdout = new Readable({ read() {} });
      const child = new EventEmitter() as EventEmitter & {
        stdin: any;
        stdout: Readable;
        kill: any;
      };
      child.stdin = { write() {}, end() {} };
      child.stdout = stdout;
      child.kill = (sig?: string) => {
        killed = sig === 'SIGTERM';
      };
      queueMicrotask(() => {
        process.emit('SIGINT');
        // Claude exits cleanly (code 0) AFTER handling SIGINT — the worst
        // case for the bug.
        queueMicrotask(() => {
          stdout.push(null);
          child.emit('exit', 0);
        });
      });
      return child;
    });
    const { runAgent } = await import('./agent.js');
    await expect(
      runAgent('a', 'prompt', 'ACS.md', {
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        extraArgs: [],
      }),
    ).rejects.toThrow(/interrupted by Ctrl-C/);
    expect(killed).toBe(true);
  });

  describe('stderr capture', () => {
    // fd 2 is piped (not inherited): runAgent reads child.stderr line by line
    // and tees each line to its LIVE sinks — an echo on the parent's
    // process.stderr and the window's --save-logs sink (logStderrLine) — while
    // keeping stderr out of textBuffer so it cannot contaminate the
    // no-producesPath return value. The rolling failure tail is the
    // `stderr failure tail` describe below. The logStderrLine tests swap in a
    // spy RollingWindow via doMock, so undo it
    // here (a no-op for the tests that don't mock it).
    afterEach(() => {
      vi.doUnmock('../RollingWindow.js');
      delete process.env.LOOM_SAVE_LOGS;
    });

    it('echoes each captured stderr line to process.stderr (line + newline)', async () => {
      spawnMock.mockImplementation(() =>
        makeFakeRunAgentChild({
          stderrLines: ['auth error: token expired\n', 'retrying once\n'],
        }),
      );
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { runAgent } = await import('./agent.js');
        await runAgent('a', 'prompt', undefined, {
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: [],
        });
        // readline strips the trailing newline off each line; runAgent re-adds
        // exactly one when echoing, preserving today's fd-2 destination.
        expect(stderrSpy).toHaveBeenCalledWith('auth error: token expired\n');
        expect(stderrSpy).toHaveBeenCalledWith('retrying once\n');
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('tees each stderr line to window.logStderrLine (the --save-logs sink)', async () => {
      process.env.LOOM_SAVE_LOGS = '1';
      const logStderrSpy = vi.fn();
      vi.doMock('../RollingWindow.js', () => ({
        RollingWindow: class {
          constructor(_name: string, _logPath: string | null) {}
          start(): void {}
          feed(): void {}
          setResult(): void {}
          finish(): void {}
          logStderrLine(line: string): void {
            logStderrSpy(line);
          }
        },
      }));
      vi.resetModules();
      spawnMock.mockImplementation(() =>
        makeFakeRunAgentChild({ stderrLines: ['boom\n', 'second diagnostic\n'] }),
      );
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { runAgent } = await import('./agent.js');
        await runAgent('ac-writer', 'prompt', undefined, {
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: [],
        });
        // logStderrLine receives the readline-split line WITHOUT a trailing
        // newline — the window adds its marker + newline itself.
        expect(logStderrSpy).toHaveBeenCalledWith('boom');
        expect(logStderrSpy).toHaveBeenCalledWith('second diagnostic');
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('flushes a newline-less final stderr line to the live sinks', async () => {
      process.env.LOOM_SAVE_LOGS = '1';
      const logStderrSpy = vi.fn();
      vi.doMock('../RollingWindow.js', () => ({
        RollingWindow: class {
          constructor(_name: string, _logPath: string | null) {}
          start(): void {}
          feed(): void {}
          setResult(): void {}
          finish(): void {}
          logStderrLine(line: string): void {
            logStderrSpy(line);
          }
        },
      }));
      vi.resetModules();
      // The final chunk carries NO trailing newline (pushed verbatim by the
      // fake child); the reader must flush that unterminated remainder on
      // stream end so it still reaches the sinks.
      spawnMock.mockImplementation(() =>
        makeFakeRunAgentChild({ stderrLines: ['fatal: no newline at end'] }),
      );
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { runAgent } = await import('./agent.js');
        await runAgent('ac-writer', 'prompt', undefined, {
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: [],
        });
        expect(logStderrSpy).toHaveBeenCalledWith('fatal: no newline at end');
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('never lets stderr contaminate the no-producesPath return value', async () => {
      // A stderr-only child (no stdout lines at all): textBuffer must stay
      // empty so the trimmed return value is '', proving stderr never fed
      // textBuffer.
      spawnMock.mockImplementation(() =>
        makeFakeRunAgentChild({ stdoutLines: [], stderrLines: ['noise on stderr\n'] }),
      );
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { runAgent } = await import('./agent.js');
        const result = await runAgent('a', 'prompt', undefined, {
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: [],
        });
        expect(result).toBe('');
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('tees one sink call per readline-split line, not per raw chunk', async () => {
      // The reader must split each stderr chunk on '\n' via readline and tee
      // PER LINE, not per chunk. A single three-line blob therefore produces
      // exactly three logStderrLine calls, in order, with no empty trailing
      // call for the final newline.
      process.env.LOOM_SAVE_LOGS = '1';
      const logStderrSpy = vi.fn();
      vi.doMock('../RollingWindow.js', () => ({
        RollingWindow: class {
          constructor(_name: string, _logPath: string | null) {}
          start(): void {}
          feed(): void {}
          setResult(): void {}
          finish(): void {}
          logStderrLine(line: string): void {
            logStderrSpy(line);
          }
        },
      }));
      vi.resetModules();
      spawnMock.mockImplementation(() =>
        makeFakeRunAgentChild({ stderrLines: ['multi\nline\nchunk\n'] }),
      );
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { runAgent } = await import('./agent.js');
        await runAgent('ac-writer', 'prompt', undefined, {
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: [],
        });
        expect(logStderrSpy.mock.calls).toEqual([['multi'], ['line'], ['chunk']]);
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('keeps stderr out of the copilot raw-stdout return value', async () => {
      // The copilot path accumulates EVERY stdout line into textBuffer
      // (textBuffer += line + '\n'), so it is the most exposed contamination
      // surface: if stderr were ever routed through the same accumulate, the
      // return value would absorb it. Assert the return is the stdout work
      // product alone while stderr still reaches its live echo sink.
      spawnMock.mockImplementation(() =>
        makeFakeRunAgentChild({
          stdoutLines: ['real copilot output'],
          stderrLines: ['stderr noise\n'],
        }),
      );
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { runAgent } = await import('./agent.js');
        const result = await runAgent('a', 'prompt', undefined, {
          cli: 'copilot',
          agentDirs: ['.github/agents/', '~/.copilot/agents/'],
          extraArgs: [],
        });
        expect(result).toBe('real copilot output');
        expect(stderrSpy).toHaveBeenCalledWith('stderr noise\n');
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });

  describe('stderr failure tail', () => {
    // The THIRD stderr sink: a rolling 8K tail surfaced on the five
    // agent/cli-death reject paths so a failed run always carries the reason
    // the child died, with or without --save-logs. A `--- stderr (tail) ---`
    // delimiter line separates the base reject message from the captured tail.
    // The SIGINT reject is deliberately NOT wrapped — a user Ctrl-C is not an
    // agent/cli death. Each test suppresses the
    // process.stderr echo so the captured lines don't bleed into the runner's
    // own stderr (mirrors the `stderr capture` block's spy pattern).
    it('survives a stderr stream error and still settles via the exit handler', async () => {
      // A low-level fd-2 read fault surfaces as an 'error' on child.stderr.
      // readline re-emits it onto the interface, where runAgent's guard
      // (errLines.on('error', ...)) swallows it — without that guard the
      // re-emitted error escapes as an uncaughtException and the promise never
      // settles. Drive the fault, then a clean exit, and assert runAgent
      // resolves normally (code 0, no producesPath → the trimmed textBuffer).
      const stdout = new Readable({ read() {} });
      const stderr = new Readable({ read() {} });
      const child = new EventEmitter() as EventEmitter & {
        stdin: any;
        stdout: Readable;
        stderr: Readable;
        kill: any;
      };
      child.stdin = { write() {}, end() {} };
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => undefined;
      spawnMock.mockImplementation(() => {
        queueMicrotask(() => {
          stdout.push(null);
          // The fault: an 'error' on fd 2. A stream is destroyed by 'error', so
          // it won't emit 'end' afterward — drive the resolve directly via
          // 'exit' rather than relying on a stderr-end barrier.
          stderr.emit('error', new Error('read fault on fd 2'));
          child.emit('exit', 0);
        });
        return child;
      });
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { runAgent } = await import('./agent.js');
        await expect(
          runAgent('a', 'prompt', undefined, {
            cli: 'claude',
            agentDirs: ['.claude/agents/', '~/.claude/agents/'],
            extraArgs: [],
          }),
        ).resolves.toBe('');
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('appends the stderr tail to the nonzero-exit reject message', async () => {
      spawnMock.mockImplementation(() =>
        makeFakeRunAgentChild({ stderrLines: ['auth error: token expired\n'], exitCode: 2 }),
      );
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { runAgent } = await import('./agent.js');
        await expect(
          runAgent('a', 'prompt', undefined, {
            cli: 'claude',
            agentDirs: ['.claude/agents/', '~/.claude/agents/'],
            extraArgs: [],
          }),
        ).rejects.toThrow(/exited with code 2\n--- stderr \(tail\) ---\nauth error: token expired/);
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('flushes a newline-less final stderr line into the tail', async () => {
      // The fake child pushes stderrLines VERBATIM (no forced newline),
      // so the unterminated remainder only reaches the tail if readline flushes
      // it on stream end. Proves the last diagnostic a crashing child prints —
      // often newline-less — still makes the failure summary.
      spawnMock.mockImplementation(() =>
        makeFakeRunAgentChild({ stderrLines: ['fatal: no newline at end'], exitCode: 2 }),
      );
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { runAgent } = await import('./agent.js');
        await expect(
          runAgent('a', 'prompt', undefined, {
            cli: 'claude',
            agentDirs: ['.claude/agents/', '~/.claude/agents/'],
            extraArgs: [],
          }),
        ).rejects.toThrow(/--- stderr \(tail\) ---\nfatal: no newline at end/);
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('appends the stderr tail to the did-not-write-expected-file reject', async () => {
      // No fakeFs entry for the produces path → the post-exit existence check
      // fails on a code-0 child; the tail must ride along on that reject too.
      spawnMock.mockImplementation(() =>
        makeFakeRunAgentChild({ stderrLines: ['could not open output: EACCES\n'], exitCode: 0 }),
      );
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { runAgent } = await import('./agent.js');
        await expect(
          runAgent('a', 'prompt', 'missing-out.json', {
            cli: 'claude',
            agentDirs: ['.claude/agents/', '~/.claude/agents/'],
            extraArgs: [],
          }),
        ).rejects.toThrow(
          /did not write expected file: .*\n--- stderr \(tail\) ---\ncould not open output: EACCES/,
        );
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('appends the stderr tail to the timeout reject message', async () => {
      vi.useFakeTimers();
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const stdout = new Readable({ read() {} });
      const stderr = new Readable({ read() {} });
      const child = new EventEmitter() as EventEmitter & {
        stdin: any;
        stdout: Readable;
        stderr: Readable;
        kill: any;
      };
      child.stdin = { write() {}, end() {} };
      child.stdout = stdout;
      child.stderr = stderr;
      // The timeout handler calls child.kill('SIGTERM'); simulate the OS by
      // ending both streams and emitting a signal-killed exit on the next
      // microtask. runAgent's `settled` guard means the exit branch never fires
      // — the timeout reject (carrying the pre-SIGTERM tail) wins.
      child.kill = () => {
        queueMicrotask(() => {
          stdout.push(null);
          stderr.push(null);
          child.emit('exit', null);
        });
      };
      spawnMock.mockImplementation(() => child);
      try {
        const { runAgent } = await import('./agent.js');
        const p = runAgent('slow-agent', 'prompt', undefined, {
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: [],
          timeout: 1000,
        });
        // The reader is attached now; a diagnostic the child printed BEFORE it
        // hung flows straight into the tail (stream already flowing).
        stderr.push('still waiting on upstream...\n');
        await Promise.resolve();
        // Pre-attach the matcher before advancing time (see the sibling timeout
        // test for the PromiseRejectionHandledWarning rationale).
        const assertion = expect(p).rejects.toThrow(
          /timed out after 1000ms\n--- stderr \(tail\) ---\nstill waiting on upstream/,
        );
        await vi.advanceTimersByTimeAsync(1500);
        await assertion;
      } finally {
        stderrSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('keeps the SIGINT reject bare (no tail) even when stderr was captured', async () => {
      // makeFakeRunAgentChild's two-stream barrier guarantees the stderr line
      // is fully drained into the tail BEFORE 'exit' fires, so the capture is
      // real by the time the reject lands. The interrupt is injected
      // synchronously right after spawn so interruptedBySigint is set before
      // that exit — the graceful-SIGINT path (child exits 0 after cleanup) with
      // stderr present, the worst case for a tail leaking onto the message.
      spawnMock.mockImplementation(() =>
        makeFakeRunAgentChild({ stderrLines: ['mid-run diagnostic\n'] }),
      );
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { runAgent } = await import('./agent.js');
        const settled = runAgent('a', 'prompt', undefined, {
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: [],
        }).catch((e) => e as Error);
        process.emit('SIGINT');
        const err = await settled;
        // stderr WAS captured (the reader echoed it before exit)...
        expect(stderrSpy).toHaveBeenCalledWith('mid-run diagnostic\n');
        // ...yet the user-initiated SIGINT reject carries neither the delimiter
        // nor the captured line — it is not an agent/cli death.
        expect(err.message).toMatch(/interrupted by Ctrl-C/);
        expect(err.message).not.toContain('--- stderr (tail) ---');
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('leaves the reject message bare (no delimiter) when no stderr was captured', async () => {
      // withStderrTail returns the base message UNCHANGED when the tail is
      // empty, so a clean failure (the child died but printed nothing to
      // stderr) stays clean — no dangling `--- stderr (tail) ---` header. The
      // negative companion to the nonzero-exit-with-tail test above; pins the
      // empty-tail branch of the helper.
      spawnMock.mockImplementation(() => makeFakeRunAgentChild({ exitCode: 2 }));
      const { runAgent } = await import('./agent.js');
      const err = await runAgent('a', 'prompt', undefined, {
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        extraArgs: [],
      }).catch((e) => e as Error);
      expect(err.message).toMatch(/exited with code 2/);
      expect(err.message).not.toContain('--- stderr (tail) ---');
    });

    it('leaves the reject message bare when only blank/whitespace stderr was captured', async () => {
      // A child that printed only blank/whitespace lines makes stderrTail
      // non-empty ('\n   \n') but trim-empty, so withStderrTail's
      // `stderrTail.trim() === ''` gate must still omit the delimiter — no bare
      // `--- stderr (tail) ---` header over an empty body. Distinct from the
      // no-stderr case above (literally ''): this case would FAIL under a plain
      // `stderrTail === ''` gate, so it pins the trim specifically.
      spawnMock.mockImplementation(() =>
        makeFakeRunAgentChild({ stderrLines: ['\n', '   \n'], exitCode: 2 }),
      );
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { runAgent } = await import('./agent.js');
        const err = await runAgent('a', 'prompt', undefined, {
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: [],
        }).catch((e) => e as Error);
        expect(err.message).toMatch(/exited with code 2/);
        expect(err.message).not.toContain('--- stderr (tail) ---');
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('caps the tail to the trailing STDERR_TAIL_CAP, keeping the newest stderr and dropping the oldest', async () => {
      // STDERR_TAIL_CAP is 8 * 1024 UTF-16 code units (a module-local const, not
      // exported — mirrored here). Push well over the cap with a recognizable
      // marker at the very start and end: after the per-line slice(-CAP) trims,
      // the surfaced tail must retain the END marker, drop the START marker, and
      // never exceed the cap. This is the runaway-chatty-child memory floor.
      const CAP = 8 * 1024;
      spawnMock.mockImplementation(() =>
        makeFakeRunAgentChild({
          stderrLines: ['START-MARKER\n', 'x'.repeat(9000) + '\n', 'END-MARKER\n'],
          exitCode: 2,
        }),
      );
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { runAgent } = await import('./agent.js');
        const err = await runAgent('a', 'prompt', undefined, {
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: [],
        }).catch((e) => e as Error);
        const delimiter = '--- stderr (tail) ---\n';
        expect(err.message).toContain(delimiter);
        const tail = err.message.slice(err.message.indexOf(delimiter) + delimiter.length);
        expect(tail.length).toBeLessThanOrEqual(CAP);
        expect(tail).toContain('END-MARKER');
        expect(tail).not.toContain('START-MARKER');
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('caps the tail across many small lines whose cumulative length crosses the cap', async () => {
      // The realistic runaway-chatty-child shape: every line is well under the
      // cap, but their running sum crosses it. A second cap shape (many small
      // lines vs the single oversized line above): verifies the surfaced tail
      // stays <= CAP with the newest lines kept and the oldest evicted.
      const CAP = 8 * 1024;
      const lines = Array.from({ length: 2000 }, (_, i) => `log line ${i}\n`);
      spawnMock.mockImplementation(() =>
        makeFakeRunAgentChild({ stderrLines: lines, exitCode: 2 }),
      );
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { runAgent } = await import('./agent.js');
        const err = await runAgent('a', 'prompt', undefined, {
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: [],
        }).catch((e) => e as Error);
        const delimiter = '--- stderr (tail) ---\n';
        const tail = err.message.slice(err.message.indexOf(delimiter) + delimiter.length);
        expect(tail.length).toBeLessThanOrEqual(CAP);
        // Newest lines survive; the oldest are evicted.
        expect(tail).toContain('log line 1999');
        expect(tail).not.toContain('log line 0\n');
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('appends the stderr tail to the signal-killed (code === null) reject message', async () => {
      // An external signal kill (e.g. the OOM killer SIGKILL) surfaces as
      // code === null WITHOUT a parent SIGINT, hitting the "was killed by
      // signal" reject — an agent/cli death, so the tail rides along. Distinct
      // from the user-initiated Ctrl-C path above, which stays bare. The
      // helper's two-stream barrier drains the stderr line into the tail before
      // the null-exit reject lands.
      spawnMock.mockImplementation(() =>
        makeFakeRunAgentChild({ stderrLines: ['Killed: out of memory\n'], exitCode: null }),
      );
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { runAgent } = await import('./agent.js');
        await expect(
          runAgent('a', 'prompt', undefined, {
            cli: 'claude',
            agentDirs: ['.claude/agents/', '~/.claude/agents/'],
            extraArgs: [],
          }),
        ).rejects.toThrow(/was killed by signal\n--- stderr \(tail\) ---\nKilled: out of memory/);
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('appends the stderr tail to a generic (non-ENOENT) spawn-error reject and preserves the cause', async () => {
      // The spawn 'error' handler wraps non-ENOENT errors as
      // withStderrTail(err.message) with { cause: err }. A child that printed a
      // diagnostic and then surfaced a post-spawn error (e.g. a failed kill)
      // must carry that diagnostic on the reject. The 'error' is emitted only
      // after stderr's 'end' so the line is fully drained into the tail first —
      // a hand-rolled race here would be flaky (mirrors the helper's barrier).
      const original = new Error('spawn EACCES') as NodeJS.ErrnoException;
      original.code = 'EACCES';
      spawnMock.mockImplementation(() => {
        const stdout = new Readable({ read() {} });
        const stderr = new Readable({ read() {} });
        const child = new EventEmitter() as EventEmitter & {
          stdin: any;
          stdout: Readable;
          stderr: Readable;
          kill: any;
        };
        child.stdin = { write() {}, end() {} };
        child.stdout = stdout;
        child.stderr = stderr;
        child.kill = () => undefined;
        stderr.on('end', () => {
          queueMicrotask(() => child.emit('error', original));
        });
        queueMicrotask(() => {
          stdout.push(null);
          stderr.push('exec format error: bad binary\n');
          stderr.push(null);
        });
        return child;
      });
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { runAgent } = await import('./agent.js');
        const err = await runAgent('a', 'prompt', undefined, {
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: [],
        }).catch((e) => e as Error);
        expect(err.message).toMatch(
          /spawn EACCES\n--- stderr \(tail\) ---\nexec format error: bad binary/,
        );
        // The generic branch keeps the raw err.message — NOT the ENOENT remediation.
        expect(err.message).not.toContain('not found on PATH');
        // The original spawn error is preserved as the cause (no info loss).
        expect(err.cause).toBe(original);
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('appends the stderr tail to the ENOENT spawn-error reject (alongside the remediation)', async () => {
      // The ENOENT branch builds its OWN remediation message ("not found on
      // PATH"), distinct from the generic branch above, and must also route
      // through withStderrTail. A real missing-binary ENOENT prints nothing —
      // the bare-remediation case is the 'throws on spawn ENOENT with
      // remediation' test — so this drives a child that emitted a diagnostic
      // then failed ENOENT, pinning the tail wrap on the remediation message
      // too. The 'error' fires only after stderr 'end' so the line drains first.
      const original = new Error('spawn claude ENOENT') as NodeJS.ErrnoException;
      original.code = 'ENOENT';
      spawnMock.mockImplementation(() => {
        const stdout = new Readable({ read() {} });
        const stderr = new Readable({ read() {} });
        const child = new EventEmitter() as EventEmitter & {
          stdin: any;
          stdout: Readable;
          stderr: Readable;
          kill: any;
        };
        child.stdin = { write() {}, end() {} };
        child.stdout = stdout;
        child.stderr = stderr;
        child.kill = () => undefined;
        stderr.on('end', () => {
          queueMicrotask(() => child.emit('error', original));
        });
        queueMicrotask(() => {
          stdout.push(null);
          stderr.push('dyld: missing shared library\n');
          stderr.push(null);
        });
        return child;
      });
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { runAgent } = await import('./agent.js');
        const err = await runAgent('a', 'prompt', undefined, {
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: [],
        }).catch((e) => e as Error);
        expect(err.message).toMatch(
          /not found on PATH\. Install the cli before running an agent\.\n--- stderr \(tail\) ---\ndyld: missing shared library/,
        );
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });
});

describe('requireFile', () => {
  // The mocked existsSync above keys off the fakeFs map, so "the file
  // exists" means an entry in fakeFs; "the file is missing" means no
  // entry. requireFile resolves the path to absolute first, so test
  // setups that key on the un-resolved form fall through the absolute→
  // relative fallback in fakeFsLookup — matching production's behavior
  // (which always passes absolute paths to existsSync).
  it('returns the absolute form of an existing path (consuming-input)', async () => {
    fakeFs['exists.md'] = 'content';
    const { requireFile } = await import('./agent.js');
    expect(requireFile('exists.md', { kind: 'consuming-input', agent: 'test-agent' })).toBe(
      nodePath.resolve('exists.md'),
    );
  });

  it('throws with the consuming-input wording when the file is missing', async () => {
    const { requireFile } = await import('./agent.js');
    const expectedAbs = nodePath.resolve('missing.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(() =>
      requireFile('missing.md', { kind: 'consuming-input', agent: 'test-agent' }),
    ).toThrow(
      new RegExp(`agent 'test-agent' requires input file '${expectedAbs}' which does not exist`),
    );
  });

  it('throws with the reading-output wording when the file is missing', async () => {
    // The 'reading-output' branch is the producer-output read site
    // (readAgentFile reading what an upstream agent was supposed to
    // write). Same existsSync probe, different diagnostic framing —
    // "did not write expected file" reads as a producer-failed-to-emit
    // message rather than a consumer-missing-input one. The two branches
    // share the helper so a future change to the existence semantics
    // stays mechanically consistent across both file-consumption sites.
    const { requireFile } = await import('./agent.js');
    const expectedAbs = nodePath.resolve('missing.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(() =>
      requireFile('missing.md', { kind: 'reading-output', agent: 'producer-agent' }),
    ).toThrow(new RegExp(`agent 'producer-agent' did not write expected file: ${expectedAbs}`));
  });

  it('resolves relative paths to absolute against cwd before the existence probe', async () => {
    fakeFs['rel.md'] = 'content';
    const { requireFile } = await import('./agent.js');
    const result = requireFile('rel.md', { kind: 'consuming-input', agent: 'test-agent' });
    expect(nodePath.isAbsolute(result)).toBe(true);
    expect(result).toBe(nodePath.resolve('rel.md'));
  });

  it('uses the agent name verbatim in the error message', async () => {
    // Both context tags interpolate `agent` verbatim. Use a name shaped
    // like the aggregate's synthetic label to lock the literal-string
    // interpolation through quoting characters.
    const { requireFile } = await import('./agent.js');
    expect(() =>
      requireFile('/definitely-not-here', {
        kind: 'consuming-input',
        agent: "aggregate (bind 'overall')",
      }),
    ).toThrow(/agent 'aggregate \(bind 'overall'\)' requires input file/);
  });
});

describe('HaltPipelineError', () => {
  it('is a named export from runtime/agent', async () => {
    const { HaltPipelineError } = await import('./agent.js');
    // A class is a function in JS — the runtime emits `export class
    // HaltPipelineError ...` and the named import must reach a real
    // constructor at runtime (not a type-only re-export).
    expect(typeof HaltPipelineError).toBe('function');
  });

  it('extends Error so generic catch handlers still work', async () => {
    const { HaltPipelineError } = await import('./agent.js');
    const err = new HaltPipelineError('msg');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HaltPipelineError);
    expect(err.name).toBe('HaltPipelineError');
    expect(err.message).toBe('msg');
  });
});
