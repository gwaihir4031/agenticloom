import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable } from 'node:stream';
import * as nodePath from 'node:path';
import { makeFakeChild } from './test-helpers.js';

// Mock child_process.spawn — interactive gates spawn the cli. Tests assert
// the argv shape + stdio config. The mocked child emits a synchronous
// 'exit' to keep the test fast.
const spawnMock = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: any[]) => spawnMock(...args),
}));

// Mock readline — the y/N gate uses createInterface({ input: process.stdin,
// output: process.stdout }) and tests control the answer via questionAnswer.
// The shape-dispatch keeps the stdout-line-streaming branch from runAgent's
// pattern intact for forward compatibility, though humanGate tests only
// exercise the y/N variant.
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

// Mock fs — humanGate's copilot branch reads agent persona files via
// loadAgentSystemPrompt. promptFileBody = null simulates "missing on
// disk" (a runtime contract violation that the runtime asserts against
// loudly). humanGate doesn't otherwise hit fakeFs but we keep the mock
// shape symmetric with the other runtime/ test files.
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

// Import AFTER vi.mock calls so the module-level imports get the mocked versions.
let humanGate: typeof import('./human-gate.js').humanGate;
beforeEach(async () => {
  vi.resetModules();
  ({ humanGate } = await import('./human-gate.js'));
  spawnMock.mockReset();
  readlineCloseMock.mockReset();
  questionAnswer = 'y';
  promptFileBody = '---\nname: test-agent\n---\nSYS PROMPT BODY\n';
  fakeFs = {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('humanGate — interactive mode', () => {
  describe('TTY check', () => {
    let originalIsTTY: boolean;
    beforeEach(() => {
      originalIsTTY = process.stdout.isTTY;
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    });
    afterEach(() => {
      Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('throws when stdout is not a TTY', async () => {
      await expect(
        humanGate({
          interactive: true,
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: ['--model', 'sonnet'],
          agent: 'ac-writer',
          input: 'ACS.md',
          prompt: 'iterate on ACS',
        }),
      ).rejects.toThrow(/requires a TTY/);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('throws when stdin is not a TTY (e.g. `loom run < /dev/null`)', async () => {
      // Override the parent describe's stdout=false; set stdin=false instead
      // and prove the gate still trips. Without this check, a closed-stdin
      // run from an otherwise-TTY shell would silently hang on readline.
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      await expect(
        humanGate({
          interactive: true,
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: ['--model', 'sonnet'],
          agent: 'ac-writer',
          input: 'ACS.md',
          prompt: 'iterate on ACS',
        }),
      ).rejects.toThrow(/requires a TTY/);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('error message names the failing gate agent', async () => {
      await expect(
        humanGate({
          interactive: true,
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: ['--model', 'sonnet'],
          agent: 'ac-writer',
          input: 'ACS.md',
          prompt: 'iterate on ACS',
        }),
      ).rejects.toThrow(/ac-writer/);
    });

    it('error message recommends a real terminal or docker -it', async () => {
      await expect(
        humanGate({
          interactive: true,
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: ['--model', 'sonnet'],
          agent: 'ac-writer',
          input: 'ACS.md',
          prompt: 'iterate on ACS',
        }),
      ).rejects.toThrow(/docker run -it|real terminal/);
    });
  });

  describe('claude cli path', () => {
    let originalIsTTY: boolean;
    beforeEach(() => {
      originalIsTTY = process.stdout.isTTY;
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    });
    afterEach(() => {
      Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('spawns claude with --agent <name> + initial prompt argv shape', async () => {
      spawnMock.mockImplementation(() => makeFakeChild());
      await humanGate({
        interactive: true,
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        extraArgs: ['--model', 'sonnet'],
        agent: 'ac-writer',
        input: 'ACS.md',
        prompt: 'iterate on ACS',
      });
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [cmd, args, options] = spawnMock.mock.calls[0];
      expect(cmd).toBe('claude');
      expect(args).toContain('--agent');
      expect(args[args.indexOf('--agent') + 1]).toBe('ac-writer');
      // --model sonnet flows through from the pipeline-header default
      // extra_args passed via InteractiveGateOpts (not loom-injected).
      expect(args).toContain('--model');
      expect(args).toContain('sonnet');
      const lastArg = args[args.length - 1] as string;
      expect(lastArg).toContain('iterate on ACS');
      // Runtime absolutifies opts.input so the spawned interactive REPL
      // (which doesn't reliably resolve bare names against the inherited
      // cwd) gets an unambiguous path. The expected string is computed via
      // path.resolve at test time to stay portable across cwds.
      expect(lastArg).toContain(`The artifact is at: ${nodePath.resolve('ACS.md')}`);
      // Explicit cwd on the spawn — load-bearing for the READ side of the
      // contract (lets the agent see user-supplied project files at/under
      // the invocation dir; modern claude CLI refuses to read absolute paths
      // outside its cwd). The WRITE side is safe via the absolute-path
      // message above — the agent's Write tool overwrites the exact path
      // regardless of cwd. Under vitest the `LOOM_INVOCATION_CWD` env var
      // is unset, so `childCwd` (in spawnInteractiveAgent) falls back to
      // `process.cwd()`, which the assertion below checks. Stdio pipes
      // stderr so the runtime can capture diagnostics that the alt-screen
      // would otherwise wipe.
      expect(options).toMatchObject({ stdio: ['inherit', 'inherit', 'pipe'], cwd: process.cwd() });
    });

    describe('spawn cwd threading via LOOM_INVOCATION_CWD', () => {
      // Mirror of the agent.test.ts coverage — the smoke fix at e3d03d0
      // spawns the interactive child with `cwd: childCwd` where
      // `childCwd = process.env.LOOM_INVOCATION_CWD ?? process.cwd()`. A
      // regression that drops the `cwd:` argument from the claude branch's
      // spawn call would only fail at the next interactive smoke run; this
      // pair closes that gap at the unit level.
      let originalInvocationCwd: string | undefined;
      beforeEach(() => {
        originalInvocationCwd = process.env.LOOM_INVOCATION_CWD;
      });
      afterEach(() => {
        if (originalInvocationCwd === undefined) delete process.env.LOOM_INVOCATION_CWD;
        else process.env.LOOM_INVOCATION_CWD = originalInvocationCwd;
      });

      it('passes LOOM_INVOCATION_CWD as cwd when set (claude path)', async () => {
        process.env.LOOM_INVOCATION_CWD = '/some/invocation/dir';
        spawnMock.mockImplementation(() => makeFakeChild());
        await humanGate({
          interactive: true,
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: ['--model', 'sonnet'],
          agent: 'ac-writer',
          input: 'ACS.md',
          prompt: 'iterate on ACS',
        });
        expect(spawnMock.mock.calls[0][2]).toMatchObject({ cwd: '/some/invocation/dir' });
      });

      it('falls back to process.cwd() when LOOM_INVOCATION_CWD is unset (claude path)', async () => {
        delete process.env.LOOM_INVOCATION_CWD;
        spawnMock.mockImplementation(() => makeFakeChild());
        await humanGate({
          interactive: true,
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: ['--model', 'sonnet'],
          agent: 'ac-writer',
          input: 'ACS.md',
          prompt: 'iterate on ACS',
        });
        expect(spawnMock.mock.calls[0][2]).toMatchObject({ cwd: process.cwd() });
      });
    });

    it('auto-appends the artifact path to the prompt', async () => {
      spawnMock.mockImplementation(() => makeFakeChild());
      await humanGate({
        interactive: true,
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        extraArgs: ['--model', 'sonnet'],
        agent: 'ac-writer',
        input: 'ACS.md',
        prompt: 'just iterate',
      });
      const args = spawnMock.mock.calls[0][1] as string[];
      const lastArg = args[args.length - 1];
      expect(lastArg).toContain('just iterate');
      expect(lastArg).toContain(`The artifact is at: ${nodePath.resolve('ACS.md')}`);
      // Prompt comes before the artifact pointer.
      expect(lastArg.indexOf('just iterate')).toBeLessThan(lastArg.indexOf('The artifact is at:'));
    });

    it('after a clean exit, asks y/N and proceeds on y', async () => {
      spawnMock.mockImplementation(() => makeFakeChild({ exitCode: 0 }));
      questionAnswer = 'y';
      await expect(
        humanGate({
          interactive: true,
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: ['--model', 'sonnet'],
          agent: 'ac-writer',
          input: 'ACS.md',
          prompt: 'iterate',
        }),
      ).resolves.toBeUndefined();
      expect(readlineCloseMock).toHaveBeenCalled();
    });

    it('after a clean exit, throws on n', async () => {
      spawnMock.mockImplementation(() => makeFakeChild({ exitCode: 0 }));
      questionAnswer = 'n';
      await expect(
        humanGate({
          interactive: true,
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: ['--model', 'sonnet'],
          agent: 'ac-writer',
          input: 'ACS.md',
          prompt: 'iterate',
        }),
      ).rejects.toThrow(/halted by human gate/);
    });

    it('throws on a non-zero child exit code', async () => {
      spawnMock.mockImplementation(() => makeFakeChild({ exitCode: 2 }));
      await expect(
        humanGate({
          interactive: true,
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: ['--model', 'sonnet'],
          agent: 'ac-writer',
          input: 'ACS.md',
          prompt: 'iterate',
        }),
      ).rejects.toThrow(/exited with code 2/);
    });

    it('treats null exit code (signal-killed without our SIGINT) as session ended (falls through to y/N)', async () => {
      // Child exited with code null but WITHOUT a parent-side SIGINT firing
      // (e.g. the child got SIGTERM from elsewhere). Treat as REPL ended;
      // the y/N below is the real gate. SIGINT-from-parent goes through
      // the separate test below.
      spawnMock.mockImplementation(() => makeFakeChild({ exitCode: null }));
      questionAnswer = 'y';
      await expect(
        humanGate({
          interactive: true,
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: ['--model', 'sonnet'],
          agent: 'ac-writer',
          input: 'ACS.md',
          prompt: 'iterate',
        }),
      ).resolves.toBeUndefined();
    });

    it('forwards SIGINT to the child and rejects with "interrupted by Ctrl-C" even when child exits 0', async () => {
      // The bug this guards against: claude can clean up its TUI on
      // SIGINT and exit code 0; the prior exit-handler logic treated
      // code 0 as session-ended and let the pipeline march on through
      // the y/N to the next step. Mirrors the runAgent SIGINT contract
      // — Ctrl-C in any agent spawn halts the pipeline.
      let killed = false;
      spawnMock.mockImplementation(() => {
        const child = new EventEmitter() as EventEmitter & {
          stdin: { write: (s: string) => void; end: () => void };
          stderr: Readable;
          kill: (sig?: string) => void;
        };
        child.stdin = { write() {}, end() {} };
        child.stderr = new Readable({ read() {} });
        child.kill = (sig?: string) => {
          killed = sig === 'SIGTERM';
        };
        queueMicrotask(() => {
          process.emit('SIGINT');
          // Worst case for the bug: child exits cleanly AFTER receiving
          // SIGINT, which without the flag would resolve indistinguishably
          // from a normal /exit.
          queueMicrotask(() => child.emit('exit', 0));
        });
        return child;
      });
      await expect(
        humanGate({
          interactive: true,
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: ['--model', 'sonnet'],
          agent: 'ac-writer',
          input: 'ACS.md',
          prompt: 'iterate',
        }),
      ).rejects.toThrow(/interrupted by Ctrl-C/);
      expect(killed).toBe(true);
    });

    it('surfaces ENOENT for missing claude binary with an install hint', async () => {
      spawnMock.mockImplementation(() => {
        const child = new EventEmitter() as any;
        child.stdin = { write() {}, end() {} };
        child.stderr = new Readable({ read() {} });
        child.kill = () => undefined;
        queueMicrotask(() => {
          const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          child.emit('error', err);
        });
        return child;
      });
      await expect(
        humanGate({
          interactive: true,
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: ['--model', 'sonnet'],
          agent: 'ac-writer',
          input: 'ACS.md',
          prompt: 'iterate',
        }),
      ).rejects.toThrow(/not found on PATH/);
    });

    it('deactivates alt-screen on ENOENT rejection (no orphan alt-screen / depth leak)', async () => {
      // The activate/deactivate pair must be symmetric across every rejection
      // path. Without the `try { ... } finally { deactivateAltScreen(); }`
      // wrap around the spawn Promise, ENOENT's `reject(...)` would skip
      // the deactivate and leave both (a) the terminal in alt buffer until
      // the process-`'exit'` safety net fires and (b) the module-level
      // `altScreenDepth` counter incremented — corrupting later agents'
      // alt-screen entry/exit pairs in-pipeline. Assert that the alt-leave
      // ANSI sequence (`\x1b[?1049l`, emitted by `deactivateAltScreen` when
      // depth returns to 0) lands on stdout after the rejection.
      const stdoutWrites: string[] = [];
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
        stdoutWrites.push(chunk);
        return true;
      }) as any);
      try {
        spawnMock.mockImplementation(() => {
          const child = new EventEmitter() as any;
          child.stdin = { write() {}, end() {} };
          child.stderr = new Readable({ read() {} });
          child.kill = () => undefined;
          queueMicrotask(() => {
            const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            child.emit('error', err);
          });
          return child;
        });
        await expect(
          humanGate({
            interactive: true,
            cli: 'claude',
            agentDirs: ['.claude/agents/', '~/.claude/agents/'],
            extraArgs: ['--model', 'sonnet'],
            agent: 'ac-writer',
            input: 'ACS.md',
            prompt: 'iterate',
          }),
        ).rejects.toThrow(/not found on PATH/);
        const all = stdoutWrites.join('');
        // Alt-enter on activate + alt-leave on deactivate must both appear.
        expect(all).toContain('\x1b[?1049h');
        expect(all).toContain('\x1b[?1049l');
      } finally {
        writeSpy.mockRestore();
      }
    });

    it('captures stderr during the session and replays it to process.stderr after exit', async () => {
      // The alt-screen wrapper wipes anything claude printed to stderr during
      // the interactive session (auth prompts, deprecation warnings, the
      // trailing error message before a non-zero exit, ...). Capturing the
      // stream while the child runs and writing it to process.stderr AFTER
      // deactivateAltScreen() lands the message in main-buffer scrollback
      // right above the y/N — visible to the user instead of lost in the
      // alt buffer.
      spawnMock.mockImplementation(() =>
        makeFakeChild({
          stderrData: ['Run `claude login` to authenticate.\n'],
        }),
      );
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await humanGate({
          interactive: true,
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: ['--model', 'sonnet'],
          agent: 'ac-writer',
          input: 'ACS.md',
          prompt: 'iterate',
        });
        expect(stderrSpy).toHaveBeenCalledWith('Run `claude login` to authenticate.\n');
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('replays captured stderr even when the child exits non-zero', async () => {
      // The motivating claude case: claude prints the actual error
      // ("Error: invalid request, ...") to stderr THEN exits with code 2.
      // Before this fix the user saw only loom's wrapper "claude exited
      // with code 2" — no signal as to what claude said. The finally runs
      // the replay regardless of resolve vs reject, so the stderr lands
      // above the wrapper error in the user's output.
      spawnMock.mockImplementation(() =>
        makeFakeChild({
          stderrData: ['Error: invalid request payload.\n'],
          exitCode: 2,
        }),
      );
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await expect(
          humanGate({
            interactive: true,
            cli: 'claude',
            agentDirs: ['.claude/agents/', '~/.claude/agents/'],
            extraArgs: ['--model', 'sonnet'],
            agent: 'ac-writer',
            input: 'ACS.md',
            prompt: 'iterate',
          }),
        ).rejects.toThrow(/exited with code 2/);
        expect(stderrSpy).toHaveBeenCalledWith('Error: invalid request payload.\n');
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('writes nothing to process.stderr when the session was silent', async () => {
      // Empty capture ⇒ no replay. Guards against an "always-write" regression
      // that would surface phantom newlines or empty writes post-exit.
      spawnMock.mockImplementation(() => makeFakeChild());
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await humanGate({
          interactive: true,
          cli: 'claude',
          agentDirs: ['.claude/agents/', '~/.claude/agents/'],
          extraArgs: ['--model', 'sonnet'],
          agent: 'ac-writer',
          input: 'ACS.md',
          prompt: 'iterate',
        });
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });

  describe('copilot cli path', () => {
    let originalIsTTY: boolean;
    beforeEach(() => {
      originalIsTTY = process.stdout.isTTY;
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    });
    afterEach(() => {
      Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('spawns copilot with --interactive + prompt argv shape (no --agent or -p flag)', async () => {
      spawnMock.mockImplementation(() => makeFakeChild());
      await humanGate({
        interactive: true,
        cli: 'copilot',
        agentDirs: ['.github/agents/', '~/.copilot/agents/'],
        extraArgs: ['--no-color'],
        agent: 'copilot-agent',
        input: 'ACS.md',
        prompt: 'iterate on ACS',
      });
      const [cmd, args] = spawnMock.mock.calls[0];
      expect(cmd).toBe('copilot');
      // copilot has no --agent (no per-agent system-prompt flag);
      // -p is non-interactive scripting mode, the opposite of what we want.
      expect(args).not.toContain('--agent');
      expect(args).not.toContain('-p');
      // --interactive <prompt> pre-loads the prompt as turn 1 and opens
      // the TUI. Without it, bare copilot with piped+EOF'd stdin entered
      // non-interactive mode and exited without opening a TUI — the bug
      // this fix addresses.
      expect(args).toContain('--interactive');
      expect(args[args.indexOf('--interactive') + 1]).toContain('iterate on ACS');
    });

    it('uses inherited stdin+stdout with stderr piped (TUI works; stderr captured for replay)', async () => {
      spawnMock.mockImplementation(() => makeFakeChild());
      await humanGate({
        interactive: true,
        cli: 'copilot',
        agentDirs: ['.github/agents/', '~/.copilot/agents/'],
        extraArgs: ['--no-color'],
        agent: 'copilot-agent',
        input: 'ACS.md',
        prompt: 'iterate',
      });
      const options = spawnMock.mock.calls[0][2];
      // Stdin + stdout inherited (the TUI needs both); stderr piped so the
      // capture listener can replay diagnostics the alt-screen would
      // otherwise wipe. Piping stdin (the prior shape) made copilot treat
      // the input as scripted and exit without a TUI. Explicit cwd is
      // load-bearing for the READ side of the contract (same rationale
      // as the claude path: invocation dir lets the agent see user-supplied
      // project files; WRITE side is safe via the absolute path threaded
      // into the prompt). Under vitest the `LOOM_INVOCATION_CWD` env var
      // is unset, so `childCwd` (in spawnInteractiveAgent) falls back to
      // `process.cwd()`, which the assertion below checks.
      expect(options).toMatchObject({ stdio: ['inherit', 'inherit', 'pipe'], cwd: process.cwd() });
    });

    describe('spawn cwd threading via LOOM_INVOCATION_CWD', () => {
      // Mirror of the claude branch's coverage. The two clis run separate
      // `spawn(...)` calls in spawnInteractiveAgent — testing only one
      // would leave the other open to silent regression. Both branches
      // share the same `childCwd` local, but the assertion is per-spawn.
      let originalInvocationCwd: string | undefined;
      beforeEach(() => {
        originalInvocationCwd = process.env.LOOM_INVOCATION_CWD;
      });
      afterEach(() => {
        if (originalInvocationCwd === undefined) delete process.env.LOOM_INVOCATION_CWD;
        else process.env.LOOM_INVOCATION_CWD = originalInvocationCwd;
      });

      it('passes LOOM_INVOCATION_CWD as cwd when set (copilot path)', async () => {
        process.env.LOOM_INVOCATION_CWD = '/some/invocation/dir';
        spawnMock.mockImplementation(() => makeFakeChild());
        await humanGate({
          interactive: true,
          cli: 'copilot',
          agentDirs: ['.github/agents/', '~/.copilot/agents/'],
          extraArgs: ['--no-color'],
          agent: 'copilot-agent',
          input: 'ACS.md',
          prompt: 'iterate',
        });
        expect(spawnMock.mock.calls[0][2]).toMatchObject({ cwd: '/some/invocation/dir' });
      });

      it('falls back to process.cwd() when LOOM_INVOCATION_CWD is unset (copilot path)', async () => {
        delete process.env.LOOM_INVOCATION_CWD;
        spawnMock.mockImplementation(() => makeFakeChild());
        await humanGate({
          interactive: true,
          cli: 'copilot',
          agentDirs: ['.github/agents/', '~/.copilot/agents/'],
          extraArgs: ['--no-color'],
          agent: 'copilot-agent',
          input: 'ACS.md',
          prompt: 'iterate',
        });
        expect(spawnMock.mock.calls[0][2]).toMatchObject({ cwd: process.cwd() });
      });
    });

    it('passes system prompt + loom prompt + path injection as the --interactive argv value', async () => {
      spawnMock.mockImplementation(() => makeFakeChild());
      await humanGate({
        interactive: true,
        cli: 'copilot',
        agentDirs: ['.github/agents/', '~/.copilot/agents/'],
        extraArgs: ['--no-color'],
        agent: 'copilot-agent',
        input: 'ACS.md',
        prompt: 'iterate on ACS',
      });
      const args = spawnMock.mock.calls[0][1] as string[];
      const interactiveValue = args[args.indexOf('--interactive') + 1];
      // Persona body is frontmatter-stripped before going in.
      expect(interactiveValue).not.toMatch(/^---/);
      expect(interactiveValue).toContain('SYS PROMPT BODY');
      expect(interactiveValue).toContain('iterate on ACS');
      expect(interactiveValue).toContain(`The artifact is at: ${nodePath.resolve('ACS.md')}`);
      // Persona body comes before the loom prompt, separated by `---`.
      expect(interactiveValue.indexOf('SYS PROMPT BODY')).toBeLessThan(
        interactiveValue.indexOf('iterate on ACS'),
      );
    });

    it('extraArgs from the pipeline header flow through to spawn argv', async () => {
      spawnMock.mockImplementation(() => makeFakeChild());
      await humanGate({
        interactive: true,
        cli: 'copilot',
        agentDirs: ['.github/agents/', '~/.copilot/agents/'],
        extraArgs: ['--no-color'],
        agent: 'copilot-agent',
        input: 'ACS.md',
        prompt: 'iterate',
      });
      const [, args] = spawnMock.mock.calls[0];
      // extraArgs comes through unchanged from the pipeline-header default
      // baked into InteractiveGateOpts. The --interactive flag is appended
      // AFTER extraArgs so the prompt argv stays last (parallels claude's
      // shape where the message argv is the trailing positional).
      expect(args).toContain('--no-color');
      expect(args.indexOf('--no-color')).toBeLessThan(args.indexOf('--interactive'));
    });

    it('surfaces ENOENT for missing copilot binary with an install hint', async () => {
      // Verifies the copilot path routes spawn-ENOENT (delivered via
      // microtask after a failed spawn) through reject() with the
      // install-hint message rather than letting the raw "spawn ENOENT"
      // text escape — the latter would be confusing to a user who doesn't
      // know copilot is missing from PATH.
      spawnMock.mockImplementation(() => {
        const child = new EventEmitter() as any;
        child.stdin = { write() {}, end() {} };
        child.stderr = new Readable({ read() {} });
        child.kill = () => undefined;
        queueMicrotask(() => {
          const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          child.emit('error', err);
        });
        return child;
      });
      await expect(
        humanGate({
          interactive: true,
          cli: 'copilot',
          agentDirs: ['.github/agents/', '~/.copilot/agents/'],
          extraArgs: ['--no-color'],
          agent: 'copilot-agent',
          input: 'ACS.md',
          prompt: 'iterate',
        }),
      ).rejects.toThrow(/not found on PATH/);
    });

    it('omits system prompt prefix when persona file is frontmatter-only (bare-cli agent)', async () => {
      // The bare-cli agent convention: a .md file with frontmatter and no
      // body. loadAgentSystemPrompt strips frontmatter and trims, leaving
      // an empty string; the runtime treats empty-body the same as
      // no-prompt and the --interactive argv value carries only the
      // loom-built initial message (no persona body, no `---` separator).
      const savedBody = promptFileBody;
      try {
        promptFileBody = '---\nname: test-agent\n---\n'; // frontmatter only, no body
        vi.resetModules();
        ({ humanGate } = await import('./human-gate.js'));
        spawnMock.mockImplementation(() => makeFakeChild());
        await humanGate({
          interactive: true,
          cli: 'copilot',
          agentDirs: ['.github/agents/', '~/.copilot/agents/'],
          extraArgs: [],
          agent: 'copilot-agent',
          input: 'ACS.md',
          prompt: 'iterate',
        });
        const args = spawnMock.mock.calls[0][1] as string[];
        const interactiveValue = args[args.indexOf('--interactive') + 1];
        expect(interactiveValue).not.toContain('SYS PROMPT BODY');
        expect(interactiveValue).toContain('iterate');
        expect(interactiveValue).toContain(`The artifact is at: ${nodePath.resolve('ACS.md')}`);
      } finally {
        promptFileBody = savedBody;
      }
    });

    it('after copilot exits, asks y/N and throws on non-y', async () => {
      spawnMock.mockImplementation(() => makeFakeChild({ exitCode: 0 }));
      questionAnswer = '';
      await expect(
        humanGate({
          interactive: true,
          cli: 'copilot',
          agentDirs: ['.github/agents/', '~/.copilot/agents/'],
          extraArgs: ['--no-color'],
          agent: 'copilot-agent',
          input: 'ACS.md',
          prompt: 'iterate',
        }),
      ).rejects.toThrow(/halted by human gate/);
    });

    it('captures stderr during the session and replays it to process.stderr after exit', async () => {
      // The fast-clean-exit silent-failure: copilot prints an auth/model/
      // entitlement diagnostic to stderr, then exits 0 — the alt-screen
      // tear-down wipes the message, the runtime sees a clean exit, and the
      // user lands at y/N with no idea what happened. Capturing stderr and
      // replaying it after deactivateAltScreen() makes the diagnostic land
      // in main-buffer scrollback right above the y/N.
      spawnMock.mockImplementation(() =>
        makeFakeChild({
          stderrData: ['Error: Unknown model `gpt-4.1`.\n'],
        }),
      );
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await humanGate({
          interactive: true,
          cli: 'copilot',
          agentDirs: ['.github/agents/', '~/.copilot/agents/'],
          extraArgs: ['--model', 'gpt-4.1'],
          agent: 'copilot-agent',
          input: 'ACS.md',
          prompt: 'iterate',
        });
        expect(stderrSpy).toHaveBeenCalledWith('Error: Unknown model `gpt-4.1`.\n');
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('writes nothing to process.stderr when the session was silent', async () => {
      spawnMock.mockImplementation(() => makeFakeChild());
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await humanGate({
          interactive: true,
          cli: 'copilot',
          agentDirs: ['.github/agents/', '~/.copilot/agents/'],
          extraArgs: ['--no-color'],
          agent: 'copilot-agent',
          input: 'ACS.md',
          prompt: 'iterate',
        });
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('caps stderr capture at 8KB (keeps the trailing bytes)', async () => {
      // Ring-buffer cap guards against a runaway log blowing memory.
      // Trailing bytes are kept because terminal error output is
      // append-only — the most recent line is the most diagnostic.
      const big = 'x'.repeat(9000);
      spawnMock.mockImplementation(() => makeFakeChild({ stderrData: [big] }));
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await humanGate({
          interactive: true,
          cli: 'copilot',
          agentDirs: ['.github/agents/', '~/.copilot/agents/'],
          extraArgs: ['--no-color'],
          agent: 'copilot-agent',
          input: 'ACS.md',
          prompt: 'iterate',
        });
        const replayCall = stderrSpy.mock.calls.find(
          (c) =>
            typeof c[0] === 'string' &&
            (c[0] as string).startsWith('x') &&
            (c[0] as string).length === 8 * 1024,
        );
        expect(replayCall).toBeDefined();
        expect(replayCall![0]).toBe('x'.repeat(8 * 1024));
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });
});

describe('humanGate — plain y/N mode', () => {
  let originalIsTTY: boolean;
  beforeEach(() => {
    originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  it('uses a generic prompt (no per-gate customization) and does not spawn', async () => {
    questionAnswer = 'y';
    await expect(humanGate()).resolves.toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readlineCloseMock).toHaveBeenCalled();
  });

  it('proceeds on y', async () => {
    questionAnswer = 'y';
    await expect(humanGate()).resolves.toBeUndefined();
  });

  it('proceeds on yes', async () => {
    questionAnswer = 'yes';
    await expect(humanGate()).resolves.toBeUndefined();
  });

  it('proceeds on Y (case-insensitive)', async () => {
    questionAnswer = 'Y';
    await expect(humanGate()).resolves.toBeUndefined();
  });

  it('throws on n', async () => {
    questionAnswer = 'n';
    await expect(humanGate()).rejects.toThrow(/halted by human gate/);
  });

  it('throws on empty input', async () => {
    questionAnswer = '';
    await expect(humanGate()).rejects.toThrow(/halted by human gate/);
  });

  it('throws on any non-y answer', async () => {
    questionAnswer = 'maybe';
    await expect(humanGate()).rejects.toThrow(/halted by human gate/);
  });

  describe('TTY check', () => {
    it('throws when stdout is not a TTY (CI/piped/non-it-docker)', async () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
      await expect(humanGate()).rejects.toThrow(/requires a TTY/);
      expect(readlineCloseMock).not.toHaveBeenCalled();
    });

    it('throws when stdin is not a TTY (`loom run < /dev/null` from a real shell)', async () => {
      // Without checking stdin, readline.question would never fire its
      // callback (no line ever available on closed stdin) and the pipeline
      // would silently hang despite stdout still being a TTY.
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      await expect(humanGate()).rejects.toThrow(/requires a TTY/);
      expect(readlineCloseMock).not.toHaveBeenCalled();
    });
  });
});
