# smoke_test/ — end-to-end pipeline runs against real CLI agents

This tree holds smoke pipelines that exercise loom's emit + runtime
through real `claude`/`copilot` invocations. It complements the unit
suite under `src/`:

- **Unit tests (`src/**/\*.test.ts`)** verify code structure — Zod
parses, emit shape, type-level invariants. They do NOT exec the
generated `.mjs` through Node.
- **Smoke tests (`smoke_test/`)** verify production behavior — `dist/`
  resolves correctly, the generated `.mjs` is Node-parseable, agents
  spawn, retry/branch/parallel/review-loop semantics fire end-to-end.

The CRIT bug fixed at `93472e1` (TypeScript annotation leaking into
emitted `.mjs`, breaking every bound branch pipeline) survived 4 review
iterations and was only caught by a smoke run. Smoke testing is
load-bearing.

## When to run

- Before merging a feature that touches `src/compile.ts` or
  `src/runtime.ts`.
- After `npm run build` produces a fresh `dist/`.
- Before a release.
- Whenever a loom-scope change might affect runtime behavior the unit
  suite can't reach (Node ESM parse, child-process spawn, file-bind
  rehydration, retry zones, layered persona discovery).

## How to invoke

```bash
# 1. ALWAYS rebuild dist/ first — the compiled pipeline imports loom's
#    runtime via `agenticloom/runtime`, which resolves through dist/, not src/.
#    Cleanup commits do NOT rebuild dist/ automatically. A stale dist/
#    silently bypasses recently-changed code paths.
npm run build

# 2. cd into smoke_test/ so per-run workspaces land here, not in the
#    repo's loom/runs/. The CLI resolves the workspace at
#    <invocationCwd>/loom/runs/<id>/.
cd smoke_test

# 3. Run a pipeline by name (no .yaml suffix). The CLI's resolver looks
#    for `loom/pipelines/<name>.yaml` under the invocation cwd first,
#    then `~/.loom/pipelines/<name>.yaml` as the global-layer fallback.
#    --save-logs captures per-agent stdout/stderr in the workspace
#    (logs/<step-label>.log).
loom run smoke-branch-hoist-consumable-claude bug --id smoke-1 --save-logs

# Pass input fixtures by absolute path. Most pipelines take a single
# scalar (e.g. a "mode" string) or a ticket-file path; check the YAML's
# `inputs:` line.
loom run probe-cli-e2e /Users/.../smoke_test/tickets/ticket-auth.md --id probe-1
```

The `--id` flag names the workspace dir (otherwise loom generates one).
Reuse the same `--id` with `--resume-from <step-label>` to continue an
in-progress run; that exercises the cursor-rehydration path.

## Pipeline categories

All pipelines live at `smoke_test/loom/pipelines/`. Invoke by name — the
CLI's resolver (`src/cli.ts:resolvePipeline`) appends `.yaml` and looks
under `loom/pipelines/` relative to the invocation cwd.

### Happy-path smokes — `smoke-*`

Expected to compile cleanly and complete a successful end-to-end run.
Each comes in a `-claude.yaml` / `-copilot.yaml` pair; pick whichever
CLI you have on PATH.

- **`smoke-branch-hoist-consumable-*`** — branch with two file-bound
  arms; downstream `$ref` consumer reads the bind. Verifies static
  consumability classification + bind hoisting from the surviving arm.
- **`smoke-branch-hoist-consumable-retry-*`** — same shape plus an
  `on_fail` retry gate that re-runs from the hoisted bind.
- **`smoke-branch-hoist-nested-*`** — branches inside branches; tests
  hoisting through multiple nesting layers and arm-terminal traversal.
- **`smoke-branch-hoist-mixed-noref-*`** — asymmetric arms (one
  file-bound, one not) with NO downstream `$ref`. Compiles because the
  bind is never consumed; if you add a consumer it should reject.
- **`smoke-branch-hoist-asymmetric-fail-*`** — asymmetric arms WITH a
  downstream `$ref`. Expected to FAIL compile with a precise error
  naming the non-file-bound arm.
- **`smoke-branch-hoist-sideeffect-retry-*`** — branch arm with a
  retry gate whose `retry_from:` lands at a side-effect (non-consumable)
  step. Exercises the side-effect retry path.
- **`smoke-branch-hoist-resume-*`** — two-pass procedure. Pass 1 runs
  cold; pass 2 uses `--resume-from <post-branch-step>` to verify the
  IIFE disk-probe rehydration when the cursor sits past a consumable
  branch.
- **`smoke-retry-from-bind-*`** — single-step retry with
  `retry_from: <bind-name>` targeting a sibling's bind. Verifies the
  retry-zone construction outside of branch context.

### Probes — `probe-cli-e2e`, `test-layered-discovery`

Minimal targeted runs that exercise one CLI surface.

- **`probe-cli-e2e`** — single step + `on_fail` retry gate against
  its own earlier sibling. Smallest pipeline that exercises the OnFail
  strict schema (verdict_field + retry_from + revise_with) and layered
  persona discovery. Use as a sanity probe when poking the CLI.
- **`test-layered-discovery`** — references the
  `loom-test-persona` agent which exists ONLY at
  `smoke_test/.claude/agents/loom-test-persona.md`. Running from
  `smoke_test/` proves project-layer agent resolution fires before the
  global-layer fallback. The full manual procedure is in
  `SANITY-CHECK-layered-discovery.md`.

### Unhappy negative tests — `unhappy-*`

Expected to FAIL at compile time with a specific error message. Run
them with `loom compile` (not `run`) to inspect the error; no agents
spawn.

- **`unhappy-1-bind-name-hyphen-*`** — `BindName` regex rejects
  `bad-name` (hyphen). Schema-level Zod error.
- **`unhappy-2-on-fail-strict-typo-*`** — `on_fail` schema is `.strict()`;
  a typo'd key (e.g. `retri_from`) trips the unrecognized-key check.
- **`unhappy-3-retry-from-nonexistent-*`** — `retry_from:` targets a
  bind that doesn't exist in scope.
- **`unhappy-4-retry-from-pipeline-input-*`** — `retry_from:` targets a
  pipeline input; pipeline inputs aren't retryable producers.
- **`unhappy-5-retry-from-hoisted-parallel-child-*`** — `retry_from:`
  targets a parallel-child bind which isn't a valid retry zone target.
- **`unhappy-6-retry-from-compound-target-*`** — `retry_from:` targets
  a compound (review_loop / parallel) bind that isn't an atomic step.
- **`unhappy-7-retry-from-intermediate-compound-*`** — `retry_from:`
  inside a nested compound resolves to an intermediate that the runtime
  can't re-enter cleanly.
- **`unhappy-8-dollar-ref-to-parallel-bind-*`** — `$ref` points at a
  parallel-child's bind from outside the parallel; the bind isn't
  hoisted out for downstream consumers.

### Canonical multi-review pipelines — `multi-review*`

Full AC → spec workflows used to exercise compound review_loops:

- **`multi-review`** — claude variant; AC review_loop + interactive
  gate + spec compound review_loop with 3 parallel reviewers
  (security, api-design, edge-case) + aggregate + interactive gate.
- **`multi-review-copilot`** — copilot variant of the same shape.

## Persona conventions

Smoke pipelines reference agents by name. The CLI's layered discovery
checks the **project layer** (relative to invocation cwd) first, then
the **global layer** at `~/.{claude,copilot}/agents/`.

When you `cd smoke_test && loom run ...`, the project layer is:

- `smoke_test/.claude/agents/` for `cli: claude` pipelines
- `smoke_test/.github/agents/` for `cli: copilot`

The personas here are **smoke-test fixtures** — minimal/test
behaviors, NOT production prompts. They override globals only inside
this tree.

When a smoke needs a specialized agent (e.g. a JSON-emitting reviewer
that knows the aggregate-gate schema), add it to the project layer for
the pipeline's cli — `smoke_test/.claude/agents/` for `cli: claude`,
`smoke_test/.github/agents/` for `cli: copilot` — rather than the
user's global layer. The `ac-reviewer.md` here is one such example: it
outputs `{"status": "pass" | "fail"}` JSON specifically shaped for
`aggregate.verdict_field: status`.

## Ticket / input fixtures

Checked-in sample inputs live alongside the pipelines:

- **`ticket-auth.md`** — auth-API redesign (HS256 → RS256, revocation
  list, encrypted refresh, CORS lockdown).
- **`ticket-bug.md`** — validator-rejects-emoji bug; UTF-8 multibyte
  regex repro.
- **`ticket-rate.md`** — RATE-1 ticket; token-bucket rate limiting per
  X-Api-Key, sliding window, per-tier overrides.

Pipelines that take a simple string `mode` / `topic` input (most of the
`smoke-branch-*` and `probe-*` shapes) take the value directly on the
command line; no fixture file is needed.

Pass file fixtures on the command line by absolute path:

```bash
loom run smoke-retry-from-bind-claude \
  "$PWD/ticket-auth.md" --id auth-1 --save-logs
```

**Sandbox note.** Agent sandboxes (esp. `claude`'s `--allowed-paths`)
may restrict reads to within the workspace cwd. If a smoke fixture
needs ticket content but the agent can't reach absolute paths outside
the run directory, the pipeline author has to stage the input into the
workspace, or extend the agent's allowed-paths list. Several historical
runs under `loom/runs/` show this failure mode in their generated
specs — those are gitignored, kept for reference only.

## Per-run workspaces

`smoke_test/loom/runs/<id>/` — auto-created by `loom run`. Contains:

- The agents' produced files (`ACS.md`, `SPEC.md`, `*-review.json`,
  etc.).
- `logs/<step-label>.log` if `--save-logs` was passed.
- Possibly the compiled `.mjs` for inspection (depending on flag use).

These are **gitignored** (per `.gitignore` `smoke_test/loom/runs/`).
Safe to delete after inspection. The runtime auto-creates fresh
workspaces; never edit a run directory manually expecting it to
re-run.

## Adding a new smoke test

1. Drop the YAML at `smoke_test/loom/pipelines/<name>.yaml` so the CLI's
   name resolver picks it up via `loom run <name>`. Naming:
   - `smoke-<feature>-<variant>.yaml` for happy-path runs that should
     complete successfully.
   - `unhappy-<N>-<description>.yaml` for compile-time negative tests.
   - `probe-<scenario>.yaml` for targeted single-step probes.
2. If the smoke needs a specialized agent, add it under `.claude/agents/`
   (for `cli: claude`) or `.github/agents/` (for `cli: copilot`), named
   `<name>.md`. Use the existing personas as templates.
3. If the smoke needs a new input fixture, add it to `smoke_test/` (or
   `smoke_test/tickets/` if you want to group) and pass by absolute
   path.
4. Document the pipeline's purpose in a header comment at the top of
   the YAML — what shape does it test? What should pass vs fail?
5. Add a one-line entry to this README's category list above.

## Cost

Each smoke run spawns one or more real CLI agent processes against
the underlying API. Expect $0.30–$1.00 per typical smoke. Compound
review-loop pipelines (3 parallel reviewers + aggregate) cost more.
Don't auto-run; gate each `loom run` on user intent.

## Build prerequisite

The CLI resolves runtime imports through `dist/` (`src/cli.ts`'s
emit-then-spawn path resolves `agenticloom/runtime` against the published
package, which means the `dist/` build). A stale `dist/` silently
bypasses recently-changed code paths.

**Always run `npm run build` before any `loom run`.** Phase 1.8's
smoke #8 burned an iteration on this — the test silently bypassed the
retry path because `dist/` had pre-rename names while the source emit
had post-rename names. Reviewers (per-chunk and comprehensive) cannot
catch this; only smoke runs exercise `dist/`.

## Layered-discovery manual check

See `SANITY-CHECK-layered-discovery.md` for a step-by-step procedure
that verifies loom resolves a pipeline + agent from the global layer
(`~/.loom/pipelines/` + `~/.claude/agents/`) when the project layer is
empty. The procedure uses `$HOME` override + `mktemp` sandbox so it
never touches the user's real home.
