# Loom YAML primitives — field reference

A reference for the YAML primitives loom understands. Each primitive is a
`FlowItem` discriminated by a unique top-level key. Source of truth lives in
`src/types.ts`; this doc is a flat, copy-friendly read.

## Conventions used in this doc

- **Required / Optional** — whether the field must appear in YAML.
  "Required (conditional)" means a refine enforces it under some other
  field's state; the row points at the rule.
- **Type** — written as TypeScript shorthand. `string`, `number`,
  `'a' | 'b'`, `string[]`, `Record<string, ValueExpr>`. `FlowItem[]` is a
  list of any primitive in this doc (parallel/branch/review_loop subflows
  recurse).
- **ValueExpr** — a string. If it begins with `$` it's a bound-variable
  reference (e.g. `$spec` resolves to whatever was previously bound as
  `bind: spec`). Otherwise it's a literal.
- **BindName** — must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/` (letters, digits,
  underscores; cannot start with a digit). Enforced so the compiler can
  emit `const ${bindName} = ...` without injection from malformed YAML.

## Quick reference — the seven FlowItem variants

| Discriminator key | Primitive      | One-line purpose                                                                   |
| ----------------- | -------------- | ---------------------------------------------------------------------------------- |
| `step:`           | StepItem       | Spawn a single agent once.                                                         |
| `review_loop:`    | ReviewLoopItem | Writer ↔ reviewer iteration until approval or `max_iters`.                         |
| `human_gate:`     | HumanGateItem  | Pause for human approval — plain y/N, or interactive REPL with an agent.           |
| `aggregate:`      | AggregateItem  | Combine labeled verdicts; doubles as a retry gate when `retry_from` is set.        |
| `parallel:`       | ParallelItem   | Run a list of FlowItems concurrently; await all.                                   |
| `branch:`         | BranchItem     | Conditionally run `then:` or `else:` based on a `$bind` expression.                |
| `foreach:`        | ForeachItem    | Iterate a runtime-produced JSONL list; per-iteration body in a sealed scratch dir. |

Type-guard predicates exported from `src/types.ts`: `isStep`,
`isReviewLoop`, `isHumanGate`, `isAggregate`, `isParallel`, `isBranch`,
`isForeach`. Each takes a `FlowItem` and narrows it to the corresponding
`*ItemT` interface.

---

## Agent references — persona name or inline agent

`step:`, `review_loop.writer`, and `review_loop.reviewer` each hold an
**agent reference** (`AgentRef` in `src/types.ts`): EITHER a persona name
or an inline agent. Every agent invocation needs a task — a persona
supplies it from its file, an inline agent supplies it via `prompt:`;
neither may be taskless. `human_gate.agent` is a related case (the
omitted-agent general gate, below).

| Form             | YAML                     | Resolves to                                                                | Tools                          |
| ---------------- | ------------------------ | -------------------------------------------------------------------------- | ------------------------------ |
| **Persona name** | `step: code-reviewer`    | The CLI loads the native agent file and enforces its frontmatter `tools:`. | Whatever the persona declares. |
| **Inline agent** | `step: { prompt, name }` | No file; loom bakes `prompt:` into the spawn as the task.                  | **All tools** (unscoped).      |

**Persona name (string).** loom delegates identity and tool scope to the
CLI's native `--agent <name>` flag — it does NOT read or inline the
persona body. The CLI loads the agent file (via the layered discovery in
the README), enforces its `tools:`, and loom appends only its role
postscript (the I/O contract). The file leaf is cli-aware:

| Pipeline `cli:` | Agent-file leaf   | Example                                 |
| --------------- | ----------------- | --------------------------------------- |
| `claude`        | `<name>.md`       | `.claude/agents/code-reviewer.md`       |
| `copilot`       | `<name>.agent.md` | `.github/agents/code-reviewer.agent.md` |

A frontmatter-only persona (no body) still works — the CLI loads an empty
system prompt but applies the file's `tools:` / `model:`.

**Inline agent (`{ prompt, name }`).** A one-off general agent with no
persona file:

- `prompt` (**required**, non-empty) — the agent's task. **Static text:**
  no `$ref` interpolation. Per-invocation data still flows via `input:` /
  `inputs:` (loom passes the producer paths), and loom's role postscript
  still supplies the output contract. Static-prompt is deliberate: an
  inline `prompt:` is fixed task/criteria, not a per-run template. Must
  not start with `-` — the CLI parses a dash-leading `-p` value as a
  flag, so compile rejects it (same rule for the `human_gate` prompt).
- `name` (**required**) — the agent's identity in logs, window titles,
  error messages, and mermaid nodes. fs-safe
  (`/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/`) because it names log files.
- loom spawns it with **all tools** and no `--agent`. Tool scoping is what
  a persona is for; the inline form is the unscoped escape hatch.

The object form (not a bare string) is the discriminator: it is what lets
compile reject a task-less inline agent (`{ name: x }` with no `prompt`)
and tells the spawn "general, not persona". Mixing forms is fine — a
`review_loop` can pair an inline writer with a persona reviewer.

**Per-CLI tool enforcement.**

- **claude** enforces a persona's `tools:` even under
  `--dangerously-skip-permissions`. Tool _availability_ (the allowlist)
  and _permission_ (the prompt) are separate layers; skip-permissions
  waives only the prompt, so a `tools: Read` persona still cannot invoke
  Bash. Real least privilege on the headless path. loom also verifies at
  spawn (via the stream-json init event's agent roster) that claude
  actually loaded the requested agent — claude exits 0 on an unknown
  `--agent`, so loom fails loud instead of running persona-less.
- **copilot** delegates identity + tools the same way via `--agent`,
  reading `.github/agents/<name>.agent.md` (project) or
  `~/.copilot/agents/<name>.agent.md` (user). **Caveat:** copilot's CLI-side
  enforcement of an agent's `tools:` is version-sensitive and, in current
  releases, not yet in effect (the `tools:` frontmatter is honored by
  copilot's editor agent system, not the CLI), so a copilot persona
  effectively runs with all tools until a copilot release enforces it.
  loom delegates and adds **no workaround**; when copilot enforces agent
  `tools:` CLI-side, the same persona files become least-privilege with no
  loom change.

**`human_gate` — the omitted-agent general form.** A `human_gate` agent
reference is a plain `agent:` string, not an `AgentRef` union (it never
takes an inline object). A general no-persona interactive gate is
expressed by **omitting agent:** entirely: a gate that sets
`interactive: true`, `input:`, and `prompt:` but no `agent:` runs as a
general agent (all tools), using the gate's already-required `prompt:` as
the task. A second inline prompt would be redundant, so there is no
`{ prompt }` object here.
A persona gate (`agent:` present) delegates via `--agent` on both CLIs.

---

## StepItem — `step:`

Spawn one agent once.

| Field        | Req? | Type                        | Notes                                                                                                                                                                               |
| ------------ | ---- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `step`       | yes  | `AgentRef`                  | Persona name (string) OR inline `{ prompt, name }` agent. See "Agent references" above. A persona resolves via project then global discovery.                                       |
| `input`      | no   | `ValueExpr`                 | Mutually exclusive with `inputs`.                                                                                                                                                   |
| `inputs`     | no   | `Record<string, ValueExpr>` | Mutually exclusive with `input`. Multiple labeled inputs.                                                                                                                           |
| `bind`       | no   | `BindName`                  | Binds the step's `produces:` path (or its raw output if no `produces`) for downstream `$ref` use.                                                                                   |
| `produces`   | no   | `string` (non-empty)        | Output file path the agent writes. Required when `on_fail` is set.                                                                                                                  |
| `extra_args` | no   | `string[]`                  | Per-step CLI args. REPLACES `default_extra_args` (does not concat). `extra_args: []` is an explicit opt-OUT (no `--model`). May not contain `--agent` (loom owns agent delegation). |
| `timeout`    | no   | `number` (positive int)     | Milliseconds. Kills the child with SIGTERM on expiry. Default 1,800,000 (30 min) applied by `runAgent` when unset.                                                                  |
| `on_fail`    | no   | `OnFail`                    | Makes this step a retry-zone gate. See OnFail below. Requires `produces:`.                                                                                                          |

**Cross-field rules**

- `input` XOR `inputs` — not both.
- `on_fail` requires `produces:` — the gate reads its verdict from the
  step's produces file.

**Example — persona**

```yaml
- step: spec-writer
  input: $ac_final
  produces: SPEC.md
  bind: spec
  timeout: 600000
```

**Example — inline general agent** (no persona file, all tools)

```yaml
- step:
    prompt: |
      Review the spec at the input path for security issues only.
      Report each finding with file, line, and severity as JSON.
    name: sec-scan # required; the agent's identity in logs, window titles, and mermaid nodes
  input: $spec
  produces: review.json
  bind: cr
```

---

## ReviewLoopItem — `review_loop:`

Writer ↔ reviewer iteration. The reviewer can be a single agent (string)
or a compound subflow (`FlowItem[]` ending in `aggregate`).

| Field               | Req?        | Type                     | Notes                                                                                                                                                                                                                                                     |
| ------------------- | ----------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `writer`            | yes         | `AgentRef`               | Writer agent: persona name (string) OR inline `{ prompt, name }`. See "Agent references" above.                                                                                                                                                           |
| `reviewer`          | yes         | `AgentRef \| FlowItem[]` | Single reviewer (persona name OR inline `{ prompt, name }`) OR a subflow whose last item must be `aggregate` (enforced at compile time, not parse time). A string or inline reviewer follows the single-reviewer rules below; only an array is a subflow. |
| `input`             | yes         | `ValueExpr`              | Initial artifact bound name or literal.                                                                                                                                                                                                                   |
| `writer_produces`   | yes         | `string` (non-empty)     | Path the writer produces.                                                                                                                                                                                                                                 |
| `max_iters`         | no          | `number` (positive int)  | Cap on iterations. Default applied by runtime when unset.                                                                                                                                                                                                 |
| `approve_when`      | no          | `string` (non-empty)     | Verdict value that counts as approval. Defaults to `'pass'` at runtime.                                                                                                                                                                                   |
| `on_max_exceeded`   | no          | `'fail' \| 'continue'`   | After exhaustion: throw or continue with last draft. Default `'continue'` applied at runtime. `'fail'` throws `HaltPipelineError`.                                                                                                                        |
| `reviewer_produces` | conditional | `string` (non-empty)     | **Required** when `reviewer` is a string; **forbidden** when reviewer is a subflow (the subflow's steps declare their own `produces:`).                                                                                                                   |
| `verdict_field`     | conditional | `string` (non-empty)     | **Required** when `reviewer` is a string; **forbidden** when reviewer is a subflow (the terminal aggregate extracts the verdict).                                                                                                                         |
| `bind`              | no          | `BindName`               | Binds the writer's final approved produces path.                                                                                                                                                                                                          |

**Cross-field rules** (all enforced at parse time)

- `reviewer:` single agent (string persona OR inline `{ prompt, name }`) → `reviewer_produces` required.
- `reviewer: FlowItem[]` → `reviewer_produces` must be omitted.
- `reviewer:` single agent (string persona OR inline `{ prompt, name }`) → `verdict_field` required.
- `reviewer: FlowItem[]` → `verdict_field` must be omitted.

**Note on `on_max_exceeded`.** Default exhaustion behavior is to warn and
return the last draft (`'continue'`). Setting `on_max_exceeded: fail` opts
into hard-fail: when `max_iters` is reached without approval, the loop
throws `HaltPipelineError` and the pipeline halts. The same typed-error
shape is shared by `step.on_fail.on_max_exceeded` and
`aggregate.on_max_exceeded` so downstream catch handlers (notably
`foreach.on_iteration_fail: continue`) can distinguish deliberate halts
from generic runtime errors. The field is independent of every other
field on `review_loop` (no cross-field rule).

**Example — single-reviewer**

```yaml
- review_loop:
    writer: ac-writer
    reviewer: ac-reviewer
    input: $ticket
    max_iters: 2
    writer_produces: ACS.md
    reviewer_produces: ac-review.json
    verdict_field: status
    approve_when: pass
    bind: ac_final
```

**Example — inline writer + persona reviewer** (forms mix freely)

```yaml
- review_loop:
    writer:
      prompt: Draft a technical spec from the ticket at the input path.
      name: spec-drafter
    reviewer: spec-reviewer # persona reviewer alongside an inline writer
    input: $ticket
    writer_produces: SPEC.md
    reviewer_produces: review.json
    verdict_field: status
    bind: spec
```

loom still appends the writer (Markdown artifact) and reviewer
(verdict-JSON) postscripts to the `*_produces` paths, so an inline
`prompt:` carries only the task/criteria — the output contract stays
loom's.

**Example — compound reviewer (subflow ending in aggregate)**

```yaml
- review_loop:
    writer: spec-writer
    input: $ac_final
    writer_produces: SPEC.md
    approve_when: pass
    bind: spec
    reviewer:
      - parallel:
          - step: security-reviewer
            input: $spec
            produces: security-review.json
            bind: sec
          - step: api-design-reviewer
            input: $spec
            produces: api-review.json
            bind: api
      - aggregate:
          inputs:
            security: $sec
            api: $api
          verdict_field: status
          approve_when: pass
          require: all_approved
```

---

## HumanGateItem — `human_gate:`

Pause for human approval. Two modes — **plain y/N** (no fields) or
**interactive** (the user types directly to a spawned agent and a y/N
confirm fires on REPL exit).

| Field         | Req?        | Type        | Notes                                                                                                                                                                                          |
| ------------- | ----------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interactive` | no          | `true`      | Literal-true-or-absent. There is no `interactive: false`; omit the field for plain y/N.                                                                                                        |
| `agent`       | conditional | `string`    | Optional under `interactive: true`. Present → persona gate (delegated via `--agent`). Omitted → general gate (all tools; the gate `prompt:` is the task). Forbidden when `interactive` absent. |
| `input`       | conditional | `ValueExpr` | Required iff `interactive: true`. Forbidden otherwise.                                                                                                                                         |
| `prompt`      | conditional | `string`    | Required iff `interactive: true`. Forbidden otherwise. The agent's initial message.                                                                                                            |
| `extra_args`  | conditional | `string[]`  | Only valid when `interactive: true`. REPLACES `default_extra_args`. `extra_args: []` is an explicit opt-OUT (no `--model`). May not contain `--agent`.                                         |

**Cross-field rules**

- `interactive: true` → `input` and `prompt` required; `agent` optional (omit it for a general gate).
- `interactive` absent → `agent`, `input`, `prompt`, `extra_args` all forbidden.

**Example — plain y/N**

```yaml
- human_gate: {}
```

**Example — interactive**

```yaml
- human_gate:
    interactive: true
    agent: ac-writer
    input: $ac_final
    prompt: |
      ACS.md has passed automated review. Iterate with the user
      now — answer open questions, refine wording, surface gaps.
```

**Example — interactive general gate** (omit `agent:`; the gate `prompt:` is the task)

```yaml
- human_gate:
    interactive: true
    input: $plan
    prompt: |
      You're my planning collaborator for the artifact at the input path.
      Refine the plan with me — split, merge, reorder.
```

---

## AggregateItem — `aggregate:`

Deterministically combine labeled verdicts from prior steps. Also doubles
as a **retry gate** when `retry_from` is set.

| Field             | Req?        | Type                        | Notes                                                                                                                         |
| ----------------- | ----------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `inputs`          | yes         | `Record<string, ValueExpr>` | Map of label → bound producer. At least one key.                                                                              |
| `verdict_field`   | yes         | `string` (non-empty)        | Field name to read from each input's JSON.                                                                                    |
| `require`         | no          | `'all_approved'`            | Aggregation policy. String union so it can grow (e.g. severity-based).                                                        |
| `approve_when`    | no          | `string` (non-empty)        | Verdict value that counts as approval. Defaults to `'pass'`.                                                                  |
| `bind`            | no          | `BindName`                  | Binds the aggregate's overall verdict for downstream use.                                                                     |
| `retry_from`      | no          | `BindName`                  | When set, this aggregate is a retry-zone gate. On fail, re-run the zone from the step bound `retry_from`.                     |
| `max_retries`     | conditional | `number` (int, 1–10)        | Cap on retries. Requires `retry_from`. Defensive ceiling of 10 — raise in `src/types.ts` if a real pipeline needs more.       |
| `on_max_exceeded` | conditional | `'fail' \| 'continue'`      | What to do after exhaustion. Requires `retry_from`. Default `'fail'` applied by runtime. `'fail'` throws `HaltPipelineError`. |
| `revise_with`     | conditional | `ReviseWith`                | Required iff `retry_from` is set. The writer needs an explicit revise prompt or feedback-file list on retry.                  |

**Cross-field rules** (all enforced at parse time)

- `max_retries` requires `retry_from`.
- `on_max_exceeded` requires `retry_from`.
- `revise_with` requires `retry_from`.
- `retry_from` requires `revise_with`.

**Example — simple aggregate (no retry)**

```yaml
- aggregate:
    inputs:
      security: $sec
      api: $api
      edge: $edge
    verdict_field: status
    approve_when: pass
    require: all_approved
    bind: spec_verdict
```

**Example — retry-gate aggregate**

```yaml
- aggregate:
    inputs: { reviewer: $rev }
    verdict_field: status
    approve_when: pass
    retry_from: writer_step
    max_retries: 3
    on_max_exceeded: fail
    revise_with:
      inputs: [$rev]
```

---

## ParallelItem — `parallel:`

Run an array of FlowItems concurrently; await all.

| Field      | Req? | Type         | Notes                                                                                         |
| ---------- | ---- | ------------ | --------------------------------------------------------------------------------------------- |
| `parallel` | yes  | `FlowItem[]` | Minimum one item. Each child runs concurrently; the primitive resolves when all have settled. |
| `bind`     | no   | `BindName`   | (Reserved — rarely used; siblings typically bind individually.)                               |

**Example**

```yaml
- parallel:
    - step: security-reviewer
      input: $spec
      produces: security-review.json
      bind: sec
    - step: api-design-reviewer
      input: $spec
      produces: api-review.json
      bind: api
```

---

## BranchItem — `branch:`

Run `then:` or `else:` depending on a JavaScript expression.

| Field         | Req? | Type         | Notes                                                                                                                                                                                                                                                                                                     |
| ------------- | ---- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `branch.when` | yes  | `string`     | Raw JavaScript condition, emitted verbatim as `if (...)`. Truthiness decides the arm taken.                                                                                                                                                                                                               |
| `branch.then` | yes  | `FlowItem[]` | Minimum one item. Runs when `when` is truthy.                                                                                                                                                                                                                                                             |
| `branch.else` | no   | `FlowItem[]` | Minimum one item if present. Runs when `when` is falsy.                                                                                                                                                                                                                                                   |
| `branch.bind` | no   | `BindName`   | Rejoin variable for the explicit-rejoin pattern. File-bound (downstream `$ref` reads the surviving arm's path) when both arms terminate in a file-bound producer AND `else:` is set; otherwise non-file-bound and usable only as a `retry_from` target. See "Notes on `branch.bind` consumability" below. |

**Example**

```yaml
- aggregate:
    inputs: { c: $cls }
    verdict_field: type
    bind: cls_type # holds "bug" or "feature"

- branch:
    when: cls_type === 'bug' # JS comparison; note: NO $-prefix in when:
    then:
      - step: bug-fixer
        input: $ticket
        produces: FIX.md
    else:
      - step: spec-writer
        input: $ticket
        produces: SPEC.md
```

### Notes on `branch.bind` consumability

A branch's `bind:` is the _rejoin variable_ for the fork-rejoin pipeline shape: declare it on the branch itself, end each arm in a file-bound producer, and downstream consumers `$ref` the branch's bind to read whichever arm fired.

```yaml
- branch:
    bind: outcome # rejoin variable
    when: cls_type === 'bug'
    then:
      - step: bug-fixer
        input: $ticket
        produces: FIX.md # terminal file-bound producer
    else:
      - step: spec-writer
        input: $ticket
        produces: SPEC.md # terminal file-bound producer

- step: final-reviewer
  input: $outcome # FIX.md or SPEC.md at runtime
  produces: review.json
```

#### Consumability rule

`branch.bind` is consumable as a `$ref` downstream when ALL of:

1. `else:` is defined.
2. Both arms terminate in a file-bound producer: a step with `produces:`, a `review_loop` (whose `writer_produces` is required), an `interactive: true` human_gate (literal-string path OR `$ref` to a file-bound producer), or a nested `branch` whose own `bind:` classifies as consumable.
3. (Reserved for the string-bound branch arm extension: aggregate-with-bind as a string-valued terminal. Not in v1.)

A branch that fails any of these admits its `bind:` as a `retry_from:` target ONLY — downstream `$ref` consumption is rejected at compile time with a per-arm error message naming the offending terminal and the remedy (add `produces:`, swap the terminal, or remove the consumer).

#### Asymmetric arms

The compile error fires only when a downstream `$ref` actually consumes the bind. A branch whose arms have asymmetric terminal kinds (one file-bound, one not) compiles cleanly as long as no `$ref` consumer reaches it. Setting `branch.bind` for `retry_from:`-only usage is supported regardless of arm shape.

#### Nested branches

When an arm's terminal is itself a nested `branch`, the nested branch must declare its own consumable `bind:` (recursively: its arms must classify as file-bound). The outer arm's value at runtime is the nested branch's resolved path. The consumer-site error walks the recursion to surface the deepest non-file-bound terminal, so the user fixes the leaf rather than the wrapper.

#### `retry_from` and `--resume-from`

**`retry_from: <branch.bind>`.** Admitted unconditionally — consumable or not. The branch's `when:` re-evaluates on retry; the appropriate arm runs. The retry callback re-fires the branch by _calling the same closures_ the main pass invoked, so arm-internal binds stay sealed inside the closure scope by JavaScript's lexical scoping (the explicit-rejoin rule's foundational invariant). The arm's literal last item — step or nested branch — receives the rendered revise prompt on retry via position-based dispatch in the closure body, so the side-effect-step pattern (single-arm branch, terminal step with no `produces:`) gets the revise prompt the same way a file-bound terminal step would.

**`--resume-from` past a consumable file-bound branch.** Loom rehydrates the bind by probing disk for each arm's statically-known terminal file. Exactly one file should exist; zero (the prior run aborted before the branch executed) or multiple (workspace was modified to leave both arms' files in place) both surface as a clear resume-time error naming the probed paths.

### Notes on `when:` evaluation

`when:` is **raw JavaScript**, emitted verbatim into the compiled pipeline as `if (${when}) { ... }`. The compiler applies one narrow preprocessing pass — `$`-prefix substitution on known bind references — and otherwise leaves the expression untouched.

**What's in scope at evaluation time:**

| In scope                                               | What it is                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Pipeline `inputs:` names (e.g. `ticket`, `mode`)       | Function parameters carrying the CLI args                                                   |
| Bind names (e.g. `writerOut`, `verdict`)               | The bind variables — file-path strings for steps/review_loop; verdict strings for aggregate |
| `readJson(path)`, `readText(path)`, `fileExists(path)` | Loom-provided file-read helpers (see "Helper argument forms" below)                         |
| JS globals                                             | `Math`, `String`, `JSON`, `Array`, etc.                                                     |
| Node globals                                           | `process`, `Buffer`                                                                         |

**Not in scope:** `fs`, `readFileSync`, `existsSync`, `path`, any other loom-specific helpers beyond the three named above.

**`$`-prefix on bind references — both styles work.**

`step.input` uses `$foo` and the `$` is stripped during compile-time resolution (`inputExprFor` in `src/compile.ts`). `branch.when:` applies the same convention: a `$identifier` that names a known bind in scope is rewritten to the bare `identifier` at compile time. Both styles below compile to the same JS:

```yaml
# both compile to `if (cls_type === 'bug')`
when: cls_type === 'bug'
when: $cls_type === 'bug'
```

The `$`-style is preferred for consistency with `step.input:` / `step.inputs:` / `revise_with.inputs:` / `aggregate.inputs:`. Bare-style is equivalent and equally valid.

The substitution is **scope-aware** (only strips `$` from identifiers that resolve to an actual bind in scope) and **respects string literals** (single, double, template). A `$foo` inside `'$foo'`, `"$foo"`, or `` `$foo` `` (outside any `${...}` interpolation) stays verbatim. Unknown `$identifier` patterns are left as-is and surface as runtime ReferenceErrors — the same posture `step.input:` substitution takes for unresolved refs.

**Helper argument forms.** The three file-read helpers (`readJson`, `readText`, `fileExists`) each accept three argument shapes equivalently:

| Form                                   | Example                             | How it resolves                                                                                                                                                                                                                                       |
| -------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$ref` (canonical, after substitution) | `readJson($cls)` → `readJson(cls)`  | `cls` holds the absolute path produced by an upstream step (per loom's bind-values-are-absolute-paths convention)                                                                                                                                     |
| Absolute literal                       | `readJson('/abs/path/to/cls.json')` | Passed verbatim to `readFileSync`                                                                                                                                                                                                                     |
| Relative literal                       | `fileExists('cached-result.json')`  | Resolved against `process.cwd()` at runtime — which is the pipeline's workspace dir (the CLI does `process.chdir(workspaceDir)` before invoking the compiled flow), so relative literals anchor at the workspace root, same as step `produces:` paths |

Loom does NOT validate literal-path arguments at compile time. Missing files surface as Node-stock `ENOENT` at runtime via the pipeline's outer catch; malformed JSON surfaces as `SyntaxError` from `JSON.parse`. Loom does not wrap these errors. **Guard with `fileExists` first** when a file may not exist, since `readJson` / `readText` halt the pipeline on missing input:

```yaml
- branch:
    when: fileExists('cached.json') && readJson('cached.json').version === 2
    then: [...]
```

**Practical sources of truth in `when:`.**

| Source                                    | Decision time                                   | Useful for                                                                                    |
| ----------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| File contents via `readJson` / `readText` | Runtime, after an upstream step writes the file | The main mechanism for content-aware routing (classifier outputs, draft-quality checks, etc.) |
| File existence via `fileExists`           | Runtime                                         | Cache-hit checks, optional-feature gating                                                     |
| Aggregate's `bind:` (verdict string)      | Runtime, derived from agent JSON output         | Verdict-string routing (when an aggregate is otherwise warranted)                             |
| Pipeline `inputs:`                        | Pre-run (CLI args)                              | Routing decisions the user already made before invoking                                       |
| JS literals / arithmetic                  | Compile-time                                    | Edge cases (random sampling, etc.)                                                            |

**A bind that holds a file path is always truthy.** Bind variables for steps and review_loops hold absolute path strings. Any non-empty string is truthy in JS, so `when: writerOut` is **always true** if execution reaches the branch. Use `fileExists($writerOut)` (or read the content) when you want a non-trivial test.

**Step failure halts the pipeline, not falls through to else.** If a prior step throws (agent error, timeout, missing produces), the `await` rejects and the pipeline exits non-zero. The branch is never reached — there's no else-arm fallback for failure recovery. (For "recover from step failure," use `step.on_fail` with `on_max_exceeded: 'continue'` or `retry_from`.)

**Two patterns for routing on a JSON field value.** For routing on one field of an upstream agent's JSON output, both patterns work:

Direct `readJson` — reads the field straight from the file:

```yaml
- step: classifier
  input: $ticket
  produces: cls.json
  bind: cls

- branch:
    when: readJson($cls).type === 'bug'
    then: [...]
```

Aggregate as extractor — wraps the producing step's output through an `aggregate` to surface a verdict-string bind:

```yaml
- step: classifier
  input: $ticket
  produces: cls.json
  bind: cls

- aggregate:
    inputs: { c: $cls }
    verdict_field: type
    bind: cls_type

- branch:
    when: $cls_type === 'bug'
    then: [...]
```

Use the direct `readJson` pattern when you only need to read one field from a single producer. Use `aggregate` when you want its verdict-string semantics: multi-input verdict combining, retry-gate behavior, or the `approve_when` knob.

---

## ForeachItem — `foreach:`

Iterate a runtime-produced JSONL file. For each non-empty line, runs the body in a per-iteration scratch directory (`loom/runs/<id>/<bind>/iter-N/`) with `$<as>` bound to the absolute path of that line's extracted `task.json`. The body runs with `process.cwd()` set to that scratch dir, so any relative `produces:` paths inside the body land in `iter-N/` automatically.

### Fields

| Field                | Required | Type                    | Description                                                                                                                                      |
| -------------------- | -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `over:`              | yes      | `ValueExpr`             | Path to a JSONL file; typically a `$`-ref to an upstream bind that produced the JSONL.                                                           |
| `as:`                | yes      | `BindName`              | Per-iteration bind name; inside the body, `$<as>` resolves to the absolute path of `iter-N/task.json`.                                           |
| `body:`              | yes      | `FlowItem[]` (min 1)    | The per-iteration work.                                                                                                                          |
| `bind:`              | no       | `BindName`              | Rejoin variable; list-bound (admissible only as `retry_from:` target or `--resume-from` cursor). When unset, foreach runs for side effects only. |
| `on_iteration_fail:` | no       | `'abort' \| 'continue'` | Default `'abort'`. `'continue'` catches plain `Error`s and warns; `HaltPipelineError` always propagates regardless.                              |

### Cross-field rules

- **Body scope is sealed.** `as:`, intermediate step binds, review_loop binds — all live inside the iteration closure by JS lexical scoping. Downstream consumers `$ref` only the foreach's own `bind:`, never body internals.
- **`foreach.bind` is list-bound.** It cannot be `$ref`-consumed via `step.input:` (or any other consume site) — admissible only as a `retry_from:` target (whole-foreach replay from iter-0) or a `--resume-from` cursor (whole-foreach replay from iter-0). Per-iteration retry/resume is deferred to a follow-up.
- **JSONL is validated upfront.** Empty/whitespace-only lines warn-and-skip; malformed JSON on any line throws BEFORE iteration 0 starts (no wasted spawns on iterations 0..K when line K+1 is bad).
- **Iteration index is NOT exposed to the body.** Agents read task data from `task.json`; if they need an ID, the task carries one (e.g., `task.id` in the JSONL).

### Example — planner-driven multi-task workflow

```yaml
- step: planner
  input: $ticket
  produces: plan.jsonl
  bind: plan

- foreach:
    over: $plan
    as: task
    body:
      - review_loop:
          writer: implementer
          reviewer: impl-reviewer
          input: $task
          writer_produces: impl.md
          reviewer_produces: review.json
          verdict_field: status
          approve_when: pass
          bind: impl
    bind: results
```

Per-iteration outputs land at `loom/runs/<id>/results/iter-N/impl.md`. Downstream tooling or human inspection reads them from there; the `results` bind itself cannot be `$ref`-consumed.

---

## Shared sub-types

### `OnFail` (used by `StepItem.on_fail`)

Wraps a step into a retry-zone gate. The step's `produces:` JSON is read,
`verdict_field` is checked against `approve_when` (default `'pass'`), and
on mismatch the zone re-runs from `retry_from` up to `max_retries` times.

| Field             | Req? | Type                   | Notes                                                                                                         |
| ----------------- | ---- | ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `retry_from`      | yes  | `BindName`             | Bind of the step the zone restarts from.                                                                      |
| `revise_with`     | yes  | `ReviseWith`           | Writer's revise instructions on retry.                                                                        |
| `verdict_field`   | yes  | `string` (non-empty)   | Field name to read from the gate's produces JSON.                                                             |
| `approve_when`    | no   | `string` (non-empty)   | Verdict value that counts as approval. Defaults to `'pass'`.                                                  |
| `max_retries`     | no   | `number` (int, 1–10)   | Cap on retries. Defensive ceiling of 10.                                                                      |
| `on_max_exceeded` | no   | `'fail' \| 'continue'` | After exhaustion: throw or continue with last attempt. Default `'fail'`. `'fail'` throws `HaltPipelineError`. |

### `ReviseWith`

Instructions for the writer when a retry zone retries. At least one of
`prompt` or `inputs` must be set (empty `{}` is rejected).

| Field    | Req?        | Type       | Notes                                                                                       |
| -------- | ----------- | ---------- | ------------------------------------------------------------------------------------------- |
| `prompt` | conditional | `string`   | Free-form revise prompt. Required unless `inputs` is set.                                   |
| `inputs` | conditional | `string[]` | Each entry must be `$`-prefixed bind ref (e.g. `$review`). Required unless `prompt` is set. |

**Cross-field rule** — at least one of `prompt` or `inputs` (non-empty)
must be present. `{}` is rejected.

---

## Pipeline top-level shape

The YAML document root.

| Field                | Req? | Type                    | Notes                                                                                                                                             |
| -------------------- | ---- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipeline`           | yes  | `string`                | Pipeline name (used in run IDs, mermaid diagrams, error messages).                                                                                |
| `cli`                | yes  | `'claude' \| 'copilot'` | Which CLI loom spawns for each agent.                                                                                                             |
| `default_extra_args` | no   | `string[]`              | Default CLI args for every spawn. Per-step `extra_args:` REPLACES this (does not concat). May not contain `--agent` (loom owns agent delegation). |
| `inputs`             | no   | `BindName[]`            | Defaults to `[]`. CLI-supplied input binds (positional args to `loom run`).                                                                       |
| `flow`               | yes  | `FlowItem[]`            | The sequence of primitives to execute.                                                                                                            |

**Example**

```yaml
pipeline: multi-review
cli: claude
default_extra_args: ['--model', 'haiku']
inputs: [ticket]
flow:
  - review_loop: { ... }
  - human_gate: { ... }
```

---

## Notes on validation layers

- **Parse-time (Zod refines)** — single-field constraints (non-empty
  strings, integer ranges, regex on BindName) and the cross-field rules
  listed in each primitive's "Cross-field rules" section. A bad YAML
  surfaces a friendly error from the CLI.
- **Compile-time (`src/compile.ts`)** — structural rules Zod can't
  enforce on recursive lazy unions. Notably: the compound-reviewer
  subflow's last item must be `aggregate`.
- **Runtime (`src/runtime/`)** — file existence + JSON parsing
  (`pipeline-helpers.ts`, `read-agent-file.ts`), agent discovery +
  timeouts (`agent.ts`), retry-zone re-execution (`aggregate.ts`).

A change to any primitive's shape must be reflected in:

1. The Zod schema body (`*ItemBody` in `src/types.ts`).
2. The hand-written interface (`*ItemT` in `src/types.ts`).
3. `src/types.driftcheck.ts` (load-bearing on `npm run build`).
