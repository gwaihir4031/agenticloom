import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { compile } from './index.js';
import { setupCompileTestEnv, setupFixture } from './test-helpers.js';

let teardown: () => void;

beforeEach(() => {
  teardown = setupCompileTestEnv();
});

afterEach(() => {
  teardown();
});

describe('retry_from compile-time resolution', () => {
  it('compiles when retry_from references a same-scope earlier bind', () => {
    const yamlPath = setupFixture({
      agents: ['tdd', 'reviewer'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: tdd
    input: $x
    produces: tests.md
    bind: tests
  - step: reviewer
    input: $tests
    produces: review.json
    bind: review
    on_fail:
      verdict_field: status
      retry_from: tests
      revise_with:
        prompt: Retry the step.
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
  });

  it('rejects retry_from to nonexistent bind, lists available binds', () => {
    const yamlPath = setupFixture({
      agents: ['tdd', 'reviewer'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: tdd
    input: $x
    produces: tests.md
    bind: tests
  - step: reviewer
    input: $tests
    produces: review.json
    bind: review
    on_fail:
      verdict_field: status
      retry_from: nonexistent
      revise_with:
        prompt: Retry the step.
`,
    });
    expect(() => compile(yamlPath)).toThrow(/retry_from.*nonexistent.*not declared.*tests/i);
  });

  it('rejects retry_from to self', () => {
    const yamlPath = setupFixture({
      agents: ['reviewer'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: reviewer
    input: $x
    produces: review.json
    bind: review
    on_fail:
      verdict_field: status
      retry_from: review
      revise_with:
        prompt: Retry the step.
`,
    });
    expect(() => compile(yamlPath)).toThrow(/retry_from.*review.*itself/i);
  });

  it('rejects retry_from to forward bind (later in flow)', () => {
    const yamlPath = setupFixture({
      agents: ['reviewer', 'later'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: reviewer
    input: $x
    produces: review.json
    bind: review
    on_fail:
      verdict_field: status
      retry_from: laterBind
      revise_with:
        prompt: Retry the step.
  - step: later
    input: $review
    produces: out.md
    bind: laterBind
`,
    });
    expect(() => compile(yamlPath)).toThrow(/retry_from.*laterBind.*not declared/i);
  });

  it('rejects retry_from to step without produces', () => {
    const yamlPath = setupFixture({
      agents: ['noprod', 'reviewer'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: noprod
    input: $x
    bind: prep
  - step: reviewer
    input: $x
    produces: review.json
    bind: review
    on_fail:
      verdict_field: status
      retry_from: prep
      revise_with:
        prompt: Retry the step.
`,
    });
    expect(() => compile(yamlPath)).toThrow(/retry_from.*prep.*no produces/i);
  });

  it('rejects retry_from cross-scope (inside parallel, target in outer scope)', () => {
    const yamlPath = setupFixture({
      agents: ['outer', 'inner'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: outer
    input: $x
    produces: outer.json
    bind: outerBind
  - parallel:
      - step: inner
        input: $x
        produces: inner.json
        bind: innerBind
        on_fail:
          verdict_field: status
          retry_from: outerBind
          revise_with:
            prompt: Retry the step.
`,
    });
    expect(() => compile(yamlPath)).toThrow(/retry_from.*outerBind.*scope/i);
  });

  it('rejects retry_from targeting a review_loop (v0.1.x: compound retry-targets deferred)', () => {
    const yamlPath = setupFixture({
      agents: ['writer', 'reviewer', 'gate'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer: writer
      reviewer: reviewer
      input: $x
      writer_produces: out.md
      reviewer_produces: rev.json
      verdict_field: status
      bind: rl
  - step: gate
    input: $x
    produces: gate.json
    bind: gateBind
    on_fail:
      verdict_field: status
      retry_from: rl
      revise_with:
        prompt: Retry the step.
`,
    });
    expect(() => compile(yamlPath)).toThrow(/retry_from.*rl.*review_loop.*atomic.*deferred/i);
  });

  it('rejects retry_from targeting a parallel (v0.1.x: compound retry-targets deferred)', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'gate'],
      yaml: `
pipeline: p
cli: claude
inputs: []
flow:
  - parallel:
      - step: a
        produces: a.json
        bind: aBind
      - step: b
        produces: b.json
        bind: bBind
    bind: par
  - step: gate
    input: $aBind
    produces: gate.json
    bind: gateBind
    on_fail:
      verdict_field: status
      retry_from: par
      revise_with:
        prompt: Retry the step.
`,
    });
    expect(() => compile(yamlPath)).toThrow(/retry_from.*par.*parallel.*atomic.*deferred/i);
  });

  it('rejects retry zone with compound at intermediate position (v0.1.x: defer)', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'writer', 'reviewer', 'gate'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: a
    input: $x
    produces: a.json
    bind: aBind
  - review_loop:
      writer: writer
      reviewer: reviewer
      input: $aBind
      writer_produces: rl.md
      reviewer_produces: rev.json
      verdict_field: status
      bind: rlBind
  - step: gate
    input: $rlBind
    produces: gate.json
    bind: gateBind
    on_fail:
      verdict_field: status
      retry_from: aBind
      revise_with:
        prompt: Retry the step.
`,
    });
    expect(() => compile(yamlPath)).toThrow(
      /retry zone.*review_loop.*intermediate.*atomic.*deferred/i,
    );
  });

  it('emits compile warning when retry_from targets aggregate', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'reviewer'],
      yaml: `
pipeline: p
cli: claude
inputs: []
flow:
  - parallel:
      - step: a
        produces: a.json
        bind: aBind
      - step: b
        produces: b.json
        bind: bBind
  - aggregate:
      inputs: { a: $aBind, b: $bBind }
      verdict_field: status
      bind: agg
  - step: reviewer
    input: $aBind
    produces: review.json
    bind: review
    on_fail:
      verdict_field: status
      retry_from: agg
      revise_with:
        prompt: Retry the step.
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/retry_from.*agg.*aggregate.*deterministic/i),
    );
    warnSpy.mockRestore();
  });

  it('rejects retry_from targeting a hoisted parallel-child bind (v0.1.x: undefined semantics)', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'gate'],
      yaml: `
pipeline: p
cli: claude
inputs: []
flow:
  - parallel:
      - step: a
        produces: a.json
        bind: aBind
      - step: b
        produces: b.json
        bind: bBind
  - step: gate
    input: $aBind
    produces: gate.json
    bind: gateBind
    on_fail:
      verdict_field: status
      retry_from: aBind
      revise_with:
        prompt: Retry the step.
`,
    });
    expect(() => compile(yamlPath)).toThrow(
      /retry_from.*aBind.*parallel.*child.*no ordering|cannot target individual parallel children/i,
    );
  });

  it('accepts retry_from targeting the parallel block itself (when the parallel has a bind)', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'gate'],
      yaml: `
pipeline: p
cli: claude
inputs: []
flow:
  - parallel:
      - step: a
        produces: a.json
        bind: aBind
      - step: b
        produces: b.json
        bind: bBind
    bind: parBind
  - step: gate
    input: $aBind
    produces: gate.json
    bind: gateBind
    on_fail:
      verdict_field: status
      retry_from: parBind
      revise_with:
        prompt: Retry the step.
`,
    });
    // This SHOULD reject too in v0.1.x because parallel is a compound — but with the existing
    // compound-target rejection (review_loop/parallel/branch deferred). Verify that error fires.
    expect(() => compile(yamlPath)).toThrow(/retry_from.*parBind.*parallel.*atomic.*deferred/i);
  });

  it('rejects retry_from targeting a pipeline input (v0.1.x: inputs are data, not steps)', () => {
    const yamlPath = setupFixture({
      agents: ['tdd'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: tdd
    input: $x
    produces: tests.md
    bind: tests
    on_fail:
      verdict_field: status
      retry_from: x
      max_retries: 1
      revise_with:
        prompt: Retry the step.
`,
    });
    expect(() => compile(yamlPath)).toThrow(
      /retry_from.*x.*pipeline input.*not steps|pipeline inputs.*data/i,
    );
  });
});

describe('nested-zone cost warning', () => {
  it('warns when retry zone is nested inside another retry zone', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'c', 'd'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: a
    input: $x
    produces: a.json
    bind: aBind
  - step: b
    input: $aBind
    produces: b.json
    bind: bBind
    on_fail:
      verdict_field: status
      retry_from: aBind
      max_retries: 3
      revise_with:
        prompt: Retry the step.
  - step: c
    input: $bBind
    produces: c.json
    bind: cBind
  - step: d
    input: $cBind
    produces: d.json
    bind: dBind
    on_fail:
      verdict_field: status
      retry_from: bBind
      max_retries: 2
      revise_with:
        prompt: Retry the step.
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnCalls).toMatch(/nested|multiplier/i);
    expect(warnCalls).toMatch(/12/); // (3+1) × (2+1) = 12
    warnSpy.mockRestore();
  });

  it('warns for strictly-nested retry zones (inner zone fully inside outer)', () => {
    // Two on_fail gates where the inner gate's zone [aBind..bGate] is fully
    // contained inside the outer gate's zone [aBind..dGate]. Both zones
    // share the same retry_from target, so the inner zone is strictly
    // nested inside the outer. Compounding multiplier: outer's retries
    // re-run inner's gate, and inner's retries fire on each outer attempt.
    // Complements the partial-overlap test above — exercises the same
    // overlap-detection logic with strict-containment geometry.
    // (The "review_loop in zone" warning case is not exercisable in v0.1.x:
    // review_loop is rejected as retry_from target and as intermediate
    // compound member, so the "(outer_max_retries+1) × inner_max_iters"
    // multiplier warning has no reachable trigger until those deferrals
    // lift.)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'c', 'd'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: a
    input: $x
    produces: a.json
    bind: aBind
  - step: b
    input: $aBind
    produces: b.json
    bind: bBind
    on_fail:
      verdict_field: status
      retry_from: aBind
      max_retries: 3
      revise_with:
        prompt: Retry the step.
  - step: c
    input: $bBind
    produces: c.json
    bind: cBind
  - step: d
    input: $cBind
    produces: d.json
    bind: dBind
    on_fail:
      verdict_field: status
      retry_from: aBind
      max_retries: 2
      revise_with:
        prompt: Retry the step.
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnCalls).toMatch(/nested|multiplier/i);
    expect(warnCalls).toMatch(/12/); // (3+1) × (2+1) = 12
    warnSpy.mockRestore();
  });

  it('does NOT warn for linear containment (branch arm with retry zone)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const yamlPath = setupFixture({
      agents: ['a', 'b'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      then:
        - step: a
          input: $x
          produces: a.json
          bind: aBind
        - step: b
          input: $aBind
          produces: b.json
          bind: bBind
          on_fail:
            verdict_field: status
            retry_from: aBind
            max_retries: 3
            revise_with:
              prompt: Retry the step.
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnCalls).not.toMatch(/nested/i);
    warnSpy.mockRestore();
  });
});

describe('on_fail emit', () => {
  it('emits let-hoisted bindings for zone members and a retryGateZone call', () => {
    const yamlPath = setupFixture({
      agents: ['tdd', 'reviewer'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: tdd
    input: $x
    produces: tests.md
    bind: tests
  - step: reviewer
    input: $tests
    produces: review.json
    bind: review
    on_fail:
      verdict_field: status
      retry_from: tests
      max_retries: 2
      revise_with:
        prompt: Retry the step.
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toContain('let tests');
    expect(emitted).toContain('let review');
    expect(emitted).toContain('retryGateZone');
    // String fields use JSON.stringify (double quotes) to match the rest of
    // the codebase's emit convention — aggregate, review_loop, run_agent
    // all do the same. The plan's pseudo-implementation uses JSON.stringify;
    // the plan's test was written with single quotes by oversight. Tests
    // here match the implementation.
    expect(emitted).toContain('verdictField: "status"');
    expect(emitted).toContain('maxRetries: 2');
    expect(emitted).toContain('onMaxExceeded: "fail"');
    expect(emitted).toContain('gateAgent: "reviewer"');
  });

  it('keeps plain (non-zone) steps as const', () => {
    const yamlPath = setupFixture({
      agents: ['plain', 'tdd', 'reviewer'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: plain
    input: $x
    produces: plain.md
    bind: plainBind
  - step: tdd
    input: $plainBind
    produces: tests.md
    bind: tests
  - step: reviewer
    input: $tests
    produces: review.json
    bind: review
    on_fail:
      verdict_field: status
      retry_from: tests
      revise_with:
        prompt: Retry the step.
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toContain('const plainBind'); // plain step stays const
    expect(emitted).toContain('let tests'); // zone members are let
    expect(emitted).toContain('let review');
  });

  it('emits two independent retryGateZone calls for stacked zones', () => {
    const yamlPath = setupFixture({
      agents: ['spec', 'tests', 'impl'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: spec
    input: $x
    produces: spec.md
    bind: specBind
  - step: tests
    input: $specBind
    produces: tests.json
    bind: testsBind
    on_fail:
      verdict_field: status
      retry_from: specBind
      max_retries: 1
      revise_with:
        prompt: Retry the step.
  - step: impl
    input: $testsBind
    produces: impl.json
    bind: implBind
    on_fail:
      verdict_field: status
      retry_from: testsBind
      max_retries: 2
      revise_with:
        prompt: Retry the step.
`,
    });
    const emitted = compile(yamlPath);
    const retryGateZoneCount = (emitted.match(/retryGateZone\(/g) || []).length;
    expect(retryGateZoneCount).toBe(2);
    // Second zone's retry callback re-runs tests as plain runAgent (gate consumed).
    // The retry callback takes `currentVerdict` as its sole argument now — the
    // compile-built revise prompt interpolates it.
    expect(emitted).toMatch(/retry: async \(currentVerdict\) => \{[\s\S]*?runAgent\(['"]tests['"]/);
  });

  it('threads retryGateZone import into emit', () => {
    const yamlPath = setupFixture({
      agents: ['tdd', 'reviewer'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: tdd
    input: $x
    produces: tests.md
    bind: tests
  - step: reviewer
    input: $tests
    produces: review.json
    bind: review
    on_fail:
      verdict_field: status
      retry_from: tests
      revise_with:
        prompt: Retry the step.
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/import\s*\{[^}]*retryGateZone[^}]*\}\s*from/);
  });
});

describe('aggregate as retry gate', () => {
  it('compiles canonical loose-pattern shape (writer → parallel reviewers → aggregate gate)', () => {
    const yamlPath = setupFixture({
      agents: ['writer', 'sec-rev', 'api-rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer
    input: $x
    produces: out.md
    bind: writerOut
  - parallel:
      - step: sec-rev
        input: $writerOut
        produces: sec.json
        bind: sec
      - step: api-rev
        input: $writerOut
        produces: api.json
        bind: api
  - aggregate:
      inputs: { security: $sec, api: $api }
      verdict_field: status
      approve_when: pass
      bind: overall
      retry_from: writerOut
      max_retries: 2
      revise_with:
        inputs: [$sec, $api]
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
    const emitted = compile(yamlPath);
    // Aggregate-host gate emits the kind: 'aggregate' discriminator + an
    // in-memory initialVerdict (not a verdictPath).
    expect(emitted).toContain("kind: 'aggregate'");
    expect(emitted).toContain('initialVerdict: overall');
    expect(emitted).toContain('gateAgent: "aggregate (bind \'overall\')"');
    expect(emitted).toContain('maxRetries: 2');
    // Aggregate's bind is `let` so the retryGateZone can reassign it.
    expect(emitted).toMatch(/let overall = await aggregate/);
    // The retry callback rewrites the writer prompt via the default
    // scaffolding (revise_with.inputs-only ⇒ no user prompt). The
    // file list interpolates the resolved bind identifiers.
    expect(emitted).toMatch(/This is a retry/);
    expect(emitted).toMatch(/Feedback files to address:/);
    expect(emitted).toMatch(/sec-rev finished its work/);
    expect(emitted).toMatch(/api-rev finished its work/);
  });

  it('emits parallel re-execution inside the retry body (carve-out applied)', () => {
    const yamlPath = setupFixture({
      agents: ['writer', 'sec-rev', 'api-rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer
    input: $x
    produces: out.md
    bind: writerOut
  - parallel:
      - step: sec-rev
        input: $writerOut
        produces: sec.json
        bind: sec
      - step: api-rev
        input: $writerOut
        produces: api.json
        bind: api
  - aggregate:
      inputs: { security: $sec, api: $api }
      verdict_field: status
      bind: overall
      retry_from: writerOut
      revise_with:
        prompt: Retry.
`,
    });
    const emitted = compile(yamlPath);
    // The retry body re-fires the writer (with rewritten prompt), the
    // parallel children (carve-out), and the aggregate (gate). Slice the
    // body by start anchor (the retry: lambda) and end anchor (the gate's
    // own `return overall;`) rather than balancing braces inside a regex —
    // the body contains object literals whose nested `},` would confuse a
    // lazy alternative.
    const startIdx = emitted.indexOf('retry: async (currentVerdict) => {');
    expect(startIdx).toBeGreaterThan(-1);
    const endMarker = 'return overall;';
    const endIdx = emitted.indexOf(endMarker, startIdx);
    expect(endIdx).toBeGreaterThan(-1);
    const retryBody = emitted.slice(startIdx, endIdx + endMarker.length);
    expect(retryBody).toMatch(/writerOut = await runAgent\("writer"/);
    expect(retryBody).toMatch(/\[sec, api\] = await parallel/);
    expect(retryBody).toMatch(/overall = await aggregate/);
  });

  it('admits a branch as intermediate compound member in an aggregate-gate retry zone (closure-call refire)', () => {
    // Under the explicit-rejoin rule, branches are admitted unconditionally
    // as retry-zone members — the retry callback re-fires the branch via
    // closure-call, preserving the arm-internal seal by construction. The
    // intermediate-compound walk in `processRetryGate` drops the branch
    // rejection; the branch's closures are called from the retry callback
    // with the same when: predicate the main pass evaluated.
    const yamlPath = setupFixture({
      agents: ['writer', 'arm-a', 'arm-b', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer
    input: $x
    produces: out.md
    bind: writerOut
  - branch:
      when: writerOut
      then:
        - step: arm-a
          input: $writerOut
          produces: a.json
          bind: aBind
      else:
        - step: arm-b
          input: $writerOut
          produces: b.json
          bind: bBind
      bind: branchOut
  - step: rev
    input: $writerOut
    produces: rev.json
    bind: revOut
  - aggregate:
      inputs: { r: $revOut }
      verdict_field: status
      bind: overall
      retry_from: writerOut
      revise_with:
        prompt: Retry.
`,
    });
    const emitted = compile(yamlPath);
    // The branch's closures are declared in the main pass...
    expect(emitted).toMatch(/const runThen_branchOut = async/);
    expect(emitted).toMatch(/const runElse_branchOut = async/);
    // ...and re-invoked from the aggregate retry callback. The closures
    // encapsulate the arm bodies; the retry callback only calls them.
    const retryStart = emitted.indexOf('retry: async (currentVerdict) => {');
    expect(retryStart).toBeGreaterThan(-1);
    const retrySlice = emitted.slice(retryStart);
    expect(retrySlice).toMatch(/branchOut = await runThen_branchOut\(/);
    expect(retrySlice).toMatch(/branchOut = await runElse_branchOut\(/);
  });

  it('rejects aggregate-gate retry zone with a parallel whose children are not consumed by inputs', () => {
    const yamlPath = setupFixture({
      agents: ['writer', 'sec-rev', 'api-rev', 'other'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer
    input: $x
    produces: out.md
    bind: writerOut
  - parallel:
      - step: sec-rev
        input: $writerOut
        produces: sec.json
        bind: sec
      - step: api-rev
        input: $writerOut
        produces: api.json
        bind: api
  - step: other
    input: $writerOut
    produces: other.json
    bind: otherOut
  - aggregate:
      inputs: { x: $otherOut }
      verdict_field: status
      bind: overall
      retry_from: writerOut
      revise_with:
        prompt: Retry.
`,
    });
    expect(() => compile(yamlPath)).toThrow(/retry zone.*overall.*parallel.*intermediate/i);
  });

  it('rejects aggregate-gate retry zone with a parallel-feeding-aggregate that has a review_loop child (carve-out is all-step)', () => {
    // The parallel's binds (rl + sec) ARE consumed by the aggregate's
    // inputs, so the bind-set match would otherwise admit the carve-out.
    // But the review_loop child violates the all-step rule — the retry-
    // body builder's emitParallelRetry only emits a `runAgent` for step
    // children, so admitting this shape would silently skip the
    // review_loop on retry. The compiler names the offending child kind
    // so the user can locate it directly.
    const yamlPath = setupFixture({
      agents: ['writer', 'rl-writer', 'rl-reviewer', 'sec-rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer
    input: $x
    produces: out.md
    bind: writerOut
  - parallel:
      - review_loop:
          writer: rl-writer
          reviewer: rl-reviewer
          input: $writerOut
          writer_produces: rl.md
          reviewer_produces: rev.json
          verdict_field: status
          bind: rl
      - step: sec-rev
        input: $writerOut
        produces: sec.json
        bind: sec
  - aggregate:
      inputs: { r: $rl, s: $sec }
      verdict_field: status
      bind: overall
      retry_from: writerOut
      revise_with:
        prompt: Retry.
`,
    });
    expect(() => compile(yamlPath)).toThrow(
      /retry zone.*overall.*parallel.*whose binds feed.*review_loop child/i,
    );
  });

  it('rejects revise_with.inputs $ref to non-anchored bind (self-ref to aggregate bind)', () => {
    const yamlPath = setupFixture({
      agents: ['writer', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer
    input: $x
    produces: out.md
    bind: writerOut
  - step: rev
    input: $writerOut
    produces: rev.json
    bind: revOut
  - aggregate:
      inputs: { r: $revOut }
      verdict_field: status
      bind: overall
      retry_from: writerOut
      revise_with:
        inputs: [$overall]
`,
    });
    expect(() => compile(yamlPath)).toThrow(
      /revise_with\.inputs\[0\].*overall.*no file-bound output/i,
    );
  });

  it('rejects revise_with.inputs $ref to a non-consumable branch bind (no else arm)', () => {
    // A branch with `bind:` but missing `else:` is non-consumable per the
    // explicit-rejoin rule (then-arm's value is undefined when when: is
    // false). checkConsume's branch-rejection path fires the
    // `missing_else` consumer-site error when revise_with.inputs targets
    // the bind.
    const yamlPath = setupFixture({
      agents: ['writer', 'arm-a', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer
    input: $x
    produces: out.md
    bind: writerOut
  - branch:
      when: writerOut
      bind: branchBind
      then:
        - step: arm-a
          input: $writerOut
          produces: a.json
          bind: aBind
  - step: rev
    input: $writerOut
    produces: rev.json
    bind: revOut
    on_fail:
      verdict_field: status
      retry_from: writerOut
      revise_with:
        inputs: [$branchBind]
`,
    });
    expect(() => compile(yamlPath)).toThrow(/branchBind.*no 'else:' arm/);
  });

  it('rejects revise_with.inputs entry referencing an unknown bind', () => {
    const yamlPath = setupFixture({
      agents: ['writer', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer
    input: $x
    produces: out.md
    bind: writerOut
  - step: rev
    input: $writerOut
    produces: rev.json
    bind: revOut
    on_fail:
      verdict_field: status
      retry_from: writerOut
      revise_with:
        inputs: [$nonexistent]
`,
    });
    expect(() => compile(yamlPath)).toThrow(
      /revise_with\.inputs\[0\].*unknown bind.*\$nonexistent/i,
    );
  });

  it('accepts revise_with.inputs $ref to a zone-member step bind', () => {
    const yamlPath = setupFixture({
      agents: ['writer', 'intermediate', 'gate'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer
    input: $x
    produces: out.md
    bind: writerOut
  - step: intermediate
    input: $writerOut
    produces: inter.json
    bind: interOut
  - step: gate
    input: $interOut
    produces: gate.json
    bind: gateOut
    on_fail:
      verdict_field: status
      retry_from: writerOut
      revise_with:
        inputs: [$interOut]
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
    const emitted = compile(yamlPath);
    // Zone-member bind is reassignable (let) so retry can refresh it; the
    // revise prompt's template literal interpolates the post-retry path.
    expect(emitted).toContain('let interOut');
    expect(emitted).toMatch(/intermediate finished its work.*\$\{interOut\}/);
  });

  it('rejects revise_with.inputs entry not $-prefixed at the SCHEMA layer (chunk 5.1 invariant)', () => {
    // The schema enforces $-prefix on every entry via a Zod regex refine,
    // so compile() never sees a non-$ entry. This test confirms the schema
    // boundary is intact — a non-$ entry is rejected at parse time with
    // the schema's own error message, not at compile-emit time.
    const yamlPath = setupFixture({
      agents: ['writer', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer
    input: $x
    produces: out.md
    bind: writerOut
  - step: rev
    input: $writerOut
    produces: rev.json
    bind: revOut
    on_fail:
      verdict_field: status
      retry_from: writerOut
      revise_with:
        inputs: [revOut]
`,
    });
    expect(() => compile(yamlPath)).toThrow(/\$-prefixed bind refs/);
  });

  it('preserves revise_with.inputs ordering in the emitted prompt (YAML order)', () => {
    const yamlPath = setupFixture({
      agents: ['writer', 'a-rev', 'b-rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer
    input: $x
    produces: out.md
    bind: writerOut
  - parallel:
      - step: a-rev
        input: $writerOut
        produces: a.json
        bind: aBind
      - step: b-rev
        input: $writerOut
        produces: b.json
        bind: bBind
  - aggregate:
      inputs: { a: $aBind, b: $bBind }
      verdict_field: status
      bind: overall
      retry_from: writerOut
      revise_with:
        inputs: [$bBind, $aBind]
`,
    });
    const emitted = compile(yamlPath);
    const idxB = emitted.indexOf('b-rev finished');
    const idxA = emitted.indexOf('a-rev finished');
    expect(idxB).toBeGreaterThan(-1);
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeLessThan(idxA);
  });

  it('warns on nested-zone overlap with the aggregate gate label in the message', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'c'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: a
    input: $x
    produces: a.json
    bind: aBind
  - step: b
    input: $aBind
    produces: b.json
    bind: bBind
    on_fail:
      verdict_field: status
      retry_from: aBind
      max_retries: 3
      revise_with:
        prompt: Retry.
  - step: c
    input: $bBind
    produces: c.json
    bind: cBind
  - aggregate:
      inputs: { c: $cBind }
      verdict_field: status
      bind: overall
      retry_from: aBind
      max_retries: 2
      revise_with:
        prompt: Aggregate retry.
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnCalls).toMatch(/nested|multiplier/i);
    expect(warnCalls).toMatch(/overall/); // aggregate's bind appears as gate label
    expect(warnCalls).toMatch(/step 'b'/); // step's label appears as the other gate
    warnSpy.mockRestore();
  });

  it('declares retry_from target as let when it is shared by two retry zones (step + aggregate)', () => {
    const yamlPath = setupFixture({
      agents: ['writer', 'inner-rev', 'outer-rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer
    input: $x
    produces: w.md
    bind: writerOut
  - step: inner-rev
    input: $writerOut
    produces: inner.json
    bind: innerOut
  - aggregate:
      inputs: { r: $innerOut }
      verdict_field: status
      bind: inner
      retry_from: writerOut
      max_retries: 2
      revise_with:
        prompt: Aggregate revise.
  - step: outer-rev
    input: $writerOut
    produces: outer.json
    bind: outerBind
    on_fail:
      verdict_field: status
      retry_from: writerOut
      max_retries: 1
      revise_with:
        prompt: Step revise.
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/let writerOut = /);
    // Three writerOut assignments: main-pass + 2 retry callbacks.
    const assignmentCount = (emitted.match(/writerOut = await runAgent/g) ?? []).length;
    expect(assignmentCount).toBeGreaterThanOrEqual(3);
  });

  it('rejects aggregate self-reference via retry_from (gate targets its own bind)', () => {
    const yamlPath = setupFixture({
      agents: ['writer'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer
    input: $x
    produces: out.md
    bind: writerOut
  - aggregate:
      inputs: { w: $writerOut }
      verdict_field: status
      bind: overall
      retry_from: overall
      revise_with:
        prompt: Retry.
`,
    });
    expect(() => compile(yamlPath)).toThrow(/aggregate.*overall.*references itself/i);
  });
});

describe('processRetryGate: foreach admission', () => {
  it('admits foreach bind as retry_from target (no compile error)', () => {
    // Aggregate's `retry_from: results` targets the foreach — admitted:
    // the retry callback replays the entire foreach from iter-0.
    // processRetryGate's target-check rejects only 'review_loop' | 'parallel';
    // foreach falls through to the aggregate-target warning path, but since
    // the target is foreach (not aggregate), no warning fires either.
    const yamlPath = setupFixture({
      agents: ['source', 'worker'],
      yaml: `
pipeline: p
cli: claude
inputs: [plan]
flow:
  - step: source
    input: $plan
    produces: src.md
    bind: src
  - foreach:
      over: $plan
      as: task
      body:
        - step: worker
          input: $task
          produces: out.md
          bind: w
      bind: results
  - aggregate:
      inputs:
        s: $src
      verdict_field: status
      bind: agg
      retry_from: results
      max_retries: 1
      revise_with:
        prompt: "retry"
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
  });

  it('admits foreach as intermediate zone member between retry_from target and gate', () => {
    // retry_from: plan2 targets the planner step; the foreach sits BETWEEN
    // the target and the gate (aggregate) as an intermediate zone member.
    // Per Decision J, the intermediate-walk admits isForeach with
    // `continue`, so the compile succeeds without the generic compound-
    // intermediate rejection.
    const yamlPath = setupFixture({
      agents: ['planner', 'worker'],
      yaml: `
pipeline: p
cli: claude
inputs: [plan]
flow:
  - step: planner
    input: $plan
    produces: plan2.jsonl
    bind: plan2
  - foreach:
      over: $plan2
      as: task
      body:
        - step: worker
          input: $task
          produces: out.md
          bind: w
      bind: results
  - aggregate:
      inputs:
        p: $plan2
      verdict_field: status
      bind: agg
      retry_from: plan2
      max_retries: 1
      revise_with:
        prompt: "retry"
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
  });
});
