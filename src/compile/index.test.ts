import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { compile, parseSpec } from './index.js';
import { setupCompileTestEnv, setupFixture } from './test-helpers.js';

let teardown: () => void;

beforeEach(() => {
  teardown = setupCompileTestEnv();
});

afterEach(() => {
  teardown();
});

describe('parseSpec', () => {
  it('parses + zod-validates a YAML file and returns the spec', () => {
    const yamlPath = setupFixture({
      agents: ['ac-writer'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: ac-writer
    input: $x
    produces: out.md
`,
    });
    const spec = parseSpec(yamlPath);
    expect(spec.pipeline).toBe('p');
    expect(spec.cli).toBe('claude');
    expect(spec.inputs).toEqual(['x']);
    expect(spec.flow).toHaveLength(1);
  });

  it('throws the same zod error compile() would on a bad spec', () => {
    const yamlPath = setupFixture({
      yaml: `pipeline: p\ncli: notavalidcli\nflow: []\n`,
    });
    expect(() => parseSpec(yamlPath)).toThrow();
  });
});

describe('v0.1.0 feature-free emit shape regression', () => {
  // A pipeline that uses none of the v0.1.0 opt-in features
  // (review_loop.on_max_exceeded, branch.when: helpers, branch.bind
  // consumable hoisting, aggregate-as-branch-arm-terminal,
  // parallel.combinor, foreach) must compile to a stable emit shape.
  // A regression here signals emit drift — import-suffix order, a
  // `flowHas*` predicate returning a false positive, or some other
  // emit-shape leak.

  it('compiles a v0.1.0-feature-free pipeline to a stable emit', () => {
    const yamlPath = setupFixture({
      agents: ['writer', 'human'],
      yaml: `
pipeline: p
cli: claude
inputs: [ticket]
flow:
  - step: writer
    input: $ticket
    produces: out.md
    bind: written
  - human_gate: {}
`,
    });
    const emitted = compile(yamlPath);
    // Golden-string-style assertion across the load-bearing emit shape.
    // Each match pins a single emit feature; together they cover the
    // import prelude, the module-level constants, the main()
    // entrypoint, and the flow body. A change anywhere in the v0.1.0
    // emit surface that affects feature-free pipelines lights this up.
    expect(emitted).toMatch(/import\s*\{[^}]*runAgent[^}]*\}\s*from\s*['"]/);
    expect(emitted).toMatch(/import\s*\{[^}]*humanGate[^}]*\}\s*from\s*['"]/);
    expect(emitted).toContain('const CLI =');
    expect(emitted).toContain('const AGENT_DIRS =');
    expect(emitted).toContain('const DEFAULT_EXTRA_ARGS =');
    expect(emitted).toMatch(/async function main/);
    expect(emitted).toContain('const written = await runAgent(');
    expect(emitted).toContain('await humanGate(');
    // The opt-in v0.1.0 features must not leak into a feature-free emit.
    expect(emitted).not.toContain('onMaxExceeded:');
    expect(emitted).not.toContain('readJson');
    expect(emitted).not.toContain('readText');
    expect(emitted).not.toContain('fileExists');
    expect(emitted).not.toContain('combinor');
    expect(emitted).not.toContain('foreach');
  });
});

describe('flowHasBranch (via compile prelude conditional import)', () => {
  // The flowHasBranch helper isn't exported — its behavior is observed
  // through the emit prelude's conditional helper import. The tests below
  // pin "branch in body → helpers imported" for each compound body that
  // can host a branch.

  it('imports helpers when the flow has a top-level branch', () => {
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
    bind: out
  - branch:
      when: 'true'
      then:
        - step: writer
          input: $x
          produces: t.md
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/import\s*\{[^}]*readJson, readText, fileExists[^}]*\}\s*from/);
  });

  it('does NOT import helpers when the flow has no branch', () => {
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
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).not.toContain('readJson');
    expect(emitted).not.toContain('readText');
    expect(emitted).not.toContain('fileExists');
  });

  it('imports helpers when a branch lives inside a parallel block', () => {
    const yamlPath = setupFixture({
      agents: ['writer', 'sib'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - parallel:
      - step: sib
        input: $x
        produces: sib.md
      - branch:
          when: 'true'
          then:
            - step: writer
              input: $x
              produces: t.md
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/import\s*\{[^}]*readJson, readText, fileExists[^}]*\}\s*from/);
  });

  it('imports helpers when a branch lives inside a review_loop reviewer subflow', () => {
    const yamlPath = setupFixture({
      agents: ['writer', 'rev1'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer: writer
      input: $x
      writer_produces: spec.md
      max_iters: 1
      bind: outer
      reviewer:
        - step: rev1
          input: $x
          produces: r1.json
          bind: r1
        - branch:
            when: 'true'
            then:
              - step: rev1
                input: $r1
                produces: r1-deeper.json
            else:
              - step: rev1
                input: $r1
                produces: r1-other.json
        - aggregate:
            inputs: { r: $r1 }
            verdict_field: status
            bind: agg
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/import\s*\{[^}]*readJson, readText, fileExists[^}]*\}\s*from/);
  });

  it('emits helpers AFTER retryGateZone when both are conditional (stable order)', () => {
    const yamlPath = setupFixture({
      agents: ['writer', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer
    input: $x
    produces: w.md
    bind: w
  - step: rev
    input: $w
    produces: r.json
    bind: r
    on_fail:
      verdict_field: status
      retry_from: w
      revise_with:
        prompt: Retry.
  - branch:
      when: 'true'
      then:
        - step: writer
          input: $x
          produces: t.md
`,
    });
    const emitted = compile(yamlPath);
    // The order in the import line must be: retryGateZone, then helpers.
    // Captures the suffix-append principle: each conditional fragment
    // anchors at a fixed position; absent fragments contribute nothing.
    expect(emitted).toMatch(
      /import\s*\{[^}]*retryGateZone, readJson, readText, fileExists[^}]*\}\s*from/,
    );
  });
});

describe('flowHasForeach (via compile prelude conditional import)', () => {
  // Same pattern as flowHasBranch above: the predicate isn't exported, so
  // its behavior is observed through the conditional `foreach` symbol in
  // the runtime import line. These tests pin the gating so a regression
  // (missing import for a foreach-using pipeline, or a spurious import
  // for a foreach-free pipeline) lights up the suite immediately.

  it('imports foreach when the flow has a top-level foreach', () => {
    const yamlPath = setupFixture({
      agents: ['worker'],
      yaml: `
pipeline: p
cli: claude
inputs: [plan]
flow:
  - foreach:
      over: $plan
      as: task
      body:
        - step: worker
          input: $task
          produces: out.md
          bind: w
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/import\s*\{[^}]*,\s*foreach[^}]*\}\s*from/);
  });

  it('does NOT import foreach when the flow has no foreach', () => {
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
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).not.toContain('foreach');
  });

  it('imports foreach when a foreach lives inside a parallel block', () => {
    const yamlPath = setupFixture({
      agents: ['worker', 'sib'],
      yaml: `
pipeline: p
cli: claude
inputs: [plan]
flow:
  - parallel:
      - step: sib
        input: $plan
        produces: sib.md
      - foreach:
          over: $plan
          as: task
          body:
            - step: worker
              input: $task
              produces: out.md
              bind: w
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/import\s*\{[^}]*,\s*foreach[^}]*\}\s*from/);
  });

  it('imports foreach when a foreach lives inside a branch arm', () => {
    const yamlPath = setupFixture({
      agents: ['worker'],
      yaml: `
pipeline: p
cli: claude
inputs: [plan]
flow:
  - branch:
      when: 'true'
      then:
        - foreach:
            over: $plan
            as: task
            body:
              - step: worker
                input: $task
                produces: out.md
                bind: w
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/import\s*\{[^}]*,\s*foreach[^}]*\}\s*from/);
  });
});

describe('flowHasRetryGate (via compile prelude conditional import)', () => {
  // The flowHasRetryGate helper isn't exported — its behavior is observed
  // through the conditional `retryGateZone` symbol in the runtime import
  // line. The tests below pin the descent into foreach bodies: a step
  // with `on_fail:` INSIDE a foreach body must still gate retryGateZone
  // into the import. Without that descent, the emit references a missing
  // symbol → Node parse crash at runtime.
  //
  // Sister coverage for non-foreach compounds already lives in the
  // 'emits helpers AFTER retryGateZone when both are conditional' test
  // above (top-level on_fail) and is implicitly verified by other
  // pipelines exercising review_loop / parallel / branch nesting.
  it('imports retryGateZone when a step on_fail lives inside a foreach body', () => {
    const yamlPath = setupFixture({
      agents: ['worker', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [plan]
flow:
  - foreach:
      over: $plan
      as: task
      body:
        - step: worker
          input: $task
          produces: w.md
          bind: w
        - step: rev
          input: $w
          produces: r.json
          bind: r
          on_fail:
            verdict_field: status
            retry_from: w
            revise_with:
              prompt: Retry.
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/import\s*\{[^}]*retryGateZone[^}]*\}\s*from/);
  });
});
