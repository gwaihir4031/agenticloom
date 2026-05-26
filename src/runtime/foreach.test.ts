import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { foreach } from './foreach.js';
import { HaltPipelineError } from './agent.js';

describe('foreach runtime helper', () => {
  let workRoot: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    // realpathSync canonicalizes macOS's /var → /private/var symlink so
    // post-chdir process.cwd() comparisons line up — the kernel resolves
    // symlinks on chdir, the test's expected-string must match.
    workRoot = realpathSync(mkdtempSync(join(tmpdir(), 'foreach-test-')));
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(workRoot, { recursive: true, force: true });
  });

  describe('JSONL upfront validation', () => {
    it('throws on malformed JSON BEFORE iteration 0 runs', async () => {
      const jsonl = join(workRoot, 'plan.jsonl');
      writeFileSync(jsonl, '{"id":1}\n{not valid}\n{"id":2}\n');

      const bodyCalls: number[] = [];
      await expect(
        foreach({
          over: jsonl,
          overLabel: '$plan',
          bindName: 'results',
          syntheticName: 'foreach-1',
          onIterationFail: 'abort',
          body: async () => {
            bodyCalls.push(1);
          },
          workspaceRoot: workRoot,
        }),
      ).rejects.toThrow(/line 2 is not valid JSON/);
      expect(bodyCalls).toEqual([]);
    });

    it('skips empty lines with a warning', async () => {
      const jsonl = join(workRoot, 'plan.jsonl');
      writeFileSync(jsonl, '{"id":1}\n\n{"id":2}\n   \n{"id":3}\n');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const bodyCalls: string[] = [];
      const result = await foreach({
        over: jsonl,
        overLabel: '$plan',
        bindName: 'results',
        syntheticName: 'foreach-1',
        onIterationFail: 'abort',
        body: async (taskPath) => {
          const content = readFileSync(taskPath, 'utf-8');
          bodyCalls.push(content);
        },
        workspaceRoot: workRoot,
      });

      expect(bodyCalls).toEqual(['{"id":1}', '{"id":2}', '{"id":3}']);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/skipping line 2 \(empty\)/));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/skipping line 4 \(empty\)/));
      expect(result.iterDirs).toHaveLength(3);
      warnSpy.mockRestore();
    });

    it("throws with the user's overLabel in the error message", async () => {
      const jsonl = join(workRoot, 'plan.jsonl');
      writeFileSync(jsonl, 'not json\n');
      await expect(
        foreach({
          over: jsonl,
          overLabel: '$plan',
          bindName: 'results',
          syntheticName: 'foreach-1',
          onIterationFail: 'abort',
          body: async () => {},
          workspaceRoot: workRoot,
        }),
      ).rejects.toThrow(/foreach over '\$plan': line 1 is not valid JSON/);
    });
  });

  describe('iteration semantics', () => {
    it('runs iterations sequentially in input order', async () => {
      const jsonl = join(workRoot, 'plan.jsonl');
      writeFileSync(jsonl, '{"id":1}\n{"id":2}\n{"id":3}\n');

      const order: number[] = [];
      await foreach({
        over: jsonl,
        overLabel: '$plan',
        bindName: 'results',
        syntheticName: 'foreach-1',
        onIterationFail: 'abort',
        body: async (taskPath) => {
          const data = JSON.parse(readFileSync(taskPath, 'utf-8'));
          order.push(data.id);
        },
        workspaceRoot: workRoot,
      });

      expect(order).toEqual([1, 2, 3]);
    });

    it('writes task.json inside iter-N/ and chdirs there', async () => {
      const jsonl = join(workRoot, 'plan.jsonl');
      writeFileSync(jsonl, '{"id":1}\n{"id":2}\n');

      const cwds: string[] = [];
      const taskPaths: string[] = [];
      await foreach({
        over: jsonl,
        overLabel: '$plan',
        bindName: 'results',
        syntheticName: 'foreach-1',
        onIterationFail: 'abort',
        body: async (taskPath, iterScratchDir) => {
          cwds.push(process.cwd());
          taskPaths.push(taskPath);
          expect(process.cwd()).toBe(iterScratchDir);
        },
        workspaceRoot: workRoot,
      });

      expect(cwds[0]).toBe(join(workRoot, 'results', 'iter-0'));
      expect(cwds[1]).toBe(join(workRoot, 'results', 'iter-1'));
      expect(taskPaths[0]).toBe(join(workRoot, 'results', 'iter-0', 'task.json'));
      expect(existsSync(taskPaths[0])).toBe(true);
      expect(existsSync(taskPaths[1])).toBe(true);
    });

    it('restores cwd after each iteration even on body error (abort)', async () => {
      const jsonl = join(workRoot, 'plan.jsonl');
      writeFileSync(jsonl, '{"id":1}\n');
      // realpathSync canonicalizes macOS's /var → /private/var symlink so
      // the comparison lines up with the kernel-resolved cwd; mirrors the
      // workRoot setup in beforeEach and the continue-mode test below.
      const beforeCwd = realpathSync(process.cwd());

      await expect(
        foreach({
          over: jsonl,
          overLabel: '$plan',
          bindName: 'results',
          syntheticName: 'foreach-1',
          onIterationFail: 'abort',
          body: async () => {
            throw new Error('body failure');
          },
          workspaceRoot: workRoot,
        }),
      ).rejects.toThrow('body failure');

      expect(realpathSync(process.cwd())).toBe(beforeCwd);
    });

    it('restores cwd after each iteration even on body error (continue)', async () => {
      const jsonl = join(workRoot, 'plan.jsonl');
      writeFileSync(jsonl, '{"id":1}\n{"id":2}\n');
      // realpathSync canonicalizes macOS's /var → /private/var symlink so
      // the comparison lines up with the kernel-resolved cwd; mirrors the
      // workRoot setup in beforeEach.
      const beforeCwd = realpathSync(process.cwd());
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // continue catches the body error, so the foreach resolves rather
      // than rejecting — assert on the final cwd after resolution.
      await foreach({
        over: jsonl,
        overLabel: '$plan',
        bindName: 'results',
        syntheticName: 'foreach-1',
        onIterationFail: 'continue',
        body: async () => {
          throw new Error('body failure');
        },
        workspaceRoot: workRoot,
      });

      expect(realpathSync(process.cwd())).toBe(beforeCwd);
      warnSpy.mockRestore();
    });

    it('uses syntheticName when bindName is omitted', async () => {
      const jsonl = join(workRoot, 'plan.jsonl');
      writeFileSync(jsonl, '{"id":1}\n');

      const cwds: string[] = [];
      await foreach({
        over: jsonl,
        overLabel: '$plan',
        syntheticName: 'foreach-7',
        onIterationFail: 'abort',
        body: async () => {
          cwds.push(process.cwd());
        },
        workspaceRoot: workRoot,
      });

      expect(cwds[0]).toBe(join(workRoot, 'foreach-7', 'iter-0'));
    });
  });

  describe('on_iteration_fail', () => {
    it('abort (default) re-throws on first iteration error', async () => {
      const jsonl = join(workRoot, 'plan.jsonl');
      writeFileSync(jsonl, '{"id":1}\n{"id":2}\n{"id":3}\n');
      const reached: number[] = [];

      await expect(
        foreach({
          over: jsonl,
          overLabel: '$plan',
          bindName: 'results',
          syntheticName: 'foreach-1',
          onIterationFail: 'abort',
          body: async (taskPath) => {
            const data = JSON.parse(readFileSync(taskPath, 'utf-8'));
            reached.push(data.id);
            if (data.id === 2) throw new Error('iter 1 failed');
          },
          workspaceRoot: workRoot,
        }),
      ).rejects.toThrow('iter 1 failed');

      expect(reached).toEqual([1, 2]); // iter-2 (id 3) never runs
    });

    it('continue catches plain Errors, logs, and proceeds', async () => {
      const jsonl = join(workRoot, 'plan.jsonl');
      writeFileSync(jsonl, '{"id":1}\n{"id":2}\n{"id":3}\n');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const reached: number[] = [];

      const result = await foreach({
        over: jsonl,
        overLabel: '$plan',
        bindName: 'results',
        syntheticName: 'foreach-1',
        onIterationFail: 'continue',
        body: async (taskPath) => {
          const data = JSON.parse(readFileSync(taskPath, 'utf-8'));
          reached.push(data.id);
          if (data.id === 2) throw new Error('iter 1 failed');
        },
        workspaceRoot: workRoot,
      });

      expect(reached).toEqual([1, 2, 3]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/iteration 1 failed: iter 1 failed; continuing/),
      );
      expect(result.iterDirs).toHaveLength(3);
      expect(result.failedIterations.get(1)).toBe('iter 1 failed');
      warnSpy.mockRestore();
    });

    it('HaltPipelineError propagates even under continue', async () => {
      const jsonl = join(workRoot, 'plan.jsonl');
      writeFileSync(jsonl, '{"id":1}\n{"id":2}\n');
      const reached: number[] = [];

      await expect(
        foreach({
          over: jsonl,
          overLabel: '$plan',
          bindName: 'results',
          syntheticName: 'foreach-1',
          onIterationFail: 'continue',
          body: async (taskPath) => {
            const data = JSON.parse(readFileSync(taskPath, 'utf-8'));
            reached.push(data.id);
            if (data.id === 1) throw new HaltPipelineError('user halt');
          },
          workspaceRoot: workRoot,
        }),
      ).rejects.toBeInstanceOf(HaltPipelineError);

      expect(reached).toEqual([1]);
    });

    it('body callback receives only (taskPath, iterScratchDir) — no iteration index leaked', async () => {
      const jsonl = join(workRoot, 'plan.jsonl');
      writeFileSync(jsonl, '{"id":1}\n');
      let arity = -1;
      await foreach({
        over: jsonl,
        overLabel: '$plan',
        bindName: 'results',
        syntheticName: 'foreach-1',
        onIterationFail: 'abort',
        body: async function bodyCB(...args) {
          arity = args.length;
        },
        workspaceRoot: workRoot,
      });
      expect(arity).toBe(2);
    });
  });

  describe('syscall failure wrapping', () => {
    it('wraps a missing JSONL file with foreach context', async () => {
      // Point at a path that doesn't exist; readFileSync throws ENOENT
      // and the helper rewraps with the user's `over:` expression so the
      // error names where the failure happened.
      const missing = join(workRoot, 'does-not-exist.jsonl');
      await expect(
        foreach({
          over: missing,
          overLabel: '$plan',
          bindName: 'results',
          syntheticName: 'foreach-1',
          onIterationFail: 'abort',
          body: async () => {},
          workspaceRoot: workRoot,
        }),
      ).rejects.toThrow(/foreach over '\$plan'.*cannot read JSONL file/);
    });

    it('wraps a chdir failure with foreach context and re-throws regardless of onIterationFail (continue)', async () => {
      const jsonl = join(workRoot, 'plan.jsonl');
      writeFileSync(jsonl, '{"id":1}\n');
      // Spy on process.chdir to simulate an ENOENT racing the mkdirSync
      // (e.g. workspace cleanup mid-run). A chdir failure must bubble even
      // under `continue` mode — attributing it to the iteration body would
      // mask the syscall problem behind a misleading per-iteration warning.
      const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('iter-0')) {
          throw new Error("ENOENT: no such file or directory, chdir '" + p + "'");
        }
      });
      try {
        await expect(
          foreach({
            over: jsonl,
            overLabel: '$plan',
            bindName: 'results',
            syntheticName: 'foreach-1',
            onIterationFail: 'continue',
            body: async () => {},
            workspaceRoot: workRoot,
          }),
        ).rejects.toThrow(/foreach over '\$plan': cannot chdir into iteration 0 scratch dir/);
      } finally {
        chdirSpy.mockRestore();
      }
    });

    it('wraps a chdir failure with foreach context and re-throws under abort mode too', async () => {
      // Mirror of the continue-mode test above: the chdir wrap re-throws
      // regardless of onIterationFail (infrastructure failures are not
      // iteration-content failures). Abort mode is the production default;
      // the parity test guards against a future regression that gates the
      // re-throw behind the policy check.
      const jsonl = join(workRoot, 'plan.jsonl');
      writeFileSync(jsonl, '{"id":1}\n');
      const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('iter-0')) {
          throw new Error("ENOENT: no such file or directory, chdir '" + p + "'");
        }
      });
      try {
        await expect(
          foreach({
            over: jsonl,
            overLabel: '$plan',
            bindName: 'results',
            syntheticName: 'foreach-1',
            onIterationFail: 'abort',
            body: async () => {},
            workspaceRoot: workRoot,
          }),
        ).rejects.toThrow(/foreach over '\$plan': cannot chdir into iteration 0 scratch dir/);
      } finally {
        chdirSpy.mockRestore();
      }
    });

    it('wraps an iteration scratch-dir setup failure with foreach context and re-throws regardless of onIterationFail', async () => {
      // Pre-create a regular file where `results/` would land. mkdirSync
      // for `results/iter-0` then fails with ENOTDIR ('results' is a file,
      // not a directory) — same posture as the chdir wrap: infrastructure
      // failures bubble even under `continue` mode.
      const jsonl = join(workRoot, 'plan.jsonl');
      writeFileSync(jsonl, '{"id":1}\n');
      writeFileSync(join(workRoot, 'results'), 'collision');

      await expect(
        foreach({
          over: jsonl,
          overLabel: '$plan',
          bindName: 'results',
          syntheticName: 'foreach-1',
          onIterationFail: 'continue',
          body: async () => {},
          workspaceRoot: workRoot,
        }),
      ).rejects.toThrow(/foreach over '\$plan': cannot set up iteration 0 scratch dir/);
    });
  });
});
