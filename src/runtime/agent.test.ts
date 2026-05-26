import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable } from 'node:stream';
import * as nodePath from 'node:path';
import { makeFakeRunAgentChild } from './test-helpers.js';

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

  it('uses stdio: pipe-stdout-inherit-stderr', async () => {
    spawnMock.mockImplementation(() => makeFakeRunAgentChild());
    const { runAgent } = await import('./agent.js');
    await runAgent('a', 'prompt', undefined, {
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      extraArgs: [],
    });
    const options = spawnMock.mock.calls[0][2];
    expect(options.stdio).toEqual(['ignore', 'pipe', 'inherit']);
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
