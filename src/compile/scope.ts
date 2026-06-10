import { StepItemT, agentLabel, inlinePromptOf } from '../types.js';
import { escapeTplLit } from './flow-helpers.js';

/** What `bind:` resolves to when consumed downstream.
 *
 *  `fileBound: true` means a downstream `$ref` to this name gets the path of
 *  a file the producer wrote — the contract this phase enforces (no
 *  stdout-piped-into-prompts). Pipeline inputs are file-bound by convention
 *  (the CLI arg is whatever the caller passes; we treat it as ok).
 *
 *  `fileBound: false` means the bind would be the producer's stdout (for
 *  steps without `produces:`) or the aggregate's in-memory verdict string
 *  (aggregate is never file-bound — it returns a small overall-verdict
 *  string, not a path). Such binds are allowed to exist — only consuming
 *  them downstream is the compile error. */
export type ProducerKind =
  | 'step'
  | 'review_loop'
  | 'aggregate'
  | 'input'
  | 'parallel'
  | 'branch'
  | 'foreach'
  | 'foreach-iteration';

/** Why a `branch.bind` failed the explicit-rejoin consumability classification.
 *  Object DU; each variant carries enough context for `checkConsume` to format
 *  a consumer-site error naming the offending arm/terminal/remedy.
 *
 *  `missing_else`: the branch has no `else:` arm, so the bind would be unset
 *  when `when:` is falsy.
 *
 *  `arm_terminal_not_file_bound`: an arm's terminal item is not a file-bound
 *  producer (e.g. aggregate verdict string, plain y/N human_gate, parallel
 *  without combinor). When the offender is a nested branch, `terminalLabel`
 *  itself is a concatenated phrase that names the wrapper plus the deepest
 *  leaf offender (e.g. `nested branch (bind 'inner') then-arm terminal
 *  aggregate (verdict string, not a path)`) — `classifyArmTerminal`'s
 *  recursive call composes the chain inline, so the consumer-site error
 *  surfaces the leaf without a separate walk.
 *
 *  `mixed_arm_kinds`: declared from day one for a future string-bound
 *  branch arm extension (admitting aggregate terminals as `kind:
 *  'string'`); v1 does NOT construct this reason. Keeping the variant
 *  here lets the consumer-site error formatter handle the case without
 *  a shape change when the extension lands. */
export type BranchConsumabilityReason =
  | { kind: 'missing_else' }
  | {
      kind: 'arm_terminal_not_file_bound';
      arm: 'then' | 'else';
      terminalLabel: string;
    }
  | {
      kind: 'mixed_arm_kinds';
      thenKind: 'file' | 'string';
      elseKind: 'file' | 'string';
      thenTerminalLabel: string;
      elseTerminalLabel: string;
    };

/** Result of classifying a branch's arms for the explicit-rejoin rule. When
 *  `consumable: true`, the branch's `bind:` resolves at runtime to whichever
 *  arm fired — a file path for `kind: 'file'`, a verdict string for
 *  `kind: 'string'`. When `consumable: false`, downstream `$ref` is rejected
 *  by `checkConsume` with a reason-specific error.
 *
 *  v1 constructs only `kind: 'file'`; a future string-bound branch arm
 *  extension can flip on `'string'` admission in `classifyArmTerminal`
 *  without reshaping this DU.
 *
 *  `thenPath` / `elsePath` carry the per-arm closure-return expressions; for
 *  arms whose terminal is a step or review_loop they are the bind name, for
 *  literal-input human_gate they are the JSON-quoted literal, and for nested
 *  branches they are the nested branch's bind (which evaluates to the inner
 *  branch's resolved leaf at runtime). `allLeafPaths` aggregates recursively
 *  via `collectLeafPaths` so the `--resume-from` disk-probe IIFE can probe
 *  every possible leaf even across nested-branch composition. */
export type BranchConsumability =
  | {
      consumable: true;
      kind: 'file' | 'string';
      thenPath: string;
      elsePath: string;
      allLeafPaths: string[];
    }
  | {
      consumable: false;
      reason: BranchConsumabilityReason;
    };

export interface ProducerInfo {
  kind: ProducerKind;
  fileBound: boolean;
  /** Human-readable producer label for error messages (e.g. "step 'ac-writer'"). */
  location: string;
  /** Schema field name that, if added, would make this producer file-bound. */
  fileField: string;
  /** Upstream agent name for the input-context wrap. Used to tell the
   *  consumer who wrote the file it's about to read. For aggregates and
   *  pipeline inputs no real agent exists — use a synthetic label. For a
   *  `step:` producer this is the resolved agent label: a persona name is
   *  itself; an inline agent is its required `name`. */
  agentName: string;
  /** Baked inline-agent prompt — set only when this producer's `step:` is the
   *  inline (object) form. Threaded into the aggregate parse-retry rewrite
   *  closure so an inline producer re-fires via its inline spawn form (the
   *  baked prompt is the agent's identity) instead of degrading to a persona
   *  `--agent <label>` lookup that has no file. Undefined for persona-name
   *  producers and every non-step kind. */
  inlinePrompt?: string;
  /** Set only when `kind === 'parallel'`. Names of the child binds declared
   *  inside the parallel block, used to make `$-ref` error messages
   *  actionable ("use $aBind, $bBind, ..." instead of a generic "no
   *  file-bound output"). The outer parallel bind itself is never
   *  file-bound; `retry_from:` targets it for "rerun the whole parallel
   *  block." */
  parallelChildBinds?: string[];
  /** Set only for `step`-kind producers — the literal path string the
   *  producer's `produces:` writes to. Used by aggregate emit to synthesize
   *  the file-rewrite closure that re-runs the producer on parse failure.
   *  Undefined for non-step producers (review_loop binds, pipeline inputs,
   *  aggregates); aggregate emit skips closure synthesis for those inputs
   *  and the runtime falls back to loud-fail. */
  producesPath?: string;
  /** Per-step `extra_args:` override captured at the step's emit, if any.
   *  Used by aggregate's retry-closure emit to invoke the producing step
   *  with the same effective extra_args on retry as on the first call,
   *  preserving the per-step REPLACES-default rule end-to-end (without
   *  this, retry would silently fall back to `DEFAULT_EXTRA_ARGS` and run
   *  the producer with different cli args than its first call). Set only
   *  for `step`-kind producers; undefined means the aggregate retry-closure
   *  falls back to `DEFAULT_EXTRA_ARGS`. */
  extraArgs?: string[];
  /** Per-step `timeout:` captured at the step's emit, if any. Threaded into
   *  the aggregate retry-closure so the retry honors the same wall-clock
   *  bound as the first call. Without this, the retry would silently fall
   *  back to runAgent's 30-min default even when the step asked for a
   *  tighter (or looser) timeout. Set only for `step`-kind producers. */
  timeout?: number;
  /** Lexical-scope identifier where this bind was declared. Set by
   *  `declare()` from the current `emit()` invocation's scope ID. Used by
   *  `retry_from:` resolution to enforce same-scope-only retry zones —
   *  even though parallel siblings, branch arms, and review_loop subflows
   *  snapshot the parent's scope for `$-ref` resolution, retry zones must
   *  not cross those boundaries. A target whose `declarationScope` differs
   *  from the gate's `currentScopeId` is rejected with a "different scope"
   *  compile error. */
  declarationScope: number;
  /** True when this `ProducerInfo` is the hoisted outer-scope copy of a
   *  parallel child's bind (re-declared in the outer scope so downstream
   *  sequential siblings can `$-ref` it). The inner-scope copy of the same
   *  bind (visible only inside the parallel child) does NOT carry this
   *  marker. Used by `retry_from:` resolution to reject targets that have
   *  no defined ordering: parallel children run concurrently, so "retry
   *  from one child of a parallel" is undefined — the only sane semantics
   *  is "rerun the whole parallel," which requires the user to target the
   *  parallel block's own bind instead. */
  hoistedFromParallel?: boolean;
  /** Set only on `kind: 'branch'` entries. Populated by the branch emit
   *  handler (and by `emitPreCursorItem` for pre-cursor branches) after both
   *  arms classify. Read by `checkConsume` to format the per-arm consumer-
   *  site error AND by `emitPreCursorItem` to drive the `--resume-from`
   *  disk-probe rehydration. `undefined` on non-`branch` kinds and on
   *  bindless branches (which have no `ProducerInfo` entry at all). */
  branchConsumability?: BranchConsumability;
  /** Set only on `kind: 'branch'` entries that emitted via the closure-call
   *  shape — each arm body is wrapped in a named `runThen_<bind>` /
   *  `runElse_<bind>` closure that returns the arm's terminal value, and
   *  the branch site invokes them as `<bind> = cond ? runThen_<bind>() :
   *  runElse_<bind>()`. Carries the emit-time JS identifiers of those
   *  closures so `buildRetryBody` can re-fire arm bodies via closure-call
   *  without re-emitting the sealed arm bodies. Undefined on bindless
   *  branches — those emit a bare `if/else` block with no closure wrap
   *  and no rejoin variable. */
  runThenName?: string;
  runElseName?: string;
  /** Set only on `kind: 'foreach'` entries. The module-level closure name
   *  emitted by the foreach handler holds the body callback; `buildRetryBody`
   *  reads this to re-invoke the closure on retry without re-emitting the
   *  body. Undefined on non-foreach kinds AND on pre-cursor foreach entries
   *  (which never participate in retry zones — see emitPreCursorItem). */
  foreachBodyName?: string;
  /** Set only on `kind: 'foreach'` entries. The synthetic directory name
   *  (`foreach-<M>/`) used when the foreach has no bind. Stashed here so
   *  buildRetryBody's foreach case can reconstruct the same `foreach({...})`
   *  call as the main pass without recomputing fresh(). When foreach.bind
   *  is set, the bind name doubles as the dir name; this field still gets
   *  populated so the retry callback's emit doesn't need to re-derive it. */
  foreachSyntheticName?: string;
}

/** Build the `kind: 'step'` producer fields derived from the step item
 *  itself; `location` is the only display-context field the caller owns
 *  (the parallel hoist appends its suffix and the `hoistedFromParallel`
 *  marker). Fusing the AgentRef-derived pair (agentName, inlinePrompt) at
 *  one site keeps the pair's invariant — inlinePrompt present ⇔ inline
 *  step — structural instead of conventional: a construction site cannot
 *  take the label and forget the baked prompt. The retry-closure fields
 *  (producesPath, extraArgs, timeout) ride along for the same reason —
 *  forgetting any of them silently changes how the aggregate parse-retry
 *  re-fires the producer. */
export function stepProducerInfo(
  item: StepItemT,
  location: string,
): Omit<ProducerInfo, 'declarationScope'> {
  return {
    kind: 'step',
    fileBound: item.produces !== undefined,
    location,
    fileField: 'produces',
    agentName: agentLabel(item.step),
    inlinePrompt: inlinePromptOf(item.step),
    producesPath: item.produces,
    extraArgs: item.extra_args,
    timeout: item.timeout,
  };
}

/** Throw if `name` is already declared in this scope; otherwise record it.
 *  Parallel arrows and branch arms get their own scope (snapshot of parent).
 *  `currentScopeId` tags the bind with its declaring lexical scope; callers
 *  pass the scope ID of the `emit()` invocation that declares the bind, so
 *  every `ProducerInfo` carries enough context for `retry_from:` to reject
 *  cross-scope targets. */
export function declare(
  name: string,
  info: Omit<ProducerInfo, 'declarationScope'>,
  scope: Map<string, ProducerInfo>,
  currentScopeId: number,
): void {
  if (scope.has(name)) {
    throw new Error(
      `Compile error: name '${name}' is bound more than once in the same scope. ` +
        `Each bind (and pipeline input) must be unique within its scope.`,
    );
  }
  scope.set(name, { ...info, declarationScope: currentScopeId });
}

/** Register a path against the enclosing parallel block's write-set, or no-op
 *  outside one. Sequential overwrite is the author's responsibility; only
 *  concurrent writes race. `siblingLabel` names where this write lives so
 *  the collision error can name both offending siblings. */
export function registerPath(
  value: string,
  fieldName: string,
  siblingLabel: string,
  pathScope: Map<string, string> | undefined,
): void {
  if (pathScope === undefined) return;
  const existing = pathScope.get(value);
  if (existing !== undefined) {
    throw new Error(
      `Compile error: parallel siblings write to the same path ${JSON.stringify(value)}: ` +
        `${existing} and ${siblingLabel} (via '${fieldName}'). ` +
        `Concurrent writes would race; rename one or move them out of the parallel block.`,
    );
  }
  pathScope.set(value, siblingLabel);
}

/** Union a child scope's entries into a parent scope. Used after a nested
 *  parallel OR a compound reviewer subflow finishes — the inner block's writes
 *  run concurrently with outer siblings, so each inner-write must be checked
 *  against the parent. The roll-up presents the inner block as a single
 *  sibling (`parallel block`) to the parent. */
export function mergeChildIntoParent(
  childScope: Map<string, string>,
  parentScope: Map<string, string> | undefined,
): void {
  if (parentScope === undefined) return;
  for (const path of childScope.keys()) {
    registerPath(path, 'parallel block', 'parallel block', parentScope);
  }
}

/** Format a single path-bound `$ref` into a template-literal expression that
 *  names the upstream agent and the path, then instructs the consumer to read
 *  the file. The runtime's role-specific postscript still appends the write
 *  target. Together they give the consumer a complete I/O contract without
 *  any artifact body in the prompt. */
export function wrapPathRef(refName: string, info: ProducerInfo): string {
  return (
    '`' +
    escapeTplLit(info.agentName) +
    ' finished its work. Its output is at: ${' +
    refName +
    '}\\n\\nRead the input file with your Read tool, then perform your task.`'
  );
}
