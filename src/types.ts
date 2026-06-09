import { z } from 'zod/v4';

/** $name = bound variable reference; otherwise literal string */
export const ValueExpr = z.string();

/** Bind name: must be a safe TypeScript identifier so emit can produce
 *  `const ${bindName} = ...` without codegen injection from malformed
 *  YAML. Letters/digits/underscores, cannot start with a digit. */
export const BindName = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, {
  error:
    'bind: must match /^[a-zA-Z_][a-zA-Z0-9_]*$/ (letters, digits, underscores; cannot start with a digit)',
});

/** Empty `{}` is rejected to eliminate silent retry-with-no-revise. */
export const ReviseWith = z
  .strictObject({
    prompt: z.string().min(1).optional(),
    inputs: z
      .array(
        z.string().min(1).regex(/^\$/, {
          error: "revise_with.inputs entries must be $-prefixed bind refs (e.g. '$review')",
        }),
      )
      .optional(),
  })
  .refine((v) => v.prompt !== undefined || (v.inputs !== undefined && v.inputs.length > 0), {
    error:
      "revise_with: at least one of 'prompt' (non-empty string) or 'inputs' (non-empty array) must be set",
  });

/** Shared retry-mechanism fields; each host re-states retry_from optionality. */
// Hosts spreading this fragment must also re-declare the host-specific
// conditional refines (e.g. AggregateItem's four refines); the fragment
// shares fields only, not invariants.
const RetryMechanism = z.strictObject({
  retry_from: BindName.optional(),
  max_retries: z.number().int().min(1).max(10).optional(),
  on_max_exceeded: z.enum(['fail', 'continue']).optional(),
  revise_with: ReviseWith.optional(),
});

/** Retry-from-bind configuration. When `on_fail` is set on a step, that step
 *  becomes the gate of a retry zone — its `produces:` JSON is read after
 *  invocation, `verdict_field` is checked against `approve_when` (default
 *  `'pass'`), and on mismatch the zone re-runs starting from the step
 *  identified by `retry_from`'s bind, up to `max_retries` times. After
 *  exhaustion: `on_max_exceeded: 'fail'` (default) throws; `'continue'`
 *  warns and continues with the last attempt's produces.
 *
 *  `z.strictObject()` so typos (e.g. `maxRetries:` camelCase) fail the schema
 *  rather than silently fall back to defaults. `max_retries.max(10)` is a defensive
 *  ceiling against runaway cost in nested retry zones — raise it if a real
 *  pipeline needs more. */
export const OnFail = z.strictObject({
  ...RetryMechanism.shape,
  verdict_field: z.string().min(1),
  approve_when: z.string().min(1).optional(),
  // retry_from is required on OnFail — the wrapper itself is the opt-in signal "this step is a gate".
  retry_from: BindName,
  revise_with: ReviseWith,
});

/** A general (inline) agent: no persona file, all tools. `prompt` is the agent's
 *  task — required and static (no `$ref` interpolation; data flows via `input:` /
 *  `inputs:`). `name` is required — the agent's identity in logs, window titles,
 *  error messages, and mermaid nodes. The object form (vs a bare persona-name
 *  string) is the discriminator that lets compile reject a task-less inline
 *  agent. */
export const InlineAgent = z.strictObject({
  prompt: z.string().min(1),
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, {
    error:
      'name: must match /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ (fs-safe: it names log files; ' +
      'alphanumeric first character, then letters, digits, dots, underscores, hyphens)',
  }),
});

/** An agent reference — the value of `step:` / `review_loop.writer` /
 *  `review_loop.reviewer`. A bare string is a persona name (the CLI loads its
 *  agent file); an object is an inline general agent. The arms are distinct JSON
 *  types, so the union is unambiguous. */
export const AgentRef = z.union([z.string(), InlineAgent]);

// Hand-written interface types — mirror the Zod schema shapes so they can be
// used as static return types of type-guard predicates (e.g. `isStep(item): i
// is StepItemT`). The `T` suffix avoids colliding with the schema constants
// of the same root name.
//
// Drift between the Zod schemas and these interfaces is caught
// BIDIRECTIONALLY by the `*ItemBody` exports below + `src/types.driftcheck.ts`:
//   - Zod removes/retypes a field the interface declares: caught by the
//     `z.ZodType<XT>` annotation on the public schema export (the inferred
//     body type fails to satisfy the interface, fails the annotation).
//   - Zod adds an optional field the interface lacks: caught by the
//     `Expect<Equal<z.infer<typeof StepItemBody>, StepItemT>>` assertions
//     in `src/types.driftcheck.ts`. The annotation alone would let this
//     slip — TS treats "missing optional" and "present-undefined optional"
//     as assignment-compatible — but the Equal idiom asserts strict
//     structural identity.
// Both directions are exercised by `npm run build` (which compiles
// `src/types.driftcheck.ts` as a regular .ts file, not a test file).
// If you add a field to a Zod schema here, add it to the corresponding
// interface as well — both sides must agree, or `npm run build` fails.
//
// Note on refines: Zod's `.refine()` doesn't change the inferred type — it
// adds runtime predicates only. So these types match the BASE schema shape
// (before refines). They're intentionally looser than what the Zod schemas
// reject at parse time (refines add cross-field invariants TS can't express,
// e.g. "if interactive: true then agent/input/prompt are required").

export interface ReviseWithT {
  prompt?: string;
  inputs?: string[];
}

export interface OnFailT {
  retry_from: string;
  max_retries?: number;
  on_max_exceeded?: 'fail' | 'continue';
  revise_with: ReviseWithT;
  verdict_field: string;
  approve_when?: string;
}

/** Static-typing mirror of the `InlineAgent` Zod shape. Hand-written (like the
 *  sibling `*T` interfaces) so it can be the narrowed target of `isInlineAgent`
 *  and a stable type for downstream compile / mermaid consumers. `name` is
 *  required — it is the agent's identity in logs, window titles, error
 *  messages, and mermaid nodes. */
export interface InlineAgentT {
  prompt: string;
  name: string;
}

/** Static-typing mirror of the `AgentRef` Zod union. */
export type AgentRef = string | InlineAgentT;

export interface StepItemT {
  step: AgentRef;
  input?: string;
  inputs?: Record<string, string>;
  bind?: string;
  produces?: string;
  extra_args?: string[];
  timeout?: number;
  on_fail?: OnFailT;
}

export interface ReviewLoopItemT {
  review_loop: {
    writer: AgentRef;
    reviewer: AgentRef | FlowItem[];
    input: string;
    max_iters?: number;
    approve_when?: string;
    writer_produces: string;
    reviewer_produces?: string;
    verdict_field?: string;
    bind?: string;
    on_max_exceeded?: 'fail' | 'continue';
  };
}

export interface HumanGateItemT {
  human_gate: {
    interactive?: true;
    agent?: string;
    input?: string;
    prompt?: string;
    extra_args?: string[];
  };
}

export interface AggregateItemT {
  aggregate: {
    inputs: Record<string, string>;
    require?: 'all_approved';
    verdict_field: string;
    approve_when?: string;
    bind?: string;
    retry_from?: string;
    max_retries?: number;
    on_max_exceeded?: 'fail' | 'continue';
    revise_with?: ReviseWithT;
  };
}

export interface ParallelItemT {
  parallel: FlowItem[];
  bind?: string;
}

export interface BranchItemT {
  branch: {
    when: string;
    then: FlowItem[];
    else?: FlowItem[];
    bind?: string;
  };
}

export interface ForeachItemT {
  foreach: {
    over: string;
    as: string;
    body: FlowItem[];
    bind?: string;
    on_iteration_fail?: 'abort' | 'continue';
  };
}

/** Type guards over `FlowItem`. After `if (isStep(item))`, `item` narrows
 *  to `StepItemT` and direct field access (`item.step`, `item.bind`, etc.)
 *  is type-safe with no casts. Centralized here so tests, the compile module, and
 *  mermaid.ts share one source of truth — discriminator drift surfaces in
 *  exactly one place, and the runtime check is the same byte-shape at every
 *  call site. */
export const isStep = (i: FlowItem): i is StepItemT => 'step' in i;
export const isReviewLoop = (i: FlowItem): i is ReviewLoopItemT => 'review_loop' in i;
export const isHumanGate = (i: FlowItem): i is HumanGateItemT => 'human_gate' in i;
export const isParallel = (i: FlowItem): i is ParallelItemT => 'parallel' in i;
export const isBranch = (i: FlowItem): i is BranchItemT => 'branch' in i;
export const isAggregate = (i: FlowItem): i is AggregateItemT => 'aggregate' in i;
export const isForeach = (i: FlowItem): i is ForeachItemT => 'foreach' in i;

/** Read helpers over `AgentRef`. Unlike the FlowItem guards above, these narrow
 *  an agent reference (string persona vs inline object), not a `FlowItem`.
 *  Centralized so every later compile + mermaid site resolves the union the same
 *  way. */
export const isInlineAgent = (ref: AgentRef): ref is InlineAgentT => typeof ref === 'object';

/** Resolve an agent reference to its display label: a persona name is itself; an
 *  inline agent is its required `name`. Label only — it never drives spawn
 *  behavior. */
export const agentLabel = (ref: AgentRef): string => (isInlineAgent(ref) ? ref.name : ref);

/** Raw schema body for `StepItem`, BEFORE the `z.ZodType<StepItemT>`
 *  annotation widens away the inferred type. Exported so the bidirectional
 *  drift-detection tests in `types.test.ts` can compare
 *  `z.infer<typeof StepItemBody>` against `StepItemT` and catch both
 *  directions of drift (Zod adds a field the interface lacks, AND
 *  Zod removes a field the interface still declares). The annotated
 *  `StepItem` below is the public schema — pipeline parsing uses it,
 *  refines and all. */
export const StepItemBody = z.strictObject({
  step: AgentRef,
  input: ValueExpr.optional(),
  inputs: z.record(z.string(), ValueExpr).optional(),
  bind: BindName.optional(),
  produces: z.string().min(1).optional(),
  // Per-step cli args. REPLACES `default_extra_args:` for this step
  // (does not concat — overrides are intentionally not additive so an
  // author can drop every default cleanly). Note: `extra_args: []`
  // (explicit empty array) is an opt-OUT — the spawn argv has NO extra
  // args, including no `--model` flag, falling back to the cli's
  // built-in default model. To use the pipeline default unchanged, omit
  // the field entirely.
  extra_args: z.array(z.string()).optional(),
  // Per-step timeout in milliseconds. When set, the runtime arms a
  // setTimeout that kills the child with SIGTERM and rejects with
  // `agent '<name>' timed out after <ms>ms` if it fires. Default 30 min
  // (1,800,000 ms) is applied in `runAgent` when this field is unset.
  timeout: z.number().int().positive().optional(),
  on_fail: OnFail.optional(),
});

export const StepItem: z.ZodType<StepItemT> = StepItemBody.refine(
  (v) => !(v.input !== undefined && v.inputs !== undefined),
  { error: 'step: use either `input` or `inputs`, not both' },
).refine((v) => v.on_fail === undefined || v.produces !== undefined, {
  error:
    "step: 'on_fail' requires 'produces' — the gate reads its verdict from the step's produces file",
});

/** Raw schema body for `ReviewLoopItem`. See `StepItemBody` docblock for
 *  why the *Body variant exists. Uses `z.lazy(() => FlowItemSchema)` for the
 *  compound-reviewer recursive case; the cycle is broken at the type level
 *  by `FlowItem` being a hand-written union (not `z.infer<typeof
 *  FlowItemSchema>`), so TypeScript doesn't have to chase through Zod's
 *  lazy thunks during inference. Runtime behavior is unaffected — z.lazy
 *  still defers reading `FlowItemSchema` until the first `.parse()` call. */
export const ReviewLoopItemBody = z.strictObject({
  review_loop: z
    .strictObject({
      writer: AgentRef,
      // Three distinct JSON types so the union is unambiguous: a string persona
      // name, an inline `{ prompt, name? }` agent (object), or a subflow
      // (array). The structural rule "subflow's last item must be aggregate" is
      // enforced at compile time in validateReviewerSubflow (compile/validation.ts);
      // Zod's recursive refine on a lazy cycle is awkward, so that gap is
      // intentional. The refines below treat string and inline-object alike as
      // the single-reviewer arm (verdict via reviewer_produces/verdict_field);
      // only the array arm is the subflow.
      reviewer: z.union([z.string(), InlineAgent, z.lazy(() => z.array(FlowItemSchema))]),
      input: ValueExpr,
      max_iters: z.number().int().positive().optional(),
      approve_when: z.string().min(1).optional(),
      writer_produces: z.string().min(1),
      reviewer_produces: z.string().min(1).optional(),
      verdict_field: z.string().min(1).optional(),
      bind: BindName.optional(),
      on_max_exceeded: z.enum(['fail', 'continue']).optional(),
    })
    .refine((v) => Array.isArray(v.reviewer) || v.reviewer_produces !== undefined, {
      error:
        "review_loop: 'reviewer_produces' is required when 'reviewer' is a single agent (a persona name or an inline agent). The reviewer writes its JSON verdict to that path.",
    })
    .refine((v) => !Array.isArray(v.reviewer) || v.reviewer_produces === undefined, {
      error:
        "review_loop: 'reviewer_produces' must be omitted when 'reviewer' is a subflow. The subflow's own steps declare their 'produces:' paths.",
    })
    .refine((v) => Array.isArray(v.reviewer) || v.verdict_field !== undefined, {
      error:
        "review_loop: 'verdict_field' is required when 'reviewer' is a single agent (a persona name or an inline agent). The loop reads that field from the reviewer's JSON verdict file.",
    })
    .refine((v) => !Array.isArray(v.reviewer) || v.verdict_field === undefined, {
      error:
        "review_loop: 'verdict_field' must be omitted when 'reviewer' is a subflow. The terminal aggregate inside the subflow performs its own verdict extraction; the loop receives the aggregate's pre-extracted overall verdict string.",
    }),
});

export const ReviewLoopItem: z.ZodType<ReviewLoopItemT> = ReviewLoopItemBody;

/** Raw schema body for `HumanGateItem`. See `StepItemBody` docblock for
 *  why this exists. */
export const HumanGateItemBody = z.strictObject({
  human_gate: z
    .strictObject({
      // `interactive` is a literal-true-or-absent flag, not a boolean: there
      // is no `interactive: false` state. The plain y/N path is "no
      // interactive field at all". Interactive mode requires `input:` and
      // `prompt:` together; `agent:` is optional. Present → a persona gate
      // (delegated to the cli via `--agent`). Absent → a general gate: the
      // gate's already-mandatory `prompt:` is the agent's task, spawned with
      // all tools and no persona. (A general agent is expressed here by
      // omitting `agent:`, not by an inline object, because the gate prompt
      // already supplies the task.) `extra_args:` is optional even with
      // interactive set; when omitted the gate uses the pipeline default.
      // See refines below.
      interactive: z.literal(true).optional(),
      agent: z.string().optional(),
      input: ValueExpr.optional(),
      // `.min(1)`: for a general gate (agent: omitted) the prompt is the
      // agent's ENTIRE task — an empty string would spawn a persona-less
      // agent with no task at all. InlineAgent.prompt enforces the same.
      prompt: z
        .string()
        .min(1, {
          error:
            "human_gate: 'prompt:' must be non-empty — it is the gate's initial message and, for a general gate (no agent:), the agent's entire task",
        })
        .optional(),
      // Per-gate cli args override (REPLACES `default_extra_args:`, doesn't
      // concatenate — matches `StepItem.extra_args`). Only meaningful in
      // interactive mode (plain y/N spawns no child). Note: `extra_args: []`
      // is an explicit opt-OUT — the gate's argv has zero extra flags
      // including no `--model`, so the cli uses its built-in default model.
      // To use the pipeline default unchanged, omit the field entirely.
      extra_args: z.array(z.string()).optional(),
    })
    .refine(
      (v) => {
        if (v.interactive !== true) return true;
        return v.input !== undefined && v.prompt !== undefined;
      },
      {
        error:
          "human_gate: when 'interactive: true' is set, 'input:' and 'prompt:' are required. " +
          "'input:' is the artifact bind the agent edits; 'prompt:' is its initial message (and, for a general gate, its task). " +
          "'agent:' is optional — omit it for a general gate spawned with all tools and no persona.",
      },
    )
    .refine(
      (v) => {
        if (v.interactive === true) return true;
        return (
          v.agent === undefined &&
          v.input === undefined &&
          v.prompt === undefined &&
          v.extra_args === undefined
        );
      },
      {
        error:
          "human_gate: 'agent:', 'input:', 'prompt:', and 'extra_args:' are only valid when 'interactive: true' is set. " +
          "Plain y/N mode (no 'interactive:') takes no fields.",
      },
    ),
});

export const HumanGateItem: z.ZodType<HumanGateItemT> = HumanGateItemBody;

/** Deterministic aggregation of labeled review outputs. Raw schema body for
 *  `AggregateItem` — see `StepItemBody` docblock for why the *Body variant
 *  exists. `require` accepts a string today ('all_approved'); kept as a
 *  string union to grow later (e.g. severity-based policies).
 *  Aggregate doubles as a retry-gate host when retry_from is set;
 *  verdict_field/approve_when drive the gate decision. Conditional
 *  invariants enforced at parse-time via four refines; downstream consumers
 *  should narrow via readRetryGate() (compile/retry-gate.ts), which encodes the
 *  schema's invariants as a unified shape. */
export const AggregateItemBody = z.strictObject({
  aggregate: z
    .strictObject({
      inputs: z.record(z.string(), ValueExpr).refine((v) => Object.keys(v).length > 0, {
        error: 'aggregate.inputs must declare at least one key',
      }),
      require: z.enum(['all_approved']).optional(),
      verdict_field: z.string().min(1),
      approve_when: z.string().min(1).optional(),
      bind: BindName.optional(),
      ...RetryMechanism.shape,
    })
    .refine((v) => v.max_retries === undefined || v.retry_from !== undefined, {
      error:
        "aggregate: 'max_retries' requires 'retry_from' — set retry_from to make this aggregate a retry gate, or remove max_retries.",
    })
    .refine((v) => v.on_max_exceeded === undefined || v.retry_from !== undefined, {
      error:
        "aggregate: 'on_max_exceeded' requires 'retry_from' — set retry_from to make this aggregate a retry gate, or remove on_max_exceeded.",
    })
    .refine((v) => v.revise_with === undefined || v.retry_from !== undefined, {
      error:
        "aggregate: 'revise_with' requires 'retry_from' — set retry_from to make this aggregate a retry gate, or remove revise_with.",
    })
    .refine((v) => v.retry_from === undefined || v.revise_with !== undefined, {
      error:
        "aggregate: 'retry_from' requires 'revise_with' — the writer needs an explicit revise prompt or feedback-file list on retry.",
    }),
});

export const AggregateItem: z.ZodType<AggregateItemT> = AggregateItemBody;

export type FlowItem =
  | StepItemT
  | ReviewLoopItemT
  | HumanGateItemT
  | AggregateItemT
  | ParallelItemT
  | BranchItemT
  | ForeachItemT;

/** Raw schema body for `ParallelItem`. Lives outside `FlowItemSchema` so the
 *  bidirectional drift-detection tests can compare its inferred shape against
 *  `ParallelItemT`. The `.min(1)` constraint here is a runtime invariant; it
 *  doesn't change the inferred TS type (a non-empty array still types as
 *  `T[]`), so the type-level Equal-check stays clean. */
export const ParallelItemBody = z.strictObject({
  parallel: z.array(z.lazy(() => FlowItemSchema)).min(1),
  bind: BindName.optional(),
});

export const ParallelItem: z.ZodType<ParallelItemT> = ParallelItemBody;

/** Raw schema body for `BranchItem`. See `ParallelItemBody` docblock. */
export const BranchItemBody = z.strictObject({
  branch: z.strictObject({
    when: z.string(),
    then: z.array(z.lazy(() => FlowItemSchema)).min(1),
    else: z
      .array(z.lazy(() => FlowItemSchema))
      .min(1)
      .optional(),
    bind: BindName.optional(),
  }),
});

export const BranchItem: z.ZodType<BranchItemT> = BranchItemBody;

/** Raw schema body for `ForeachItem`. The `body` field uses `z.lazy(() =>
 *  FlowItemSchema)` for the recursive body case; the cycle is broken at
 *  the type level by `FlowItem` being a hand-written union. */
export const ForeachItemBody = z.strictObject({
  foreach: z.strictObject({
    over: ValueExpr,
    as: BindName,
    body: z.array(z.lazy(() => FlowItemSchema)).min(1),
    bind: BindName.optional(),
    on_iteration_fail: z.enum(['abort', 'continue']).optional(),
  }),
});

export const ForeachItem: z.ZodType<ForeachItemT> = ForeachItemBody;

export const FlowItemSchema: z.ZodType<FlowItem> = z.lazy(() =>
  z.union([
    StepItem,
    ReviewLoopItem,
    HumanGateItem,
    AggregateItem,
    ParallelItem,
    BranchItem,
    ForeachItem,
  ]),
);

export const Pipeline = z.strictObject({
  pipeline: z.string(),
  cli: z.enum(['claude', 'copilot']),
  default_extra_args: z.array(z.string()).optional(),
  inputs: z.array(BindName).default([]),
  flow: z.array(FlowItemSchema),
});

export type PipelineSpec = z.infer<typeof Pipeline>;
