import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { compile } from './index.js';
import { setupCompileTestEnv, setupFixture } from './test-helpers.js';

let teardown: () => void;

beforeEach(() => {
  teardown = setupCompileTestEnv();
});

afterEach(() => {
  teardown();
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
