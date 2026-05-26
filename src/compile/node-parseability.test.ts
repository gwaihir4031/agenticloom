import { describe, it, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import * as path from 'path';
import { compile } from './index.js';
import { setupCompileTestEnv, setupFixture } from './test-helpers.js';

describe('Node-parseability of compile() output', () => {
  // Defense-in-depth against TS-syntax leaks into the production .mjs emit.
  // Background: the unit suite's `compileAndTypeCheck` validates the emit
  // by writing it to a `.ts` file and running `tsc --noEmit`. TS syntax
  // (type annotations, generics, etc.) parses cleanly there, so a leak
  // like `revisePromptForTerminal?: string` slipped through every emit
  // test in groups A-K. Production runs the emit as plain Node on a
  // `.mjs` temp (see `cli.ts`'s dev-vs-prod runner branching), which
  // rejects TS-only syntax with a SyntaxError. Only the 11 Group I
  // runtime tests actually execute the emit via Node; the other ~40+
  // emit-shape tests validate via tsc and would not catch a future leak.
  //
  // This block closes that structural divergence by parsing every fixture
  // with `node --check` (parse-only, no execution; unresolved imports are
  // fine at parse time). One assertion per fixture: exit 0 + no stderr.
  // The fixtures sample the emit-construct surface area (plain step,
  // consumable branch, non-consumable branch + retry, nested branches,
  // review_loop single + compound, parallel, aggregate gate, human_gate)
  // so a new TS-syntax leak in any emit code path lights the suite up.
  //
  // Cost: `node --check` is parse-only and spawns subprocess in <100ms.
  // Total overhead at 9 fixtures is well under a second.

  let teardown: () => void;

  beforeEach(() => {
    teardown = setupCompileTestEnv();
  });

  afterEach(() => {
    teardown();
  });

  function nodeCheckEmit(emit: string): { ok: boolean; stderr: string } {
    const checkDir = mkdtempSync(path.join(tmpdir(), 'loom-nodecheck-'));
    try {
      // `.mjs` is load-bearing: `node --check` rejects `import`/`export`
      // syntax in a plain `.js` file unless package.json sets `"type":
      // "module"`. The production runner writes `.mjs` for the same
      // reason — see `cli.ts` runner-branching.
      const emitPath = path.join(checkDir, 'emit.mjs');
      writeFileSync(emitPath, emit);
      const result = spawnSync(process.execPath, ['--check', emitPath], {
        encoding: 'utf-8',
      });
      return { ok: result.status === 0, stderr: result.stderr };
    } finally {
      rmSync(checkDir, { recursive: true, force: true });
    }
  }

  function expectNodeParseable(emit: string): void {
    const { ok, stderr } = nodeCheckEmit(emit);
    if (!ok) {
      throw new Error(`node --check rejected the emit:\n${stderr}\n\nEMIT:\n${emit}`);
    }
  }

  it('plain step + produces — no branch, no retry', () => {
    const yamlPath = setupFixture({
      agents: ['a'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: a
    input: $x
    produces: out.md
    bind: aOut
`,
    });
    expectNodeParseable(compile(yamlPath));
  });

  it('consumable branch — both arms file-bound, downstream $ref consumer', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outcome
      then:
        - step: a
          input: $x
          produces: A.md
          bind: aBind
      else:
        - step: b
          input: $x
          produces: B.md
          bind: bBind
  - step: cons
    input: $outcome
    produces: out.md
`,
    });
    expectNodeParseable(compile(yamlPath));
  });

  it('non-consumable branch + retry_from — design-point-3 side-effect case', () => {
    // Design-point-3 case: single-arm bound branch, side-effect terminal
    // (step WITHOUT `produces:`), bind non-consumable but still a valid
    // retry_from target. Position-based dispatch (43a4c7c) unblocked the
    // shape — the rendered revise prompt threads to the side-effect step
    // via the closure's `revisePromptForTerminal` parameter. This fixture
    // also exercises the same closure declaration whose stale `?: string`
    // annotation 93472e1 removed.
    const yamlPath = setupFixture({
      agents: ['writer', 'side', 'rev'],
      yaml: `
pipeline: p
cli: claude
inputs: [topic]
flow:
  - step: writer
    input: $topic
    produces: DRAFT.md
    bind: writerOut
  - branch:
      bind: branchPoint
      when: writerOut.length > 0
      then:
        - step: side
          input: $writerOut
  - step: rev
    input: $writerOut
    produces: review.json
    bind: revOut
  - aggregate:
      inputs:
        r: $revOut
      verdict_field: status
      approve_when: pass
      bind: overall
      retry_from: branchPoint
      max_retries: 1
      revise_with:
        prompt: "Reconsider and revise the draft."
`,
    });
    expectNodeParseable(compile(yamlPath));
  });

  it('nested branches (2-deep) — recursive closure threading', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'c', 'cons'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      bind: outerOutcome
      then:
        - branch:
            when: $x
            bind: innerOutcome
            then:
              - step: a
                input: $x
                produces: A.md
                bind: aBind
            else:
              - step: b
                input: $x
                produces: B.md
                bind: bBind
      else:
        - step: c
          input: $x
          produces: C.md
          bind: cBind
  - step: cons
    input: $outerOutcome
    produces: out.md
`,
    });
    expectNodeParseable(compile(yamlPath));
  });

  it('review_loop — single-mode reviewer', () => {
    const yamlPath = setupFixture({
      agents: ['w', 'r'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer: w
      reviewer: r
      input: $x
      writer_produces: out.md
      reviewer_produces: rev.json
      verdict_field: status
      bind: rlOut
`,
    });
    expectNodeParseable(compile(yamlPath));
  });

  it('review_loop — compound reviewer subflow with aggregate terminal', () => {
    const yamlPath = setupFixture({
      agents: ['w', 'r1', 'r2'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer: w
      input: $x
      writer_produces: out.md
      bind: rlOut
      reviewer:
        - parallel:
            - step: r1
              input: $x
              produces: r1.json
              bind: r1
            - step: r2
              input: $x
              produces: r2.json
              bind: r2
        - aggregate:
            inputs: { a: $r1, b: $r2 }
            verdict_field: status
            bind: agg
`,
    });
    expectNodeParseable(compile(yamlPath));
  });

  it('parallel — three children', () => {
    const yamlPath = setupFixture({
      agents: ['a', 'b', 'c'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - parallel:
      - step: a
        input: $x
        produces: a.md
        bind: aBind
      - step: b
        input: $x
        produces: b.md
        bind: bBind
      - step: c
        input: $x
        produces: c.md
        bind: cBind
`,
    });
    expectNodeParseable(compile(yamlPath));
  });

  it('aggregate gate with retry_from + revise_with — retry zone wrapper emit', () => {
    const yamlPath = setupFixture({
      agents: ['w', 'r'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: w
    input: $x
    produces: out.md
    bind: writerOut
  - step: r
    input: $writerOut
    produces: rev.json
    bind: revOut
  - aggregate:
      inputs: { r: $revOut }
      verdict_field: status
      approve_when: pass
      bind: agg
      retry_from: writerOut
      max_retries: 1
      revise_with:
        prompt: "Retry the writer."
`,
    });
    expectNodeParseable(compile(yamlPath));
  });

  it('human_gate — interactive + plain y/N', () => {
    const yamlPath = setupFixture({
      agents: ['w', 'gate'],
      yaml: `
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: w
    input: $x
    produces: out.md
    bind: written
  - human_gate:
      interactive: true
      agent: gate
      input: $written
      prompt: review
  - human_gate: {}
`,
    });
    expectNodeParseable(compile(yamlPath));
  });
});
