import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { compile } from './index.js';
import { setupCompileTestEnv, setupFixture } from './test-helpers.js';

let teardown: () => void;

beforeEach(() => {
  teardown = setupCompileTestEnv();
});

afterEach(() => {
  teardown();
});

describe('revise_with — end-to-end emit shapes', () => {
  it('inputs-only emits default scaffolding + currentVerdict interpolation + file list with agent-name framing', () => {
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
        inputs: [$revOut]
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/This is a retry. Your previous output is at: out\.md/);
    expect(emitted).toMatch(/rev finished its work/);
    expect(emitted).toMatch(/Read each feedback file and address every concern/);
    expect(emitted).toMatch(/Revise your output and overwrite out\.md/);
    // `${currentVerdict}` interpolates the prior attempt's verdict at runtime.
    expect(emitted).toMatch(/rejected with verdict '\$\{currentVerdict\}'/);
  });

  it('prompt-only emits the user string verbatim (no scaffolding, no feedback block)', () => {
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
        prompt: "Custom verbatim revise instructions go here."
`,
    });
    const emitted = compile(yamlPath);
    // The writer's retry-callback invocation passes the user's prompt
    // verbatim as a JSON string (no template-literal scaffolding wrap).
    expect(emitted).toMatch(
      /writerOut = await runAgent\("writer", "Custom verbatim revise instructions go here\."/,
    );
    // No standard scaffolding emitted inside the retry callback for this case.
    expect(emitted).not.toMatch(/This is a retry/);
    expect(emitted).not.toMatch(/Feedback files to address/);
  });

  it('prompt + inputs emits user prompt leading the standard feedback block', () => {
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
        prompt: "Address blocker findings first."
        inputs: [$revOut]
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/Address blocker findings first/);
    expect(emitted).toMatch(/Feedback files to address:/);
    expect(emitted).toMatch(/rev finished its work/);
    // User-prompt-led template skips the default scaffolding ("This is a retry…").
    // Slice the retry body by anchors instead of regex-matching balanced
    // braces — the body contains object literals whose `},` patterns
    // would confuse a lazy alternative.
    const startIdx = emitted.indexOf('retry: async (currentVerdict) => {');
    const endIdx = emitted.indexOf('return ', startIdx);
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(-1);
    const retryBody = emitted.slice(startIdx, endIdx);
    expect(retryBody).not.toMatch(/This is a retry/);
  });

  // Pins the buildRetryBody + buildRevisePromptExpr interaction when
  // retry_from targets an aggregate (no producesPath) AND revise_with is
  // inputs-only (no user prompt). The aggregate is admitted by
  // processRetryGate (which warns "no-op retry"). buildRetryBody then falls
  // through with `producesPath: ''` (the empty-string fallback at
  // `compile/emit-call.ts`: `targetInfo.producesPath = targetProducer.producesPath ?? ''`),
  // hands that to buildRevisePromptExpr, and walks zone members for re-fire.
  //
  // The constructed revise prompt is degenerate ("at: <empty>", "overwrite
  // <empty>.") but the only zone member is the aggregate itself — which the
  // retry-body loop intentionally `continue`s past — so the degenerate text
  // is NEVER inserted into the emitted output. The retry callback just
  // re-fires the gate step; no upstream rewrite happens. The combination
  // is effectively a no-op retry (the upstream warn is loom's signal of
  // this), and the test pins that:
  //   (1) compile succeeds without throwing,
  //   (2) the upstream warn fires,
  //   (3) the emit contains a retry callback that re-fires the gate but
  //       does NOT contain the degenerate "at: " / "overwrite ." text from
  //       the unused prompt expression.
  //
  // If processRetryGate is ever tightened to REJECT this combination at
  // compile time (a follow-up the silent-failure-hunter flagged), this
  // test will need to flip its expectation to a thrown error. The intent
  // is to surface the case to that future change author rather than have
  // a silently-unused degenerate prompt leak into a real pipeline run.
  it('aggregate-target inputs-only revise_with: compiles + warns + no degenerate text emitted', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const yamlPath = setupFixture({
      agents: ['writer', 'rev', 'gate'],
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
      bind: agg
  - step: gate
    input: $writerOut
    produces: gate.json
    bind: gateOut
    on_fail:
      verdict_field: status
      retry_from: agg
      revise_with:
        inputs: [$revOut]
`,
    });
    let emitted: string | undefined;
    expect(() => {
      emitted = compile(yamlPath);
    }).not.toThrow();
    // The "aggregate target is no-op" warning fires.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/retry_from.*agg.*aggregate.*deterministic/i),
    );
    // The emit contains a retry callback (the gate is `gate`, on_fail wraps it).
    expect(emitted).toMatch(/retry: async \(currentVerdict\) => \{/);
    // The retry callback re-fires the gate step; the gate's bind gets
    // reassigned the gate's runAgent result.
    expect(emitted).toMatch(/return await runAgent\("gate"/);
    // The degenerate text from the unused buildRevisePromptExpr does NOT
    // appear in the emit — buildRetryBody's zone-member loop hits only the
    // aggregate at retryFromIdx, which the `isAggregate` branch `continue`s
    // past, so the constructed revisePromptExpr is silently dropped.
    expect(emitted).not.toMatch(/This is a retry\. Your previous output is at: \\n/);
    expect(emitted).not.toMatch(/Revise your output and overwrite \.\\n/);
    warnSpy.mockRestore();
  });
});

describe('buildRetryBody: foreach re-invokes the stored closure', () => {
  it('emits a foreach({...}) call referencing the stored closure name in the retry body', () => {
    // Per Decision K: the retry callback re-invokes the main-pass closure
    // via foreachBodyName. The body itself is sealed inside the closure;
    // the retry callback must NOT re-emit the body — it references the
    // closure by name.
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
    const emitted = compile(yamlPath);
    // Slice from the retry callback opener so the assertions only see the
    // re-execution body, not the main-pass emit.
    const retryStart = emitted.indexOf('retry: async (currentVerdict) =>');
    expect(retryStart).toBeGreaterThan(-1);
    const retryBody = emitted.slice(retryStart);
    // The retry callback reassigns the foreach bind via a foreach({...})
    // call (the bind was `let`-declared in the main-pass shape because
    // it's a zone member).
    expect(retryBody).toMatch(/results = await foreach\(\{/);
    // The body callback is REFERENCED by name, not re-emitted. The
    // closure-name suffix is `_N` from fresh() — the test regex matches
    // the full `__foreach_body_N` shape including the underscore.
    expect(retryBody).toMatch(/body: __foreach_body_\d+/);
    // Regression: `over:` is a file path readFileSync opens, NOT an agent
    // input. The retry-callback emit must use the bare bind identifier,
    // not the inputExprFor wrap (which would template-literal the path
    // into an agent prompt and break the runtime read). Mirrors the
    // main-pass assertion in emit-walker.test.ts.
    expect(retryBody).toMatch(/over: plan2,/);
    expect(retryBody).not.toMatch(/over: `planner finished its work/);
  });

  it('skips bindless foreach in the retry body (no rejoin variable to reassign)', () => {
    // Per Decision K: bindless foreaches have no rejoin variable, so
    // buildRetryBody's foreach case skips them with `continue` — same
    // way bindless branches are skipped.
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
    const emitted = compile(yamlPath);
    const retryStart = emitted.indexOf('retry: async (currentVerdict) =>');
    expect(retryStart).toBeGreaterThan(-1);
    const retryBody = emitted.slice(retryStart, emitted.indexOf('});', retryStart));
    // The retry body does NOT re-fire the bindless foreach — there's
    // nothing to reassign, so the foreach is absent from the retry loop.
    expect(retryBody).not.toMatch(/await foreach\(\{/);
  });
});
