import { describe, it, expect } from 'vitest';
import {
  StepItem,
  ReviewLoopItem,
  HumanGateItem,
  AggregateItem,
  Pipeline,
  BindName,
  ReviseWith,
  InlineAgent,
  AgentRef,
  isStep,
  isReviewLoop,
  isHumanGate,
  isParallel,
  isBranch,
  isAggregate,
  isForeach,
  isInlineAgent,
  agentLabel,
} from './types.js';
import type { FlowItem } from './types.js';

describe('Pipeline schema', () => {
  const validMinimal = {
    pipeline: 'p',
    cli: 'claude',
    inputs: [],
    flow: [],
  };

  it('accepts a minimal valid pipeline', () => {
    expect(Pipeline.safeParse(validMinimal).success).toBe(true);
  });

  it('accepts cli: claude', () => {
    expect(Pipeline.safeParse({ ...validMinimal, cli: 'claude' }).success).toBe(true);
  });

  it('accepts cli: copilot', () => {
    expect(Pipeline.safeParse({ ...validMinimal, cli: 'copilot' }).success).toBe(true);
  });

  it('rejects cli: codex', () => {
    const result = Pipeline.safeParse({ ...validMinimal, cli: 'codex' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['cli']);
    }
  });

  it('rejects missing cli', () => {
    const { cli, ...withoutCli } = validMinimal;
    expect(Pipeline.safeParse(withoutCli).success).toBe(false);
  });

  it('accepts optional default_extra_args', () => {
    expect(
      Pipeline.safeParse({ ...validMinimal, default_extra_args: ['--model', 'sonnet'] }).success,
    ).toBe(true);
  });

  it('defaults inputs to []', () => {
    const { inputs, ...withoutInputs } = validMinimal;
    const result = Pipeline.parse(withoutInputs);
    expect(result.inputs).toEqual([]);
  });

  // Sanity-check: v4 preserves v3's `.default()` semantics. The v4 upgrade
  // reworked codec internals (defaults now short-circuit when input is
  // undefined, with the default value required to match the OUTPUT type)
  // and this test verifies behavior remained correct for loom's only
  // `.default()` site — `inputs: z.array(BindName).default([])`. Distinct
  // from the spread-based test above by building a literal object without
  // any `inputs:` key, mirroring what pipeline authors actually write.
  it('applies the empty-array default on literal omission', () => {
    const parsed = Pipeline.parse({
      pipeline: 'p',
      cli: 'claude',
      flow: [],
    });
    expect(parsed.inputs).toEqual([]);
  });

  it('rejects hyphenated pipeline input names (BindName regex)', () => {
    const result = Pipeline.safeParse({
      pipeline: 'p',
      cli: 'claude',
      inputs: ['valid', 'bad-name'],
      flow: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid identifier input names', () => {
    const result = Pipeline.safeParse({
      pipeline: 'p',
      cli: 'claude',
      inputs: ['ticket', 'target_branch', 'agg1Result_v2'],
      flow: [],
    });
    expect(result.success).toBe(true);
  });
});

describe('StepItem schema', () => {
  it('accepts minimal step', () => {
    expect(StepItem.safeParse({ step: 'agent-name' }).success).toBe(true);
  });

  it('accepts step with input', () => {
    expect(StepItem.safeParse({ step: 'a', input: '$x' }).success).toBe(true);
  });

  it('accepts step with inputs map', () => {
    expect(StepItem.safeParse({ step: 'a', inputs: { k: '$x' } }).success).toBe(true);
  });

  it('rejects step with BOTH input and inputs', () => {
    const result = StepItem.safeParse({ step: 'a', input: '$x', inputs: { k: '$y' } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/use either `input` or `inputs`/);
    }
  });

  it('accepts optional produces', () => {
    expect(StepItem.safeParse({ step: 'a', produces: 'out.md' }).success).toBe(true);
  });

  it('rejects empty produces string', () => {
    expect(StepItem.safeParse({ step: 'a', produces: '' }).success).toBe(false);
  });

  it('accepts optional extra_args', () => {
    expect(StepItem.safeParse({ step: 'a', extra_args: ['--model', 'haiku'] }).success).toBe(true);
  });

  it('rejects unknown keys (strict mode)', () => {
    expect(StepItem.safeParse({ step: 'a', unknown_key: 'x' }).success).toBe(false);
  });
});

describe('StepItem timeout field', () => {
  it('accepts a positive integer', () => {
    const result = StepItem.safeParse({ step: 'a', timeout: 60000 });
    expect(result.success).toBe(true);
  });

  it('rejects zero', () => {
    const result = StepItem.safeParse({ step: 'a', timeout: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects negative numbers', () => {
    const result = StepItem.safeParse({ step: 'a', timeout: -1000 });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer numbers', () => {
    const result = StepItem.safeParse({ step: 'a', timeout: 1.5 });
    expect(result.success).toBe(false);
  });

  it('rejects string values', () => {
    const result = StepItem.safeParse({ step: 'a', timeout: '30m' });
    expect(result.success).toBe(false);
  });

  it('is optional (step parses without timeout)', () => {
    const result = StepItem.safeParse({ step: 'a' });
    expect(result.success).toBe(true);
  });
});

describe('ReviewLoopItem schema', () => {
  const validSingle = {
    review_loop: {
      writer: 'w',
      reviewer: 'r',
      input: '$x',
      writer_produces: 'out.md',
      reviewer_produces: 'review.json',
      verdict_field: 'status',
    },
  };

  it('accepts a valid single-reviewer review_loop', () => {
    expect(ReviewLoopItem.safeParse(validSingle).success).toBe(true);
  });

  it('rejects single-reviewer form missing reviewer_produces', () => {
    const { reviewer_produces, ...rest } = validSingle.review_loop;
    const result = ReviewLoopItem.safeParse({ review_loop: rest });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(
        /'reviewer_produces' is required when 'reviewer' is a single agent/,
      );
    }
  });

  it('rejects single-reviewer form missing verdict_field', () => {
    const { verdict_field, ...rest } = validSingle.review_loop;
    const result = ReviewLoopItem.safeParse({ review_loop: rest });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(
        /'verdict_field' is required when 'reviewer' is a single agent/,
      );
    }
  });

  it('accepts a compound-reviewer review_loop without reviewer_produces or verdict_field', () => {
    const compound = {
      review_loop: {
        writer: 'w',
        reviewer: [{ aggregate: { inputs: { a: '$a' }, verdict_field: 'status' } }],
        input: '$x',
        writer_produces: 'out.md',
      },
    };
    expect(ReviewLoopItem.safeParse(compound).success).toBe(true);
  });

  it('rejects compound-reviewer form WITH reviewer_produces', () => {
    const compound = {
      review_loop: {
        writer: 'w',
        reviewer: [{ aggregate: { inputs: { a: '$a' }, verdict_field: 'status' } }],
        input: '$x',
        writer_produces: 'out.md',
        reviewer_produces: 'should-not-be-here.json',
      },
    };
    const result = ReviewLoopItem.safeParse(compound);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(
        /'reviewer_produces' must be omitted when 'reviewer' is a subflow/,
      );
    }
  });

  it('rejects compound-reviewer form WITH verdict_field', () => {
    const compound = {
      review_loop: {
        writer: 'w',
        reviewer: [{ aggregate: { inputs: { a: '$a' }, verdict_field: 'status' } }],
        input: '$x',
        writer_produces: 'out.md',
        verdict_field: 'should-not-be-here',
      },
    };
    const result = ReviewLoopItem.safeParse(compound);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(
        /'verdict_field' must be omitted when 'reviewer' is a subflow/,
      );
    }
  });

  it('rejects review_loop missing writer_produces', () => {
    const { writer_produces, ...rest } = validSingle.review_loop;
    expect(ReviewLoopItem.safeParse({ review_loop: rest }).success).toBe(false);
  });

  it('rejects unknown keys (strict mode)', () => {
    expect(
      ReviewLoopItem.safeParse({
        review_loop: { ...validSingle.review_loop, unknown_key: 'x' },
      }).success,
    ).toBe(false);
  });

  it('accepts review_loop with on_max_exceeded: fail', () => {
    const withFail = {
      review_loop: { ...validSingle.review_loop, on_max_exceeded: 'fail' },
    };
    expect(ReviewLoopItem.safeParse(withFail).success).toBe(true);
  });

  it('accepts review_loop with on_max_exceeded: continue', () => {
    const withContinue = {
      review_loop: { ...validSingle.review_loop, on_max_exceeded: 'continue' },
    };
    expect(ReviewLoopItem.safeParse(withContinue).success).toBe(true);
  });

  it('accepts review_loop without on_max_exceeded (default applied at runtime)', () => {
    // Documents the "field is optional" invariant — the default is applied
    // at runtime (opts.onMaxExceeded ?? 'continue'), NOT in the schema.
    expect(ReviewLoopItem.safeParse(validSingle).success).toBe(true);
  });

  it('rejects review_loop with on_max_exceeded: <other-value>', () => {
    const bogus = {
      review_loop: { ...validSingle.review_loop, on_max_exceeded: 'abort' },
    };
    const result = ReviewLoopItem.safeParse(bogus);
    expect(result.success).toBe(false);
    if (!result.success) {
      // Zod's enum error names the allowed values; verify the message
      // surfaces them so the user sees "fail | continue" rather than a
      // generic "invalid input."
      const allIssueMessages = result.error.issues.map((i) => i.message).join('\n');
      expect(allIssueMessages).toMatch(/fail|continue/);
    }
  });

  it('accepts compound review_loop with on_max_exceeded: fail', () => {
    const compound = {
      review_loop: {
        writer: 'w',
        reviewer: [{ aggregate: { inputs: { a: '$a' }, verdict_field: 'status' } }],
        input: '$x',
        writer_produces: 'out.md',
        on_max_exceeded: 'fail',
      },
    };
    expect(ReviewLoopItem.safeParse(compound).success).toBe(true);
  });

  it('accepts compound review_loop with on_max_exceeded: continue', () => {
    const compound = {
      review_loop: {
        writer: 'w',
        reviewer: [{ aggregate: { inputs: { a: '$a' }, verdict_field: 'status' } }],
        input: '$x',
        writer_produces: 'out.md',
        on_max_exceeded: 'continue',
      },
    };
    expect(ReviewLoopItem.safeParse(compound).success).toBe(true);
  });
});

describe('HumanGateItem schema', () => {
  it('accepts plain mode (empty body)', () => {
    expect(HumanGateItem.safeParse({ human_gate: {} }).success).toBe(true);
  });

  it('accepts interactive: true with all three required fields', () => {
    const valid = {
      human_gate: {
        interactive: true,
        agent: 'ac-writer',
        input: '$x',
        prompt: 'iterate',
      },
    };
    expect(HumanGateItem.safeParse(valid).success).toBe(true);
  });

  it('accepts interactive: true with agent omitted (general gate)', () => {
    // A general gate omits `agent:`; the gate's required `prompt:` is the
    // agent's task and it spawns with all tools and no persona.
    const result = HumanGateItem.safeParse({
      human_gate: { interactive: true, input: '$x', prompt: 'iterate' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects interactive: true missing input', () => {
    const result = HumanGateItem.safeParse({
      human_gate: { interactive: true, agent: 'a', prompt: 'iterate' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects interactive: true missing prompt', () => {
    const result = HumanGateItem.safeParse({
      human_gate: { interactive: true, agent: 'a', input: '$x' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty prompt on a general gate (prompt is the entire task)', () => {
    const result = HumanGateItem.safeParse({
      human_gate: { interactive: true, input: '$x', prompt: '' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/must be non-empty/);
    }
  });

  it('rejects an empty prompt on a persona gate', () => {
    const result = HumanGateItem.safeParse({
      human_gate: { interactive: true, agent: 'a', input: '$x', prompt: '' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects interactive: false (literal-true-only)', () => {
    const result = HumanGateItem.safeParse({
      human_gate: { interactive: false },
    });
    expect(result.success).toBe(false);
  });

  it('rejects plain mode WITH agent/input/prompt', () => {
    const result = HumanGateItem.safeParse({
      human_gate: { agent: 'a', input: '$x', prompt: 'p' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/only valid when 'interactive: true'/);
    }
  });

  it('rejects unknown keys (strict mode)', () => {
    expect(
      HumanGateItem.safeParse({
        human_gate: { unknown_key: 'x' },
      }).success,
    ).toBe(false);
  });

  it('accepts interactive: true with extra_args override', () => {
    const valid = {
      human_gate: {
        interactive: true,
        agent: 'ac-writer',
        input: '$x',
        prompt: 'iterate',
        extra_args: ['--model', 'haiku'],
      },
    };
    expect(HumanGateItem.safeParse(valid).success).toBe(true);
  });

  it('accepts a general gate (agent omitted) with an extra_args override', () => {
    // The relaxed first refine makes `agent:` optional. A general gate still
    // carries interactive's required input/prompt and may add a per-gate
    // extra_args override — only the persona name is dropped.
    const valid = {
      human_gate: {
        interactive: true,
        input: '$x',
        prompt: 'iterate',
        extra_args: ['--model', 'haiku'],
      },
    };
    expect(HumanGateItem.safeParse(valid).success).toBe(true);
  });

  it('rejects extra_args in plain mode (without interactive)', () => {
    // extra_args is meaningless without interactive: true — plain y/N
    // mode spawns no child. Loud-fail rather than silently ignoring.
    const result = HumanGateItem.safeParse({
      human_gate: { extra_args: ['--model', 'haiku'] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/only valid when 'interactive: true'/);
    }
  });
});

describe('AggregateItem schema', () => {
  const validAgg = {
    aggregate: {
      inputs: { a: '$a' },
      verdict_field: 'status',
    },
  };

  it('accepts minimal aggregate', () => {
    expect(AggregateItem.safeParse(validAgg).success).toBe(true);
  });

  it('rejects aggregate missing verdict_field', () => {
    const result = AggregateItem.safeParse({
      aggregate: { inputs: { a: '$a' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects aggregate missing inputs', () => {
    expect(
      AggregateItem.safeParse({
        aggregate: { verdict_field: 'status' },
      }).success,
    ).toBe(false);
  });

  it('accepts require: all_approved', () => {
    expect(
      AggregateItem.safeParse({
        aggregate: { ...validAgg.aggregate, require: 'all_approved' },
      }).success,
    ).toBe(true);
  });

  it('rejects unknown require value', () => {
    expect(
      AggregateItem.safeParse({
        aggregate: { ...validAgg.aggregate, require: 'unknown' },
      }).success,
    ).toBe(false);
  });

  it('accepts optional approve_when', () => {
    expect(
      AggregateItem.safeParse({
        aggregate: { ...validAgg.aggregate, approve_when: 'pass' },
      }).success,
    ).toBe(true);
  });

  it('rejects unknown keys (strict mode)', () => {
    expect(
      AggregateItem.safeParse({
        aggregate: { ...validAgg.aggregate, unknown_key: 'x' },
      }).success,
    ).toBe(false);
  });

  it('rejects empty inputs: {}', () => {
    // Mirrors the .min(1) tightening on parallel/branch arrays: an aggregate
    // with zero inputs has no labeled producers to merge, renders the
    // degenerate Mermaid label `aggregate: ` with a trailing space, and emits
    // a no-op aggregate call in the compiled TS. Loud-fail at parse time.
    const result = AggregateItem.safeParse({
      aggregate: { inputs: {}, verdict_field: 'status' },
    });
    expect(result.success).toBe(false);
  });
});

describe('Container array min-length', () => {
  // Empty parallel / branch.then / branch.else arrays are degenerate (no
  // useful semantic — the container connects to nothing) and produce a
  // silently disconnected node in the mermaid view + a no-op block in the
  // compiled TS. Loud-fail at parse time instead. See commit `1099415` for
  // the surfacing context (empty-container schema fix).
  const minimalPipeline = { pipeline: 'p', cli: 'claude', inputs: [], flow: [] };

  it('rejects empty parallel: []', () => {
    const result = Pipeline.safeParse({
      ...minimalPipeline,
      flow: [{ parallel: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty branch.then: []', () => {
    const result = Pipeline.safeParse({
      ...minimalPipeline,
      flow: [{ branch: { when: 'true', then: [] } }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty branch.else: []', () => {
    const result = Pipeline.safeParse({
      ...minimalPipeline,
      flow: [
        {
          branch: {
            when: 'true',
            then: [{ step: 't', input: '', produces: 't.md' }],
            else: [],
          },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('accepts branch with no else key (only then required)', () => {
    const result = Pipeline.safeParse({
      ...minimalPipeline,
      flow: [
        {
          branch: {
            when: 'true',
            then: [{ step: 't', input: '', produces: 't.md' }],
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('BindName regex', () => {
  it('accepts simple identifier', () => {
    expect(BindName.safeParse('spec').success).toBe(true);
  });

  it('accepts underscore-prefixed', () => {
    expect(BindName.safeParse('_internal').success).toBe(true);
  });

  it('accepts mixed case and digits', () => {
    expect(BindName.safeParse('agg1Result_v2').success).toBe(true);
  });

  it('rejects leading digit', () => {
    const result = BindName.safeParse('1spec');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/letters, digits, underscores/);
    }
  });

  it('rejects hyphen', () => {
    expect(BindName.safeParse('spec-writer').success).toBe(false);
  });

  it('rejects whitespace', () => {
    expect(BindName.safeParse('spec writer').success).toBe(false);
  });

  it('rejects empty string', () => {
    expect(BindName.safeParse('').success).toBe(false);
  });

  it('rejects code-injection attempt', () => {
    expect(BindName.safeParse("'); maliciousCode(); //").success).toBe(false);
  });
});

describe('Existing bind fields use BindName regex', () => {
  it('StepItem rejects hyphen in bind', () => {
    const result = StepItem.safeParse({ step: 'foo', bind: 'bad-name' });
    expect(result.success).toBe(false);
  });

  it('ReviewLoopItem rejects hyphen in bind', () => {
    const result = ReviewLoopItem.safeParse({
      review_loop: {
        writer: 'w',
        reviewer: 'r',
        input: '$x',
        writer_produces: 'out.md',
        reviewer_produces: 'rev.json',
        verdict_field: 'status',
        bind: 'bad-name',
      },
    });
    expect(result.success).toBe(false);
  });

  it('AggregateItem rejects hyphen in bind', () => {
    const result = AggregateItem.safeParse({
      aggregate: {
        inputs: { a: '$a' },
        verdict_field: 'status',
        bind: 'bad-name',
      },
    });
    expect(result.success).toBe(false);
  });

  it('StepItem accepts valid bind', () => {
    expect(StepItem.safeParse({ step: 'foo', bind: 'good_name1' }).success).toBe(true);
  });
});

describe('OnFail schema', () => {
  const validStep = {
    step: 'reviewer',
    produces: 'review.json',
    bind: 'review',
  };
  const validOnFail = {
    verdict_field: 'status',
    retry_from: 'tests',
    revise_with: { prompt: 'Retry the step.' },
  };

  it('accepts minimal on_fail (with defaults applied at runtime)', () => {
    const result = StepItem.safeParse({ ...validStep, on_fail: validOnFail });
    expect(result.success).toBe(true);
  });

  it('accepts on_fail with all fields', () => {
    const result = StepItem.safeParse({
      ...validStep,
      on_fail: {
        verdict_field: 'status',
        approve_when: 'pass',
        retry_from: 'tests',
        max_retries: 3,
        on_max_exceeded: 'continue',
        revise_with: { prompt: 'Address feedback.', inputs: ['$x'] },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects on_fail without verdict_field', () => {
    const result = StepItem.safeParse({
      ...validStep,
      on_fail: { retry_from: 'tests', revise_with: { prompt: 'X' } },
    });
    expect(result.success).toBe(false);
    // Assert specifically the missing verdict_field — without revise_with
    // in the YAML, the prior shape would also fail revise_with-required
    // and we wouldn't know which refine caught it.
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('verdict_field'))).toBe(true);
    }
  });

  it('rejects on_fail without retry_from', () => {
    const result = StepItem.safeParse({
      ...validStep,
      on_fail: { verdict_field: 'status', revise_with: { prompt: 'X' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('retry_from'))).toBe(true);
    }
  });

  it('rejects on_fail without revise_with (revise_with is unconditionally required)', () => {
    const result = StepItem.safeParse({
      ...validStep,
      on_fail: { verdict_field: 'status', retry_from: 'tests' },
    });
    expect(result.success).toBe(false);
    // Zod's "Required" message doesn't name the field — the field name lives
    // in issue.path. Assert via path so the test pins the specific refine
    // (rather than incidentally matching any text containing "revise_with").
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('revise_with'))).toBe(true);
    }
  });

  it('accepts on_fail with revise_with (prompt-only)', () => {
    const result = StepItem.safeParse({
      ...validStep,
      on_fail: {
        verdict_field: 'status',
        retry_from: 'tests',
        revise_with: { prompt: 'Retry the step.' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts on_fail with revise_with (inputs-only)', () => {
    const result = StepItem.safeParse({
      ...validStep,
      on_fail: {
        verdict_field: 'status',
        retry_from: 'tests',
        revise_with: { inputs: ['$ref-a'] },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects max_retries: 0', () => {
    const result = StepItem.safeParse({
      ...validStep,
      on_fail: { ...validOnFail, max_retries: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects max_retries: 11 (above cap)', () => {
    const result = StepItem.safeParse({
      ...validStep,
      on_fail: { ...validOnFail, max_retries: 11 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects on_max_exceeded: loud-fail (no longer valid)', () => {
    const result = StepItem.safeParse({
      ...validStep,
      on_fail: { ...validOnFail, on_max_exceeded: 'loud-fail' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects on_fail with typo (strict mode)', () => {
    const result = StepItem.safeParse({
      ...validStep,
      on_fail: { ...validOnFail, maxRetries: 3 }, // camelCase typo
    });
    expect(result.success).toBe(false);
  });

  it('rejects retry_from with hyphen (BindName regex)', () => {
    const result = StepItem.safeParse({
      ...validStep,
      on_fail: { verdict_field: 'status', retry_from: 'bad-name', revise_with: { prompt: 'X' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects step with on_fail but no produces', () => {
    const result = StepItem.safeParse({
      step: 'reviewer',
      bind: 'review',
      on_fail: validOnFail,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/on_fail.*produces/i);
    }
  });
});

describe('ReviseWith schema', () => {
  it('accepts revise_with with prompt only', () => {
    expect(ReviseWith.safeParse({ prompt: 'Retry the step.' }).success).toBe(true);
  });

  it('accepts revise_with with inputs only', () => {
    expect(ReviseWith.safeParse({ inputs: ['$ref-a', '$ref-b'] }).success).toBe(true);
  });

  it('accepts revise_with with both prompt and inputs', () => {
    expect(ReviseWith.safeParse({ prompt: 'Address findings.', inputs: ['$ref-a'] }).success).toBe(
      true,
    );
  });

  it('rejects empty revise_with: {} with the at-least-one message', () => {
    const result = ReviseWith.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message).join('\n')).toMatch(
        /at least one of 'prompt'.*or 'inputs'/,
      );
    }
  });

  it('rejects revise_with with empty prompt string', () => {
    const result = ReviseWith.safeParse({ prompt: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Tighten: assert the specific too_small / min(1) Zod issue path so
      // we know the .min(1) refine fired (and not, e.g., the at-least-one
      // refine kicking in despite prompt being present-but-empty).
      const promptIssues = result.error.issues.filter(
        (i) => i.path.length > 0 && i.path[0] === 'prompt',
      );
      expect(promptIssues.length).toBeGreaterThan(0);
      expect(promptIssues[0].code).toBe('too_small');
    }
  });

  it('rejects revise_with with empty inputs array (structurally equivalent to neither set)', () => {
    const result = ReviseWith.safeParse({ inputs: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message).join('\n')).toMatch(
        /at least one of 'prompt'.*or 'inputs'/,
      );
    }
  });

  it('rejects revise_with with unknown key (strict)', () => {
    const result = ReviseWith.safeParse({ prompt: 'X', extra_field: 'nope' });
    expect(result.success).toBe(false);
  });

  it('rejects revise_with.inputs entry without $ prefix', () => {
    // The JSDoc promises $-prefixed bind refs; the schema enforces that
    // promise so a typo (`'review'` instead of `'$review'`) is caught at
    // parse time rather than producing a silent literal-string consume site
    // that compile would never validate as a bind ref.
    const result = ReviseWith.safeParse({ inputs: ['raw-name'] });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === 'inputs' && i.path[1] === 0);
      expect(issue).toBeDefined();
      // v4 unified regex/format violations under the 'invalid_format' code
      // (v3 used the broader 'invalid_string'). The behavior — rejection of
      // a non-`$`-prefixed entry — is unchanged; only the issue code label
      // changed shape.
      expect(issue!.code).toBe('invalid_format');
    }
  });
});

describe('AggregateItem retry-gate refines', () => {
  const validAggBase = {
    inputs: { a: '$x' },
    verdict_field: 'status',
  };

  it('accepts aggregate with no retry fields (existing behavior preserved)', () => {
    const result = AggregateItem.safeParse({ aggregate: { ...validAggBase } });
    expect(result.success).toBe(true);
  });

  it('accepts aggregate with full retry-gate config', () => {
    const result = AggregateItem.safeParse({
      aggregate: {
        ...validAggBase,
        retry_from: 'tests',
        max_retries: 3,
        on_max_exceeded: 'fail',
        revise_with: { prompt: 'Address feedback.' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects max_retries without retry_from', () => {
    const result = AggregateItem.safeParse({
      aggregate: { ...validAggBase, max_retries: 3 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/max_retries.*requires.*retry_from/);
    }
  });

  it('rejects on_max_exceeded without retry_from', () => {
    const result = AggregateItem.safeParse({
      aggregate: { ...validAggBase, on_max_exceeded: 'continue' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/on_max_exceeded.*requires.*retry_from/);
    }
  });

  it('rejects revise_with without retry_from', () => {
    const result = AggregateItem.safeParse({
      aggregate: { ...validAggBase, revise_with: { prompt: 'X' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/revise_with.*requires.*retry_from/);
    }
  });

  it('rejects retry_from without revise_with', () => {
    const result = AggregateItem.safeParse({
      aggregate: { ...validAggBase, retry_from: 'tests' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/retry_from.*requires.*revise_with/);
    }
  });
});

describe('branch: with bind inside the branch object', () => {
  it('accepts branch without bind (existing behavior)', () => {
    const result = Pipeline.safeParse({
      pipeline: 'p',
      cli: 'claude',
      inputs: [],
      flow: [
        {
          branch: { when: '$x', then: [{ step: 'a' }] },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts branch with inside-object bind', () => {
    const result = Pipeline.safeParse({
      pipeline: 'p',
      cli: 'claude',
      inputs: [],
      flow: [
        {
          branch: { when: '$x', then: [{ step: 'a' }], bind: 'arm' },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects branch with hyphenated bind', () => {
    const result = Pipeline.safeParse({
      pipeline: 'p',
      cli: 'claude',
      inputs: [],
      flow: [
        {
          branch: { when: '$x', then: [{ step: 'a' }], bind: 'bad-name' },
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('parallel: with bind at FlowItem level', () => {
  it('accepts parallel without bind (existing behavior)', () => {
    const result = Pipeline.safeParse({
      pipeline: 'p',
      cli: 'claude',
      inputs: [],
      flow: [{ parallel: [{ step: 'a' }, { step: 'b' }] }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts parallel with FlowItem-level bind', () => {
    const result = Pipeline.safeParse({
      pipeline: 'p',
      cli: 'claude',
      inputs: [],
      flow: [
        {
          parallel: [{ step: 'a' }, { step: 'b' }],
          bind: 'reviewers',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects parallel with hyphenated bind (BindName regex)', () => {
    const result = Pipeline.safeParse({
      pipeline: 'p',
      cli: 'claude',
      inputs: [],
      flow: [
        {
          parallel: [{ step: 'a' }],
          bind: 'bad-name',
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('foreach: schema', () => {
  const minimalForeach = {
    foreach: {
      over: '$plan',
      as: 'task',
      body: [{ step: 'worker', input: '$task', produces: 'out.md' }],
    },
  };

  it('accepts minimal foreach (over + as + body)', () => {
    const result = Pipeline.safeParse({
      pipeline: 'p',
      cli: 'claude',
      inputs: ['plan'],
      flow: [minimalForeach],
    });
    expect(result.success).toBe(true);
  });

  it('accepts foreach with bind + on_iteration_fail', () => {
    const result = Pipeline.safeParse({
      pipeline: 'p',
      cli: 'claude',
      inputs: ['plan'],
      flow: [
        {
          foreach: {
            over: '$plan',
            as: 'task',
            body: [{ step: 'worker', input: '$task', produces: 'out.md' }],
            bind: 'results',
            on_iteration_fail: 'continue',
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects foreach with empty body', () => {
    const result = Pipeline.safeParse({
      pipeline: 'p',
      cli: 'claude',
      inputs: ['plan'],
      flow: [{ foreach: { over: '$plan', as: 'task', body: [] } }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects foreach missing over', () => {
    const result = Pipeline.safeParse({
      pipeline: 'p',
      cli: 'claude',
      inputs: ['plan'],
      flow: [
        {
          foreach: {
            as: 'task',
            body: [{ step: 'worker', input: '$task', produces: 'out.md' }],
          },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects foreach missing as', () => {
    const result = Pipeline.safeParse({
      pipeline: 'p',
      cli: 'claude',
      inputs: ['plan'],
      flow: [
        {
          foreach: {
            over: '$plan',
            body: [{ step: 'worker', input: '$task', produces: 'out.md' }],
          },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects foreach with invalid on_iteration_fail value', () => {
    const result = Pipeline.safeParse({
      pipeline: 'p',
      cli: 'claude',
      inputs: ['plan'],
      flow: [
        {
          foreach: {
            over: '$plan',
            as: 'task',
            body: [{ step: 'worker', input: '$task', produces: 'out.md' }],
            on_iteration_fail: 'maybe',
          },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects foreach with hyphenated bind (BindName regex)', () => {
    const result = Pipeline.safeParse({
      pipeline: 'p',
      cli: 'claude',
      inputs: ['plan'],
      flow: [
        {
          foreach: {
            over: '$plan',
            as: 'task',
            body: [{ step: 'worker', input: '$task', produces: 'out.md' }],
            bind: 'bad-name',
          },
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('Pipeline schema — agents_path: rejection', () => {
  it('rejects legacy agents_path: with Unrecognized key error', () => {
    const result = Pipeline.safeParse({
      pipeline: 'p',
      cli: 'claude',
      agents_path: '.claude/agents/',
      inputs: [],
      flow: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      // v4's strict-object unrecognized-key message is `Unrecognized key:
      // "agents_path"` (singular, double-quoted); v3 emitted the more verbose
      // `Unrecognized key(s) in object: 'agents_path'`. The behavior — strict
      // rejection of the legacy key — is unchanged; only the surface wording
      // tightened. Match either form so the test pinpoints the rejected key
      // without coupling to a specific zod version's message template.
      expect(messages).toMatch(/Unrecognized key.*agents_path/);
    }
  });
});

// ============================================================================
// FlowItem variant types — bidirectional drift detection
// ============================================================================
//
// Drift detection lives in `src/types.driftcheck.ts` (a non-test `.ts` file),
// NOT here. Why: vitest doesn't type-check `*.test.ts` files by default, and
// the standard `tsconfig.json` EXCLUDES `*.test.ts` from the `tsc` build —
// so any `Expect<Equal<...>>` assertion living in this file would be inert
// under both `npm test` and `npm run build`. Moving the assertions to a
// regular `.ts` source file makes them load-bearing under `npm run build`
// (which CI already runs on every PR), closing the safety-net loop.
//
// To exercise the drift check: `npm run build`. To verify the assertions
// actually fire, see the verification recipe at the top of
// `src/types.driftcheck.ts`.

// ============================================================================
// FlowItem type guards — runtime correctness
// ============================================================================
//
// Three cases per guard: a positive match (returns true for its target
// variant), a negative match (returns false for another variant), and an
// adversarial empty-object case (returns false for `{}`, which has no
// discriminator at all — locks in safe-default behavior for malformed input
// that bypassed Zod parsing). The well-formed fixtures are annotated as
// `FlowItem` so they exercise the guards through their declared input type;
// the empty-object case uses an explicit `unknown` cast to bypass TS
// narrowing, mirroring the "test the contract for adversarial input" stance.
// Where a positive fixture requires the full nested shape (e.g.
// ReviewLoopItem's writer/reviewer/etc.) it's spelled out; bind-only or
// missing-field fixtures are kept minimal.

describe('FlowItem type guards — isStep', () => {
  it('returns true for { step: ... }', () => {
    const item: FlowItem = { step: 'a' };
    expect(isStep(item)).toBe(true);
  });

  it('returns false for other variants', () => {
    const item: FlowItem = { human_gate: {} };
    expect(isStep(item)).toBe(false);
  });

  it('returns false for an empty object (no discriminator)', () => {
    expect(isStep({} as unknown as FlowItem)).toBe(false);
  });
});

describe('FlowItem type guards — isReviewLoop', () => {
  it('returns true for { review_loop: ... }', () => {
    const item: FlowItem = {
      review_loop: {
        writer: 'w',
        reviewer: 'r',
        input: '$x',
        writer_produces: 'out.md',
        reviewer_produces: 'rev.json',
        verdict_field: 'status',
      },
    };
    expect(isReviewLoop(item)).toBe(true);
  });

  it('returns false for other variants', () => {
    const item: FlowItem = { step: 'a' };
    expect(isReviewLoop(item)).toBe(false);
  });

  it('returns false for an empty object (no discriminator)', () => {
    expect(isReviewLoop({} as unknown as FlowItem)).toBe(false);
  });
});

describe('FlowItem type guards — isHumanGate', () => {
  it('returns true for { human_gate: ... }', () => {
    const item: FlowItem = { human_gate: {} };
    expect(isHumanGate(item)).toBe(true);
  });

  it('returns false for other variants', () => {
    const item: FlowItem = { step: 'a' };
    expect(isHumanGate(item)).toBe(false);
  });

  it('returns false for an empty object (no discriminator)', () => {
    expect(isHumanGate({} as unknown as FlowItem)).toBe(false);
  });
});

describe('FlowItem type guards — isParallel', () => {
  it('returns true for { parallel: ... }', () => {
    const item: FlowItem = { parallel: [{ step: 'a' }] };
    expect(isParallel(item)).toBe(true);
  });

  it('returns false for other variants', () => {
    const item: FlowItem = { step: 'a' };
    expect(isParallel(item)).toBe(false);
  });

  it('returns false for an empty object (no discriminator)', () => {
    expect(isParallel({} as unknown as FlowItem)).toBe(false);
  });
});

describe('FlowItem type guards — isBranch', () => {
  it('returns true for { branch: ... }', () => {
    const item: FlowItem = { branch: { when: 'true', then: [{ step: 'a' }] } };
    expect(isBranch(item)).toBe(true);
  });

  it('returns false for other variants', () => {
    const item: FlowItem = { step: 'a' };
    expect(isBranch(item)).toBe(false);
  });

  it('returns false for an empty object (no discriminator)', () => {
    expect(isBranch({} as unknown as FlowItem)).toBe(false);
  });
});

describe('FlowItem type guards — isAggregate', () => {
  it('returns true for { aggregate: ... }', () => {
    const item: FlowItem = {
      aggregate: { inputs: { x: '$a' }, verdict_field: 'status' },
    };
    expect(isAggregate(item)).toBe(true);
  });

  it('returns false for other variants', () => {
    const item: FlowItem = { step: 'a' };
    expect(isAggregate(item)).toBe(false);
  });

  it('returns false for an empty object (no discriminator)', () => {
    expect(isAggregate({} as unknown as FlowItem)).toBe(false);
  });
});

describe('FlowItem type guards — isForeach', () => {
  it('returns true for { foreach: ... }', () => {
    const item: FlowItem = {
      foreach: { over: '$plan', as: 'task', body: [{ step: 'worker' }] },
    };
    expect(isForeach(item)).toBe(true);
  });

  it('returns false for other variants', () => {
    const item: FlowItem = { step: 'a' };
    expect(isForeach(item)).toBe(false);
  });

  it('returns false for an empty object (no discriminator)', () => {
    expect(isForeach({} as unknown as FlowItem)).toBe(false);
  });
});

// ============================================================================
// FlowItem discriminator uniqueness
// ============================================================================
//
// Each variant's discriminator key MUST be present on its own variant and
// absent from every other variant. This is the invariant the type-guards
// rely on: `'step' in item` only narrows safely when no other variant can
// ever have a `step` field (even optional). Tested at runtime via the
// fixture map below — if any future schema change adds (e.g.) an optional
// `step:` to ReviewLoopItem, this test fails before the bug ships.

describe('FlowItem variant discriminators are unique', () => {
  // One example per variant. The fixtures here include all fields each
  // variant requires (so they could be parsed by Zod if wrapped in a
  // pipeline), but this test treats them as plain objects — the assertion
  // is purely structural: each variant's discriminator key appears on its
  // own fixture and on no other variant's fixture.
  const variants: Record<string, FlowItem> = {
    step: { step: 'a' },
    review_loop: {
      review_loop: {
        writer: 'w',
        reviewer: 'r',
        input: '$x',
        writer_produces: 'out.md',
        reviewer_produces: 'rev.json',
        verdict_field: 'status',
      },
    },
    human_gate: { human_gate: {} },
    aggregate: { aggregate: { inputs: { x: '$a' }, verdict_field: 'status' } },
    parallel: { parallel: [{ step: 'a' }] },
    branch: { branch: { when: 'true', then: [{ step: 'a' }] } },
    foreach: { foreach: { over: '$plan', as: 'task', body: [{ step: 'a' }] } },
  };
  const allDiscriminators = Object.keys(variants);

  for (const [variantKey, exampleValue] of Object.entries(variants)) {
    it(`'${variantKey}' is present on the ${variantKey} variant and absent from all others`, () => {
      expect(variantKey in exampleValue).toBe(true);
      for (const otherKey of allDiscriminators) {
        if (otherKey === variantKey) continue;
        expect(otherKey in exampleValue).toBe(false);
      }
    });
  }
});

// ============================================================================
// Inline-agent grammar — InlineAgent / AgentRef schemas + read helpers
// ============================================================================
//
// An agent reference is either a bare persona-name string (the CLI loads its
// agent file) or an inline-agent object. The object form is the discriminator
// that lets a later compile pass reject a task-less inline agent. These blocks
// pin the schema's accept/reject surface and the two pure read helpers
// (isInlineAgent / agentLabel) that every later compile + mermaid site resolves
// the union through.

describe('InlineAgent schema', () => {
  it('accepts an inline agent with prompt and a valid name', () => {
    // The name regex is broader than BindName: a digit may lead, and '.' / '-'
    // are allowed in non-leading positions (an fs-safe identity for logs /
    // windows / mermaid nodes).
    expect(InlineAgent.safeParse({ prompt: 'p', name: 'code-reviewer.v2' }).success).toBe(true);
  });

  it('rejects an inline agent missing name', () => {
    expect(InlineAgent.safeParse({ prompt: 'do the thing' }).success).toBe(false);
  });

  it('rejects an inline agent missing prompt', () => {
    expect(InlineAgent.safeParse({ name: 'x' }).success).toBe(false);
  });

  it('rejects an inline agent with an empty prompt string', () => {
    expect(InlineAgent.safeParse({ prompt: '', name: 'x' }).success).toBe(false);
  });

  it('rejects a name with a leading underscore', () => {
    // Diverges from BindName (which permits a leading underscore): the label
    // regex requires an alphanumeric first character.
    expect(InlineAgent.safeParse({ prompt: 'p', name: '_internal' }).success).toBe(false);
  });

  it('rejects a name containing whitespace', () => {
    expect(InlineAgent.safeParse({ prompt: 'p', name: 'has space' }).success).toBe(false);
  });

  it('rejects an empty name string', () => {
    expect(InlineAgent.safeParse({ prompt: 'p', name: '' }).success).toBe(false);
  });

  it('rejects unknown keys (strict mode)', () => {
    expect(InlineAgent.safeParse({ prompt: 'p', name: 'n', unknown_key: 'x' }).success).toBe(false);
  });
});

describe('AgentRef schema', () => {
  it('accepts a bare persona-name string', () => {
    expect(AgentRef.safeParse('code-reviewer').success).toBe(true);
  });

  it('accepts an inline-agent object', () => {
    expect(AgentRef.safeParse({ prompt: 'do the thing', name: 'doer' }).success).toBe(true);
  });

  it('rejects an object that satisfies neither arm (missing prompt)', () => {
    // The object arm is InlineAgent, not "any object": a prompt-less object
    // fails the string arm and the InlineAgent arm both.
    expect(AgentRef.safeParse({ name: 'x' }).success).toBe(false);
  });
});

describe('AgentRef read helpers — isInlineAgent', () => {
  it('returns false for a persona-name string', () => {
    expect(isInlineAgent('code-reviewer')).toBe(false);
  });

  it('returns true for an inline-agent object', () => {
    expect(isInlineAgent({ prompt: 'p', name: 'n' })).toBe(true);
  });
});

describe('AgentRef read helpers — agentLabel', () => {
  it('returns the persona name itself for a string ref', () => {
    expect(agentLabel('persona')).toBe('persona');
  });

  it('returns the required name for an inline agent', () => {
    expect(agentLabel({ prompt: 'p', name: 'n' })).toBe('n');
  });
});

// ============================================================================
// StepItem.step retype — AgentRef accepted end-to-end through StepItem
// ============================================================================
//
// `StepItem.step` is now an `AgentRef` (persona-name string OR inline-agent
// object), not a bare `z.string()`. The InlineAgent/AgentRef blocks above pin
// the union in isolation; these pin the union THROUGH `StepItem`, which is the
// surface a pipeline author actually parses. The inline-object accept/reject
// cases are the load-bearing ones — before the retype, `step: { prompt: ... }`
// failed StepItem's `z.string()` arm outright.

describe('StepItem.step accepts the AgentRef union', () => {
  it('still accepts a persona-name string step after the retype', () => {
    // Parity arm: the string branch of AgentRef must keep parsing exactly as
    // the old `z.string()` did, so all-persona pipelines are unaffected.
    expect(StepItem.safeParse({ step: 'code-reviewer' }).success).toBe(true);
  });

  it('accepts an inline-agent object step (prompt + name)', () => {
    expect(
      StepItem.safeParse({ step: { prompt: 'Review the diff.', name: 'reviewer' } }).success,
    ).toBe(true);
  });

  it('rejects an inline-agent object step missing name', () => {
    // `name` is required on inline agents — it is the agent's identity in
    // logs, window titles, error messages, and mermaid nodes.
    expect(StepItem.safeParse({ step: { prompt: 'Review the diff.' } }).success).toBe(false);
  });

  it('rejects an inline-agent object step with no prompt', () => {
    // The object arm is InlineAgent, which requires `prompt`. A prompt-less
    // object satisfies neither the string arm nor the InlineAgent arm.
    expect(StepItem.safeParse({ step: { name: 'reviewer' } }).success).toBe(false);
  });

  it('rejects an inline-agent object step with an empty prompt', () => {
    expect(StepItem.safeParse({ step: { prompt: '', name: 'reviewer' } }).success).toBe(false);
  });

  it('rejects an inline-agent object step with an unknown key (InlineAgent is strict)', () => {
    // The strictObject inside the union still rejects unknown keys when the
    // step is the inline form — the retype widened the field, not its rigor.
    expect(StepItem.safeParse({ step: { prompt: 'p', name: 'n', persona: 'x' } }).success).toBe(
      false,
    );
  });

  it('preserves the inline object on parse alongside the other step fields', () => {
    // Downstream emit reads `item.step` as the object (isInlineAgent / the
    // baked prompt), so the union must survive the parse without collapsing
    // the inline form to a string. Co-occurring produces/bind must not disturb
    // it.
    const parsed = StepItem.parse({
      step: { prompt: 'Produce the artifact.', name: 'producer' },
      produces: 'out.json',
      bind: 'r',
    });
    expect(parsed.step).toEqual({ prompt: 'Produce the artifact.', name: 'producer' });
  });
});

// ============================================================================
// review_loop.writer / reviewer retype — AgentRef accepted through ReviewLoopItem
// ============================================================================
//
// `review_loop.writer` is now an `AgentRef` (persona-name string OR inline-agent
// object), and `reviewer` is a three-arm union (string / inline-agent object /
// subflow array). The single-reviewer refines (reviewer_produces + verdict_field
// required) fire for an inline-object reviewer exactly as they do for a string
// reviewer — only the subflow array arm is exempt. The InlineAgent/AgentRef
// blocks above pin the union in isolation; these pin it THROUGH ReviewLoopItem,
// the surface a pipeline author parses. Before the retype, `writer: { prompt }`
// failed the bare `z.string()` and an inline-object `reviewer:` matched no arm.

describe('review_loop.writer accepts the AgentRef union', () => {
  const base = {
    reviewer: 'r',
    input: '$x',
    writer_produces: 'out.md',
    reviewer_produces: 'review.json',
    verdict_field: 'status',
  };

  it('still accepts a persona-name string writer after the retype', () => {
    // Parity arm: the string branch must keep parsing exactly as the old
    // `z.string()` did, so all-persona review loops are unaffected.
    expect(ReviewLoopItem.safeParse({ review_loop: { ...base, writer: 'w' } }).success).toBe(true);
  });

  it('accepts an inline-agent object writer (prompt + name)', () => {
    expect(
      ReviewLoopItem.safeParse({
        review_loop: { ...base, writer: { prompt: 'Draft the spec.', name: 'drafter' } },
      }).success,
    ).toBe(true);
  });

  it('rejects an inline-agent object writer missing name', () => {
    // `name` is required on inline agents — it is the agent's identity in
    // logs, window titles, error messages, and mermaid nodes.
    expect(
      ReviewLoopItem.safeParse({
        review_loop: { ...base, writer: { prompt: 'Draft the spec.' } },
      }).success,
    ).toBe(false);
  });

  it('rejects an inline-agent object writer with no prompt', () => {
    // The object arm is InlineAgent, which requires `prompt`. A name-only
    // object satisfies neither the string arm nor the InlineAgent arm — the
    // union widened to admit inline agents, not arbitrary objects.
    expect(
      ReviewLoopItem.safeParse({
        review_loop: { ...base, writer: { name: 'drafter' } },
      }).success,
    ).toBe(false);
  });

  it('rejects an inline-agent object writer with an empty prompt', () => {
    expect(
      ReviewLoopItem.safeParse({
        review_loop: { ...base, writer: { prompt: '', name: 'drafter' } },
      }).success,
    ).toBe(false);
  });

  it('preserves the inline writer object on parse alongside the other fields', () => {
    // Downstream emit reads `r.writer` as the object (isInlineAgent / the baked
    // prompt), so the union must survive the parse without collapsing to a string.
    const parsed = ReviewLoopItem.parse({
      review_loop: { ...base, writer: { prompt: 'Draft the spec.', name: 'drafter' } },
    });
    expect(parsed.review_loop.writer).toEqual({ prompt: 'Draft the spec.', name: 'drafter' });
  });
});

describe('review_loop.reviewer accepts the inline-agent arm', () => {
  const base = {
    writer: 'w',
    input: '$x',
    writer_produces: 'out.md',
    reviewer_produces: 'review.json',
    verdict_field: 'status',
  };

  it('still accepts a persona-name string reviewer after the retype', () => {
    expect(ReviewLoopItem.safeParse({ review_loop: { ...base, reviewer: 'r' } }).success).toBe(
      true,
    );
  });

  it('accepts an inline-agent object reviewer with reviewer_produces + verdict_field', () => {
    expect(
      ReviewLoopItem.safeParse({
        review_loop: { ...base, reviewer: { prompt: 'Audit the draft.', name: 'auditor' } },
      }).success,
    ).toBe(true);
  });

  it('rejects an inline-agent object reviewer missing name', () => {
    // `name` is required on inline agents — it is the agent's identity in
    // logs, window titles, error messages, and mermaid nodes.
    expect(
      ReviewLoopItem.safeParse({
        review_loop: { ...base, reviewer: { prompt: 'Audit the draft.' } },
      }).success,
    ).toBe(false);
  });

  it('accepts a subflow-array reviewer (third arm, unchanged)', () => {
    // Parity arm: the array branch is still the subflow form and still parses
    // without reviewer_produces / verdict_field.
    expect(
      ReviewLoopItem.safeParse({
        review_loop: {
          writer: 'w',
          reviewer: [{ aggregate: { inputs: { a: '$a' }, verdict_field: 'status' } }],
          input: '$x',
          writer_produces: 'out.md',
        },
      }).success,
    ).toBe(true);
  });

  it('rejects an inline reviewer missing reviewer_produces (single-agent rule applies to inline)', () => {
    // An inline-object reviewer follows the STRING-reviewer rules, not the
    // subflow rules: the refine discriminates on Array.isArray(reviewer) (false
    // for an inline object), so reviewer_produces is required just as for a
    // persona-name reviewer.
    const { reviewer_produces, ...rest } = base;
    const result = ReviewLoopItem.safeParse({
      review_loop: { ...rest, reviewer: { prompt: 'Audit the draft.', name: 'auditor' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(
        /'reviewer_produces' is required when 'reviewer' is a single agent/,
      );
    }
  });

  it('rejects an inline reviewer missing verdict_field (single-agent rule applies to inline)', () => {
    const { verdict_field, ...rest } = base;
    const result = ReviewLoopItem.safeParse({
      review_loop: { ...rest, reviewer: { prompt: 'Audit the draft.', name: 'auditor' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(
        /'verdict_field' is required when 'reviewer' is a single agent/,
      );
    }
  });

  it('preserves the inline reviewer object on parse', () => {
    const parsed = ReviewLoopItem.parse({
      review_loop: { ...base, reviewer: { prompt: 'Audit the draft.', name: 'auditor' } },
    });
    expect(parsed.review_loop.reviewer).toEqual({ prompt: 'Audit the draft.', name: 'auditor' });
  });
});
