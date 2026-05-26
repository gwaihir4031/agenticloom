import {
  FlowItem,
  StepItemT,
  AggregateItemT,
  ParallelItemT,
  isStep,
  isParallel,
  isBranch,
  isAggregate,
  isForeach,
} from '../types.js';
import { ProducerInfo } from './scope.js';
import { inputExprFor, multiInputExpr, computeInputPaths, substituteBindRefs } from './inputs.js';
import { RetryGateInfo, buildRevisePromptExpr } from './revise.js';
import { isParallelFeedingAggregateGate } from './retry-gate.js';

/** Emit the `await runAgent(...)` call expression for a step (no `const` /
 *  `let` prefix, no trailing `;`). Used by both the main-pass step emit
 *  (which prepends `const`/`let ${v} = ` + appends `;`) and the on_fail
 *  retry-callback emit (which prepends `${memberBind} = ` for re-assignment).
 *
 *  This is pure string assembly — it does NOT call `checkConsume`,
 *  `validatePath`, or `registerPath`. Those side-effecting checks fire
 *  ONCE at the main-pass site; the retry callback re-emits the same call
 *  shape against an already-validated step.
 *
 *  The two `overrideMode` values exist because the call sites need
 *  fundamentally different emit shapes — one wants compile-time
 *  wholesale substitution, the other needs the substitution deferred
 *  to the emitted JS at runtime:
 *
 *  - `'replace'` (compile-time wholesale): the emit uses `promptOverride`
 *    in place of the normal input expression. Used by `buildRetryBody` to
 *    thread the compile-built revise prompt template into the retry_from
 *    target's runAgent call. The override is a literal expression
 *    (template-literal or string literal) from `buildRevisePromptExpr`,
 *    which is the only input the retry-target step should see on retry —
 *    so dropping the normal-input expression at compile time is the
 *    intended behavior.
 *
 *  - `'fallback'` (runtime `??`): the emit becomes the literal string
 *    `<promptOverride> ?? <normal input expression>`, so the `??`
 *    appears in the EMITTED JS and gets evaluated at JS runtime. Used
 *    by the branch-arm closure's terminal step emit, where the value of
 *    `promptOverride` here is `"revisePromptForTerminal"` — the name of
 *    the JS closure parameter, NOT a literal prompt. The main-pass call
 *    site passes the literal `undefined` as the closure arg (every call
 *    site passes an explicit arg now since the parameter is required),
 *    so at runtime the parameter is `undefined` and the runtime `??`
 *    falls through to the normal input. The retry callback invokes the
 *    closure with the rendered revise prompt, and the runtime `??`
 *    resolves to that prompt.
 *    A compile-time TS-side `??` (i.e., `inputExpr = promptOverride ??
 *    normalInputExpr` in this function's body) would NOT work here:
 *    `promptOverride` is the non-null string `"revisePromptForTerminal"`
 *    at loom-compile time, so the TS-side `??` would short-circuit to
 *    that string immediately, dropping `normalInputExpr` from the emit
 *    entirely. Every bound-branch terminal would then call runAgent
 *    with `undefined` as its normal input on the main pass. The
 *    `'fallback'` mode builds the `??` into the emit STRING so the
 *    fallthrough is resolved by the emitted JS at runtime, not by
 *    loom-compile.
 *
 *  `inputPaths` is computed here (via `computeInputPaths`) so the
 *  retry-callback re-emits inherit the pre-spawn input check for free:
 *  every runAgent call site — initial pass, retry-target rewrite,
 *  intermediate-zone-member re-fire, parallel-child re-execution — flows
 *  through this single emitter, so the runtime validates declared inputs
 *  symmetrically on both passes. */
export function emitRunAgentExpr(
  it: StepItemT,
  scope: Map<string, ProducerInfo>,
  promptOverride?: string,
  overrideMode: 'replace' | 'fallback' = 'replace',
): string {
  const normalInputExpr = it.inputs
    ? multiInputExpr(it.inputs, scope)
    : inputExprFor(it.input, scope);
  let inputExpr: string;
  if (promptOverride === undefined) {
    inputExpr = normalInputExpr;
  } else if (overrideMode === 'replace') {
    inputExpr = promptOverride;
  } else {
    inputExpr = `${promptOverride} ?? ${normalInputExpr}`;
  }
  // Explicit `undefined` (not omission) when `produces:` is unset: `opts`
  // is the 4th positional arg of `runAgent`, so the 3rd slot must be filled
  // even when absent — otherwise `opts` would land in the produces-path slot.
  const producesArg = it.produces ? `, ${JSON.stringify(it.produces)}` : ', undefined';
  const extraArgsExpr =
    it.extra_args !== undefined ? JSON.stringify(it.extra_args) : 'DEFAULT_EXTRA_ARGS';
  // When unset, omit the `timeout` field entirely; runAgent applies its own
  // 30-min default via `opts.timeout ?? 30 * 60 * 1000`. Baking the default
  // into emit would dilute the single source-of-truth (`runtime/agent.ts`) and
  // lengthen every step's options bag for no behavior change.
  const timeoutExpr = it.timeout !== undefined ? `, timeout: ${it.timeout}` : '';
  const inputPaths = computeInputPaths(it, scope);
  // Omit the clause when empty so steps with no resolvable inputs emit
  // byte-identical output (the runtime treats `undefined` as "skip the
  // check," matching the absence).
  const inputPathsClause = inputPaths.length > 0 ? `, inputPaths: [${inputPaths.join(', ')}]` : '';
  const optsExpr = `{ cli: CLI, agentDirs: AGENT_DIRS, extraArgs: ${extraArgsExpr}${timeoutExpr}${inputPathsClause} }`;
  return `await runAgent(${JSON.stringify(it.step)}, ${inputExpr}${producesArg}, ${optsExpr})`;
}

/** Build the inner field lines of an `await aggregate({...})` emit — the
 *  `inputs:`, `verdictField:`, optional `require:`, optional `approveWhen:`,
 *  optional `rewriteProducerFiles:` block. Callers compose the surrounding
 *  declaration/assignment + closing `});`. Shared between the main-pass
 *  aggregate emit (which wraps with `${aggDecl} ${v} = await aggregate({`
 *  + `});`) and the aggregate-gate retry callback's re-fire (which wraps
 *  with `${v} = await aggregate({` + `}); return ${v};`). Each returned
 *  line is prefixed with the caller-supplied `pad` so the outer emit
 *  stays in control of its own indent. */
export function emitAggregateCallInner(
  a: AggregateItemT['aggregate'],
  entries: string[],
  rewriteEntries: string[],
  pad: string,
): string[] {
  const lines: string[] = [
    `${pad}inputs: { ${entries.join(', ')} },`,
    `${pad}verdictField: ${JSON.stringify(a.verdict_field)},`,
  ];
  if (a.require) lines.push(`${pad}require: ${JSON.stringify(a.require)},`);
  if (a.approve_when) lines.push(`${pad}approveWhen: ${JSON.stringify(a.approve_when)},`);
  if (rewriteEntries.length > 0) {
    lines.push(`${pad}rewriteProducerFiles: { ${rewriteEntries.join(', ')} },`);
  }
  return lines;
}

/** Emit the re-execution lines for a `parallel` member inside an aggregate-
 *  gate retry callback. Mirrors the main-pass parallel emit's shape (an
 *  `await parallel([...])` of async lambdas) but reassigns rather than
 *  re-declares the child binds — the pre-pass already let-declared every
 *  zone member, including every parallel child. The aggregate-gate
 *  intermediate-compound carve-out guarantees every child is a step (see
 *  `isParallelFeedingAggregateGate`); non-step children would emit a
 *  retry that silently skipped them. */
export function emitParallelRetry(
  parallelItem: ParallelItemT,
  scope: Map<string, ProducerInfo>,
  pad: string,
): string[] {
  // The aggregate-gate carve-out (isParallelFeedingAggregateGate) guarantees
  // every child is a step at the call site; narrow defensively so the
  // step-only emit shape (runAgent re-fire) is type-correct.
  const children = parallelItem.parallel;
  const stepChildren: StepItemT[] = [];
  for (const child of children) {
    if (!isStep(child)) {
      throw new Error(
        `Internal compile error: emitParallelRetry reached a non-step child; ` +
          `isParallelFeedingAggregateGate should have rejected this carve-out.`,
      );
    }
    stepChildren.push(child);
  }
  // `c.bind!` is safe here because isParallelFeedingAggregateGate (called
  // upstream by processRetryGate) admits this code path only when every
  // step child has a bind that the downstream aggregate consumes — a
  // bindless step child would have been rejected before reaching emit.
  const names: string[] = stepChildren.map((c) => c.bind!);
  const lines: string[] = [];
  lines.push(`${pad}[${names.join(', ')}] = await parallel([`);
  for (let ci = 0; ci < stepChildren.length; ci++) {
    const child = stepChildren[ci];
    lines.push(`${pad}  async () => {`);
    lines.push(`${pad}    ${names[ci]} = ${emitRunAgentExpr(child, scope)};`);
    lines.push(`${pad}    return ${names[ci]};`);
    lines.push(`${pad}  },`);
  }
  lines.push(`${pad}]);`);
  return lines;
}

/** Build the lines that go inside a retry callback's body. Shared between
 *  step-host (`on_fail`) and aggregate-host (top-level `retry_from`) gates;
 *  the only host-specific bit is `gateReExec` — a `return <runAgent...>;`
 *  string for step gates, an `await aggregate({...}); return <bind>;` block
 *  for aggregate gates. The retry callback receives the prior attempt's
 *  verdict as `currentVerdict` (in scope inside the body); the rewritten
 *  prompt template interpolates it. Re-executes zone members in
 *  [retryFromIdx, gateIdx) with the target step's prompt rewritten via
 *  `buildRevisePromptExpr`. */
export function buildRetryBody(
  gateIdx: number,
  retryFromIdx: number,
  items: FlowItem[],
  gateItem: FlowItem,
  gate: RetryGateInfo,
  scope: Map<string, ProducerInfo>,
  pad: string,
  gateReExec: string[],
): string[] {
  const body: string[] = [];
  // Resolve `targetInfo` (agent name + producesPath) from the retry_from
  // target. The common case is `target = step-with-produces`, which gives
  // both fields. Aggregate-target retries are also admitted by
  // processRetryGate (with a "no-op retry" warning) but aggregates aren't
  // agents and don't write files of their own, so `targetProducer` has no
  // agentName/producesPath. The empty-string fallback for producesPath is
  // constructed here but not consumed for aggregate targets in practice:
  // the iteration below filters to step members via `isStep`, and
  // buildRevisePromptExpr only reads producesPath in the prompt-undefined
  // branch. The degenerate "at: " text appears only if a pipeline author
  // writes `retry_from: <aggregate-bind>` AND `revise_with: { inputs }`
  // (no prompt) — processRetryGate already warned the user that this is
  // a no-op zone, so the prompt text being slightly off is incidental.
  const targetProducer = scope.get(gate.retryFrom);
  if (targetProducer === undefined) {
    throw new Error(
      `Internal compile error: buildRetryBody called with retry_from='${gate.retryFrom}' ` +
        `that is not declared in scope; processRetryGate should have rejected this.`,
    );
  }
  const targetInfo = {
    agentName: targetProducer.agentName,
    producesPath: targetProducer.producesPath ?? '',
  };
  const revisePromptExpr = buildRevisePromptExpr(gate, targetInfo, scope);

  for (let k = retryFromIdx; k < gateIdx; k++) {
    const member = items[k];
    if (isStep(member)) {
      const memberBind = member.bind;
      if (memberBind === undefined) continue;
      if (k === retryFromIdx) {
        body.push(
          `${pad}    ${memberBind} = ${emitRunAgentExpr(member, scope, revisePromptExpr)};`,
        );
      } else {
        body.push(`${pad}    ${memberBind} = ${emitRunAgentExpr(member, scope)};`);
      }
    } else if (isAggregate(member)) {
      // Aggregate at intermediate position is deterministic given its
      // inputs; re-executing in the retry callback is a no-op. The
      // upstream re-run already refreshed those inputs, so skipping the
      // aggregate is equivalent to firing it again.
      continue;
    } else if (
      isParallel(member) &&
      gate.kind === 'aggregate' &&
      isAggregate(gateItem) &&
      isParallelFeedingAggregateGate(member, gateItem)
    ) {
      // Carve-out: re-fire the parallel's children. Step-host gates reject
      // all intermediate compounds at resolution time, so this branch is
      // only reachable from aggregate-gate retry zones. The dual `gate.kind`
      // / `isAggregate(gateItem)` checks are belt-and-suspenders — `gate` is
      // derived from `gateItem` upstream, so either condition would suffice
      // at runtime; the second narrows `gateItem` for the call below.
      body.push(...emitParallelRetry(member, scope, pad + '    '));
    } else if (isBranch(member)) {
      // Branch member: call the same closures the main pass invoked. The
      // arm bodies are sealed inside the closures by JS lexical scoping;
      // the retry callback CANNOT re-emit them — it must call the closures.
      // Bindless branches have no rejoin variable; they're not zone members,
      // so they don't appear in `buildRetryBody`. The retry-zone pre-pass
      // would have skipped them via `getBindName(member) === undefined`.
      const branchBind = member.branch.bind;
      if (branchBind === undefined) continue;
      const branchInfo = scope.get(branchBind);
      if (
        branchInfo === undefined ||
        branchInfo.kind !== 'branch' ||
        branchInfo.runThenName === undefined
      ) {
        throw new Error(
          `Internal compile error: buildRetryBody reached a branch member (bind '${branchBind}') ` +
            `whose ProducerInfo has no closure names. The main-pass branch emit should have stored ` +
            `runThenName before the retry callback's emit.`,
        );
      }
      // Substitute $-prefixed bind refs in the when: expression — same
      // discipline the main-pass branch emit applies.
      const whenExprSub = substituteBindRefs(member.branch.when, scope);
      // Revise-prompt threading: only the retry_from target's terminal step
      // receives the override. Intermediate branch members re-fire their
      // arms with no override (their terminal steps run with normal inputs).
      const promptArg = k === retryFromIdx ? revisePromptExpr : 'undefined';
      body.push(
        `${pad}    if (${whenExprSub}) ${branchBind} = await ${branchInfo.runThenName}(${promptArg});`,
      );
      // When the branch has no else arm, the else case assigns undefined —
      // mirroring the main-pass shape. The bind is non-consumable in this
      // case (classification.consumable === false; reason: 'missing_else'),
      // so downstream `$ref` was already rejected at the main-pass emit
      // and the `undefined` value never reaches a consumer.
      if (branchInfo.runElseName !== undefined) {
        body.push(`${pad}    else ${branchBind} = await ${branchInfo.runElseName}(${promptArg});`);
      } else {
        body.push(`${pad}    else ${branchBind} = undefined;`);
      }
    } else if (isForeach(member)) {
      // Foreach member: same shape rationale as branch above — the body
      // is sealed inside the module-level closure, so the retry callback
      // can only call it, not re-emit it. The closure was stored as
      // foreachBodyName on the foreach's ProducerInfo during the main-pass
      // emit; the retry callback references it by name.
      //
      // Bindless foreaches have no rejoin variable, so the retry-zone
      // pre-pass would have skipped them — but cover the case defensively
      // since the intermediate-zone walk admits them via `continue`.
      const foreachBind = member.foreach.bind;
      if (foreachBind === undefined) continue;
      const foreachInfo = scope.get(foreachBind);
      if (
        foreachInfo === undefined ||
        foreachInfo.kind !== 'foreach' ||
        foreachInfo.foreachBodyName === undefined
      ) {
        throw new Error(
          `Internal compile error: buildRetryBody reached a foreach member (bind '${foreachBind}') ` +
            `whose ProducerInfo has no foreachBodyName. The main-pass foreach emit should have stored ` +
            `the closure name before the retry callback's emit.`,
        );
      }
      const f = member.foreach;
      // Reproduce the syntheticName the main-pass emit picked. When bind
      // is set, the bind name doubles as the dir name (main-pass derived
      // it identically); when bindless, foreachSyntheticName carries the
      // fresh `foreach_N` so the retry doesn't recompute fresh() — that
      // would generate a fresh ID this retry-pass and write iter-N/ to
      // a different dir than the main pass. The main-pass emit always
      // populates foreachSyntheticName (emit-walker's foreach handler sets
      // it in the same statement that assigns dirName), so an undefined
      // value here is a compile-internal contract violation, not a
      // legitimate runtime state — surface it as such.
      const dirName = foreachInfo.foreachSyntheticName;
      if (dirName === undefined) {
        throw new Error(
          `Internal compile error: buildRetryBody reached a foreach member (bind '${foreachBind}') ` +
            `whose ProducerInfo has no foreachSyntheticName. The main-pass foreach emit should have ` +
            `populated it alongside foreachBodyName.`,
        );
      }
      // `over` is a file path the foreach runtime helper opens with
      // readFileSync — NOT an agent input. Emit the bare JS identifier for
      // a `$`-prefixed bind (substituteBindRefs drops the `$`) or a
      // JSON-stringified literal otherwise. Mirrors emit-walker.ts's
      // main-pass foreach emit.
      const overExpr = f.over.startsWith('$')
        ? substituteBindRefs(f.over, scope)
        : JSON.stringify(f.over);
      body.push(`${pad}    ${foreachBind} = await foreach({`);
      body.push(`${pad}      over: ${overExpr},`);
      body.push(`${pad}      overLabel: ${JSON.stringify(f.over)},`);
      if (f.bind !== undefined) {
        body.push(`${pad}      bindName: ${JSON.stringify(f.bind)},`);
      }
      body.push(`${pad}      syntheticName: ${JSON.stringify(dirName)},`);
      body.push(`${pad}      onIterationFail: ${JSON.stringify(f.on_iteration_fail ?? 'abort')},`);
      body.push(`${pad}      body: ${foreachInfo.foreachBodyName},`);
      body.push(`${pad}    });`);
    }
  }

  for (const line of gateReExec) body.push(`${pad}    ${line}`);
  return body;
}
