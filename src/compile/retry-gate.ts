import {
  FlowItem,
  StepItemT,
  AggregateItemT,
  ParallelItemT,
  isStep,
  isReviewLoop,
  isHumanGate,
  isParallel,
  isBranch,
  isAggregate,
  isForeach,
  agentLabel,
} from '../types.js';
import { getBindName } from './flow-helpers.js';
import { ProducerInfo } from './scope.js';
import { checkConsume } from './inputs.js';
import { RetryGateInfo, StepRetryGate, AggregateRetryGate, normalizeReviseWith } from './revise.js';

/** Read the step variant of a retry gate. Caller passes a step item — the
 *  narrowed parameter type makes mis-routing (e.g. handing an aggregate to
 *  this reader) a compile error rather than a runtime mystery. */
export function readStepRetryGate(item: StepItemT): StepRetryGate | undefined {
  if (item.on_fail === undefined) return undefined;
  return {
    kind: 'step',
    retryFrom: item.on_fail.retry_from,
    maxRetries: item.on_fail.max_retries ?? 1,
    onMaxExceeded: item.on_fail.on_max_exceeded ?? 'fail',
    verdictField: item.on_fail.verdict_field,
    approveWhen: item.on_fail.approve_when ?? 'pass',
    reviseWith: normalizeReviseWith(item.on_fail.revise_with),
    label: `step '${agentLabel(item.step, item.bind ?? 'inline-agent')}'`,
    gateAgentLabel: agentLabel(item.step, item.bind ?? 'inline-agent'),
  };
}

/** Read the aggregate variant of a retry gate. Caller passes an aggregate
 *  item — same narrowing rationale as readStepRetryGate. */
export function readAggregateRetryGate(item: AggregateItemT): AggregateRetryGate | undefined {
  const a = item.aggregate;
  if (a.retry_from === undefined) return undefined;
  const bindName = a.bind ?? '<unbound aggregate>';
  const label = `aggregate (bind '${bindName}')`;
  // Schema refine ("aggregate: 'retry_from' requires 'revise_with'") guarantees
  // revise_with is defined whenever retry_from is — narrow with `!` so the
  // compile-layer ReviseWithCompile DU stays cohesive.
  return {
    kind: 'aggregate',
    retryFrom: a.retry_from,
    maxRetries: a.max_retries ?? 1,
    onMaxExceeded: a.on_max_exceeded ?? 'fail',
    approveWhen: a.approve_when ?? 'pass',
    reviseWith: normalizeReviseWith(a.revise_with!),
    label,
    gateAgentLabel: label,
  };
}

export function readRetryGate(item: FlowItem): RetryGateInfo | undefined {
  if (isStep(item)) return readStepRetryGate(item);
  if (isAggregate(item)) return readAggregateRetryGate(item);
  return undefined;
}

/** Exposed subset of `readRetryGate` for callers outside the compile walker
 *  (e.g. `cli.ts`'s cursor-inside-retry-zone check) that need only the gate's
 *  retry_from target name and diagnostic label. Returns `undefined` when the
 *  item is not a retry gate. Single source of truth for "is this item a retry
 *  gate and what are its zone bounds?" — duplicating the host-specific shape
 *  checks (`'step' in item && item.on_fail !== undefined && ...`) outside
 *  compile/ would drift on every new gate-host kind. */
export function readRetryGateForCursorCheck(
  item: FlowItem,
): { retryFrom: string; label: string } | undefined {
  const gate = readRetryGate(item);
  if (gate === undefined) return undefined;
  return { retryFrom: gate.retryFrom, label: gate.label };
}

/** Predicate for the aggregate-gate intermediate-compound carve-out: a
 *  `parallel` is considered "feeding" an aggregate gate iff every child is
 *  a step AND every $-prefixed entry in the aggregate's `inputs:` map
 *  resolves to one of the parallel's child step binds. Mixed inputs are
 *  allowed (a literal-string entry doesn't disqualify the shape) but the
 *  parallel must contribute at least one referenced bind — without
 *  positive evidence of consumption there's no canonical loose-pattern
 *  to carve out. Restricted to step children only because the retry-body
 *  builder re-fires each parallel child via `emitParallelRetry`, which
 *  emits a `runAgent(...)` for step children only; admitting non-step
 *  children would emit a retry callback that silently skips them. */
export function isParallelFeedingAggregateGate(
  parallelItem: ParallelItemT,
  aggregateItem: AggregateItemT,
): boolean {
  const children = parallelItem.parallel;
  // Non-step children break the carve-out's re-execution contract. Bail
  // out early so the broader intermediate-compound rejection surfaces a
  // generic "parallel intermediate" error — `findNonStepParallelChild` is
  // the right place to throw a child-specific error when the OUTER shape
  // would otherwise admit the carve-out.
  for (const child of children) {
    if (!isStep(child)) return false;
  }
  const childBinds = new Set<string>();
  for (const child of children) {
    if (!isStep(child)) continue;
    if (child.bind !== undefined) childBinds.add(child.bind);
  }
  const aggInputs = aggregateItem.aggregate.inputs;
  let hasRefFromParallel = false;
  for (const v of Object.values(aggInputs)) {
    if (typeof v !== 'string' || !v.startsWith('$')) continue;
    const refName = v.slice(1);
    if (!childBinds.has(refName)) return false;
    hasRefFromParallel = true;
  }
  return hasRefFromParallel;
}

/** When a parallel sits between an aggregate-gate's `retry_from` target and
 *  the gate AND its bind set would otherwise admit the carve-out, identify
 *  any non-step child so the rejection error can name the exact offender.
 *  Returns the offending child's kind ('review_loop', 'parallel', etc.) or
 *  undefined when every child is a step. */
export function findNonStepParallelChild(parallelItem: ParallelItemT): string | undefined {
  for (const child of parallelItem.parallel) {
    if (isStep(child)) continue;
    if (isReviewLoop(child)) return 'review_loop';
    if (isParallel(child)) return 'parallel';
    if (isBranch(child)) return 'branch';
    if (isAggregate(child)) return 'aggregate';
    if (isHumanGate(child)) return 'human_gate';
    return 'unknown';
  }
  return undefined;
}

/** Does the parallel's bind set otherwise satisfy the carve-out (every
 *  aggregate `inputs:` $ref resolves to a child bind, at least one such
 *  ref present)? Ignores child-kind so the caller can distinguish "shape
 *  doesn't fit at all" (generic intermediate-compound rejection) from
 *  "shape fits but a child violates the all-step rule" (the specific
 *  reject this function lets the caller produce). */
export function parallelBindsFeedAggregateGate(
  parallelItem: ParallelItemT,
  aggregateItem: AggregateItemT,
): boolean {
  const childBinds = new Set<string>();
  for (const child of parallelItem.parallel) {
    if (isStep(child)) {
      if (child.bind !== undefined) childBinds.add(child.bind);
    } else if (isReviewLoop(child)) {
      const cb = child.review_loop.bind;
      if (cb !== undefined) childBinds.add(cb);
    }
  }
  const aggInputs = aggregateItem.aggregate.inputs;
  let hasRefFromParallel = false;
  for (const v of Object.values(aggInputs)) {
    if (typeof v !== 'string' || !v.startsWith('$')) continue;
    const refName = v.slice(1);
    if (!childBinds.has(refName)) return false;
    hasRefFromParallel = true;
  }
  return hasRefFromParallel;
}

/** Active retry-zone descriptor. Each retry gate (step `on_fail` or aggregate
 *  `retry_from`) appends one of these to `RetryGateCtx.activeZones` after
 *  passing semantic-gap validation; the nested-zone cost warning reads the
 *  list to detect overlapping zones in the same lexical scope. */
export interface ZoneInfo {
  gateName: string;
  retryFromIdx: number;
  gateIdx: number;
  maxRetries: number;
}

/** State threaded into `processRetryGate` for one emit-pass iteration:
 *  - `scope` — producer map for this lexical scope; read by retry-target
 *    resolution and `revise_with` checkConsume.
 *  - `currentScopeId` — scope identifier used to enforce same-scope retry
 *    targets.
 *  - `items` — items array currently being emitted; used for the
 *    `retryFromIdx` lookup that drives the intermediate-compound walk.
 *  - `activeZones` — accumulator the function appends to; see the
 *    hidden-state contract below. */
interface RetryGateCtx {
  scope: Map<string, ProducerInfo>;
  currentScopeId: number;
  items: FlowItem[];
  activeZones: ZoneInfo[];
}

/** Resolve `retry_from` against the current scope, apply every semantic-gap
 *  rejection (self-ref, cross-scope, pipeline-input target,
 *  hoisted-parallel-child target, compound-primitive target,
 *  missing-produces), validate the intermediate-compound walk with the
 *  aggregate-gate carve-out, validate `revise_with.inputs` $refs via
 *  `checkConsume`, fire the nested-zone cost warning, and register this gate
 *  in `ctx.activeZones`. `gateBind` is the bind name of the gate item (used
 *  for self-reference detection and the available-binds error list); for
 *  aggregate gates it may be a fresh-generated name when the YAML didn't
 *  supply `bind:`.
 *
 *  Hidden-state contract — non-negotiable: `ctx` is held by reference.
 *  `processRetryGate` mutates `ctx.activeZones` via `.push()`; do NOT
 *  destructure `activeZones` out of `ctx` inside this function. Read-only
 *  destructuring of `scope`/`items`/`currentScopeId` is acceptable. Any
 *  write goes through `ctx.activeZones.push(...)` or breaks the contract
 *  silently. */
export function processRetryGate(
  gate: RetryGateInfo,
  gateBind: string,
  gateItem: FlowItem,
  gateIdx: number,
  ctx: RetryGateCtx,
): void {
  const { scope, currentScopeId, items } = ctx;
  const gateLabelForErr = gate.label;
  const retryFromName = gate.retryFrom;
  if (retryFromName === gateBind) {
    throw new Error(
      `Compile error: ${gateLabelForErr} has retry_from='${retryFromName}', ` +
        `which references itself. retry_from must point to an earlier same-scope bind.`,
    );
  }
  const target = scope.get(retryFromName);
  if (target === undefined || target.declarationScope !== currentScopeId) {
    const available = Array.from(scope.entries())
      .filter(([k, v2]) => k !== gateBind && v2.declarationScope === currentScopeId)
      .map(([k]) => k)
      .join(', ');
    if (target === undefined) {
      throw new Error(
        `Compile error: ${gateLabelForErr} has retry_from='${retryFromName}', ` +
          `but that bind is not declared in this scope. Available binds before this gate: [${available}].`,
      );
    }
    throw new Error(
      `Compile error: ${gateLabelForErr} has retry_from='${retryFromName}', ` +
        `which references a bind in a different scope. retry_from must point to a bind in the ` +
        `same lexical scope as the gate. Available binds in this scope: [${available}].`,
    );
  }
  if (target.kind === 'input') {
    throw new Error(
      `Compile error: ${gateLabelForErr} has retry_from='${retryFromName}', which ` +
        `targets a pipeline input. Pipeline inputs are not steps — they're data passed in at runtime — ` +
        `so 'retry from a pipeline input' is undefined. Pick an earlier step's bind as the retry_from target.`,
    );
  }
  if (target.hoistedFromParallel) {
    throw new Error(
      `Compile error: ${gateLabelForErr} has retry_from='${retryFromName}', which targets a ` +
        `parallel block's child step. v0.1.x retry zones cannot target individual parallel children — ` +
        `parallel children have no ordering, so 'retry from one child' is undefined. ` +
        `Workaround: add 'bind:' to the parallel block itself and target the parallel's bind, OR ` +
        `restructure to keep the retry zone atomic.`,
    );
  }
  if (target.kind === 'review_loop' || target.kind === 'parallel') {
    throw new Error(
      `Compile error: ${gateLabelForErr} has retry_from='${retryFromName}', ` +
        `whose target is a ${target.kind} ('${retryFromName}'). v0.1.x retry zones support ` +
        `atomic steps + branches; ${target.kind} as target is deferred to a follow-up. ` +
        `Workaround: restructure to keep the retry zone atomic, OR wrap the compound's logic ` +
        `in a single agent step.`,
    );
  }
  if (target.kind === 'step' && target.producesPath === undefined) {
    throw new Error(
      `Compile error: ${gateLabelForErr} has retry_from='${retryFromName}', ` +
        `but that step has no produces: so there is no file to overwrite on retry. ` +
        `Add 'produces:' to step '${target.agentName}' or pick a different retry_from target.`,
    );
  }
  if (target.kind === 'aggregate') {
    // Aggregate is deterministic given its inputs — re-running it alone
    // produces the same verdict. The warning is informational because
    // some pipelines may legitimately want this when the aggregate's
    // inputs are zone members.
    console.warn(
      `WARN: ${gateLabelForErr} has retry_from='${retryFromName}', which ` +
        `targets an aggregate. Aggregate is deterministic given its inputs; retrying it is ` +
        `a no-op unless its inputs are also in the retry zone.`,
    );
  }
  // Validate revise_with.inputs $refs — schema enforces the `$`-prefix,
  // and checkConsume catches non-anchored / out-of-scope refs (including
  // an aggregate gate's self-reference, since aggregate binds are not
  // file-bound). The check fires per-entry so each bad ref gets its own
  // error message pointing at the offending index.
  if (gate.reviseWith.inputs !== undefined) {
    for (let idx = 0; idx < gate.reviseWith.inputs.length; idx++) {
      const entry = gate.reviseWith.inputs[idx];
      checkConsume(entry, `${gateLabelForErr}.revise_with.inputs[${idx}]`, scope);
    }
  }
  // Intermediate-compound walk + aggregate-gate carve-out. Step gates
  // reject every non-step / non-aggregate intermediate; aggregate gates
  // additionally accept a parallel whose hoisted children are consumed
  // by the aggregate's `inputs:` map (the canonical loose-pattern
  // shape).
  const retryFromIdx = items.findIndex((m, j) => j < gateIdx && getBindName(m) === retryFromName);
  if (retryFromIdx >= 0) {
    // `gate.kind === 'aggregate'` is derived from gateItem, so when set we
    // know gateItem is an AggregateItemT. Capture the narrowed reference
    // once for the inner predicate calls.
    const aggregateGateItem =
      gate.kind === 'aggregate' && isAggregate(gateItem) ? gateItem : undefined;
    for (let k = retryFromIdx + 1; k < gateIdx; k++) {
      const member = items[k];
      if (isStep(member) || isAggregate(member)) continue;
      // Branch members are admitted unconditionally as intermediate
      // retry-zone members under the explicit-rejoin rule. The retry
      // callback re-fires the branch by invoking its arm closures, not
      // by re-emitting arm bodies; arm-internal binds stay sealed inside
      // the closure scope by JS semantics. Branches without a bind have
      // no rejoin variable and are skipped by `buildRetryBody` (its
      // branch case checks `member.branch.bind` and continues for
      // bindless branches).
      if (isBranch(member)) continue;
      // Foreach members are admitted as intermediate zone members. The
      // retry callback re-invokes the body closure stored in
      // foreachBodyName; body-internal binds stay sealed inside the
      // closure scope by JS semantics. Bindless foreaches (no rejoin
      // variable) are skipped by buildRetryBody's foreach case the same
      // way bindless branches are.
      if (isForeach(member)) continue;
      if (
        aggregateGateItem !== undefined &&
        isParallel(member) &&
        isParallelFeedingAggregateGate(member, aggregateGateItem)
      ) {
        continue;
      }
      // Bind-set fits the carve-out shape but a non-step child violates
      // the all-step rule the retry-body builder can re-execute. Name
      // the offending child kind so the user can locate it directly,
      // instead of falling through to the generic "parallel
      // intermediate" message.
      if (
        aggregateGateItem !== undefined &&
        isParallel(member) &&
        parallelBindsFeedAggregateGate(member, aggregateGateItem)
      ) {
        const offending = findNonStepParallelChild(member);
        if (offending !== undefined) {
          throw new Error(
            `Compile error: retry zone gated by ${gateLabelForErr} contains a parallel at ` +
              `position ${k} whose binds feed the aggregate gate but which has a ${offending} ` +
              `child. The parallel-feeding-aggregate-gate carve-out admits parallels with step ` +
              `children only; ${offending} children inside a retry-zone parallel are deferred ` +
              `to a follow-up. Workaround: flatten the ${offending} into atomic steps, or move ` +
              `the parallel outside the retry zone.`,
          );
        }
      }
      let memberKind: string;
      if (isReviewLoop(member)) memberKind = 'review_loop';
      else if (isParallel(member)) memberKind = 'parallel';
      else if (isBranch(member)) memberKind = 'branch';
      else if (isHumanGate(member)) memberKind = 'human_gate';
      else memberKind = 'unknown';
      throw new Error(
        `Compile error: retry zone gated by ${gateLabelForErr} contains a ${memberKind} at ` +
          `position ${k} (between retry_from target and gate). v0.1.x retry zones support ` +
          `intermediate atomic steps only; compound primitives in retry zones are deferred ` +
          `to a follow-up. Workaround: restructure to keep the retry zone atomic.`,
      );
    }
  }
  // Nested-zone cost warning. Closed-interval overlap; touching at a
  // single shared step counts so the outer's retry re-runs the inner's
  // gate. retryFromIdx < 0 (pipeline-input target) was already rejected
  // above, but the formula handles negative values uniformly.
  const innerMaxR = gate.maxRetries;
  for (const prior of ctx.activeZones) {
    const overlapLo = Math.max(retryFromIdx, prior.retryFromIdx);
    const overlapHi = Math.min(gateIdx, prior.gateIdx);
    if (overlapLo <= overlapHi) {
      const mult = (prior.maxRetries + 1) * (innerMaxR + 1);
      console.warn(
        `WARN: retry zone gated by '${gateLabelForErr}' is nested inside retry zone gated by ` +
          `'${prior.gateName}' (same scope).\n` +
          `      Worst-case multiplier: (${prior.maxRetries}+1) × (${innerMaxR}+1) = ${mult} invocations of the innermost step.\n` +
          `      Set max_retries explicitly if this is intentional.`,
      );
    }
  }
  ctx.activeZones.push({
    gateName: gateLabelForErr,
    retryFromIdx,
    gateIdx,
    maxRetries: innerMaxR,
  });
}
