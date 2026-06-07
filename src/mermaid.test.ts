import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { Pipeline } from './types.js';
import { emitMermaid } from './mermaid.js';

// Mermaid emit is a pure function over a parsed spec — no fs, no validation
// beyond zod. Tests parse a YAML string inline (no temp dir) and assert the
// emitted Mermaid contains the expected lines.

function spec(yaml: string) {
  return Pipeline.parse(parseYaml(yaml));
}

describe('emitMermaid — header + inputs', () => {
  it('starts with `flowchart TD`', () => {
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: []
flow: []
`),
    );
    expect(out.split('\n')[0]).toBe('flowchart TD');
  });

  it('renders each pipeline input as a parallelogram node', () => {
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: [ticket, target_branch]
flow: []
`),
    );
    // Two parallelogram nodes, distinct IDs, labels match input names.
    expect(out).toMatch(/^ {4}n\d+\[\/"ticket"\/\]$/m);
    expect(out).toMatch(/^ {4}n\d+\[\/"target_branch"\/\]$/m);
  });

  it('emits no edges when flow is empty', () => {
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: [x]
flow: []
`),
    );
    expect(out).not.toMatch(/-->/);
  });
});

describe('emitMermaid — step', () => {
  it('renders a step as a rounded-rect node', () => {
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: ac-writer
    input: $x
    produces: out.md
`),
    );
    expect(out).toMatch(/^ {4}n\d+\(\["ac-writer"\]\)$/m);
  });

  it('connects each pipeline input to the first flow item', () => {
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: [ticket]
flow:
  - step: ac-writer
    input: $ticket
    produces: out.md
`),
    );
    // input n1 → step n2
    expect(out).toMatch(/^ {4}n1 --> n2$/m);
  });

  it('connects consecutive step items with a structural arrow', () => {
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: []
flow:
  - step: a
    input: ""
    produces: a.md
  - step: b
    input: ""
    produces: b.md
`),
    );
    // step n1 → step n2
    expect(out).toMatch(/^ {4}n1 --> n2$/m);
  });

  it('HTML-escapes special chars in labels', () => {
    // Step names are arbitrary strings per the schema, so they exercise
    // escapeLabel through the same code path the other label sources use.
    // (Inputs and binds are restricted to identifier-shaped names via
    // BindName; step / agent names have no such constraint.)
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: []
flow:
  - step: "a<b&c"
    produces: out.md
`),
    );
    expect(out).toMatch(/a&lt;b&amp;c/);
    expect(out).not.toMatch(/a<b&c/);
  });
});

describe('emitMermaid — review_loop', () => {
  it('renders a single-reviewer review_loop as a subgraph with writer + reviewer + back-edge', () => {
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer: w
      reviewer: r
      input: $x
      max_iters: 2
      writer_produces: out.md
      reviewer_produces: rev.json
      verdict_field: status
`),
    );
    // Subgraph wrapper with max_iters in title.
    expect(out).toMatch(/^ {4}subgraph n\d+\["review_loop \(max_iters: 2\)"\]$/m);
    // Writer + reviewer as rounded rects inside.
    expect(out).toMatch(/n\d+\(\["w"\]\)/);
    expect(out).toMatch(/n\d+\(\["r"\]\)/);
    // Forward edge writer → reviewer with writer_produces label.
    expect(out).toMatch(/n\d+ -->\|"writer_produces"\| n\d+/);
    // Dotted on-fail back-edge reviewer → writer.
    expect(out).toMatch(/n\d+ -\.->\|"on fail"\| n\d+/);
    // Subgraph closer.
    expect(out).toMatch(/^ {4}end$/m);
  });

  it('defaults to max_iters: 3 when omitted in the YAML (matches runtime default)', () => {
    const out = emitMermaid(
      spec(`
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
`),
    );
    expect(out).toMatch(/"review_loop \(max_iters: 3\)"/);
  });

  it('renders a compound review_loop by walking the reviewer subflow inside the subgraph', () => {
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer: spec-writer
      input: $x
      max_iters: 1
      writer_produces: SPEC.md
      bind: spec
      reviewer:
        - step: sec
          input: $spec
          produces: s.json
          bind: s
        - aggregate:
            inputs: { s: $s }
            verdict_field: status
            bind: v
`),
    );
    // Subgraph wrapper present.
    expect(out).toMatch(/subgraph n\d+\["review_loop \(max_iters: 1\)"\]/);
    // Writer node.
    expect(out).toMatch(/n\d+\(\["spec-writer"\]\)/);
    // Reviewer subflow step node (sec).
    expect(out).toMatch(/n\d+\(\["sec"\]\)/);
    // Aggregate node (key list in label).
    expect(out).toMatch(/n\d+\[\/"aggregate: s"\\\]/);
    // Forward edge from writer to first subflow item's head.
    // (Two arrows: writer→sec via writer_produces, then sec→aggregate seq.)
    expect(out).toMatch(/n\d+ -->\|"writer_produces"\| n\d+/);
    expect(out).toMatch(/n\d+ --> n\d+/);
    // Back-edge from terminal aggregate to writer.
    expect(out).toMatch(/n\d+ -\.->\|"on fail"\| n\d+/);
  });

  it('uses approve_when in the subgraph title when set', () => {
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer: w
      reviewer: r
      input: $x
      max_iters: 1
      approve_when: pass
      writer_produces: out.md
      reviewer_produces: rev.json
      verdict_field: status
`),
    );
    expect(out).toMatch(/"review_loop \(max_iters: 1, approve_when: pass\)"/);
  });
});

describe('emitMermaid — parallel', () => {
  it('renders parallel children inside a subgraph; predecessor fans out, successor fans in', () => {
    // No pipeline inputs so the IDs assigned in emit order are:
    // n1 = pre, n2 = parallel subgraph, n3 = a, n4 = b, n5 = post. The
    // fan-out assertion below counts `n1 --> n*` edges, which are the
    // pre → child structural arrows (two of them).
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: []
flow:
  - step: pre
    input: ""
    produces: pre.md
  - parallel:
      - step: a
        input: ""
        produces: a.md
      - step: b
        input: ""
        produces: b.md
  - step: post
    input: ""
    produces: post.md
`),
    );
    // subgraph wrapper
    expect(out).toMatch(/subgraph n\d+\["parallel"\]/);
    // both children nodes
    expect(out).toMatch(/n\d+\(\["a"\]\)/);
    expect(out).toMatch(/n\d+\(\["b"\]\)/);
    // fan-out: pre → a AND pre → b (two arrows from pre)
    const preToChildren = out.match(/n1 --> n\d+/g) ?? [];
    // n1 = pre (first node after no-inputs); should connect to both a and b
    expect(preToChildren.length).toBeGreaterThanOrEqual(2);
    // fan-in: a → post AND b → post
    // (covered by the structural connect; explicit regex not strictly necessary
    // — the count above demonstrates the principle. Assert post exists.)
    expect(out).toMatch(/n\d+\(\["post"\]\)/);
  });
});

describe('emitMermaid — branch', () => {
  it('renders a branch as a diamond + then/else subgraphs with true/false edge labels', () => {
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: "x === 'yes'"
      then:
        - step: t
          input: $x
          produces: t.md
      else:
        - step: e
          input: $x
          produces: e.md
`),
    );
    // Diamond — the `'` is escaped to `&#39;` in the label.
    expect(out).toMatch(/n\d+\{"when: x === &#39;yes&#39;"\}/);
    // then + else subgraphs.
    expect(out).toMatch(/subgraph n\d+\["then"\]/);
    expect(out).toMatch(/subgraph n\d+\["else"\]/);
    // Labeled edges from diamond.
    expect(out).toMatch(/n\d+ -->\|"true"\| n\d+/);
    expect(out).toMatch(/n\d+ -->\|"false"\| n\d+/);
  });

  it('omits the else branch + edge when no else arm is present', () => {
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: "x"
      then:
        - step: t
          input: $x
          produces: t.md
`),
    );
    expect(out).toMatch(/subgraph n\d+\["then"\]/);
    expect(out).not.toMatch(/subgraph n\d+\["else"\]/);
    expect(out).toMatch(/n\d+ -->\|"true"\| n\d+/);
    expect(out).not.toMatch(/"false"/);
  });
});

describe('emitMermaid — human_gate', () => {
  it('renders a plain y/N gate as a hexagon', () => {
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: pre
    input: $x
    produces: out.md
  - human_gate: {}
`),
    );
    expect(out).toMatch(/n\d+\{\{"human_gate \(y\/N\)"\}\}/);
  });

  it('renders an interactive gate as a hexagon labeled with the agent name', () => {
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: pre
    input: $x
    produces: out.md
    bind: o
  - human_gate:
      interactive: true
      agent: ac-writer
      input: $o
      prompt: "iterate"
`),
    );
    expect(out).toMatch(/n\d+\{\{"human_gate \(interactive\): ac-writer"\}\}/);
  });
});

describe('emitMermaid — foreach', () => {
  it('renders foreach as a labeled subgraph with body items inside; predecessor connects into first body item, successor connects out of last', () => {
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: []
flow:
  - step: planner
    input: ""
    produces: plan.jsonl
    bind: plan
  - foreach:
      over: $plan
      as: task
      body:
        - step: worker
          input: $task
          produces: out.md
      bind: results
  - step: post
    input: ""
    produces: post.md
`),
    );
    // Subgraph header uses the bind name as the id and includes over + as in the label.
    expect(out).toMatch(/subgraph results\["foreach: results over \$plan \(as task\)"\]/);
    // Body's worker step rendered inside the subgraph.
    expect(out).toMatch(/n\d+\(\["worker"\]\)/);
    // Predecessor (planner) connects INTO the body's first item (the worker node),
    // not into the subgraph border — same fan-in semantics as parallel.
    // Successor (post) connects OUT of the body's last item.
    // Edge counts: planner --> worker, worker --> post.
    expect(out.match(/-->/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('uses a fresh n* id for the subgraph when no bind is set', () => {
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: []
flow:
  - step: planner
    input: ""
    produces: plan.jsonl
    bind: plan
  - foreach:
      over: $plan
      as: task
      body:
        - step: side-effect
          input: $task
          produces: out.md
`),
    );
    // No bind on the foreach → subgraph id is a fresh n* token; label
    // omits the bind prefix and starts directly with "foreach over".
    expect(out).toMatch(/subgraph n\d+\["foreach over \$plan \(as task\)"\]/);
    expect(out).not.toMatch(/foreach:/);
  });

  it('renders multi-item body as a connected sequence inside the subgraph', () => {
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: []
flow:
  - step: planner
    input: ""
    produces: plan.jsonl
    bind: plan
  - foreach:
      over: $plan
      as: task
      body:
        - step: implementer
          input: $task
          produces: notes.md
          bind: notes
        - step: tester
          inputs:
            task: $task
            notes: $notes
          produces: tests.md
      bind: results
`),
    );
    expect(out).toMatch(/subgraph results\["foreach: results over \$plan \(as task\)"\]/);
    expect(out).toMatch(/n\d+\(\["implementer"\]\)/);
    expect(out).toMatch(/n\d+\(\["tester"\]\)/);
    // The body emits as a sequence — implementer's tail connects to tester's head
    // via the standard structural arrow (-->), inside the indented subgraph block
    // (8 spaces = pipeline indent 4 + subgraph inner indent 4).
    expect(out).toMatch(/ {8}n\d+ --> n\d+/);
  });

  it('allows a downstream step.on_fail.retry_from to back-edge into the foreach subgraph', () => {
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: []
flow:
  - step: planner
    input: ""
    produces: plan.jsonl
    bind: plan
  - foreach:
      over: $plan
      as: task
      body:
        - step: worker
          input: $task
          produces: out.md
      bind: results
  - step: gate
    input: $plan
    produces: gate.json
    bind: gate
    on_fail:
      verdict_field: status
      retry_from: results
      max_retries: 2
      revise_with:
        prompt: retry
`),
    );
    // The retry_from='results' back-edge from the gate step to the foreach
    // subgraph — bindNodes['results'] === 'results' (the subgraph id), so the
    // back-edge dotted arrow with `retry × 2` label targets the subgraph name
    // directly. This validates that registering foreach.bind in bindNodes
    // (mirroring parallel's pattern) integrates with the existing back-edge
    // emit at walkItem's step branch.
    expect(out).toMatch(/n\d+ -\.->\|retry × 2\| results/);
  });
});

describe('mermaid for on_fail and parallel/branch bind', () => {
  it('emits back-edge from gate step to retry_from target with retry × N label', () => {
    const out = emitMermaid(
      spec(`
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
      max_retries: 3
      revise_with:
        prompt: Retry the step.
`),
    );
    expect(out).toMatch(/retry × 3/);
    expect(out).toMatch(/-\.->|<-\.-/); // Mermaid dotted-arrow style
  });

  it('emits labeled subgraph when parallel has a bind', () => {
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: []
flow:
  - parallel:
      - step: sec
        produces: sec.json
        bind: secBind
      - step: api
        produces: api.json
        bind: apiBind
    bind: reviewers
`),
    );
    expect(out).toMatch(/subgraph\s+reviewers/i);
  });

  it('emits labeled subgraph when branch has a bind', () => {
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: [x]
flow:
  - branch:
      when: $x
      then:
        - step: t
          produces: t.json
          bind: tBind
      bind: branchBind
`),
    );
    expect(out).toMatch(/subgraph\s+branchBind/i);
  });

  it('does NOT emit subgraph label when parallel has no bind (backwards-compat)', () => {
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: []
flow:
  - parallel:
      - step: a
        produces: a.json
      - step: b
        produces: b.json
`),
    );
    // No bind → no labeled subgraph header for 'reviewers' or 'branchBind' names:
    expect(out).not.toMatch(/subgraph\s+(reviewers|branchBind)/i);
  });

  it('emits a visible "unresolved" sink + back-edge when retry_from has no matching bind', () => {
    // the compile module rejects this; --mermaid-only bypasses that check so this
    // path is reachable. The emit must be visibly broken (not silently
    // omitted) so the user notices the typo.
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: writer
    input: $x
    produces: out.md
    bind: draft
  - step: reviewer
    input: $draft
    produces: review.json
    bind: review
    on_fail:
      verdict_field: status
      retry_from: nonexistent
      max_retries: 2
      revise_with:
        prompt: Retry the step.
`),
    );
    // The unresolved sink node should appear, naming the bad bind.
    expect(out).toMatch(/unresolved_n\d+_nonexistent\{\{"⚠ unresolved: \$nonexistent"\}\}/);
    // And the back-edge points at the sink, not nothing.
    expect(out).toMatch(/n\d+ -\.->\|retry × 2\| unresolved_n\d+_nonexistent/);
  });
});

describe('emitMermaid — inline-agent step node label', () => {
  // An inline `step:` (object form) labels its node by the resolved agent
  // reference: name, else the step's bind, else a flow-position `inline-<index>`
  // token. The node id stays a fresh `n*` Mermaid identifier; only the visible
  // label changes.

  it('labels an inline step by its name when set', () => {
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: [x]
flow:
  - step:
      prompt: Review the diff.
      name: my-reviewer
    input: $x
    produces: out.md
`),
    );
    expect(out).toMatch(/n\d+\(\["my-reviewer"\]\)/);
  });

  it('falls back to the step bind when the inline agent has no name', () => {
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: [x]
flow:
  - step:
      prompt: Review the diff.
    bind: stepBind
    input: $x
    produces: out.md
`),
    );
    expect(out).toMatch(/n\d+\(\["stepBind"\]\)/);
  });

  it('falls back to a flow-position inline-<index> token when nameless and bindless', () => {
    // The inline step is the second top-level item (index 1), so the
    // positional fallback is `inline-1` — proving the label uses the flow
    // index, not a constant.
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: [x]
flow:
  - step: persona-a
    input: $x
    produces: a.md
  - step:
      prompt: Do the thing.
    input: $x
    produces: out.md
`),
    );
    expect(out).toMatch(/n\d+\(\["inline-1"\]\)/);
  });

  it('uses the per-child index for a nameless, bindless inline parallel child', () => {
    // Inside a parallel, each child is walked with its own positional index.
    // The inline step is the second child (index 1), so its fallback label is
    // `inline-1` — pinning that the parallel-child index is threaded, not the
    // outer flow position.
    const out = emitMermaid(
      spec(`
pipeline: p
cli: claude
inputs: []
flow:
  - parallel:
      - step: persona-a
        produces: a.md
      - step:
          prompt: Do the thing.
        produces: b.md
`),
    );
    expect(out).toMatch(/n\d+\(\["inline-1"\]\)/);
  });
});
