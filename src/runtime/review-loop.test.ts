import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable } from 'node:stream';
import * as nodePath from 'node:path';
import { makeFakeRunAgentChild } from './test-helpers.js';

// Mock child_process.spawn — reviewLoop fires runAgent for the writer and
// (in single mode) the reviewer. The tests below install spawnMock impls
// that route by prompt-body marker to a fakeFs side-effect mimicking the
// writer / reviewer file writes.
const spawnMock = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: any[]) => spawnMock(...args),
}));

// Mock readline — runAgent's stdout-line consumer needs the line-streaming
// shape. The y/N branch isn't exercised by reviewLoop but the shape-dispatch
// is kept for forward compatibility with a future test that needs it.
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

// Mock fs — reviewLoop reads writer/reviewer persona files via
// loadAgentSystemPrompt and reads the reviewer verdict via readAgentFile.
// fakeFs is keyed both by bare filename (the literal YAML form) and
// absolute (the absolutified bind form).
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

describe('reviewLoop (single reviewer)', () => {
  // Helper: simulate writer + reviewer file writes by populating fakeFs.
  // The prompt body carries the producesPath; we use that to route which
  // file the call "writes" to.
  // Routing by prompt-body marker (rather than call index) decouples the
  // helper from assumptions about writer-vs-reviewer call interleaving —
  // reviewLoop's call order is the production code's concern, not the
  // test's.
  // The side-effect writes to fakeFs fire synchronously at spawn-time; the
  // returned fake child closes its stdout and exits 0 on the next microtask
  // (see makeFakeRunAgentChild), so runAgent resolves before reviewLoop reads
  // the file.
  function installFileWritingSpawnMock(reviewerSequence: string[]): void {
    let reviewerCallIdx = 0;
    spawnMock.mockImplementation((_bin: string, args: string[]) => {
      const prompt = args[1] as string;
      if (prompt.includes('Write your review to:')) {
        const verdictBody =
          reviewerSequence[reviewerCallIdx] ?? reviewerSequence[reviewerSequence.length - 1]; // hold last
        fakeFs['review.json'] = verdictBody;
        reviewerCallIdx++;
      } else if (prompt.includes('Write your artifact')) {
        fakeFs['out.md'] = 'draft body';
      }
      return makeFakeRunAgentChild();
    });
  }

  it('returns the writer path on iter-1 approval', async () => {
    installFileWritingSpawnMock([JSON.stringify({ status: 'pass' })]);
    const { reviewLoop } = await import('./review-loop.js');
    const draft = await reviewLoop({
      kind: 'single',
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      defaultExtraArgs: [],
      writer: 'w',
      reviewer: 'r',
      input: 'input',
      writerProduces: 'out.md',
      reviewerProduces: 'review.json',
      verdictField: 'status',
    });
    expect(draft).toBe(nodePath.resolve('out.md'));
    expect(spawnMock).toHaveBeenCalledTimes(2); // 1 writer + 1 reviewer
  });

  it('iterates once on reviewer fail then approves', async () => {
    installFileWritingSpawnMock([
      JSON.stringify({ status: 'fail' }),
      JSON.stringify({ status: 'pass' }),
    ]);
    const { reviewLoop } = await import('./review-loop.js');
    const draft = await reviewLoop({
      kind: 'single',
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      defaultExtraArgs: [],
      writer: 'w',
      reviewer: 'r',
      input: 'input',
      writerProduces: 'out.md',
      reviewerProduces: 'review.json',
      verdictField: 'status',
      maxIters: 3,
    });
    expect(draft).toBe(nodePath.resolve('out.md'));
    expect(spawnMock).toHaveBeenCalledTimes(4); // 2 writer + 2 reviewer
  });

  it('returns last draft after max_iters without approval', async () => {
    installFileWritingSpawnMock([JSON.stringify({ status: 'fail' })]);
    const { reviewLoop } = await import('./review-loop.js');
    const draft = await reviewLoop({
      kind: 'single',
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      defaultExtraArgs: [],
      writer: 'w',
      reviewer: 'r',
      input: 'input',
      writerProduces: 'out.md',
      reviewerProduces: 'review.json',
      verdictField: 'status',
      maxIters: 2,
    });
    expect(draft).toBe(nodePath.resolve('out.md'));
    // iter-1: writer + reviewer (fail), iter-1 falls through to revise prompt;
    // iter-2: writer (revise) + reviewer (fail) → max_iters hit → return.
    expect(spawnMock).toHaveBeenCalledTimes(4);
  });

  it('uses approveWhen value when set', async () => {
    installFileWritingSpawnMock([JSON.stringify({ status: 'OK' })]);
    const { reviewLoop } = await import('./review-loop.js');
    const draft = await reviewLoop({
      kind: 'single',
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      defaultExtraArgs: [],
      writer: 'w',
      reviewer: 'r',
      input: 'input',
      writerProduces: 'out.md',
      reviewerProduces: 'review.json',
      verdictField: 'status',
      approveWhen: 'OK',
      maxIters: 1,
    });
    expect(draft).toBe(nodePath.resolve('out.md'));
  });

  it('passes writerProduces path to reviewer prompt text', async () => {
    // Reviewer's input prompt is "The artifact to review is at: <writerPath>"
    // — the runtime owns this framing; verifies it survives the path threading.
    installFileWritingSpawnMock([JSON.stringify({ status: 'pass' })]);
    const { reviewLoop } = await import('./review-loop.js');
    await reviewLoop({
      kind: 'single',
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      defaultExtraArgs: [],
      writer: 'w',
      reviewer: 'r',
      input: 'input',
      writerProduces: 'out.md',
      reviewerProduces: 'review.json',
      verdictField: 'status',
    });
    const reviewerCallArgs = spawnMock.mock.calls[1][1] as string[];
    const reviewerPrompt = reviewerCallArgs.find((a: string) =>
      a.includes('The artifact to review is at:'),
    );
    // Tight match on the absolute form — a regression that re-relativized
    // writerPath in the reviewer-input prompt would silently pass a basename
    // substring check.
    expect(reviewerPrompt).toContain(`The artifact to review is at: ${nodePath.resolve('out.md')}`);
  });

  it('throws HaltPipelineError on exhaustion when on_max_exceeded: fail (single reviewer)', async () => {
    installFileWritingSpawnMock([JSON.stringify({ status: 'fail' })]);
    const { reviewLoop } = await import('./review-loop.js');
    const { HaltPipelineError } = await import('./agent.js');
    let thrown: unknown;
    try {
      await reviewLoop({
        kind: 'single',
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        defaultExtraArgs: [],
        writer: 'w',
        reviewer: 'r',
        input: 'input',
        writerProduces: 'out.md',
        reviewerProduces: 'review.json',
        verdictField: 'status',
        maxIters: 1,
        onMaxExceeded: 'fail',
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HaltPipelineError);
    expect((thrown as Error).name).toBe('HaltPipelineError');
    expect((thrown as Error).message).toMatch(/review_loop 'w' exhausted max_iters=1/);
    expect((thrown as Error).message).toMatch(/verdict_field='status'/);
    expect((thrown as Error).message).toMatch(/approve_when='pass'/);
    expect((thrown as Error).message).toMatch(/Last verdict: 'fail'/);
  });

  it('warns and returns last draft on exhaustion when on_max_exceeded: continue (single reviewer)', async () => {
    installFileWritingSpawnMock([JSON.stringify({ status: 'fail' })]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { reviewLoop } = await import('./review-loop.js');
    const draft = await reviewLoop({
      kind: 'single',
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      defaultExtraArgs: [],
      writer: 'w',
      reviewer: 'r',
      input: 'input',
      writerProduces: 'out.md',
      reviewerProduces: 'review.json',
      verdictField: 'status',
      maxIters: 1,
      onMaxExceeded: 'continue',
    });
    expect(draft).toBe(nodePath.resolve('out.md'));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/review_loop 'w' exhausted max_iters=1/),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/Returning last draft\./));
    warnSpy.mockRestore();
  });

  it('defaults to continue when on_max_exceeded is omitted (single reviewer)', async () => {
    installFileWritingSpawnMock([JSON.stringify({ status: 'fail' })]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { reviewLoop } = await import('./review-loop.js');
    const draft = await reviewLoop({
      kind: 'single',
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      defaultExtraArgs: [],
      writer: 'w',
      reviewer: 'r',
      input: 'input',
      writerProduces: 'out.md',
      reviewerProduces: 'review.json',
      verdictField: 'status',
      maxIters: 1,
      // onMaxExceeded omitted — default 'continue' applied at runtime.
    });
    expect(draft).toBe(nodePath.resolve('out.md'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/Returning last draft\./));
    warnSpy.mockRestore();
  });

  it('does NOT throw on mid-loop approval even when on_max_exceeded: fail (single reviewer)', async () => {
    // Sequence: iter-1 fail, iter-2 pass. on_max_exceeded only fires when i === max.
    installFileWritingSpawnMock([
      JSON.stringify({ status: 'fail' }),
      JSON.stringify({ status: 'pass' }),
    ]);
    const { reviewLoop } = await import('./review-loop.js');
    const draft = await reviewLoop({
      kind: 'single',
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      defaultExtraArgs: [],
      writer: 'w',
      reviewer: 'r',
      input: 'input',
      writerProduces: 'out.md',
      reviewerProduces: 'review.json',
      verdictField: 'status',
      maxIters: 3,
      onMaxExceeded: 'fail',
    });
    expect(draft).toBe(nodePath.resolve('out.md'));
  });

  it('exhaustion message format matches the single-reviewer DRAFT shape', async () => {
    // Pin writerProduces='out.md' / reviewerProduces='review.json' to match
    // installFileWritingSpawnMock's hardcoded routing — the helper only
    // writes those two paths to fakeFs, so any other writerProduces would
    // make runAgent throw "did not write expected file" before the
    // exhaustion branch fires.
    installFileWritingSpawnMock([JSON.stringify({ status: 'needs_revision' })]);
    const { reviewLoop } = await import('./review-loop.js');
    const { HaltPipelineError } = await import('./agent.js');
    let thrown: InstanceType<typeof HaltPipelineError> | undefined;
    try {
      await reviewLoop({
        kind: 'single',
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        defaultExtraArgs: [],
        writer: 'spec-writer',
        reviewer: 'spec-reviewer',
        input: 'input',
        writerProduces: 'out.md',
        reviewerProduces: 'review.json',
        verdictField: 'status',
        approveWhen: 'pass',
        maxIters: 2,
        onMaxExceeded: 'fail',
      });
    } catch (e) {
      thrown = e as InstanceType<typeof HaltPipelineError>;
    }
    expect(thrown).toBeDefined();
    // Tight match — writer name + max_iters + verdict + verdict_field + approve_when.
    expect(thrown!.message).toMatch(
      /^review_loop 'spec-writer' exhausted max_iters=2 without approval\.\nLast verdict: 'needs_revision' \(verdict_field='status', approve_when='pass'\)\.$/,
    );
  });
});

describe('reviewLoop (compound reviewer)', () => {
  beforeEach(() => {
    // Writer always "produces" out.md when invoked. The reviewer half of the
    // compound case is owned by the user-supplied subflow callback (a vi.fn
    // returning { verdict, reviewerPaths }), not by runAgent — so only the
    // writer's spawn needs to side-effect-write its produces file.
    spawnMock.mockImplementation((_bin: string, args: string[]) => {
      const prompt = args[1] as string;
      if (prompt.includes('Write your artifact')) {
        fakeFs['out.md'] = 'draft body';
      }
      return makeFakeRunAgentChild();
    });
  });

  it('returns writer path when subflow callback returns pass', async () => {
    const subflow = vi.fn(async (_draftPath: string) => ({
      verdict: 'pass',
      reviewerPaths: [{ agentName: 'r1', path: 'r1.json' }],
    }));
    const { reviewLoop } = await import('./review-loop.js');
    const draft = await reviewLoop({
      kind: 'compound',
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      defaultExtraArgs: [],
      writer: 'w',
      reviewerSubflow: subflow,
      input: 'input',
      writerProduces: 'out.md',
    });
    expect(draft).toBe(nodePath.resolve('out.md'));
    expect(subflow).toHaveBeenCalledWith(nodePath.resolve('out.md'));
  });

  it('re-invokes writer when subflow returns fail then pass', async () => {
    let subCallCount = 0;
    const subflow = vi.fn(async () => {
      subCallCount++;
      return {
        verdict: subCallCount === 1 ? 'fail' : 'pass',
        reviewerPaths: [
          { agentName: 'r1', path: 'r1.json' },
          { agentName: 'r2', path: 'r2.json' },
        ],
      };
    });
    const { reviewLoop } = await import('./review-loop.js');
    await reviewLoop({
      kind: 'compound',
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      defaultExtraArgs: [],
      writer: 'w',
      reviewerSubflow: subflow,
      input: 'input',
      writerProduces: 'out.md',
      maxIters: 3,
    });
    expect(subflow).toHaveBeenCalledTimes(2);
    // Writer invoked twice (iter-1 initial + iter-2 revise):
    expect(spawnMock).toHaveBeenCalledTimes(2);
    // Iter-2's writer call's prompt must reference the N reviewer paths and
    // the overall-verdict text framing — that's the compound revise prompt.
    const revisePrompt = spawnMock.mock.calls[1][1].find((a: string) => a.includes('out.md'));
    expect(revisePrompt).toContain('r1.json');
    expect(revisePrompt).toContain('r2.json');
    expect(revisePrompt).toContain('r1 finished its work');
    expect(revisePrompt).toContain('overall verdict: fail');
  });

  it('returns last draft after max_iters without approval', async () => {
    const subflow = vi.fn(async () => ({
      verdict: 'fail',
      reviewerPaths: [{ agentName: 'r', path: 'r.json' }],
    }));
    const { reviewLoop } = await import('./review-loop.js');
    const draft = await reviewLoop({
      kind: 'compound',
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      defaultExtraArgs: [],
      writer: 'w',
      reviewerSubflow: subflow,
      input: 'input',
      writerProduces: 'out.md',
      maxIters: 2,
    });
    expect(draft).toBe(nodePath.resolve('out.md'));
    expect(subflow).toHaveBeenCalledTimes(2);
  });

  it('passes the current draft path to each subflow invocation', async () => {
    const seenPaths: string[] = [];
    const subflow = vi.fn(async (draftPath: string) => {
      seenPaths.push(draftPath);
      return {
        verdict: seenPaths.length >= 2 ? 'pass' : 'fail',
        reviewerPaths: [{ agentName: 'r', path: 'r.json' }],
      };
    });
    const { reviewLoop } = await import('./review-loop.js');
    await reviewLoop({
      kind: 'compound',
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      defaultExtraArgs: [],
      writer: 'w',
      reviewerSubflow: subflow,
      input: 'input',
      writerProduces: 'out.md',
      maxIters: 3,
    });
    // Every subflow call sees the same writerProduces path — the loop pins
    // it as the single artifact and overwrites in place.
    const abs = nodePath.resolve('out.md');
    expect(seenPaths).toEqual([abs, abs]);
  });

  it('honors approveWhen for non-default verdict strings', async () => {
    const subflow = vi.fn(async () => ({
      verdict: 'APPROVED',
      reviewerPaths: [{ agentName: 'r', path: 'r.json' }],
    }));
    const { reviewLoop } = await import('./review-loop.js');
    const draft = await reviewLoop({
      kind: 'compound',
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      defaultExtraArgs: [],
      writer: 'w',
      reviewerSubflow: subflow,
      input: 'input',
      writerProduces: 'out.md',
      approveWhen: 'APPROVED',
      maxIters: 1,
    });
    expect(draft).toBe(nodePath.resolve('out.md'));
    expect(subflow).toHaveBeenCalledTimes(1);
  });

  it('throws HaltPipelineError on exhaustion when on_max_exceeded: fail (compound reviewer)', async () => {
    const subflow = vi.fn(async () => ({
      verdict: 'fail',
      reviewerPaths: [{ agentName: 'r', path: 'r.json' }],
    }));
    const { reviewLoop } = await import('./review-loop.js');
    const { HaltPipelineError } = await import('./agent.js');
    let thrown: unknown;
    try {
      await reviewLoop({
        kind: 'compound',
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        defaultExtraArgs: [],
        writer: 'w',
        reviewerSubflow: subflow,
        input: 'input',
        writerProduces: 'out.md',
        maxIters: 1,
        onMaxExceeded: 'fail',
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HaltPipelineError);
    expect((thrown as Error).name).toBe('HaltPipelineError');
    expect((thrown as Error).message).toMatch(/review_loop 'w' exhausted max_iters=1/);
    expect((thrown as Error).message).toMatch(/approve_when='pass'/);
    expect((thrown as Error).message).toMatch(/the verdict was extracted by the inner aggregate/);
    // Sentinel: compound mode must NOT name verdict_field — that field
    // doesn't exist on CompoundReviewerOpts. A regression that pasted the
    // single-mode message body into the compound branch would fail here.
    expect((thrown as Error).message).not.toMatch(/verdict_field/);
  });

  it('warns and returns last draft on exhaustion when on_max_exceeded: continue (compound reviewer)', async () => {
    const subflow = vi.fn(async () => ({
      verdict: 'fail',
      reviewerPaths: [{ agentName: 'r', path: 'r.json' }],
    }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { reviewLoop } = await import('./review-loop.js');
    const draft = await reviewLoop({
      kind: 'compound',
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      defaultExtraArgs: [],
      writer: 'w',
      reviewerSubflow: subflow,
      input: 'input',
      writerProduces: 'out.md',
      maxIters: 1,
      onMaxExceeded: 'continue',
    });
    expect(draft).toBe(nodePath.resolve('out.md'));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/review_loop 'w' exhausted max_iters=1/),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/the verdict was extracted by the inner aggregate/),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/Returning last draft\./));
    warnSpy.mockRestore();
  });

  it('defaults to continue when on_max_exceeded is omitted (compound reviewer)', async () => {
    const subflow = vi.fn(async () => ({
      verdict: 'fail',
      reviewerPaths: [{ agentName: 'r', path: 'r.json' }],
    }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { reviewLoop } = await import('./review-loop.js');
    const draft = await reviewLoop({
      kind: 'compound',
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      defaultExtraArgs: [],
      writer: 'w',
      reviewerSubflow: subflow,
      input: 'input',
      writerProduces: 'out.md',
      maxIters: 1,
      // onMaxExceeded omitted — default 'continue' applied at runtime.
    });
    expect(draft).toBe(nodePath.resolve('out.md'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/Returning last draft\./));
    warnSpy.mockRestore();
  });

  it('does NOT throw on mid-loop approval even when on_max_exceeded: fail (compound reviewer)', async () => {
    let subCallCount = 0;
    const subflow = vi.fn(async () => {
      subCallCount++;
      return {
        verdict: subCallCount === 1 ? 'fail' : 'pass',
        reviewerPaths: [{ agentName: 'r', path: 'r.json' }],
      };
    });
    const { reviewLoop } = await import('./review-loop.js');
    const draft = await reviewLoop({
      kind: 'compound',
      cli: 'claude',
      agentDirs: ['.claude/agents/', '~/.claude/agents/'],
      defaultExtraArgs: [],
      writer: 'w',
      reviewerSubflow: subflow,
      input: 'input',
      writerProduces: 'out.md',
      maxIters: 3,
      onMaxExceeded: 'fail',
    });
    expect(draft).toBe(nodePath.resolve('out.md'));
    expect(subflow).toHaveBeenCalledTimes(2);
  });

  it('exhaustion message format matches the compound-reviewer DRAFT shape', async () => {
    const subflow = vi.fn(async () => ({
      verdict: 'needs_revision',
      reviewerPaths: [{ agentName: 'r', path: 'r.json' }],
    }));
    const { reviewLoop } = await import('./review-loop.js');
    const { HaltPipelineError } = await import('./agent.js');
    let thrown: InstanceType<typeof HaltPipelineError> | undefined;
    try {
      // Pin writerProduces='out.md' to match the compound block's
      // beforeEach spawnMock — it only side-effects-writes that path.
      await reviewLoop({
        kind: 'compound',
        cli: 'claude',
        agentDirs: ['.claude/agents/', '~/.claude/agents/'],
        defaultExtraArgs: [],
        writer: 'spec-writer',
        reviewerSubflow: subflow,
        input: 'input',
        writerProduces: 'out.md',
        approveWhen: 'pass',
        maxIters: 2,
        onMaxExceeded: 'fail',
      });
    } catch (e) {
      thrown = e as InstanceType<typeof HaltPipelineError>;
    }
    expect(thrown).toBeDefined();
    // Tight match — writer name + max_iters + verdict + approve_when + aggregate clause.
    expect(thrown!.message).toMatch(
      /^review_loop 'spec-writer' exhausted max_iters=2 without approval\.\nLast verdict: 'needs_revision' \(approve_when='pass'\); the verdict was extracted by the inner aggregate\.$/,
    );
  });
});
