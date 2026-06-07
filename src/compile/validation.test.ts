import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import * as path from 'path';
import { compile } from './index.js';
import { agentFileLeaf } from './validation.js';
import { setupCompileTestEnv, setupFixture } from './test-helpers.js';

let teardown: () => void;

beforeEach(() => {
  teardown = setupCompileTestEnv();
});

afterEach(() => {
  teardown();
});

describe('agentFileLeaf', () => {
  // The persona-file leaf must be the exact filename each CLI opens, so the
  // compile-time existence check probes for the persona at that leaf.
  it('returns the bare .md leaf for a claude agent', () => {
    expect(agentFileLeaf('claude', 'reviewer')).toBe('reviewer.md');
  });

  it('returns the .agent.md leaf for a copilot agent', () => {
    expect(agentFileLeaf('copilot', 'reviewer')).toBe('reviewer.agent.md');
  });
});

describe('validateAgentFilesExist (via compile)', () => {
  it('accepts a pipeline where all referenced agents have .md files', () => {
    const yamlPath = setupFixture({
      agents: ['ac-writer'],
      yaml: `
pipeline: ok
cli: claude
inputs: [x]
flow:
  - step: ac-writer
    input: $x
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
  });

  it('rejects a pipeline that references an agent without a persona file', () => {
    const yamlPath = setupFixture({
      agents: ['only-this-one'],
      yaml: `
pipeline: missing
cli: claude
inputs: [x]
flow:
  - step: missing-agent
    input: $x
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(
      /references agent 'missing-agent'.*no persona file exists at either layer.*\.claude\/agents\/missing-agent\.md/s,
    );
  });

  it('walks compound subflow steps when checking', () => {
    const yamlPath = setupFixture({
      agents: ['ac-writer'], // only writer; reviewers missing
      yaml: `
pipeline: compound-missing
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer: ac-writer
      input: $x
      writer_produces: out.md
      reviewer:
        - parallel:
            - step: missing-reviewer
              input: $out
              produces: r.json
              bind: r
        - aggregate:
            inputs: { r: $r }
            verdict_field: status
            bind: v
`,
    });
    expect(() => compile(yamlPath)).toThrow(/missing-reviewer/);
  });

  it('walks branch arms when checking', () => {
    const yamlPath = setupFixture({
      agents: ['ac-writer'],
      yaml: `
pipeline: branch-missing
cli: claude
inputs: [x]
flow:
  - step: ac-writer
    input: $x
    produces: out.md
    bind: out
  - branch:
      when: 'true'
      then:
        - step: missing-then
          input: $out
          produces: t.md
      else:
        - step: missing-else
          input: $out
          produces: e.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(/missing-(then|else)/);
  });

  it('detects missing agent referenced inside a foreach body', () => {
    // Per Decision M: the walker recurses into foreach bodies the same
    // way it descends into parallel + branch arms + review_loop subflows.
    // Without this, a typo / refactor leftover inside a foreach body
    // would only surface at runtime (first iteration spawn) instead of
    // at compile time.
    const yamlPath = setupFixture({
      agents: ['planner'],
      yaml: `
pipeline: foreach-missing
cli: claude
inputs: [plan]
flow:
  - foreach:
      over: $plan
      as: task
      body:
        - step: nonexistent-agent
          input: $task
          produces: out.md
          bind: w
`,
    });
    expect(() => compile(yamlPath)).toThrow(/nonexistent-agent/);
  });

  it('walks interactive human_gate agents (separate compile-time check)', () => {
    const yamlPath = setupFixture({
      agents: ['ac-writer'], // ac-writer exists; gate-agent missing
      yaml: `
pipeline: gate-missing
cli: claude
inputs: [x]
flow:
  - step: ac-writer
    input: $x
    produces: out.md
    bind: out
  - human_gate:
      interactive: true
      agent: gate-agent
      input: $out
      prompt: review
`,
    });
    expect(() => compile(yamlPath)).toThrow(/gate-agent/);
  });

  it('validates a copilot pipeline against the .github/agents/<name>.agent.md leaf', () => {
    // The existence check must validate the SAME file the CLI opens. GitHub
    // Copilot CLI reads `<name>.agent.md` under `.github/agents/`, so a correct
    // copilot persona at that leaf must pass. setupFixture(cli: 'copilot')
    // writes exactly that file.
    const yamlPath = setupFixture({
      agents: ['reviewer'],
      cli: 'copilot',
      yaml: `
pipeline: copilot-ok
cli: copilot
inputs: [x]
flow:
  - step: reviewer
    input: $x
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
  });

  it('rejects a copilot pipeline naming the .agent.md path at both layers when absent', () => {
    // No persona file created. The thrown error must name the copilot leaf
    // (`<name>.agent.md`) at both the project (.github/agents) and global
    // (~/.copilot/agents) layers — the exact files the copilot CLI would open.
    const yamlPath = setupFixture({
      yaml: `
pipeline: copilot-missing
cli: copilot
inputs: [x]
flow:
  - step: reviewer
    input: $x
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(
      /references agent 'reviewer'.*no persona file exists at either layer.*\.github\/agents\/reviewer\.agent\.md/s,
    );
    // Global layer too: `~/.copilot/agents/` (the `~/` is expanded to the
    // sandbox HOME by the layered probe, so match the expanded tail).
    expect(() => compile(yamlPath)).toThrow(/\.copilot\/agents\/reviewer\.agent\.md/);
  });

  it('rejects a copilot pipeline whose persona sits at the .md leaf (copilot opens .agent.md)', () => {
    // A `<name>.md` in `.github/agents/` is not the file the copilot CLI
    // opens, so it must NOT satisfy the check — this is the crux of the
    // cli-aware leaf. Write the wrong leaf and assert compile still fails,
    // naming the `.agent.md` path it actually requires.
    mkdirSync('.github/agents', { recursive: true });
    writeFileSync('.github/agents/reviewer.md', '---\nname: reviewer\n---\nbody\n');
    const yamlPath = setupFixture({
      yaml: `
pipeline: copilot-wrong-leaf
cli: copilot
inputs: [x]
flow:
  - step: reviewer
    input: $x
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(/\.github\/agents\/reviewer\.agent\.md/);
  });

  it('validates a copilot review_loop writer and string reviewer against the .agent.md leaf', () => {
    // The walker collects review_loop writer/reviewer names through a
    // different arm than the plain-step case, so confirm those references
    // also resolve the cli-aware copilot leaf. Both personas sit at
    // `.github/agents/<name>.agent.md`, so compile must succeed.
    const yamlPath = setupFixture({
      agents: ['writer', 'reviewer'],
      cli: 'copilot',
      yaml: `
pipeline: copilot-review-loop
cli: copilot
inputs: [x]
flow:
  - review_loop:
      writer: writer
      reviewer: reviewer
      input: $x
      writer_produces: draft.md
      reviewer_produces: review.json
      verdict_field: status
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
  });

  it('rejects a copilot review_loop whose reviewer persona is missing, naming the .agent.md leaf', () => {
    // Only the writer exists; the reviewer reference must fail the cli-aware
    // probe and name the copilot leaf it requires.
    const yamlPath = setupFixture({
      agents: ['writer'],
      cli: 'copilot',
      yaml: `
pipeline: copilot-review-loop-missing
cli: copilot
inputs: [x]
flow:
  - review_loop:
      writer: writer
      reviewer: reviewer
      input: $x
      writer_produces: draft.md
      reviewer_produces: review.json
      verdict_field: status
`,
    });
    expect(() => compile(yamlPath)).toThrow(
      /references agent 'reviewer'.*\.github\/agents\/reviewer\.agent\.md/s,
    );
  });

  it('resolves a copilot persona present only in the global ~/.copilot/agents layer', () => {
    // The positive copilot cases above seed only the project layer
    // (.github/agents). Seed the persona at the GLOBAL copilot leaf alone to
    // prove the cli-aware `.agent.md` leaf is applied at every probe layer,
    // not just the project dir. HOME is sandboxed to the per-test tmp dir by
    // setupCompileTestEnv, so `~/.copilot/agents/` expands there.
    const globalDir = path.join(homedir(), '.copilot', 'agents');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(path.join(globalDir, 'reviewer.agent.md'), '---\nname: reviewer\n---\nbody\n');
    const yamlPath = setupFixture({
      yaml: `
pipeline: copilot-global-layer
cli: copilot
inputs: [x]
flow:
  - step: reviewer
    input: $x
    produces: out.md
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
  });
});

describe('validatePath (via compile)', () => {
  it('rejects absolute path in produces', () => {
    const yamlPath = setupFixture({
      agents: ['a'],
      yaml: `
pipeline: abs
cli: claude
inputs: [x]
flow:
  - step: a
    input: $x
    produces: /etc/passwd
`,
    });
    expect(() => compile(yamlPath)).toThrow(/absolute path/);
  });

  it('rejects parent-traversal in produces', () => {
    const yamlPath = setupFixture({
      agents: ['a'],
      yaml: `
pipeline: trav
cli: claude
inputs: [x]
flow:
  - step: a
    input: $x
    produces: ../escape.md
`,
    });
    expect(() => compile(yamlPath)).toThrow(/parent-directory traversal/);
  });

  it('accepts a deep but valid relative path', () => {
    const yamlPath = setupFixture({
      agents: ['a'],
      yaml: `
pipeline: deep
cli: claude
inputs: [x]
flow:
  - step: a
    input: $x
    produces: deep/nested/out.md
`,
    });
    expect(() => compile(yamlPath)).not.toThrow();
  });
});

describe('validateReviewerSubflow (via compile)', () => {
  it('rejects empty reviewer subflow', () => {
    const yamlPath = setupFixture({
      agents: ['w'],
      yaml: `
pipeline: empty-sub
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer: w
      input: $x
      writer_produces: out.md
      reviewer: []
`,
    });
    expect(() => compile(yamlPath)).toThrow(/has empty reviewer subflow/);
  });

  it('rejects reviewer subflow whose last item is not aggregate', () => {
    const yamlPath = setupFixture({
      agents: ['w', 'r'],
      yaml: `
pipeline: no-agg
cli: claude
inputs: [x]
flow:
  - review_loop:
      writer: w
      input: $x
      writer_produces: out.md
      reviewer:
        - step: r
          input: $out
          produces: r.json
          bind: r
`,
    });
    expect(() => compile(yamlPath)).toThrow(/reviewer subflow's last item must be 'aggregate'/);
  });
});
