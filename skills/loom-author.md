---
name: loom-author
description: Use when the user wants help writing or modifying a loom pipeline YAML. Loom is a YAML→TS compiler for orchestrating CLI coding agents (claude, copilot) with native primitives for review loops, human gates, parallelism, and retry zones. Activates on requests like "write me a loom pipeline...", "add X to my pipeline", "modify <name>.yaml to...".
---

# Loom pipeline authoring

Loom compiles a pipeline YAML into a TypeScript script that orchestrates CLI coding agents. Seven primitives: `step`, `review_loop`, `human_gate`, `parallel`, `branch`, `aggregate`, `foreach`. No LLM supervisor — the compiled script is deterministic.

## When invoked

Write or edit a pipeline at `<cwd>/loom/pipelines/<name>.yaml`. Validate via `loom compile <name> /tmp/out.ts` when shell + loom are available; otherwise give the user the command. Persona authoring (`.claude/agents/<name>.md` files) is out of scope — if a referenced agent has no persona file, `loom compile` fails with the candidate paths listed; surface that error to the user verbatim.

## Schema

### Pipeline header
```yaml
pipeline: <string>           # required; matches filename slug
cli: claude | copilot        # required
default_extra_args: [...]    # optional; CLI args applied to every agent
inputs: [name1, name2]       # bind names accepted at runtime (default [])
flow: [ FlowItem, ... ]      # required; array of primitives
```

### `step` — one agent invocation
- Required: `step: <agent-name>`
- One of `input: $bind | "literal"` OR `inputs: { key: $ref, ... }` (not both)
- Optional: `bind`, `produces`, `extra_args`, `timeout` (ms, runtime default 1,800,000 / 30 min), `on_fail`
- `on_fail` (turns the step into a retry-zone gate; requires `produces` so the gate can read its verdict):
```yaml
on_fail:
  verdict_field: status              # required
  approve_when: pass                 # default 'pass'
  retry_from: <bind>                 # required
  revise_with: { prompt?, inputs? }  # required; at least one of prompt/inputs
  max_retries: 1-10                  # optional
  on_max_exceeded: fail | continue   # default 'fail'
```

### `review_loop` — bounded writer ↔ reviewer
- Required: `writer`, `input`, `writer_produces`
- `reviewer` is ONE of:
  - **Agent name (string)** — then `reviewer_produces` AND `verdict_field` are also required.
  - **Subflow (`FlowItem[]`)** — last item MUST be `aggregate`; `reviewer_produces`/`verdict_field` must be ABSENT (the inner aggregate carries the verdict).
- Optional: `max_iters` (runtime default 3), `approve_when` (default 'pass'), `on_max_exceeded: fail | continue` (default `'continue'`; `'fail'` throws `HaltPipelineError` on exhaustion), `bind`

### `human_gate` — pause for human
- **Plain y/N**: `human_gate: {}` with no other fields permitted.
- **Interactive REPL** (all four required together): `interactive: true`, `agent`, `input: $bind`, `prompt`.
- Optional in interactive: `extra_args` (only meaningful here — plain y/N spawns no child).
- **Both modes require a TTY** — `human_gate` fails loudly when stdin/stdout aren't terminals (e.g. CI, piped input).

### `parallel` — fan-out via Promise.all
- Required: `parallel: [FlowItem, ...]` (≥ 1 child)
- Optional: `bind`
- Children's `bind:`s hoist into the outer scope, so subsequent items can `$ref` them.

### `branch` — if/else on a JS expression
- Required: `branch: { when: <jsExpression>, then: [FlowItem, ...] }` (≥ 1 then-item)
- Optional: `else: [FlowItem, ...]` (≥ 1 if present), `bind` (rejoin variable; see consumability rule)
- **`branch.bind` is the rejoin variable** for fork-rejoin pipelines: downstream consumers `$ref` it and read whichever arm fired. **Consumable as `$ref`** when ALL of (a) `else:` is set, AND (b) both arms terminate in a file-bound producer — a `step` with `produces:`, a `review_loop`, an interactive `human_gate` whose `input:` resolves to a file, or a nested consumable `branch`. Otherwise admissible only as a `retry_from:` target. The compile error fires at the consumer site, so asymmetric arms compile fine when nothing downstream `$ref`s the bind. See PRIMITIVES.md § "BranchItem" → "Notes on `branch.bind` consumability" for the full per-arm error model.
- `when:` is **raw JavaScript** with three loom-provided file-read helpers in scope: `readJson(path)`, `readText(path)`, `fileExists(path)`. Helpers accept three argument forms: `$ref` (after compile-time substitution the bind variable holds an absolute path), absolute literal, or relative literal (anchored at the workspace cwd at runtime). `$bind` references in `when:` are stripped to the bare name at compile time (so `$cls_type === 'bug'` and `cls_type === 'bug'` are equivalent); the `$`-style is preferred for consistency with `step.input:`. Common patterns: classifier output (`readJson($cls).type === 'bug'`), draft content (`readText($draft).includes('TODO')`), cache hit (`fileExists('cached.json')`), pipeline input strings (`ticket.startsWith('BUG-')`).

### `aggregate` — deterministically combine labeled inputs into one verdict
- Required: `inputs: { label: $ref, ... }` (≥ 1 entry), `verdict_field`
- Optional: `require: all_approved` (currently the only legal value), `approve_when` (default 'pass'), `bind`
- Becomes a **retry gate** iff `retry_from` is set:
```yaml
retry_from: <bind>                  # required to be a gate
revise_with: { prompt?, inputs? }   # required when retry_from set
max_retries: 1-10                   # requires retry_from
on_max_exceeded: fail | continue    # requires retry_from
```

### `foreach` — iterate a runtime-produced JSONL list
- Required: `over: <ValueExpr>` (typically `$bind` to a JSONL-producing step), `as: <BindName>`, `body: [FlowItem, ...]` (≥ 1 item)
- Optional: `bind`, `on_iteration_fail: abort | continue` (default `abort`)
- The body runs once per non-empty JSONL line in a per-iteration scratch dir (`<bind>/iter-N/`); cwd is chdir'd there so relative `produces:` paths land in `iter-N/` automatically. `$<as>` resolves inside the body to the absolute path of `iter-N/task.json` (the line's content extracted by loom).
- **Body scope is sealed:** `as:`, intermediate step binds, review_loop binds all stay inside the iteration closure. Downstream `$ref`s only see the foreach's own `bind:`, never body internals.
- **`foreach.bind` is list-bound:** admissible only as a `retry_from:` target (replays the whole foreach from iter-0) or a `--resume-from` cursor (same). `$ref` consumption via `step.input:` is rejected at compile time.
- **JSONL is validated upfront:** empty lines warn-and-skip; malformed JSON on any line throws before iteration 0 starts.
- **Iteration index is NOT exposed to the body.** Agents read task data from `task.json`; if iterations need an ID, the JSONL line should carry one (e.g. `{"id":1, ...}`).
- **`HaltPipelineError`** (e.g. from a nested `on_max_exceeded: fail`) propagates regardless of `on_iteration_fail`.

## Bindings, refs, and produces

- **`bind: <name>`** saves a primitive's result for later reference.
  `BindName` regex: `^[a-zA-Z_][a-zA-Z0-9_]*$` (letters/digits/underscores, no leading digit, no dashes).
- **`$name`** in `input:`, `inputs: {key: $name}`, or `revise_with.inputs: [$name]` references a bound variable. It resolves to the producer's `produces:` path (a string).
- **`produces: <path>`** declares the agent's output file (workspace-relative under `loom/runs/<id>/`). Set it whenever a downstream step consumes the output. Compile rejects a `$ref` to a producer without `produces:`.
- **Agents communicate via files, never stdout-into-prompts.** Downstream Reads the file itself via its own tool.

## Pattern library

### Pattern 1 — Single-reviewer convergence
Writer iterates against one reviewer's JSON verdict. Bounded by `max_iters`.
```yaml
pipeline: ac-review
cli: claude
inputs: [ticket]
flow:
  - review_loop:
      writer: ac-writer
      reviewer: ac-reviewer
      input: $ticket
      max_iters: 3
      writer_produces: ACS.md
      reviewer_produces: ac-review.json
      verdict_field: status
      approve_when: pass
      bind: ac
```

### Pattern 2 — Multi-reviewer fan-out (loose, no retry)
Writer runs once; parallel reviewers fan out; aggregate emits one verdict. Terminal — verdict is read by the next pipeline step.
```yaml
pipeline: spec-multi-review
cli: claude
inputs: [ticket]
flow:
  - step: spec-writer
    input: $ticket
    produces: SPEC.md
    bind: spec
  - parallel:
      - step: security-reviewer
        input: $spec
        produces: security-review.json
        bind: sec
      - step: api-reviewer
        input: $spec
        produces: api-review.json
        bind: api
  - aggregate:
      inputs: { security: $sec, api: $api }
      verdict_field: status
      require: all_approved
      bind: spec_verdict
```

### Pattern 3 — Multi-reviewer with retry (loose, aggregate-as-gate)
Same fan-out shape, but the aggregate becomes a retry gate that re-runs the writer with the per-reviewer feedback files. The user prefers this over compound `review_loop` because per-reviewer binds (`$sec`, `$api`) remain accessible to downstream steps.
```yaml
pipeline: spec-with-retry
cli: claude
inputs: [ticket]
flow:
  - step: spec-writer
    input: $ticket
    produces: SPEC.md
    bind: spec
  - parallel:
      - step: security-reviewer
        input: $spec
        produces: security-review.json
        bind: sec
      - step: api-reviewer
        input: $spec
        produces: api-review.json
        bind: api
  - aggregate:
      inputs: { security: $sec, api: $api }
      verdict_field: status
      require: all_approved
      retry_from: spec
      max_retries: 3
      revise_with:
        inputs: [$sec, $api]
```

### Pattern 4 — Compound `review_loop` (multi-reviewer subflow inside the loop)
Alternative to pattern 3. The reviewer is a subflow ending in `aggregate`. On a failed verdict the writer re-runs with all reviewer paths in its revise prompt. Pattern 3 is generally preferred (cleaner bind scoping) but compound is canonical when you want the iteration semantics packaged.
```yaml
pipeline: spec-compound
cli: claude
inputs: [ticket]
flow:
  - review_loop:
      writer: spec-writer
      input: $ticket
      writer_produces: SPEC.md
      max_iters: 3
      bind: spec
      reviewer:
        - parallel:
            - step: security-reviewer
              input: $spec
              produces: security-review.json
              bind: sec
            - step: api-reviewer
              input: $spec
              produces: api-review.json
              bind: api
        - aggregate:
            inputs: { security: $sec, api: $api }
            verdict_field: status
            require: all_approved
            bind: spec_verdict        # terminal aggregate in a reviewer subflow MUST have bind:
```

### Pattern 5 — Interactive human gate after automated review
Pauses for a human to edit the artifact via an agent REPL. Inherits stdio; the user types directly to the agent; gate confirms y/N on REPL exit.
```yaml
pipeline: ac-with-human
cli: claude
inputs: [ticket]
flow:
  - review_loop:
      writer: ac-writer
      reviewer: ac-reviewer
      input: $ticket
      writer_produces: ACS.md
      reviewer_produces: ac-review.json
      verdict_field: status
      bind: ac
  - human_gate:
      interactive: true
      agent: ac-writer
      input: $ac
      prompt: |
        ACs passed automated review. Iterate with the user — answer
        open questions, refine wording.
```

### Pattern 6 — Planner-driven multi-task workflow with `foreach`
A planner emits N tasks as JSONL; the pipeline runs an impl + test loop per task. Per-iteration outputs land in per-iteration scratch dirs on disk for inspection or downstream tooling.
```yaml
pipeline: plan-and-implement
cli: claude
inputs: [ticket]
flow:
  - step: planner
    input: $ticket
    produces: plan.jsonl   # one JSON object per line, e.g. {"id":1, "desc":"..."}
    bind: plan

  - foreach:
      over: $plan
      as: task              # inside body, $task = absolute path to iter-N/task.json
      body:
        - review_loop:
            writer: implementer
            reviewer: impl-reviewer
            input: $task
            writer_produces: impl.md            # lands at iter-N/impl.md
            reviewer_produces: impl-review.json
            verdict_field: status
            approve_when: pass
            bind: impl
        - review_loop:
            writer: tester
            reviewer: test-reviewer
            input: $task
            writer_produces: tests.md           # lands at iter-N/tests.md
            reviewer_produces: test-review.json
            verdict_field: status
            approve_when: pass
            bind: tests
      bind: task_results
      on_iteration_fail: continue   # don't abort foreach on one bad task
```

### Pattern 7 — Branch fork-rejoin (consumable `branch.bind`)
A branch's `bind:` is the rejoin variable: declare it on the branch, end each arm in a file-bound producer, and downstream consumers `$ref` it to read whichever arm fired. Both arms must terminate file-bound AND `else:` must be set — without those, the bind is admissible only as a `retry_from:` target, never as a `$ref`.
```yaml
pipeline: classify-and-route
cli: claude
inputs: [ticket]
flow:
  - step: classifier
    input: $ticket
    produces: cls.json
    bind: cls
  - aggregate:
      inputs: { c: $cls }
      verdict_field: type
      bind: cls_type             # holds "bug" or "feature"
  - branch:
      bind: outcome              # rejoin variable
      when: $cls_type === 'bug'
      then:
        - step: bug-fixer
          input: $ticket
          produces: FIX.md       # terminal file-bound producer
      else:
        - step: spec-writer
          input: $ticket
          produces: SPEC.md      # terminal file-bound producer
  - step: final-reviewer
    input: $outcome              # FIX.md or SPEC.md at runtime
    produces: review.json
```

## Invariants & gotchas

- **Every `$ref` must resolve to a `bind:` declared upstream.** Compile fails otherwise.
- **`$ref` requires the producer to have `produces:`.** A reference to a step without `produces:` fails compile.
- **`revise_with` is required whenever `retry_from` is set** (and vice versa in `aggregate`). Empty `{}` is rejected — at least one of `prompt:` or `inputs:` must be set.
- **`revise_with.inputs[]` entries are `$`-prefixed bind refs** (e.g. `[$sec, $api]`), not literal paths.
- **Compound `review_loop`'s reviewer subflow's last item MUST be `aggregate`**, AND that terminal `aggregate` MUST declare `bind:` (the loop reads the verdict via that bind).
- **`reviewer_produces` + `verdict_field`** are required iff `reviewer` is an agent name (string); forbidden iff `reviewer` is a subflow.
- **`human_gate` interactive-mode fields** (`agent`, `input`, `prompt`) are all-or-nothing. Plain y/N is `human_gate: {}` with no other fields.
- **`step.on_fail` requires `step.produces`** — the gate reads its verdict from the step's output file.
- **`aggregate` retry-mechanism fields** (`max_retries`, `on_max_exceeded`, `revise_with`) all require `retry_from`. Set `retry_from` to make `aggregate` a retry gate, or remove them all.
- **`extra_args` REPLACES `default_extra_args` for that step/gate** — it does not concatenate. `extra_args: []` is an explicit opt-out (no `--model` flag, falls back to CLI's built-in default model). To use the default unchanged, **omit the field entirely**.
- **`BindName` regex**: `^[a-zA-Z_][a-zA-Z0-9_]*$` — no dashes, no leading digits.
- **`produces:` paths must be workspace-relative** — leading `/` (absolute) or `..` (traversal) is rejected at compile.
- **`parallel` siblings cannot share a `produces:` path** — compile-time collision check.
- **`retry_from:` accepts step binds (with `produces:`), `branch.bind`, and `foreach.bind`.** `review_loop` and `parallel` targets are rejected at compile, as are hoisted parallel-child binds and pipeline inputs. `aggregate` is accepted but warns — aggregate is deterministic in its inputs, so retrying it alone is a no-op unless its inputs are in the retry zone.
- **All object schemas are strict (`z.strictObject`)**: typos like `maxRetries:` (camelCase) fail with "unrecognized key" — they don't silently fall through to defaults.
- **`branch.when` is raw JavaScript with three loom-provided file-read helpers in scope** (`readJson`, `readText`, `fileExists`). Helpers accept `$ref`, absolute, or relative literal paths. `$bind` references are stripped to the bare name at compile time (scope-aware; respects string literals). Loom does NOT validate literal paths at compile time — missing files surface as Node-stock `ENOENT` at runtime. See PRIMITIVES.md § "BranchItem" → "Notes on `when:` evaluation" for the full surface.
- **Agents are referenced by name** — the name resolves via the layered lookup (`<cwd>/.<cli>/agents/<name>.md` first, then `~/.<cli>/agents/<name>.md`). Missing persona files fail at compile, not runtime.

## Source-of-truth

If `loom` is installed and you need to verify a subtle invariant the prose above doesn't cover:

```bash
npm list -g --depth=0 agenticloom --parseable   # global install path, if installed globally
# or use <cwd>/node_modules/agenticloom for a local install
```

Then Read:
- `<install>/PRIMITIVES.md` — canonical field-by-field primitive reference
- `<install>/README.md` — pipeline-author overview and examples
