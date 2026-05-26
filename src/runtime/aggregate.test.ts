import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as nodePath from 'node:path';

// Mock fs — aggregate reads agent-produced JSON via readAgentFile, which
// hits existsSync + readFileSync. The fakeFs map below substitutes the
// on-disk layer with a deterministic path→content lookup.
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
    if (looksLikePersonaPath(p)) return false; // aggregate tests don't read persona files
    return fakeFsLookup(p) !== undefined;
  },
  readFileSync: (p: string, _enc?: string) => {
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
  fakeFs = {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('aggregate (verdict computation)', () => {
  it('returns approveWhen when all inputs match', async () => {
    fakeFs['a.json'] = JSON.stringify({ status: 'pass' });
    fakeFs['b.json'] = JSON.stringify({ status: 'pass' });
    const { aggregate } = await import('./aggregate.js');
    const verdict = await aggregate({
      inputs: { a: 'a.json', b: 'b.json' },
      verdictField: 'status',
      approveWhen: 'pass',
    });
    expect(verdict).toBe('pass');
  });

  it('returns NEEDS_REVISION when any input fails', async () => {
    fakeFs['a.json'] = JSON.stringify({ status: 'pass' });
    fakeFs['b.json'] = JSON.stringify({ status: 'fail' });
    const { aggregate } = await import('./aggregate.js');
    const verdict = await aggregate({
      inputs: { a: 'a.json', b: 'b.json' },
      verdictField: 'status',
      approveWhen: 'pass',
    });
    expect(verdict).toBe('NEEDS_REVISION');
  });

  it('returns NEEDS_REVISION when all inputs fail', async () => {
    fakeFs['a.json'] = JSON.stringify({ status: 'fail' });
    fakeFs['b.json'] = JSON.stringify({ status: 'fail' });
    const { aggregate } = await import('./aggregate.js');
    const verdict = await aggregate({
      inputs: { a: 'a.json', b: 'b.json' },
      verdictField: 'status',
    });
    expect(verdict).toBe('NEEDS_REVISION');
  });

  it('defaults approveWhen to "pass" when omitted', async () => {
    fakeFs['a.json'] = JSON.stringify({ status: 'pass' });
    const { aggregate } = await import('./aggregate.js');
    const verdict = await aggregate({
      inputs: { a: 'a.json' },
      verdictField: 'status',
    });
    expect(verdict).toBe('pass');
  });

  it('honors custom verdictField name', async () => {
    fakeFs['a.json'] = JSON.stringify({ outcome: 'OK' });
    const { aggregate } = await import('./aggregate.js');
    const verdict = await aggregate({
      inputs: { a: 'a.json' },
      verdictField: 'outcome',
      approveWhen: 'OK',
    });
    expect(verdict).toBe('OK');
  });

  it('approves when reviewer JSON has leading/trailing whitespace in the verdict', async () => {
    // Parity with reviewLoop's single + compound verdict comparison, which
    // both trim before comparing. Without this, the same agent output
    // (`{"status": " pass"}`) would approve in a single-mode review_loop
    // but reject when read by an aggregate inside a compound subflow —
    // observable verdict divergence on the same JSON payload.
    fakeFs['a.json'] = JSON.stringify({ status: ' pass' });
    fakeFs['b.json'] = JSON.stringify({ status: 'pass\n' });
    const { aggregate } = await import('./aggregate.js');
    const verdict = await aggregate({
      inputs: { a: 'a.json', b: 'b.json' },
      verdictField: 'status',
      approveWhen: 'pass',
    });
    expect(verdict).toBe('pass');
  });

  it('also trims approveWhen so a YAML-side whitespace accident matches a clean verdict', async () => {
    // The fix uses `.trim()` on BOTH sides of the comparison. Without this
    // symmetric coverage, a regression that dropped `.trim()` from the
    // `approve` side would still pass the verdict-side test above. The
    // aggregate return is the un-trimmed `approveWhen` (only the comparison
    // trims), so the assertion preserves the input whitespace.
    fakeFs['a.json'] = JSON.stringify({ status: 'pass' });
    const { aggregate } = await import('./aggregate.js');
    const verdict = await aggregate({
      inputs: { a: 'a.json' },
      verdictField: 'status',
      approveWhen: ' pass ',
    });
    expect(verdict).toBe(' pass ');
  });

  it('aggregates multiple inputs and returns the aggregated verdict', async () => {
    // Verifies the multi-input read + verdict-compute path. Aggregate's
    // source uses Promise.all for parallel reads, but with synchronous
    // fakeFs the test cannot observe parallelism — only the aggregated
    // verdict and the wall-clock-under-bound assertion (which would still
    // pass if a future regression made reads sequential, just slower).
    fakeFs['a.json'] = JSON.stringify({ status: 'pass' });
    fakeFs['b.json'] = JSON.stringify({ status: 'pass' });
    fakeFs['c.json'] = JSON.stringify({ status: 'pass' });
    const start = Date.now();
    const { aggregate } = await import('./aggregate.js');
    const verdict = await aggregate({
      inputs: { a: 'a.json', b: 'b.json', c: 'c.json' },
      verdictField: 'status',
    });
    expect(verdict).toBe('pass');
    expect(Date.now() - start).toBeLessThan(5000);
  });
});

describe('retryGateZone', () => {
  function makeVerdictPath(name: string, value: Record<string, unknown>): string {
    const p = nodePath.resolve(`${name}.json`);
    fakeFs[p] = JSON.stringify(value);
    return p;
  }

  it('returns initial path when verdict matches approve_when', async () => {
    const { retryGateZone } = await import('./aggregate.js');
    const initialPath = makeVerdictPath('verdict-pass', { status: 'pass' });
    const retryFn = vi.fn(async () => {
      throw new Error('should not retry');
    });

    const result = await retryGateZone({
      kind: 'step',
      initialVerdictPath: initialPath,
      verdictField: 'status',
      approveWhen: 'pass',
      maxRetries: 1,
      onMaxExceeded: 'fail',
      gateAgent: 'reviewer',
      retry: retryFn,
    });
    expect(result).toBe(initialPath);
    expect(retryFn).not.toHaveBeenCalled();
  });

  it('invokes retry callback on verdict mismatch, succeeds within max_retries', async () => {
    const { retryGateZone } = await import('./aggregate.js');
    const initialPath = makeVerdictPath('verdict-1', { status: 'fail' });
    const retryPath = makeVerdictPath('verdict-2', { status: 'pass' });
    const retryFn = vi.fn(async () => retryPath);

    const result = await retryGateZone({
      kind: 'step',
      initialVerdictPath: initialPath,
      verdictField: 'status',
      approveWhen: 'pass',
      maxRetries: 1,
      onMaxExceeded: 'fail',
      gateAgent: 'reviewer',
      retry: retryFn,
    });
    expect(result).toBe(retryPath);
    expect(retryFn).toHaveBeenCalledTimes(1);
    // The retry callback receives the prior attempt's verdict as its arg.
    expect(retryFn).toHaveBeenCalledWith('fail');
  });

  it('throws on exhaustion with on_max_exceeded: fail (names attempts + last verdict)', async () => {
    const { retryGateZone } = await import('./aggregate.js');
    const initialPath = makeVerdictPath('verdict-3', { status: 'fail' });
    const retryPath = makeVerdictPath('verdict-4', { status: 'fail' });
    const retryFn = vi.fn(async () => retryPath);

    let thrown: Error | undefined;
    try {
      await retryGateZone({
        kind: 'step',
        initialVerdictPath: initialPath,
        verdictField: 'status',
        approveWhen: 'pass',
        maxRetries: 2,
        onMaxExceeded: 'fail',
        gateAgent: 'reviewer',
        retry: retryFn,
      });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/reviewer/);
    expect(thrown!.message).toMatch(/max_retries=2/);
    expect(thrown!.message).toMatch(/3 total attempts/);
    expect(thrown!.message).toMatch(/"fail"/);
    expect(thrown!.message).toMatch(/'status'/);
    expect(retryFn).toHaveBeenCalledTimes(2);
  });

  it('warns and continues on exhaustion with on_max_exceeded: continue', async () => {
    const { retryGateZone } = await import('./aggregate.js');
    const initialPath = makeVerdictPath('verdict-5', { status: 'fail' });
    const retryPath = makeVerdictPath('verdict-6', { status: 'fail' });
    const retryFn = vi.fn(async () => retryPath);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await retryGateZone({
      kind: 'step',
      initialVerdictPath: initialPath,
      verdictField: 'status',
      approveWhen: 'pass',
      maxRetries: 1,
      onMaxExceeded: 'continue',
      gateAgent: 'reviewer',
      retry: retryFn,
    });
    expect(result).toBe(retryPath);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/reviewer.*exhausted/));
    warnSpy.mockRestore();
  });

  it('reads verdict via JSON contract (tolerates ```json fences via readAgentFile)', async () => {
    const { retryGateZone } = await import('./aggregate.js');
    const p = nodePath.resolve('verdict-fenced.json');
    fakeFs[p] = '```json\n{"status":"pass"}\n```';

    const retryFn = vi.fn(async () => {
      throw new Error('should not retry');
    });
    const result = await retryGateZone({
      kind: 'step',
      initialVerdictPath: p,
      verdictField: 'status',
      approveWhen: 'pass',
      maxRetries: 1,
      onMaxExceeded: 'fail',
      gateAgent: 'reviewer',
      retry: retryFn,
    });
    expect(result).toBe(p);
  });

  it('throws HaltPipelineError (not plain Error) on exhaustion with onMaxExceeded: fail (step-host)', async () => {
    // Retrofit regression coverage: the message text is byte-identical to
    // before the retrofit (existing test at the prior `it(...)` confirms),
    // but the thrown type is now HaltPipelineError so foreach's
    // on_iteration_fail catch can distinguish deliberate halts.
    const { retryGateZone } = await import('./aggregate.js');
    const { HaltPipelineError } = await import('./agent.js');
    const initialPath = makeVerdictPath('verdict-7', { status: 'fail' });
    const retryPath = makeVerdictPath('verdict-8', { status: 'fail' });
    const retryFn = vi.fn(async () => retryPath);

    let thrown: unknown;
    try {
      await retryGateZone({
        kind: 'step',
        initialVerdictPath: initialPath,
        verdictField: 'status',
        approveWhen: 'pass',
        maxRetries: 2,
        onMaxExceeded: 'fail',
        gateAgent: 'reviewer',
        retry: retryFn,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HaltPipelineError);
    expect((thrown as Error).name).toBe('HaltPipelineError');
    // Message text byte-identical regression: the existing step-host
    // exhaustion-throw regex assertions must still match — retrofit changed type only.
    expect((thrown as Error).message).toMatch(/reviewer/);
    expect((thrown as Error).message).toMatch(/max_retries=2/);
    expect((thrown as Error).message).toMatch(/3 total attempts/);
    expect((thrown as Error).message).toMatch(/"fail"/);
    expect((thrown as Error).message).toMatch(/'status'/);
  });
});

describe('retryGateZone (aggregate host)', () => {
  it('returns immediately when initial verdict matches approveWhen', async () => {
    const { retryGateZone } = await import('./aggregate.js');
    const retryFn = vi.fn(async () => 'unused');
    const result = await retryGateZone({
      kind: 'aggregate',
      initialVerdict: 'pass',
      approveWhen: 'pass',
      maxRetries: 2,
      onMaxExceeded: 'fail',
      gateAgent: "aggregate (bind 'overall')",
      retry: retryFn,
    });
    expect(result).toBe('pass');
    expect(retryFn).not.toHaveBeenCalled();
  });

  it('retries and converges on attempt 2 with currentVerdict threaded into callback', async () => {
    const { retryGateZone } = await import('./aggregate.js');
    const observedVerdicts: string[] = [];
    let attempts = 0;
    const result = await retryGateZone({
      kind: 'aggregate',
      initialVerdict: 'needs_revision',
      approveWhen: 'pass',
      maxRetries: 3,
      onMaxExceeded: 'fail',
      gateAgent: "aggregate (bind 'overall')",
      retry: async (currentVerdict) => {
        observedVerdicts.push(currentVerdict);
        attempts++;
        return attempts === 1 ? 'still_failing' : 'pass';
      },
    });
    expect(result).toBe('pass');
    expect(attempts).toBe(2);
    expect(observedVerdicts).toEqual(['needs_revision', 'still_failing']);
  });

  it('throws on exhaustion with onMaxExceeded: fail (no verdict_field in message)', async () => {
    const { retryGateZone } = await import('./aggregate.js');
    let thrown: Error | undefined;
    try {
      await retryGateZone({
        kind: 'aggregate',
        initialVerdict: 'fail',
        approveWhen: 'pass',
        maxRetries: 2,
        onMaxExceeded: 'fail',
        gateAgent: "aggregate (bind 'overall')",
        retry: async () => 'fail',
      });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/exhausted max_retries=2/);
    expect(thrown!.message).toMatch(/3 total attempts/);
    expect(thrown!.message).toMatch(/approve_when='pass'/);
    // Aggregate gates extract their verdict inside the aggregate primitive,
    // so the surface message must NOT include a verdict_field clause —
    // that field is only meaningful for step-host gates.
    expect(thrown!.message).not.toMatch(/verdict_field/);
  });

  it('returns last verdict on exhaustion with onMaxExceeded: continue', async () => {
    const { retryGateZone } = await import('./aggregate.js');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await retryGateZone({
      kind: 'aggregate',
      initialVerdict: 'fail',
      approveWhen: 'pass',
      maxRetries: 1,
      onMaxExceeded: 'continue',
      gateAgent: "aggregate (bind 'overall')",
      retry: async () => 'still_fail',
    });
    expect(result).toBe('still_fail');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/exhausted.*Continuing past gate with last attempt's verdict\./),
    );
    warnSpy.mockRestore();
  });

  it('throws an exhaustive error when kind discriminator is malformed', async () => {
    // Cast through `unknown` to bypass TypeScript's discriminated-union
    // narrowing — the test exercises the runtime's defense against a
    // future refactor that lets a malformed `kind` slip past the type
    // system. Without the exhaustive throw, an unknown kind would route
    // silently into the aggregate branch (the prior `kind === 'step' ?
    // ... : ...` shape) and burn the retry budget on mis-routed verdicts.
    const { retryGateZone } = await import('./aggregate.js');
    const opts = {
      kind: 'aggrgate', // typo: 'aggrgate' not 'aggregate'
      initialVerdict: 'fail',
      approveWhen: 'pass',
      maxRetries: 1,
      onMaxExceeded: 'fail',
      gateAgent: 'whatever',
      retry: async () => 'fail',
    } as unknown as Parameters<typeof retryGateZone>[0];
    await expect(retryGateZone(opts)).rejects.toThrow(/unknown kind 'aggrgate'/);
  });

  it('throws HaltPipelineError (not plain Error) on exhaustion with onMaxExceeded: fail (aggregate-host)', async () => {
    // Retrofit regression coverage for the aggregate-host path: message
    // text is byte-identical to before the retrofit; thrown type is now
    // HaltPipelineError. Mirrors the step-host retrofit assertion.
    const { retryGateZone } = await import('./aggregate.js');
    const { HaltPipelineError } = await import('./agent.js');
    let thrown: unknown;
    try {
      await retryGateZone({
        kind: 'aggregate',
        initialVerdict: 'fail',
        approveWhen: 'pass',
        maxRetries: 2,
        onMaxExceeded: 'fail',
        gateAgent: "aggregate (bind 'overall')",
        retry: async () => 'fail',
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HaltPipelineError);
    expect((thrown as Error).name).toBe('HaltPipelineError');
    // Message text byte-identical regression: the existing aggregate-host
    // exhaustion-throw regex assertions must still match — retrofit changed type only.
    expect((thrown as Error).message).toMatch(/exhausted max_retries=2/);
    expect((thrown as Error).message).toMatch(/3 total attempts/);
    expect((thrown as Error).message).toMatch(/approve_when='pass'/);
    expect((thrown as Error).message).not.toMatch(/verdict_field/);
  });
});
