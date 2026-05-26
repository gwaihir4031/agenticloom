import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

describe('checkConsume (via compile)', () => {
  it('rejects $ref to an unknown name', () => {
    const yamlPath = setupFixture({
      agents: ['a'],
      yaml: `
pipeline: unknown-ref
cli: claude
inputs: [x]
flow:
  - step: a
    input: $missing
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(/unknown bind '\$missing'/);
  });

  it('rejects $ref to a producer without produces:', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b'],
      yaml: `
pipeline: not-file-bound
cli: claude
inputs: [x]
flow:
  - step: a
    input: $x
    bind: result
  - step: b
    input: $result
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(/no file-bound output/);
  });

  it('accepts $ref to a pipeline input (text)', () => {
    const yamlPath = setupFixture({
      agents: ['a'],
      yaml: `
pipeline: input-ref
cli: claude
inputs: [ticket]
flow:
  - step: a
    input: $ticket
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
  });

  it('rejects $ref to an aggregate bind (aggregate is not file-bound)', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b'],
      yaml: `
pipeline: agg-ref
cli: claude
inputs: [x]
flow:
  - step: a
    input: $x
    produces: a.json
    bind: a_out
  - aggregate:
      inputs: { a: $a_out }
      verdict_field: status
      bind: agg_verdict
  - step: b
    input: $agg_verdict
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(/no file-bound output/);
  });
});

describe('checkConsume: foreach list-bound rejection', () => {
  it('rejects $ref to a foreach bind via step.input with a list-bound remedy', () => {
    const yamlPath = setupFixture({
      agents: ['worker', 'consumer'],
      yaml: `
pipeline: foreach-ref
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
      bind: results
  - step: consumer
    input: $results
    produces: summary.md
`,
    });
    // Two assertions: the rejection message names "list-bound" + the
    // PRD-pinned remedy mentions retry_from / --resume-from.
    expect(() => compile(yamlPath)).toThrow(/list-bound/);
    expect(() => compile(yamlPath)).toThrow(/'retry_from:' target or a '--resume-from' cursor/);
  });
});

describe('parallel-sibling path collision (via compile)', () => {
  it('rejects two parallel siblings writing to the same path', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b'],
      yaml: `
pipeline: collide
cli: claude
inputs: [x]
flow:
  - parallel:
      - step: a
        input: $x
        produces: shared.md
        bind: a
      - step: b
        input: $x
        produces: shared.md
        bind: b
`,
    });
    expect(() => compile(yamlPath)).toThrow(/parallel siblings write to the same path "shared.md"/);
  });

  it('rejects nested parallel blocks', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b'],
      yaml: `
pipeline: nested-par
cli: claude
inputs: [x]
flow:
  - parallel:
      - parallel:
          - step: a
            input: $x
            produces: a.md
            bind: a
      - step: b
        input: $x
        produces: b.md
        bind: b
`,
    });
    expect(() => compile(yamlPath)).toThrow(/parallel block contains a nested parallel/);
  });

  it('accepts parallel siblings writing to different paths', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b'],
      yaml: `
pipeline: ok-par
cli: claude
inputs: [x]
flow:
  - parallel:
      - step: a
        input: $x
        produces: a.md
        bind: a
      - step: b
        input: $x
        produces: b.md
        bind: b
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
  });
});

describe('$-ref error messages for new bind types', () => {
  it('rejects $-ref to parallel bind with helpful suggestion', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'consumer'],
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
    bind: pBind
  - step: consumer
    input: $pBind
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(/pBind.*parallel.*multiple outputs.*aBind.*bBind/i);
  });

  it('rejects $-ref to branch bind with missing-else with helpful explanation', () => {
    // Under the explicit-rejoin rule, a branch bind is consumable only when
    // both arms terminate in file-bound producers AND the else arm exists.
    // Missing-else triggers the `missing_else` reason in BranchConsumability;
    // the consumer-site error names the bind, the consume site, and the fix.
    const yamlPath = setupFixture({
      agents: ['a', 'consumer'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      then:
        - step: a
          produces: a.json
          bind: aBind
      bind: bBind
  - step: consumer
    input: $bBind
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(/bBind.*no 'else:' arm/);
  });
});

describe('emit shape — runAgent inputPaths threading', () => {
  // Every runAgent emit carries an `inputPaths: [...]` clause listing the
  // step's declared input bind refs (resolved to JS identifiers in scope)
  // and literal-string paths. The runtime iterates the clause and calls
  // `requireFile` on each before spawning so no agent runs against a
  // missing input — the core safety guarantee of the resume capability.
  // Pipelines that don't use --resume-from still benefit: the same check
  // catches silent-empty / wrong-path failures on every run.

  it('emits inputPaths with the bind identifier for a single $ref input', () => {
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
    bind: writerOut
  - step: rev
    input: $writerOut
    produces: r.json
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/runAgent\("rev",[\s\S]*?inputPaths: \[writerOut\]/);
  });

  it('emits inputPaths with one entry per resolvable ref in a multi-input map', () => {
    const yamlPath = setupFixture({
      agents: ['writer-a', 'writer-b', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer-a
    input: $x
    produces: a.md
    bind: aOut
  - step: writer-b
    input: $x
    produces: b.md
    bind: bOut
  - step: rev
    inputs:
      a: $aOut
      b: $bOut
    produces: r.json
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/runAgent\("rev",[\s\S]*?inputPaths: \[aOut, bOut\]/);
  });

  it('preserves YAML iteration order — reversing the inputs map reverses the inputPaths order', () => {
    // The runtime walks inputPaths in array order; the first miss in
    // declared order is the one that throws. js-yaml preserves mapping-
    // entry insertion order on the parsed object; `Object.values` walks
    // them in that same order. Reversing the YAML map order must reverse
    // the emitted array — pinning the order contract end-to-end.
    const yamlPath = setupFixture({
      agents: ['writer-a', 'writer-b', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer-a
    input: $x
    produces: a.md
    bind: aOut
  - step: writer-b
    input: $x
    produces: b.md
    bind: bOut
  - step: rev
    inputs:
      b: $bOut
      a: $aOut
    produces: r.json
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/runAgent\("rev",[\s\S]*?inputPaths: \[bOut, aOut\]/);
  });

  it('emits literal-string inputs as JSON-stringified entries', () => {
    const yamlPath = setupFixture({
      agents: ['writer'],
      yaml: `
pipeline: p
cli: claude
flow:
  - step: writer
    input: ticket.md
    produces: w.md
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/runAgent\("writer",[\s\S]*?inputPaths: \["ticket\.md"\]/);
  });

  it('includes pipeline-input refs as identifiers', () => {
    // Pipeline inputs are file-bound by convention (the CLI's
    // absolutifyFileArgs treats path-shaped positional args as paths).
    // The compile emits them as JS identifiers so the runtime resolves
    // the bind value against cwd via path.resolve inside requireFile,
    // surfacing typoed path positionals at the first agent consumer.
    const yamlPath = setupFixture({
      agents: ['writer'],
      yaml: `
pipeline: p
cli: claude
inputs: [ticket]
flow:
  - step: writer
    input: $ticket
    produces: w.md
`,
    });
    const emitted = compile(yamlPath);
    expect(emitted).toMatch(/runAgent\("writer",[\s\S]*?inputPaths: \[ticket\]/);
  });

  it('threads inputPaths through to retry-callback emits (both initial and retry passes)', () => {
    // The retry-target's iteration-2+ runAgent emit flows through the
    // same emitRunAgentExpr as the initial pass, so inputPaths is
    // computed for both passes. Without this single-emit-site invariant
    // a retry would silently bypass the pre-spawn check.
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
    bind: writerOut
  - step: rev
    input: $writerOut
    produces: r.json
    bind: revOut
    on_fail:
      verdict_field: status
      retry_from: writerOut
      revise_with:
        prompt: Retry.
`,
    });
    const emitted = compile(yamlPath);
    const writerCount = (emitted.match(/runAgent\("writer",[\s\S]*?inputPaths: \[x\]/g) ?? [])
      .length;
    expect(writerCount).toBeGreaterThanOrEqual(2);
  });

  it('aggregate rewriter closures do NOT carry inputPaths (re-validation would be tautological)', () => {
    // The rewriter closure's job is to re-produce the upstream output
    // file; the upstream input check already fired on the main pass.
    // Threading inputPaths here would re-validate the same set of
    // upstream files. The asymmetry is by construction.
    const yamlPath = setupFixture({
      agents: ['writer'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer
    input: $x
    produces: w.json
    bind: writerOut
  - aggregate:
      inputs: { w: $writerOut }
      verdict_field: status
`,
    });
    const emitted = compile(yamlPath);
    // The main-pass writer carries inputPaths.
    expect(emitted).toMatch(/runAgent\("writer",[\s\S]*?inputPaths: \[x\]/);
    // The rewriter closure for the writer's slot does NOT carry inputPaths.
    const closureMatch = emitted.match(/rewriteProducerFiles:[\s\S]+?\.then/);
    expect(closureMatch).not.toBeNull();
    expect(closureMatch![0]).not.toMatch(/inputPaths:/);
  });
});

describe('substituteBindRefs (via compile branch.when:)', () => {
  // The tokenizer isn't exported — its behavior is observed through the
  // emitted `if (...)` line for branches. Each test below compiles a
  // small fixture and asserts the substituted `if (...)` line.

  describe('basic substitution', () => {
    it('substitutes $foo to foo when foo is a known bind', () => {
      const yamlPath = setupFixture({
        agents: ['w'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: w
    input: $x
    produces: out.md
    bind: foo
  - branch:
      when: $foo === 'bug'
      then:
        - step: w
          input: $x
          produces: t.md
`,
      });
      const emitted = compile(yamlPath);
      expect(emitted).toContain("if (foo === 'bug') {");
    });

    it('leaves bare foo unchanged (no $ to strip)', () => {
      const yamlPath = setupFixture({
        agents: ['w'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: w
    input: $x
    produces: out.md
    bind: foo
  - branch:
      when: foo === 'bug'
      then:
        - step: w
          input: $x
          produces: t.md
`,
      });
      const emitted = compile(yamlPath);
      expect(emitted).toContain("if (foo === 'bug') {");
    });

    it('substitutes mixed bare + $-prefix refs in one expression', () => {
      const yamlPath = setupFixture({
        agents: ['w'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: w
    input: $x
    produces: out.md
    bind: foo
  - branch:
      when: $foo === 'bug' && foo !== 'feature'
      then:
        - step: w
          input: $x
          produces: t.md
`,
      });
      const emitted = compile(yamlPath);
      expect(emitted).toContain("if (foo === 'bug' && foo !== 'feature') {");
    });

    it('substitutes pipeline-input names', () => {
      const yamlPath = setupFixture({
        agents: ['w'],
        yaml: `
pipeline: p
cli: claude
inputs: [ticket]
flow:
  - branch:
      when: $ticket.startsWith('BUG-')
      then:
        - step: w
          input: $ticket
          produces: t.md
`,
      });
      const emitted = compile(yamlPath);
      expect(emitted).toContain("if (ticket.startsWith('BUG-')) {");
    });

    it('substitutes aggregate-bind names (string verdict bind)', () => {
      const yamlPath = setupFixture({
        agents: ['w'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: w
    input: $x
    produces: cls.json
    bind: cls
  - aggregate:
      inputs: { c: $cls }
      verdict_field: type
      bind: cls_type
  - branch:
      when: $cls_type === 'bug'
      then:
        - step: w
          input: $x
          produces: t.md
`,
      });
      const emitted = compile(yamlPath);
      expect(emitted).toContain("if (cls_type === 'bug') {");
    });

    it('substitutes step-bind names (path-string verdict bind)', () => {
      const yamlPath = setupFixture({
        agents: ['w'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: w
    input: $x
    produces: out.md
    bind: draft
  - branch:
      when: $draft.endsWith('.md')
      then:
        - step: w
          input: $x
          produces: t.md
`,
      });
      const emitted = compile(yamlPath);
      expect(emitted).toContain("if (draft.endsWith('.md')) {");
    });
  });

  describe('string-literal protection', () => {
    it('leaves $foo inside a single-quote string literal unchanged', () => {
      const yamlPath = setupFixture({
        agents: ['w'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: w
    input: $x
    produces: out.md
    bind: foo
  - branch:
      when: "foo === '$foo'"
      then:
        - step: w
          input: $x
          produces: t.md
`,
      });
      const emitted = compile(yamlPath);
      // The OUTER foo is substituted (no leading $); the INNER $foo is
      // inside a single-quote string literal and must stay verbatim.
      expect(emitted).toContain("if (foo === '$foo') {");
    });

    it('leaves $foo inside a double-quote string literal unchanged', () => {
      const yamlPath = setupFixture({
        agents: ['w'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: w
    input: $x
    produces: out.md
    bind: foo
  - branch:
      when: 'foo === "$foo"'
      then:
        - step: w
          input: $x
          produces: t.md
`,
      });
      const emitted = compile(yamlPath);
      expect(emitted).toContain('if (foo === "$foo") {');
    });

    it('leaves $foo inside a template-literal string unchanged when not in ${...}', () => {
      const yamlPath = setupFixture({
        agents: ['w'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: w
    input: $x
    produces: out.md
    bind: foo
  - branch:
      when: "foo === \`$foo\`"
      then:
        - step: w
          input: $x
          produces: t.md
`,
      });
      const emitted = compile(yamlPath);
      expect(emitted).toContain('if (foo === `$foo`) {');
    });

    it('substitutes $foo inside a template-literal ${...} interpolation', () => {
      const yamlPath = setupFixture({
        agents: ['w'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: w
    input: $x
    produces: out.md
    bind: foo
  - branch:
      when: "\`prefix-\${$foo}\` === 'prefix-bug'"
      then:
        - step: w
          input: $x
          produces: t.md
`,
      });
      const emitted = compile(yamlPath);
      // Inside the ${...} interpolation we're back in expression-mode, so
      // $foo substitutes to foo.
      expect(emitted).toContain("if (`prefix-${foo}` === 'prefix-bug') {");
    });

    it('handles balanced {} inside ${...} (object literal in template)', () => {
      const yamlPath = setupFixture({
        agents: ['w'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: w
    input: $x
    produces: out.md
    bind: foo
  - branch:
      when: "\`\${ ({k: $foo}).k }\` === 'bug'"
      then:
        - step: w
          input: $x
          produces: t.md
`,
      });
      const emitted = compile(yamlPath);
      // The object-literal braces inside ${...} must balance correctly so
      // the closing $-substitution and template state restoration line up.
      expect(emitted).toContain("if (`${ ({k: foo}).k }` === 'bug') {");
    });

    it('handles backslash-escaped quotes inside a double-quoted string literal', () => {
      // Inside the double-quote JS literal, the embedded \" escape must NOT
      // pop us out of the string; the inner $foo therefore stays
      // unsubstituted. Test uses double-quote JS form rather than
      // single-quote because YAML's single-quoted scalar doesn't have
      // backslash escapes (only '' = '), so testing JS \' inside YAML
      // would require double-quoted YAML scalars anyway. The tokenizer
      // rule under test (backslash consumes next char inside a string
      // literal) fires identically for both JS quote styles.
      const yamlPath = setupFixture({
        agents: ['w'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: w
    input: $x
    produces: out.md
    bind: foo
  - branch:
      when: 'foo === "this \\" is a $foo".toLowerCase()'
      then:
        - step: w
          input: $x
          produces: t.md
`,
      });
      const emitted = compile(yamlPath);
      // The outer foo (before ===) substitutes; the inner $foo stays
      // inside the literal because the escaped \" doesn't end it.
      expect(emitted).toContain('if (foo === "this \\" is a $foo".toLowerCase()) {');
    });
  });

  describe('unknown identifiers and edge cases', () => {
    it('leaves $unknown unchanged when the identifier is not in scope', () => {
      const yamlPath = setupFixture({
        agents: ['w'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $unknown === 'bug'
      then:
        - step: w
          input: $x
          produces: t.md
`,
      });
      const emitted = compile(yamlPath);
      // Unknown $unknown stays verbatim; surfaces as a runtime
      // ReferenceError when the emitted JS runs.
      expect(emitted).toContain("if ($unknown === 'bug') {");
    });

    it('leaves $Math (a JS global) unchanged — globals are not in scope', () => {
      const yamlPath = setupFixture({
        agents: ['w'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $Math.random() > 0.5
      then:
        - step: w
          input: $x
          produces: t.md
`,
      });
      const emitted = compile(yamlPath);
      // $Math is NOT in scope (JS globals are not tracked in the bind
      // map), so the substitution skips it. The user wrote a typo; the
      // ReferenceError at runtime tells them so.
      expect(emitted).toContain('if ($Math.random() > 0.5) {');
    });

    it('handles cls$foo as a single identifier (NO substitution)', () => {
      // `cls$foo` is one JS identifier; the `$` is an identifier-continuation
      // character preceded by `s`. The substitution rule requires the `$`
      // be at position 0 or preceded by a non-identifier character, so
      // this case is left untouched.
      const yamlPath = setupFixture({
        agents: ['w'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: cls$foo === 'bug'
      then:
        - step: w
          input: $x
          produces: t.md
`,
      });
      const emitted = compile(yamlPath);
      // `cls$foo` stays verbatim. Whether the JS identifier exists at
      // runtime is the pipeline's problem; the substitution doesn't try
      // to interpret it.
      expect(emitted).toContain("if (cls$foo === 'bug') {");
    });

    it('handles a malformed lone $ with no identifier (no-op)', () => {
      const yamlPath = setupFixture({
        agents: ['w'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: '$ === undefined'
      then:
        - step: w
          input: $x
          produces: t.md
`,
      });
      const emitted = compile(yamlPath);
      // A lone $ followed by a space is not a substitution candidate.
      expect(emitted).toContain('if ($ === undefined) {');
    });

    it('passes through expressions with no $ patterns verbatim', () => {
      const yamlPath = setupFixture({
        agents: ['w'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: w
    input: $x
    produces: out.md
    bind: foo
  - branch:
      when: foo === 'bug' && Math.random() > 0.5
      then:
        - step: w
          input: $x
          produces: t.md
`,
      });
      const emitted = compile(yamlPath);
      // No $ patterns → byte-identical pass-through.
      expect(emitted).toContain("if (foo === 'bug' && Math.random() > 0.5) {");
    });
  });

  describe('end-to-end: branch.when: substitution + helpers in a real compiled pipeline', () => {
    it('compiles fileExists with a literal-string path (no substitution needed)', () => {
      const yamlPath = setupFixture({
        agents: ['w'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: "fileExists('cached-result.json')"
      then:
        - step: w
          input: $x
          produces: t.md
`,
      });
      const emitted = compile(yamlPath);
      expect(emitted).toContain("if (fileExists('cached-result.json')) {");
      expect(emitted).toMatch(/import\s*\{[^}]*fileExists[^}]*\}\s*from/);
    });

    it('compiles readJson($cls) with substitution + helper import', () => {
      const yamlPath = setupFixture({
        agents: ['w'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: w
    input: $x
    produces: cls.json
    bind: cls
  - branch:
      when: "readJson($cls).type === 'bug'"
      then:
        - step: w
          input: $x
          produces: t.md
`,
      });
      const emitted = compile(yamlPath);
      expect(emitted).toContain("if (readJson(cls).type === 'bug') {");
      expect(emitted).toMatch(/import\s*\{[^}]*readJson[^}]*\}\s*from/);
    });

    it('compiles readText($draft).includes(...) with substitution + helper import', () => {
      const yamlPath = setupFixture({
        agents: ['w'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: w
    input: $x
    produces: out.md
    bind: draft
  - branch:
      when: "readText($draft).includes('TODO')"
      then:
        - step: w
          input: $x
          produces: t.md
`,
      });
      const emitted = compile(yamlPath);
      expect(emitted).toContain("if (readText(draft).includes('TODO')) {");
      expect(emitted).toMatch(/import\s*\{[^}]*readText[^}]*\}\s*from/);
    });

    it('compiles a multi-helper when: (fileExists + readJson) with both helpers in scope', () => {
      const yamlPath = setupFixture({
        agents: ['w'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: w
    input: $x
    produces: cache.json
    bind: cache
  - branch:
      when: "fileExists($cache) && readJson($cache).version === 2"
      then:
        - step: w
          input: $x
          produces: t.md
`,
      });
      const emitted = compile(yamlPath);
      expect(emitted).toContain('if (fileExists(cache) && readJson(cache).version === 2) {');
      // Both helpers appear once in the import line (not duplicated).
      const importLineMatch = emitted.match(/import\s*\{[^}]*\}\s*from/);
      expect(importLineMatch).not.toBeNull();
      const importLine = importLineMatch![0];
      // Each helper appears at most once in the import line.
      expect(importLine.match(/fileExists/g)?.length).toBe(1);
      expect(importLine.match(/readJson/g)?.length).toBe(1);
    });

    it('compiles nested branches with helpers — each when: substituted independently', () => {
      const yamlPath = setupFixture({
        agents: ['w'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: w
    input: $x
    produces: cls.json
    bind: cls
  - branch:
      when: "readJson($cls).type === 'bug'"
      then:
        - branch:
            when: "readJson($cls).severity === 'critical'"
            then:
              - step: w
                input: $x
                produces: crit.md
            else:
              - step: w
                input: $x
                produces: norm.md
      else:
        - step: w
          input: $x
          produces: feat.md
`,
      });
      const emitted = compile(yamlPath);
      expect(emitted).toContain("if (readJson(cls).type === 'bug') {");
      expect(emitted).toContain("if (readJson(cls).severity === 'critical') {");
    });

    it('compiles a pipeline with branch AND on_fail — both retryGateZone AND helpers imported', () => {
      const yamlPath = setupFixture({
        agents: ['w', 'rev'],
        yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: w
    input: $x
    produces: out.md
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
      when: "readJson($r).status === 'pass'"
      then:
        - step: w
          input: $x
          produces: t.md
`,
      });
      const emitted = compile(yamlPath);
      expect(emitted).toMatch(
        /import\s*\{[^}]*retryGateZone, readJson, readText, fileExists[^}]*\}\s*from/,
      );
      expect(emitted).toContain("if (readJson(r).status === 'pass') {");
    });
  });
});
