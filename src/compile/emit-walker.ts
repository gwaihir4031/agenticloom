import {
  FlowItem,
  isStep,
  isReviewLoop,
  isHumanGate,
  isParallel,
  isBranch,
  isAggregate,
  isForeach,
  agentLabel,
  inlinePromptOf,
} from '../types.js';
import { ensureTerminalBindForArm, val, resultNameFor, getBindName } from './flow-helpers.js';
import {
  validateReviewerSubflow,
  validatePath,
  validatePersonaFile,
  readReviewerArm,
} from './validation.js';
// Type-only: `AgentCli` is a string union, erased at emit; keeps emit-walker's
// module graph free of runtime/agent.ts's heavy deps (same posture as
// validation.ts, whose helpers this file already shares).
import type { AgentCli } from '../runtime/agent.js';
import {
  ProducerInfo,
  declare,
  registerPath,
  mergeChildIntoParent,
  stepProducerInfo,
} from './scope.js';
import { inputExprFor, checkConsume, collectReviewerPaths, substituteBindRefs } from './inputs.js';
import {
  readStepRetryGate,
  readAggregateRetryGate,
  readRetryGate,
  isParallelFeedingAggregateGate,
  processRetryGate,
  ZoneInfo,
} from './retry-gate.js';
import { emitRunAgentExpr, emitAggregateCallInner, buildRetryBody } from './emit-call.js';
import { classifyArmTerminals } from './branch-arms.js';

/** Per-recursion context that signals "the current `emit()` invocation is a
 *  branch arm's closure body, and the terminal item inside it should propagate
 *  the closure's revise-prompt parameter to the writer agent on retry."
 *
 *  Terminal identity is positional, not name-based: `emit()`'s item loop only
 *  threads `terminalContext` into the LAST item's processing (the literal
 *  last element of the arm's `FlowItem[]`). Consumers therefore check
 *  `terminalContext !== undefined` to mean "I am the terminal of the arm
 *  whose closure body I'm inside" — no bind-name match required, which means
 *  side-effect-step terminals (no `produces:`, no `bind:`; admitted as
 *  arm terminals because the arm only needs a terminal item, not a
 *  file-bound one, when nothing downstream `$ref`s the branch's bind)
 *  work the same as terminals with a `produces:`.
 *
 *  Read by two emit handlers:
 *
 *  - Step terminal: the step-emit handler, on the last iteration of its
 *    items loop, swaps the runAgent input expression to
 *    `(revisePromptForTerminal ?? <normal>)`, so the step's runAgent sees
 *    the revise prompt on retry and its normal input on the main pass
 *    (runtime `??`).
 *
 *  - Nested-branch terminal (recursive threading): the branch-emit handler,
 *    on the last iteration of its items loop, threads
 *    `revisePromptForTerminal` as the argument when
 *    invoking the nested branch's `runThen_<innerBind>` / `runElse_<innerBind>`
 *    closures from the main-pass call site (inside the outer arm's closure
 *    body). The nested closures declare `revisePromptForTerminal` as a plain
 *    untyped parameter (no `?: string` annotation — Node rejects TS syntax
 *    on the `.mjs` temp; see the closure-declaration site in the branch
 *    emit handler for the rationale), and every call site passes an explicit
 *    argument (literal `undefined` on the main pass with no outer context,
 *    or the outer closure's parameter when threaded). The parameter flows
 *    recursively to the inner terminals.
 *
 *  Other terminal kinds (review_loop, interactive human_gate) don't consume
 *  the parameter in v1: their writer-revise threading uses different
 *  surfaces (review_loop's own revise prompt; human_gate doesn't get
 *  programmatic prompts).
 *
 *  Reset to `undefined` on every recursion into a non-terminal compound
 *  primitive (parallel children, review_loop subflows, foreach bodies).
 *  Only the outer arm's literal terminal item — step or nested branch —
 *  consumes the parameter. */
interface EmitTerminalContext {
  revisePromptIdent: string;
  /** Name of the arm closure's `reviseInputPathsForTerminal` parameter,
   *  threaded in lockstep with `revisePromptIdent`. The terminal step's
   *  inputPaths clause becomes `<ident> ?? [<original>]` so the pre-flight
   *  check follows `revise_with` on retry, exactly as the prompt does. */
  reviseInputPathsIdent: string;
}

/** Emit zero or more lines for a pre-cursor top-level item under
 *  `--resume-from`. Returns an array (empty when the item has no bind to
 *  declare). The lines are pure bind-assignments to path-string literals
 *  (for anchored producers) or `undefined` (for non-anchored producers);
 *  no agent spawn, no `produces:` registration in `pathScope`.
 *
 *  Pre-cursor items still call `declare()` so post-cursor `$ref` consumers
 *  resolve correctly. They do NOT call `validatePath` / `registerPath` —
 *  the rewrite emits no runtime side effect, so registering the path
 *  against the shared `pathScope` would synthesize a spurious sibling
 *  whose collisions are an artifact of the rewrite, not a real
 *  concurrent-write hazard.
 *
 *  Parallel pre-cursor items also emit one path-literal line per
 *  anchored hoisted child — mirroring the outer-scope hoist that the
 *  normal parallel emit performs. Without this, a post-cursor `$ref` to
 *  a hoisted child name would loud-fail at `checkConsume` because the
 *  pre-cursor parallel never reached the hoist step. Other containers
 *  (branch, review_loop) do NOT hoist their interior binds, so this is
 *  the one documented descent in the rewrite. */
export function emitPreCursorItem(
  item: FlowItem,
  scope: Map<string, ProducerInfo>,
  currentScopeId: number,
  pad: string,
  fresh: () => string,
): string[] {
  if (isStep(item)) {
    if (item.bind === undefined) return [];
    const resolvedLabel = agentLabel(item.step);
    declare(item.bind, stepProducerInfo(item, `step '${resolvedLabel}'`), scope, currentScopeId);
    const rhs = item.produces ? JSON.stringify(item.produces) : 'undefined';
    return [`${pad}const ${item.bind} = ${rhs};`];
  }
  if (isReviewLoop(item)) {
    const r = item.review_loop;
    if (r.bind === undefined) return [];
    const resolvedWriter = agentLabel(r.writer);
    declare(
      r.bind,
      {
        kind: 'review_loop',
        fileBound: true,
        location: `review_loop writer='${resolvedWriter}'`,
        fileField: 'writer_produces',
        agentName: resolvedWriter,
      },
      scope,
      currentScopeId,
    );
    return [`${pad}const ${r.bind} = ${JSON.stringify(r.writer_produces)};`];
  }
  if (isAggregate(item)) {
    const a = item.aggregate;
    if (a.bind === undefined) return [];
    declare(
      a.bind,
      {
        kind: 'aggregate',
        fileBound: false,
        location: `aggregate (bind '${a.bind}')`,
        fileField: '',
        agentName: `aggregate (bind '${a.bind}')`,
      },
      scope,
      currentScopeId,
    );
    return [`${pad}const ${a.bind} = undefined;`];
  }
  if (isParallel(item)) {
    const lines: string[] = [];
    // Hoist mirror: emit one path-literal line per anchored hoisted child,
    // matching the outer-scope hoist the normal parallel emit performs.
    // `hoistedFromParallel: true` is preserved on the declare so retry_from
    // resolution still rejects "retry from one parallel child" on post-
    // cursor retries — file-boundness, agent name, and hoist marker stay
    // consistent with the non-resumed shape.
    //
    // Hoist all bind-carrying child kinds, not just steps. The CLI's
    // `enumerateTopLevelBinds` admits any bind-carrying parallel child as
    // a hoisted name; the compile must mirror that or a post-cursor $ref
    // to a hoisted review_loop / aggregate child surfaces as a misleading
    // "unknown bind" inside checkConsume instead of a structured rewrite.
    for (const child of item.parallel) {
      if (isStep(child)) {
        if (child.bind === undefined) continue;
        const childLabel = agentLabel(child.step);
        declare(
          child.bind,
          {
            ...stepProducerInfo(child, `step '${childLabel}' (hoisted from parallel)`),
            hoistedFromParallel: true,
          },
          scope,
          currentScopeId,
        );
        const childRhs = child.produces ? JSON.stringify(child.produces) : 'undefined';
        lines.push(`${pad}const ${child.bind} = ${childRhs};`);
      } else if (isReviewLoop(child)) {
        const r = child.review_loop;
        if (r.bind === undefined) continue;
        const resolvedWriter = agentLabel(r.writer);
        declare(
          r.bind,
          {
            kind: 'review_loop',
            fileBound: true,
            location: `review_loop writer='${resolvedWriter}' (hoisted from parallel)`,
            fileField: 'writer_produces',
            agentName: resolvedWriter,
            hoistedFromParallel: true,
          },
          scope,
          currentScopeId,
        );
        lines.push(`${pad}const ${r.bind} = ${JSON.stringify(r.writer_produces)};`);
      } else if (isAggregate(child)) {
        const a = child.aggregate;
        if (a.bind === undefined) continue;
        declare(
          a.bind,
          {
            kind: 'aggregate',
            fileBound: false,
            location: `aggregate (bind '${a.bind}') (hoisted from parallel)`,
            fileField: '',
            agentName: `aggregate (bind '${a.bind}')`,
            hoistedFromParallel: true,
          },
          scope,
          currentScopeId,
        );
        lines.push(`${pad}const ${a.bind} = undefined;`);
      }
    }
    if (item.bind !== undefined) {
      declare(
        item.bind,
        {
          kind: 'parallel',
          fileBound: false,
          location: `parallel block (bind '${item.bind}')`,
          fileField: '',
          agentName: `parallel block (bind '${item.bind}')`,
        },
        scope,
        currentScopeId,
      );
      lines.push(`${pad}const ${item.bind} = undefined;`);
    }
    return lines;
  }
  if (isBranch(item)) {
    // Branch's `bind:` is nested INSIDE the `branch:` block (alongside
    // `when`/`then`/`else`), unlike parallel's bind which sits at the
    // wrapper level. Reading `item.branch.bind` matches the normal-emit
    // shape at the main branch emit handler below.
    const b = item.branch;
    if (b.bind === undefined) return [];
    // Synthesize terminal binds before classification — same discipline
    // the main branch emit applies. `classifyArmTerminal` reads
    // `last.bind` for the `path` field, which the pre-cursor path doesn't
    // ultimately use (it relies on `allLeafPaths` instead) — but the
    // classifier's internal check still demands the bind exist.
    ensureTerminalBindForArm(b.then, fresh);
    if (b.else) ensureTerminalBindForArm(b.else, fresh);
    // Classify the arms BEFORE declaring the bind, so we know whether to
    // rehydrate via disk-probe (consumable + file-bound) or to emit the
    // plain `const <bind> = undefined;` (non-consumable). Classification
    // is pure: it inspects the arm's terminal item plus the outer scope.
    const classification = classifyArmTerminals(b, scope);
    if (!classification.consumable) {
      // Non-consumable: emit a bare `const <bind> = undefined;` line. The
      // bind exists for retry-zone walking and `retry_from:` targeting;
      // post-cursor `$ref` consumers would have been rejected by
      // `checkConsume` earlier when the classification ran.
      declare(
        b.bind,
        {
          kind: 'branch',
          fileBound: false,
          location: `branch (bind '${b.bind}')`,
          fileField: '',
          agentName: `branch (bind '${b.bind}')`,
          branchConsumability: classification,
        },
        scope,
        currentScopeId,
      );
      return [`${pad}const ${b.bind} = undefined;`];
    }
    // Consumable file-bound branch: rehydrate via disk probe. v1 only
    // constructs `kind: 'file'`; the string-bound branch arm extension
    // dispatches `kind: 'string'` to a different rehydration path.
    if (classification.kind !== 'file') {
      throw new Error(
        `Internal compile error: emitPreCursorItem reached a branch with consumable ` +
          `kind='${classification.kind}' but v1's emitPreCursorItem only handles 'file'. ` +
          `The string-bound branch arm extension must have landed partially.`,
      );
    }
    declare(
      b.bind,
      {
        kind: 'branch',
        fileBound: true,
        location: `branch (bind '${b.bind}')`,
        fileField: '',
        agentName: `branch (bind '${b.bind}')`,
        branchConsumability: classification,
      },
      scope,
      currentScopeId,
    );
    // Single-leaf-path fast path: when every arm writes to the same file,
    // the bind value is unambiguous — emit a literal assignment, no IIFE.
    const uniquePaths = Array.from(new Set(classification.allLeafPaths));
    if (uniquePaths.length === 1) {
      return [`${pad}const ${b.bind} = ${JSON.stringify(uniquePaths[0])};`];
    }
    // Multi-path probe: emit an IIFE that checks each leaf path. Exactly
    // one should exist; if zero or more than one exists, throw a clear
    // resume-time error naming all probed paths.
    const probeCandidates = uniquePaths.map((p) => JSON.stringify(p)).join(', ');
    return [
      `${pad}const ${b.bind} = (() => {`,
      `${pad}  const __candidates = [${probeCandidates}];`,
      `${pad}  const __existing = __candidates.filter(p => fileExists(p));`,
      `${pad}  if (__existing.length === 1) return __existing[0];`,
      `${pad}  if (__existing.length === 0) {`,
      `${pad}    throw new Error(`,
      `${pad}      'Resume error: branch ${b.bind} has no terminal file on disk. ' +`,
      `${pad}      'Probed: ' + __candidates.map(p => JSON.stringify(p)).join(', ') + '. ' +`,
      `${pad}      'The prior run likely aborted before the branch executed, or the workspace was modified. ' +`,
      `${pad}      'Re-run from an earlier cursor, or write one of the probed files manually.'`,
      `${pad}    );`,
      `${pad}  }`,
      `${pad}  throw new Error(`,
      `${pad}    'Resume error: branch ${b.bind} has multiple terminal files on disk (ambiguous). ' +`,
      `${pad}    'Present: ' + __existing.map(p => JSON.stringify(p)).join(', ') + '. ' +`,
      `${pad}    'Clean the workspace to leave only the surviving arm\\'s file before resuming.'`,
      `${pad}  );`,
      `${pad}})();`,
    ];
  }
  if (isForeach(item)) {
    // Pre-cursor foreach: declare the bind in scope so post-cursor lookups
    // resolve, but emit `const <bind> = undefined;` because the foreach is
    // list-bound — downstream `$ref` consumption is rejected by checkConsume
    // anyway. No body emit, no closure, no module-level declarations:
    // pre-cursor items are pure skip-and-declare. foreachBodyName /
    // foreachSyntheticName are intentionally left undefined — pre-cursor
    // foreach entries never participate in retry zones (cli.ts rejects
    // cursors strictly inside a zone), so buildRetryBody's foreach case
    // is unreachable on pre-cursor entries.
    const f = item.foreach;
    if (f.bind === undefined) return [];
    declare(
      f.bind,
      {
        kind: 'foreach',
        fileBound: false,
        location: `foreach (bind '${f.bind}')`,
        fileField: '',
        agentName: `foreach (bind '${f.bind}')`,
      },
      scope,
      currentScopeId,
    );
    return [`${pad}const ${f.bind} = undefined;`];
  }
  // human_gate has no `bind:` field; nothing to declare or emit.
  return [];
}

/** Per-compile constants threaded through the emit recursion as one value.
 *  Everything here is invariant across the whole walk — recursion never
 *  varies it — so new pipeline-level constants join this object instead of
 *  growing every recursive call site by another positional param. */
export interface EmitCtx {
  readonly agentDirs: readonly string[];
  readonly cli: AgentCli;
}

export function emit(
  items: FlowItem[],
  pad: string,
  scope: Map<string, ProducerInfo>,
  fresh: () => string,
  ctx: EmitCtx,
  nextScopeId: () => number,
  currentScopeId: number,
  pathScope?: Map<string, string>,
  resumeCursor?: string,
  terminalContext?: EmitTerminalContext,
): string[] {
  const out: string[] = [];
  // Resume cursor index — two-stage lookup mirroring cli.ts's
  // `enumerateTopLevelBinds` dual-write:
  //   1. Direct match against any top-level item's bind.
  //   2. Hoisted-child fallback: scan top-level parallel items' children
  //      for a child whose bind matches the cursor name; resolve to the
  //      enclosing parallel's index. Without this, a cursor naming a
  //      hoisted parallel-child bind would fall through to the defensive
  //      throw, contradicting the spec's "hoisted-from-parallel bind
  //      named as the cursor: Allowed" row.
  // The cursor is guaranteed to resolve under one of these stages by
  // cli.ts's prior validation; if both return -1 despite that, the
  // cli.ts→compile/emit-walker.ts contract has drifted and we throw loud
  // rather than silently shipping an emit that ignores the cursor.
  let cursorIdx = -1;
  if (resumeCursor !== undefined) {
    cursorIdx = items.findIndex((item) => getBindName(item) === resumeCursor);
    if (cursorIdx < 0) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!isParallel(item)) continue;
        if (item.parallel.some((c) => getBindName(c) === resumeCursor)) {
          cursorIdx = i;
          break;
        }
      }
    }
    if (cursorIdx < 0) {
      throw new Error(
        `Internal compile error: --resume-from cursor '${resumeCursor}' does not match ` +
          `any top-level bind in the current scope. cli.ts must have validated this before ` +
          `calling compile() with resumeFrom set.`,
      );
    }
  }
  // Per-scope active retry zones. Tracks every on_fail-gated step processed
  // earlier in THIS lexical scope so subsequent on_fail steps can warn when
  // their zones overlap (worst-case multiplier from compounded retries).
  // Fresh array per emit() invocation — parallel/branch/review_loop subscopes
  // recurse with their own empty zones array, which is why linear containment
  // (e.g. `branch` arm with one zone inside) does NOT warn: the outer scope
  // sees no zones, the inner scope sees only its own. Spec § 5 (nested-zone
  // cost warning).
  const activeZones: ZoneInfo[] = [];
  // Zone-member pre-pass: every bind whose owner sits between any on_fail
  // gate's retry_from target and that gate's index (both inclusive, same
  // scope) is a "zone member" and gets emitted as `let` instead of `const`
  // so the retry callback can re-assign it. The pre-pass runs ONCE per
  // emit() invocation (per lexical scope) and intentionally does NOT cross
  // into nested parallel children / branch arms / review_loop subflows —
  // those recurse with their own emit() call and their own zoneMembers set.
  // The set stays empty for pipelines that don't use on_fail, preserving
  // byte-identical output for every shipped pipeline.
  const zoneMembers = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    // Read host-agnostically: both step-on_fail and aggregate-retry_from
    // gates contribute zone members the same way. Atomic parallel children
    // inside the carve-out shape also get reassigned on retry, so the
    // pre-pass descends into the parallel's children too — without that,
    // they'd be `const` and the retry callback couldn't reassign them.
    const gate = readRetryGate(items[i]);
    if (gate === undefined) continue;
    // Pre-cursor gates are rewritten wholesale to bind-assignments by
    // emitPreCursorItem; their zone members become `const` literals, not
    // `let`-mutable slots. Skipping the zone-membership additions here
    // keeps the rewrite's `const` declarations from clashing with the
    // pre-pass implying `let`. cli.ts's cursor-inside-retry-zone check
    // already rejects cursors that sit strictly between retryFromIdx and
    // gateIdx, so a zone whose gate is pre-cursor has its entire span
    // pre-cursor; no zone-member declarations need `let`.
    if (cursorIdx >= 0 && i < cursorIdx) continue;
    const retryFromIdx = items.findIndex((m, j) => j < i && getBindName(m) === gate.retryFrom);
    if (retryFromIdx < 0) continue;
    // `gate.kind === 'aggregate'` was derived from items[i], so when that
    // discriminant is set we know items[i] is an AggregateItemT. Snapshot the
    // narrowed reference once so the inner branch can pass it to the carve-
    // out predicate without re-narrowing per iteration.
    const gateItem = items[i];
    const aggregateGateItem =
      gate.kind === 'aggregate' && isAggregate(gateItem) ? gateItem : undefined;
    for (let j = retryFromIdx; j <= i; j++) {
      const member = items[j];
      const b = getBindName(member);
      if (b !== undefined) zoneMembers.add(b);
      if (
        aggregateGateItem !== undefined &&
        isParallel(member) &&
        isParallelFeedingAggregateGate(member, aggregateGateItem)
      ) {
        for (const child of member.parallel) {
          const cb = getBindName(child);
          if (cb !== undefined) zoneMembers.add(cb);
        }
      }
    }
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    // Position-based terminal flag for branch-arm closure bodies. When this
    // `emit()` invocation is processing a branch arm whose closure should
    // propagate the revise prompt to its terminal item, the caller threads
    // a `terminalContext`. Only the LITERAL last item of the arm
    // (`items.length - 1`) consumes that context; earlier items see
    // `undefined` so the override does not leak to intermediate steps.
    // Reading the flag this way means the terminal need not carry a bind
    // for the consumer to identify it — the side-effect-step pattern
    // (no `produces:` and no required `bind:`; valid when nothing
    // downstream $refs the branch's bind) is handled by the same
    // mechanism that handles the consumable case.
    const itemTerminalContext = i === items.length - 1 ? terminalContext : undefined;
    if (cursorIdx >= 0 && i < cursorIdx) {
      // Pre-cursor item: emit bind-assignment(s), no agent spawn. See
      // emitPreCursorItem for the per-kind rewrite shape.
      const preCursorEmit = emitPreCursorItem(item, scope, currentScopeId, pad, fresh);
      if (preCursorEmit.length > 0) out.push(...preCursorEmit);
      continue;
    }
    if (isStep(item)) {
      const v = item.bind ?? fresh();
      // Resolve the step's agent reference to a label once: a persona name is
      // itself; an inline agent is its required `name`. Synthesized `_N` binds
      // (resultNameFor) are emit-internal variable names and never become
      // labels. Drives the runAgent name, the ProducerInfo label, and every
      // diagnostic in this branch.
      const resolvedLabel = agentLabel(item.step);
      const stepLabel = `step '${resolvedLabel}'`;
      // Run consume-side checks for their side effects (declarations errors,
      // file-bound validation). String-building of the runAgent call itself
      // is delegated to `emitRunAgentExpr` (in emit-call.ts) so the on_fail
      // retry callback can reuse the exact same emit shape.
      if (item.inputs) {
        for (const [k, expr] of Object.entries(item.inputs)) {
          checkConsume(expr, `${stepLabel}.inputs[${JSON.stringify(k)}]`, scope);
        }
      } else {
        checkConsume(item.input, `${stepLabel}.input`, scope);
      }
      if (item.produces) {
        validatePath(item.produces, 'produces', stepLabel);
        registerPath(item.produces, 'produces', stepLabel, pathScope);
      }
      declare(v, stepProducerInfo(item, stepLabel), scope, currentScopeId);

      // retry_from: compile-time scope resolution. Resolved AFTER declaring
      // the gate's own bind so self-reference is detectable, and BEFORE
      // emitting any retryGateZone wrapper so error messages surface with
      // the gate's label first. The resolution helper is host-agnostic —
      // it works the same for step-on_fail and aggregate-retry_from gates;
      // see processRetryGate in retry-gate.ts.
      const stepGate = readStepRetryGate(item);
      if (stepGate !== undefined) {
        processRetryGate(stepGate, v, item, i, { scope, currentScopeId, items, activeZones });
      }
      // Zone members get `let` so the retry callback can re-assign. Plain
      // (non-zone) steps stay `const` — zoneMembers is empty when the
      // current scope has no retry gates, preserving byte-identical output
      // for every shipped pipeline.
      const decl = zoneMembers.has(v) ? 'let' : 'const';
      // Branch-arm terminal threading: when this step is the literal last
      // item of a branch arm's `FlowItem[]` AND the arm's closure declared
      // `revisePromptForTerminal` (signalled by the caller threading
      // `terminalContext` into this `emit()` call), the runAgent call's
      // input expression becomes `(revisePromptForTerminal ?? <normal input>)`
      // (a RUNTIME `??`, so `mode: 'fallback'`). The main pass
      // passes the literal `undefined` to the closure → the parameter is
      // `undefined` inside → the `??` falls through to the normal input.
      // The retry callback invokes the closure with the rendered revise
      // prompt → the `??` resolves to that prompt. Terminal identity is
      // positional, so the step needs no `produces:` and no `bind:` for
      // the override to apply — covering the side-effect-step pattern
      // (admitted as arm terminal when nothing downstream $refs the
      // branch's bind).
      // The inputPaths param is threaded in lockstep with the prompt param:
      // both are runtime-conditional (`?? <normal>`) so the single terminal
      // emit serves both passes. Supplied only when this step is the arm's
      // terminal (itemTerminalContext present) — non-terminal steps keep the
      // compile-time-omittable inputPaths clause, byte-identical to before.
      const termPromptOverride =
        itemTerminalContext !== undefined ? itemTerminalContext.revisePromptIdent : undefined;
      const termInputPathsOverride =
        itemTerminalContext !== undefined ? itemTerminalContext.reviseInputPathsIdent : undefined;
      out.push(
        `${pad}${decl} ${v} = ${emitRunAgentExpr(item, scope, { promptOverride: termPromptOverride, mode: 'fallback', fallbackInputPathsIdent: termInputPathsOverride })};`,
      );

      // Emit the retryGateZone() wrapper for this step-host gate. The
      // initial gate's runAgent already ran above and bound its verdict
      // path into `${v}`; the wrapper reads that path, compares verdict to
      // approve_when, and on mismatch runs the retry callback up to
      // max_retries times. Step-host and aggregate-host gates share the
      // SAME runtime helper via the `kind` discriminator; only the gate
      // re-execution expression differs.
      if (stepGate !== undefined) {
        const retryFromIdxLocal = items.findIndex(
          (m, j) => j < i && getBindName(m) === stepGate.retryFrom,
        );
        // Final line re-invokes the gate's own step and returns the verdict
        // PATH (step-host contract). The retry callback is host-agnostic;
        // the differing return-type lives in this one host-specific line.
        const gateReExec = [`return ${emitRunAgentExpr(item, scope)};`];
        const retryBody = buildRetryBody(
          i,
          retryFromIdxLocal,
          items,
          item,
          stepGate,
          scope,
          pad,
          gateReExec,
        );

        out.push(`${pad}${v} = await retryGateZone({`);
        out.push(`${pad}  kind: 'step',`);
        out.push(`${pad}  initialVerdictPath: ${v},`);
        out.push(`${pad}  verdictField: ${JSON.stringify(stepGate.verdictField)},`);
        out.push(`${pad}  approveWhen: ${JSON.stringify(stepGate.approveWhen)},`);
        out.push(`${pad}  maxRetries: ${stepGate.maxRetries},`);
        out.push(`${pad}  onMaxExceeded: ${JSON.stringify(stepGate.onMaxExceeded)},`);
        out.push(`${pad}  gateAgent: ${JSON.stringify(stepGate.gateAgentLabel)},`);
        out.push(`${pad}  retry: async (currentVerdict) => {`);
        out.push(...retryBody);
        out.push(`${pad}  },`);
        out.push(`${pad}});`);
      }
    } else if (isReviewLoop(item)) {
      const r = item.review_loop;
      const v = r.bind ?? fresh();
      // Resolve the writer's agent reference to a label once: a persona name is
      // itself; an inline agent is its required `name`. When the writer is
      // inline, its baked prompt threads to the runtime as `writerInlinePrompt`;
      // persona writers leave it undefined and take runAgent's `--agent` path.
      const writerLabel = agentLabel(r.writer);
      const writerInlinePrompt = inlinePromptOf(r.writer);
      const label = `review_loop writer='${writerLabel}'`;
      checkConsume(r.input, `${label}.input`, scope);
      validatePath(r.writer_produces, 'writer_produces', label);
      registerPath(r.writer_produces, 'writer_produces', label, pathScope);

      // loopProducerInfo describes the loop's bind for both the outer scope
      // (downstream sequential siblings) and the subflow scope (so $loopBind
      // resolves inside the subflow). Typed without `declarationScope` —
      // `declare()` tags it from the calling scope's ID at registration time
      // so the outer-scope and subflow-scope declarations carry distinct IDs.
      const loopProducerInfo: Omit<ProducerInfo, 'declarationScope'> = {
        kind: 'review_loop',
        fileBound: true,
        location: label,
        fileField: 'writer_produces',
        agentName: writerLabel,
      };

      // Read the reviewer union as a discriminated arm once; the single arm
      // carries reviewer_produces/verdict_field as plain strings (the schema
      // refines' cross-field guarantees, enforced structurally — see
      // readReviewerArm). Everything below branches on the arm's kind.
      const reviewerArm = readReviewerArm(r, label);

      // Both reviewer forms emit the same reviewLoop({ ... }) scaffold —
      // `kind:` is the only header line that differs, and only the reviewer
      // wiring in the middle is branch-specific. writer: carries the resolved
      // LABEL string; writerInlinePrompt: is emitted only for an inline
      // writer (the runtime's inline-prompt field). For a persona writer the
      // label is the bare name and the inline field is absent, so this is
      // byte-identical to the pre-inline emit.
      const lines = [
        `${pad}const ${v} = await reviewLoop({`,
        `${pad}  kind: '${reviewerArm.kind === 'subflow' ? 'compound' : 'single'}',`,
        `${pad}  cli: CLI,`,
        `${pad}  agentDirs: AGENT_DIRS,`,
        `${pad}  defaultExtraArgs: DEFAULT_EXTRA_ARGS,`,
        `${pad}  writer: ${JSON.stringify(writerLabel)},`,
      ];
      if (writerInlinePrompt !== undefined)
        lines.push(`${pad}  writerInlinePrompt: ${JSON.stringify(writerInlinePrompt)},`);

      // Single-only verdict-extraction fields (`reviewerProduces:` +
      // `verdictField:`). They sit between the shared writerProduces and
      // approveWhen lines below, so the single arm stashes them here rather
      // than pushing onto `lines` inside the split. The compound form emits
      // neither — the aggregate inside the subflow already extracts the
      // verdict; the loop only consumes the aggregate's pre-extracted string.
      // The compound runtime interface (CompoundReviewerOpts) does not
      // declare verdictField, and schema-side `verdict_field:` is forbidden
      // on the YAML for the compound form (a refine in types.ts catches it).
      const verdictExtractionLines: string[] = [];

      // An inline-object reviewer routes through the single arm (see
      // readReviewerArm), where its verdict comes from the arm's
      // reviewerProduces/verdictField exactly as a persona's does.
      if (reviewerArm.kind === 'single') {
        const { reviewerProduces, verdictField } = reviewerArm;
        // Resolve the reviewer's agent reference the same way as the writer.
        const reviewerLabel = agentLabel(reviewerArm.reviewer);
        const reviewerInlinePrompt = inlinePromptOf(reviewerArm.reviewer);
        validatePath(reviewerProduces, 'reviewer_produces', label);
        // Intra-block self-collision: each role has its own file. Same path
        // across roles means one overwrites the other between iterations or
        // within a single iteration — silent corruption or a stale draft.
        if (r.writer_produces === reviewerProduces) {
          throw new Error(
            `Compile error: ${label} has intra-block self-collision — ` +
              `'writer_produces' and 'reviewer_produces' both point to ${JSON.stringify(r.writer_produces)}. ` +
              `Reviewer would overwrite the writer's artifact (or vice versa).`,
          );
        }
        registerPath(reviewerProduces, 'reviewer_produces', label, pathScope);

        declare(v, loopProducerInfo, scope, currentScopeId);
        // reviewer: mirrors writer: — the resolved label, with the inline
        // prompt emitted only for an inline reviewer.
        lines.push(`${pad}  reviewer: ${JSON.stringify(reviewerLabel)},`);
        if (reviewerInlinePrompt !== undefined)
          lines.push(`${pad}  reviewerInlinePrompt: ${JSON.stringify(reviewerInlinePrompt)},`);
        verdictExtractionLines.push(
          `${pad}  reviewerProduces: ${JSON.stringify(reviewerProduces)},`,
          `${pad}  verdictField: ${JSON.stringify(verdictField)},`,
        );
      } else {
        const subflow = reviewerArm.subflow;
        validateReviewerSubflow(subflow, label);

        // Snapshot the OUTER scope BEFORE declaring the loop's bind in either
        // map, so the subflow can declare the loop's bind into its own scope
        // without colliding with the outer declare. The outer declare happens
        // separately below.
        const subScope = new Map(scope);
        // The subflow is a new lexical scope (its own retry_from horizon).
        // Allocate its scope ID here so the subflow-scoped clone of the
        // loop's bind carries that ID; the recursive emit below reuses the
        // same ID for everything declared inside the subflow body.
        const subflowScopeId = nextScopeId();
        declare(
          r.bind ?? v,
          {
            ...loopProducerInfo,
            location: `${label} (subflow-scoped bind)`,
          },
          subScope,
          subflowScopeId,
        );
        // Outer declare goes on the original scope so downstream sequential
        // siblings of the review_loop see the bind. This must happen AFTER
        // the subScope snapshot above to avoid duplicate-name collision.
        declare(v, loopProducerInfo, scope, currentScopeId);

        const subPathScope = new Map<string, string>();
        const subBody = emit(
          subflow,
          pad + '    ',
          subScope,
          fresh,
          ctx,
          nextScopeId,
          subflowScopeId,
          subPathScope,
        );
        // Subflow child writes are concurrent with outer-sibling writes from
        // the loop's perspective (e.g. a sibling step OUTSIDE the review_loop
        // that produces: the same path as one of the subflow's parallel
        // children would silently corrupt). Roll the subflow's pathScope
        // back into the outer pathScope so those collisions are caught —
        // matches the parallel block's pattern below.
        mergeChildIntoParent(subPathScope, pathScope);

        // validateReviewerSubflow above guarantees the terminal item is an
        // aggregate; narrow defensively so a future refactor that drops the
        // structural check would fail tsc rather than emitting a runtime
        // mystery.
        const lastItem = subflow[subflow.length - 1];
        if (!isAggregate(lastItem)) {
          throw new Error(
            `Internal compile error: ${label} reviewer subflow's terminal item ` +
              `is not an aggregate; validateReviewerSubflow should have rejected this.`,
          );
        }
        const aggBind = lastItem.aggregate.bind;
        if (!aggBind) {
          throw new Error(
            `Compile error: ${label} reviewer subflow's terminal aggregate must declare ` +
              `'bind:' so the loop can read its verdict. Add 'bind: <name>' to the aggregate.`,
          );
        }

        const reviewerPaths = collectReviewerPaths(subflow);
        if (reviewerPaths.length === 0) {
          throw new Error(
            `Compile error: ${label} reviewer subflow contains no path-bound producers. ` +
              `On reviewer-fail the writer would have no reviewer files to address. ` +
              `Add at least one 'step:' with 'produces:' inside the subflow.`,
          );
        }

        const pathEntries = reviewerPaths
          .map(
            (p) => '{ agentName: ' + JSON.stringify(p.agentName) + ', path: ' + p.bindName + ' }',
          )
          .join(', ');

        // The compound reviewer is a subflow whose inner steps carry their
        // own inline handling, so there is no single reviewerInlinePrompt
        // here — only the closure wiring is compound-specific.
        lines.push(
          `${pad}  reviewerSubflow: async (${r.bind ?? v}) => {`,
          ...subBody,
          `${pad}    return { verdict: ${aggBind}, reviewerPaths: [${pathEntries}] };`,
          `${pad}  },`,
        );
      }

      lines.push(
        `${pad}  input: ${inputExprFor(r.input, scope)},`,
        `${pad}  maxIters: ${r.max_iters ?? 3},`,
        `${pad}  writerProduces: ${JSON.stringify(r.writer_produces)},`,
        ...verdictExtractionLines,
      );
      if (r.approve_when) lines.push(`${pad}  approveWhen: ${JSON.stringify(r.approve_when)},`);
      if (r.on_max_exceeded)
        lines.push(`${pad}  onMaxExceeded: ${JSON.stringify(r.on_max_exceeded)},`);
      lines.push(`${pad}});`);
      out.push(...lines);
    } else if (isHumanGate(item)) {
      const h = item.human_gate;
      if (h.interactive === true) {
        // Schema refine guarantees input/prompt are defined together with
        // `interactive: true`. `agent` is optional: present for a persona
        // gate (delegated to the cli via `--agent`), absent for a general
        // gate (the gate's mandatory `prompt:` is the agent's task, spawned
        // with all tools and no persona).
        const input = h.input!;
        const prompt = h.prompt!;
        const agent = h.agent;
        const gateLabel =
          agent !== undefined ? `human_gate (agent '${agent}')` : 'human_gate (general)';
        if (agent !== undefined) {
          // Persona gate: the agent must resolve exactly like a flow step's —
          // the same shared probe as the flow-walking check
          // (validateAgentFilesExist), called here because human_gate has its
          // own emit branch. Covers the layered cli-aware existence check AND
          // claude's frontmatter-name check, so a gate persona that claude
          // would not register fails at compile time too. A general gate
          // (agent omitted) spawns no persona, so there is nothing to probe.
          validatePersonaFile(ctx.agentDirs, ctx.cli, agent, 'human_gate interactive mode');
        }
        checkConsume(input, `${gateLabel}.input`, scope);
        // `input:` resolves to the artifact PATH (a string identifier referring
        // to the path the producer wrote). The runtime auto-appends "The
        // artifact is at: <path>" to the agent's initial message — so we emit
        // the bare bind name here, NOT the inputExprFor wrap (which builds a
        // multi-line "agent X finished its work" template suited for one-shot
        // step inputs, not the interactive gate's concise context line).
        const inputExpr = val(input);
        // Per-gate extra_args REPLACES the pipeline default (mirrors the
        // StepItem `extraArgsExpr` posture in the step-emit branch above).
        // Emitted as a literal array when present; falls through to
        // DEFAULT_EXTRA_ARGS otherwise. Lets a pipeline pick e.g. a smaller /
        // faster model for interactive human iteration without changing the
        // heavy-review default used elsewhere.
        const extraArgsExpr =
          h.extra_args !== undefined ? JSON.stringify(h.extra_args) : 'DEFAULT_EXTRA_ARGS';
        out.push(`${pad}await humanGate({`);
        out.push(`${pad}  interactive: true,`);
        // Persona gate emits the agent name (delegated via `--agent`); a
        // general gate omits the field entirely so the runtime spawns with
        // no persona and all tools.
        if (agent !== undefined) out.push(`${pad}  agent: ${JSON.stringify(agent)},`);
        out.push(`${pad}  cli: CLI,`);
        out.push(`${pad}  agentDirs: AGENT_DIRS,`);
        out.push(`${pad}  extraArgs: ${extraArgsExpr},`);
        out.push(`${pad}  input: ${inputExpr},`);
        out.push(`${pad}  prompt: ${JSON.stringify(prompt)},`);
        out.push(`${pad}});`);
      } else {
        // Plain y/N path: the generic prompt is hardcoded in the runtime;
        // the YAML side is content-free for this mode.
        out.push(`${pad}await humanGate();`);
      }
    } else if (isAggregate(item)) {
      const a = item.aggregate;
      const v = a.bind ?? fresh();
      const aggLabel = `aggregate (bind '${v}')`;
      for (const [k, expr] of Object.entries(a.inputs)) {
        checkConsume(expr, `${aggLabel}.inputs[${JSON.stringify(k)}]`, scope);
      }
      // Aggregate is never file-bound: it returns a small in-memory verdict
      // string ('pass' / 'NEEDS_REVISION'), not a path. A downstream `$ref`
      // to an aggregate's bind would mean piping that string into an agent's
      // prompt, violating loom's file-bound I/O contract. `fileField` is
      // empty because no schema knob exists to make aggregate file-bound.
      declare(
        v,
        {
          kind: 'aggregate',
          fileBound: false,
          location: aggLabel,
          fileField: '',
          agentName: `aggregate (bind '${v}')`,
        },
        scope,
        currentScopeId,
      );
      // When the aggregate is itself a retry gate, resolve and validate the
      // retry zone (intermediate-compound + revise_with.inputs + nested-zone
      // warning) BEFORE emitting the aggregate call. Errors surface with the
      // aggregate's label at the top of the failure mode, matching step-host
      // diagnostics.
      const aggGate = readAggregateRetryGate(item);
      if (aggGate !== undefined) {
        processRetryGate(aggGate, v, item, i, { scope, currentScopeId, items, activeZones });
      }
      const entries = Object.entries(a.inputs).map(
        ([k, expr]) => `${JSON.stringify(k)}: ${val(expr)}`,
      );
      // Synthesize per-input file-rewrite closures for step-kind producers so
      // `readAgentFile` can re-invoke them on parse failure. Non-step inputs
      // (review_loop binds, pipeline inputs, aggregates) are omitted; the
      // runtime falls back to loud-fail for those. Emit the field only when
      // at least one entry exists — an empty `rewriteProducerFiles: {}` adds
      // noise without value.
      //
      // These closures do NOT carry `inputPaths`. The rewriter's role is to
      // re-produce the upstream output file (the file the readAgentFile
      // parse failed on); the upstream producer's input check already fired
      // during the main-pass runAgent invocation, and the rewriter's job is
      // to fix the output, not to revalidate inputs. Threading inputPaths
      // here would be tautological — the runtime would re-check the same
      // set of upstream files that were valid when the main-pass ran.
      const rewriteEntries: string[] = [];
      for (const [k, expr] of Object.entries(a.inputs)) {
        if (!expr.startsWith('$')) continue;
        const refName = expr.slice(1);
        const producerInfo = scope.get(refName);
        if (
          producerInfo !== undefined &&
          producerInfo.kind === 'step' &&
          producerInfo.producesPath !== undefined
        ) {
          // Mirror the producer step's effective extra_args onto the retry
          // closure so the retry call uses the same per-step override as
          // the first call (replaces, not merges). Falls back to
          // DEFAULT_EXTRA_ARGS when the step had no override.
          const closureExtraArgs =
            producerInfo.extraArgs !== undefined
              ? JSON.stringify(producerInfo.extraArgs)
              : 'DEFAULT_EXTRA_ARGS';
          // Same posture for timeout: when the step set one, honor it on the
          // retry path so the retry isn't silently relaxed to runAgent's
          // 30-min default. Omit the field when unset so the runtime applies
          // its default — mirrors `timeoutExpr` in the step-emit branch above.
          const closureTimeout =
            producerInfo.timeout !== undefined ? `, timeout: ${producerInfo.timeout}` : '';
          // Re-bake an inline producer's prompt so the parse-retry re-fire uses
          // the inline spawn form (the baked prompt is the agent's identity)
          // instead of degrading to a persona `--agent <label>` lookup with no
          // file. Empty for persona producers — byte-identical to before.
          const closureInlinePrompt =
            producerInfo.inlinePrompt !== undefined
              ? `, inlinePrompt: ${JSON.stringify(producerInfo.inlinePrompt)}`
              : '';
          rewriteEntries.push(
            `${JSON.stringify(k)}: (correctivePrompt) => runAgent(${JSON.stringify(producerInfo.agentName)}, correctivePrompt, ${JSON.stringify(producerInfo.producesPath)}, { cli: CLI, agentDirs: AGENT_DIRS, extraArgs: ${closureExtraArgs}${closureTimeout}${closureInlinePrompt} }).then(() => undefined)`,
          );
        }
      }
      // Zone members (aggregate is in another zone, OR aggregate is a gate
      // for its own zone) get `let` so the retry callback can reassign.
      // Plain aggregates stay `const`, preserving byte-identical output for
      // pipelines that don't use the retry-gate feature.
      const aggDecl = zoneMembers.has(v) ? 'let' : 'const';
      const lines = [
        `${pad}${aggDecl} ${v} = await aggregate({`,
        ...emitAggregateCallInner(a, entries, rewriteEntries, `${pad}  `),
        `${pad}});`,
      ];
      out.push(...lines);

      // Aggregate-as-retry-gate emit. The aggregate above ran once and
      // bound its verdict STRING into `${v}`. retryGateZone (kind:
      // 'aggregate' variant) compares that string against approveWhen;
      // on mismatch it re-runs the zone members via buildRetryBody and
      // re-fires the aggregate inside the retry callback. Reassigns `${v}`
      // so downstream sequential siblings see the post-retry verdict.
      if (aggGate !== undefined) {
        const retryFromIdxLocal = items.findIndex(
          (m, j) => j < i && getBindName(m) === aggGate.retryFrom,
        );
        // Aggregate re-fire inside the retry callback. Composes the SAME
        // inner field set as the main-pass emit via `emitAggregateCallInner`
        // (entries / verdictField / require / approveWhen /
        // rewriteProducerFiles), reassigns `${v}`, and returns the new
        // verdict string to retryGateZone.
        const gateReExec: string[] = [
          `${v} = await aggregate({`,
          ...emitAggregateCallInner(a, entries, rewriteEntries, '  '),
          `});`,
          `return ${v};`,
        ];

        const retryBody = buildRetryBody(
          i,
          retryFromIdxLocal,
          items,
          item,
          aggGate,
          scope,
          pad,
          gateReExec,
        );

        out.push(`${pad}${v} = await retryGateZone({`);
        out.push(`${pad}  kind: 'aggregate',`);
        out.push(`${pad}  initialVerdict: ${v},`);
        out.push(`${pad}  approveWhen: ${JSON.stringify(aggGate.approveWhen)},`);
        out.push(`${pad}  maxRetries: ${aggGate.maxRetries},`);
        out.push(`${pad}  onMaxExceeded: ${JSON.stringify(aggGate.onMaxExceeded)},`);
        out.push(`${pad}  gateAgent: ${JSON.stringify(aggGate.gateAgentLabel)},`);
        out.push(`${pad}  retry: async (currentVerdict) => {`);
        out.push(...retryBody);
        out.push(`${pad}  },`);
        out.push(`${pad}});`);
      }
    } else if (isParallel(item)) {
      const children = item.parallel;
      // Forbid parallel-inside-parallel. Grandchild binds are scoped to the
      // inner arrow function; a downstream `$ref` to one would fail at
      // tsc-time with "Cannot find name". Flattening to a single parallel
      // level expresses the same concurrency without the scope leak. If a
      // legitimate use case for nested parallels emerges, the fix is to
      // thread grandchild binds back through the outer arrow's return value.
      for (let ci = 0; ci < children.length; ci++) {
        if (isParallel(children[ci])) {
          throw new Error(
            `Compile error: parallel block contains a nested parallel at child index ${ci}. ` +
              `Parallel blocks cannot be nested. Flatten by listing all concurrent items as ` +
              `siblings of one parallel block.`,
          );
        }
      }
      // Snapshot the outer scope BEFORE hoisting sibling names so each child
      // can see outer-scope binds but not its concurrent siblings (whose
      // values aren't ready when the child starts running).
      const parentSnapshot = new Map(scope);
      // Capture which children declared an explicit `bind:` BEFORE
      // resultNameFor synthesizes anonymous `_N` names for unbound ones.
      // Used below to populate `parallelChildBinds` on the parent parallel's
      // ProducerInfo — we only want to surface user-meaningful names in the
      // remedy message, not internal anonymous identifiers.
      const explicitChildBinds: (string | undefined)[] = children.map((c) => {
        if (isStep(c)) return c.bind;
        if (isReviewLoop(c)) return c.review_loop.bind;
        if (isAggregate(c)) return c.aggregate.bind;
        return undefined;
      });
      const names = children.map((c) => resultNameFor(c, fresh));
      // Each child emits with its own scope (snapshot of outer). The child's
      // own bind gets registered in the inner scope at emit time; the same
      // bind is also hoisted to the outer scope below for downstream consumers.
      // Fresh path scope per parallel block: siblings share the collision check,
      // unrelated parallel blocks (and sequential steps) do not.
      const childPathScope = new Map<string, string>();
      // Mirror the step (line ~549) and aggregate (line ~921) emitters: a
      // parallel whose children are retry-zone members must be declared `let`,
      // not `const`. The zone-member pre-pass adds those child binds to
      // `zoneMembers` precisely so the gate's retry callback can re-fire the
      // parallel and reassign the destructured names (`[a, b] = await
      // parallel(...)`); a `const` declaration turns that reassignment into a
      // runtime `TypeError: Assignment to constant variable` the moment the
      // first sibling resolves, aborting the whole run. One declarator covers
      // every name, so `.some` is the all-or-nothing choice — the carve-out
      // marks all of a feeding parallel's children together or none of them.
      const parallelDecl = names.some((n) => zoneMembers.has(n)) ? 'let' : 'const';
      out.push(`${pad}${parallelDecl} [${names.join(', ')}] = await parallel([`);
      const childInfos: Array<Omit<ProducerInfo, 'declarationScope'>> = [];
      for (let ci = 0; ci < children.length; ci++) {
        const child = children[ci];
        const producesValue = isStep(child) || isReviewLoop(child);
        out.push(`${pad}  async () => {`);
        const childScope = new Map(parentSnapshot);
        // Each parallel child is its own lexical scope — retry_from inside a
        // child sees only that child's binds, not its siblings' nor the
        // outer scope's. Allocate a fresh scope ID per child.
        const childScopeId = nextScopeId();
        out.push(
          ...emit(
            [child],
            pad + '    ',
            childScope,
            fresh,
            ctx,
            nextScopeId,
            childScopeId,
            childPathScope,
          ),
        );
        // Pull the child's own ProducerInfo back out so we can hoist it
        // (with file-boundness preserved) into the outer scope. The hoisted
        // copy gets a new `declarationScope` of the OUTER scope below, so
        // strip the inner-child ID before storing for hoist.
        const info = childScope.get(names[ci]);
        if (info !== undefined) {
          const { declarationScope: _ignored, ...withoutScope } = info;
          childInfos.push(withoutScope);
        } else {
          childInfos.push({
            kind: 'step',
            fileBound: false,
            location: `parallel child '${names[ci]}'`,
            fileField: 'produces',
            agentName: `parallel child '${names[ci]}'`,
          });
        }
        if (producesValue) out.push(`${pad}    return ${names[ci]};`);
        out.push(`${pad}  },`);
      }
      out.push(`${pad}]);`);
      // Hoist each child's bind into the outer scope so downstream sequential
      // siblings can reference them. File-boundness is preserved. The hoist
      // re-tags `declarationScope` to the outer scope's ID so `retry_from:`
      // from outer-scope steps targeting a child bind passes the same-scope
      // check; a `retry_from:` inside one parallel sibling targeting another
      // sibling still fails because each child runs in its own scope ID
      // (siblings don't see each other's binds at all). The outer-scope copy
      // is tagged `hoistedFromParallel: true` so retry_from resolution can
      // reject "retry from one parallel child" — parallel children have no
      // ordering, so the semantics is undefined; the user must target the
      // parallel block's own bind to rerun the whole parallel. The inner
      // copy (visible only inside the child's own scope, used for $-ref of
      // the child's own bind from within the child's subflow) does NOT carry
      // the marker — only the hoisted outer copy does.
      for (let ci = 0; ci < children.length; ci++) {
        declare(names[ci], { ...childInfos[ci], hoistedFromParallel: true }, scope, currentScopeId);
      }
      // Register the parallel block's own bind (when set) so retry_from
      // can target it and so `$-ref` errors get a kind-aware remedy
      // pointing at the individual child binds. The bind itself is never
      // file-bound — a parallel block has N outputs, not one — so consuming
      // it via `$ref` will fall through checkConsume's `!info.fileBound`
      // branch to the multi-output explanation.
      const parallelBind = item.bind;
      if (parallelBind !== undefined) {
        const childBindList = explicitChildBinds.filter((b): b is string => b !== undefined);
        declare(
          parallelBind,
          {
            kind: 'parallel',
            fileBound: false,
            location: `parallel block (bind '${parallelBind}')`,
            fileField: '',
            agentName: `parallel (bind '${parallelBind}')`,
            parallelChildBinds: childBindList,
          },
          scope,
          currentScopeId,
        );
      }
      // When nested inside another parallel (or a branch inside one), the
      // inner block's writes all run concurrently with the outer block's
      // other siblings — roll them up so outer-sibling collisions are caught.
      mergeChildIntoParent(childPathScope, pathScope);
    } else if (isBranch(item)) {
      const b = item.branch;
      // Strip `$`-prefix on bind references in `when:` so the syntax matches
      // `step.input` etc. (and so the emitted JS references the bare bind
      // variable that's actually in scope). The substitution runs at the
      // branch emit site, NOT at parse time — `b.when` stays the user's raw
      // string in any other consumer (e.g. `mermaid.ts`'s view rendering).
      const whenExpr = substituteBindRefs(b.when, scope);
      // Branch arms are mutually exclusive at runtime: only one runs per
      // pipeline execution. Each arm snapshots the parent pathScope (so
      // collisions with siblings *outside* the branch still fire) but
      // writes within one arm don't collide with writes in the other.
      // After both arms emit, union each arm's new entries back into the
      // parent so downstream siblings still see the union of possible writes.
      const thenScope = pathScope !== undefined ? new Map(pathScope) : undefined;
      // Each branch arm is its own lexical scope. Siblings don't see each
      // other's binds via the scope map at all, so a `retry_from` from inside
      // the else-arm referencing a then-arm bind is caught by the "not
      // declared in this scope" branch in on_fail resolution. The distinct
      // scope IDs are belt-and-braces — if some future change exposed
      // sibling binds via the scope map, the cross-scope check would still
      // reject them.
      const thenScopeId = nextScopeId();
      const elseScopeId = b.else !== undefined ? nextScopeId() : undefined;

      if (b.bind === undefined) {
        // Bindless branch: emit a bare `if/else` block — no closure wrap,
        // no rejoin variable, no `let`. Arm-internal binds stay sealed by
        // the recursive emit's own scope snapshot.
        out.push(`${pad}if (${whenExpr}) {`);
        out.push(
          ...emit(
            b.then,
            pad + '  ',
            new Map(scope),
            fresh,
            ctx,
            nextScopeId,
            thenScopeId,
            thenScope,
          ),
        );
        let elseScope: Map<string, string> | undefined;
        if (b.else) {
          elseScope = pathScope !== undefined ? new Map(pathScope) : undefined;
          out.push(`${pad}} else {`);
          out.push(
            ...emit(
              b.else,
              pad + '  ',
              new Map(scope),
              fresh,
              ctx,
              nextScopeId,
              elseScopeId!,
              elseScope,
            ),
          );
        }
        out.push(`${pad}}`);
        if (pathScope !== undefined) {
          if (thenScope !== undefined) {
            for (const [k, val] of thenScope) if (!pathScope.has(k)) pathScope.set(k, val);
          }
          if (elseScope !== undefined) {
            for (const [k, val] of elseScope) if (!pathScope.has(k)) pathScope.set(k, val);
          }
        }
        // Bindless branches have no ProducerInfo entry; no declare() call.
      } else {
        // Bound branch: emit via the closure-call shape — each arm body is
        // wrapped in a named `runThen_<bind>` / `runElse_<bind>` closure
        // that returns the arm's terminal value, and the branch site
        // invokes them as `<bind> = cond ? runThen_<bind>() :
        // runElse_<bind>()`. The arm bodies emit normally inside each
        // closure; arm-internal binds stay sealed by JS lexical scoping.
        // Both the main pass AND any retry callback assign to the rejoin
        // variable, so the declaration is `let`. Rejoin model mirrors
        // block-scoped `let outcome; if (cond) { outcome = ... } else
        // { outcome = ... }` so downstream `$ref`s on the branch's bind
        // see whichever arm fired.
        const branchBind = b.bind;
        // Pre-synthesize per-arm terminal bind names so the closure's
        // return statement (and `classifyArmTerminals` invocation below)
        // can reference them. The arm's main-pass emit walks the body
        // and would mutate `child.bind ??= fresh()` for unbound terminal
        // steps; doing it here UP-FRONT ensures the names exist before
        // classification reads them. `ensureTerminalBindForArm` recurses
        // into nested-branch terminals for the same reason.
        ensureTerminalBindForArm(b.then, fresh);
        if (b.else) ensureTerminalBindForArm(b.else, fresh);

        // Pre-classify the arms to know (a) whether the branch is
        // consumable, (b) the per-arm return expression, (c) the closure's
        // terminalContext fields. The classification runs against a
        // snapshot of the outer scope; arm-local declarations don't exist
        // yet, but the classifier doesn't need them — it inspects the
        // arm's terminal item directly.
        const classification = classifyArmTerminals(b, scope);

        // Resolve closure names. Primary form `runThen_<bind>` /
        // `runElse_<bind>`; collision with an existing bind in scope drops
        // to `runThen_<fresh()>` / `runElse_<fresh()>` with the SAME fresh
        // suffix for pairing.
        let runThenName = `runThen_${branchBind}`;
        let runElseName = `runElse_${branchBind}`;
        if (scope.has(runThenName) || scope.has(runElseName)) {
          const suffix = fresh();
          runThenName = `runThen${suffix}`;
          runElseName = `runElse${suffix}`;
        }

        // The `let <bind>;` declaration is UNCONDITIONAL on consumable
        // branches — both main-pass and retry callback assign to it. For
        // bindless branches we already emitted the bare `if/else` above.
        out.push(`${pad}let ${branchBind};`);

        // Then-arm closure declaration. The arm body emits normally; the
        // recursive `emit()` call always threads `terminalContext` — the
        // recursive emit's items loop attaches it to the arm's last item
        // only (position-based dispatch). Two terminal kinds consume the
        // parameter:
        //   1. Step — the step-emit handler swaps the runAgent input expression
        //      to `(revisePromptForTerminal ?? <normal input>)` so retry sees
        //      the revise prompt, main pass sees the normal input.
        //   2. Nested branch — the inner branch-emit handler threads the
        //      parameter through to its own `runThen_<innerBind>` /
        //      `runElse_<innerBind>` call sites, propagating recursively to
        //      the inner terminals.
        // Other terminal kinds (review_loop, interactive human_gate) declare
        // the closure parameter but ignore it — their writer-revise threading
        // is via different surfaces. Threading unconditionally (rather than
        // gating on consumability) covers the single-arm bound-branch case
        // with side-effect-only steps used only as `retry_from` targets:
        // they still receive the revise prompt on retry, even when the
        // branch's bind has no downstream `$ref` consumer.
        const armContext: EmitTerminalContext = {
          revisePromptIdent: 'revisePromptForTerminal',
          reviseInputPathsIdent: 'reviseInputPathsForTerminal',
        };
        // The revise-prompt parameter has no TS type annotation: the
        // production runner is plain Node on a `.mjs` temp (see cli.ts's
        // dev-vs-prod runner branching), which would reject `?: string`
        // with a SyntaxError at the `?` token. Every call site passes the
        // parameter explicitly (main-pass: literal `undefined`; retry: the
        // rendered prompt string) — see the main-pass call site below and
        // `buildRetryBody`'s branch-member case — so the parameter is
        // effectively required, and tsc accepts it as implicit-any under
        // `compileAndTypeCheck`'s `noImplicitAny: false` setting (the emit
        // deliberately leans on inference rather than annotation; this
        // closure is part of that contract). At runtime the unconditional
        // `??` fallthrough in step terminals (`(revisePromptForTerminal
        // ?? <normal input>)`) treats `undefined` as "use normal input"
        // and any string as "use revise prompt."
        out.push(
          `${pad}const ${runThenName} = async (revisePromptForTerminal, reviseInputPathsForTerminal) => {`,
        );
        out.push(
          ...emit(
            b.then,
            pad + '  ',
            new Map(scope),
            fresh,
            ctx,
            nextScopeId,
            thenScopeId,
            thenScope,
            undefined,
            armContext,
          ),
        );
        if (classification.consumable === true) {
          out.push(`${pad}  return ${classification.thenPath};`);
        }
        out.push(`${pad}};`);

        // Else-arm closure declaration (only if else: present). Same
        // armContext as the then-arm — step or nested-branch terminals
        // propagate the revise prompt via positional dispatch in the
        // recursive emit's items loop; other kinds ignore the closure
        // parameter.
        let elseScope: Map<string, string> | undefined;
        if (b.else !== undefined) {
          elseScope = pathScope !== undefined ? new Map(pathScope) : undefined;
          out.push(
            `${pad}const ${runElseName} = async (revisePromptForTerminal, reviseInputPathsForTerminal) => {`,
          );
          out.push(
            ...emit(
              b.else,
              pad + '  ',
              new Map(scope),
              fresh,
              ctx,
              nextScopeId,
              elseScopeId!,
              elseScope,
              undefined,
              armContext,
            ),
          );
          if (classification.consumable === true) {
            out.push(`${pad}  return ${classification.elsePath};`);
          }
          out.push(`${pad}};`);
        }

        // Main-pass call site: assign the closure's return into the
        // branch's bind. When else: is absent, the else-arm closure
        // doesn't exist; assign `undefined` to mirror the bind's
        // not-set-when-when-is-false semantics (non-consumable branch).
        //
        // The closure parameter has no type annotation (see the closure
        // declaration above for the rationale — Node rejects TS `?: string`
        // in `.mjs`), so the parameter is required at call sites. Every
        // main-pass invocation must therefore pass an explicit argument:
        // - No outer terminal context → pass the literal `undefined` (the
        //   main pass has no revise prompt to thread).
        // - This branch IS the terminal item of an outer arm's closure body
        //   (nested-branch recursive threading) → thread the outer
        //   closure's `revisePromptForTerminal` parameter through to our
        //   `runThen_`/`runElse_` calls so it flows recursively to the
        //   inner terminals. Main pass propagates `undefined`; retry
        //   propagates the rendered prompt — same runtime-`??` fallthrough
        //   the step terminal uses.
        // The inputPaths arg is threaded in lockstep with the prompt arg —
        // both are `undefined` on the main pass with no outer context, or the
        // outer closure's parameters propagated for a nested-branch terminal.
        const armArg =
          itemTerminalContext !== undefined ? itemTerminalContext.revisePromptIdent : 'undefined';
        const armInputPathsArg =
          itemTerminalContext !== undefined
            ? itemTerminalContext.reviseInputPathsIdent
            : 'undefined';
        if (b.else !== undefined) {
          out.push(
            `${pad}if (${whenExpr}) ${branchBind} = await ${runThenName}(${armArg}, ${armInputPathsArg});`,
          );
          out.push(
            `${pad}else ${branchBind} = await ${runElseName}(${armArg}, ${armInputPathsArg});`,
          );
        } else {
          out.push(
            `${pad}if (${whenExpr}) ${branchBind} = await ${runThenName}(${armArg}, ${armInputPathsArg});`,
          );
          out.push(`${pad}else ${branchBind} = undefined;`);
        }

        // Merge arm pathScopes into the parent pathScope so outer-sibling
        // collisions on either arm's writes still fire.
        if (pathScope !== undefined) {
          if (thenScope !== undefined) {
            for (const [k, val] of thenScope) if (!pathScope.has(k)) pathScope.set(k, val);
          }
          if (elseScope !== undefined) {
            for (const [k, val] of elseScope) if (!pathScope.has(k)) pathScope.set(k, val);
          }
        }

        // Register the branch's ProducerInfo. `fileBound` reflects the
        // classification — consumable + kind 'file' → file-bound (downstream
        // `$ref` works); anything else → not file-bound (downstream `$ref`
        // is rejected by checkConsume with a reason-specific error). The
        // closure names are stored so `buildRetryBody` can call them.
        const consumableAsFile =
          classification.consumable === true && classification.kind === 'file';
        declare(
          branchBind,
          {
            kind: 'branch',
            fileBound: consumableAsFile,
            location: `branch (bind '${branchBind}')`,
            fileField: '',
            agentName: `branch (bind '${branchBind}')`,
            branchConsumability: classification,
            runThenName,
            runElseName: b.else !== undefined ? runElseName : undefined,
          },
          scope,
          currentScopeId,
        );
      }
    } else if (isForeach(item)) {
      const f = item.foreach;
      // Synthesize the dir-name + closure-name: dir-name doubles as the
      // bind when set, otherwise a fresh `foreach_<M>` so per-iteration
      // scratch dirs don't collide between sibling foreaches. The closure
      // gets its own `__foreach_body_<N>` namespace to avoid shadowing any
      // user-supplied bind.
      // fresh() returns leading-underscore names (e.g. `_3`); concat raw
      // so the synthetic dir reads `foreach_3` (not `foreach-_3`) and the
      // closure reads `__foreach_body_3` (not `__foreach_body__3`). The
      // dir name is purely internal (only used when foreach.bind is
      // unset) — the runtime helper sees this same value via
      // syntheticName, and the retry callback re-uses the field from
      // ProducerInfo, so both passes pick the same dir.
      let dirName = f.bind ?? `foreach${fresh()}`;
      let closureName = `__foreach_body${fresh()}`;
      // Defensive parity with the branch site's runThen/runElse collision
      // check. The `__` prefix and monotonic fresh() counter make a real
      // collision vanishingly unlikely; the check is in place so the posture
      // is explicit and survives a future rename rather than being introduced
      // post-hoc. The synthetic dir name (used only when foreach.bind is
      // unset) gets the same treatment — without a user-supplied bind to
      // namespace it, a `foreach_<N>` collision with an outer-scope name
      // would be silently masked.
      if (scope.has(closureName)) {
        closureName = `__foreach_body${fresh()}`;
      }
      if (f.bind === undefined && scope.has(dirName)) {
        dirName = `foreach${fresh()}`;
      }
      // Snapshot the outer scope for the body — body-internal binds stay
      // sealed inside the iteration closure by JS lexical scoping. The
      // body's fresh scope ID makes retry_from from inside the body see
      // only body-local binds (siblings outside the foreach are at a
      // different scope ID).
      const bodyScope = new Map(scope);
      const bodyScopeId = nextScopeId();
      // Declare the `as` bind inside the body scope with kind
      // 'foreach-iteration' — distinct from 'step' to avoid matching
      // aggregate's rewrite-closure synthesis (which keys on kind === 'step').
      // File-bound (it resolves to the iter-N/task.json path); the runtime
      // template wraps it with the standard "agent X finished its work" line.
      declare(
        f.as,
        {
          kind: 'foreach-iteration',
          fileBound: true,
          location: `foreach iteration task (bind '${f.as}')`,
          fileField: '',
          agentName: 'foreach iteration task',
        },
        bodyScope,
        bodyScopeId,
      );
      // Fresh path scope for the body — body items share collision-checks
      // with each other; outer-sibling writes in the same iteration dir
      // are still a real concurrency hazard when nested under parallel,
      // so the body's pathScope gets merged into the outer pathScope below.
      const bodyPathScope = new Map<string, string>();
      const bodyEmit = emit(
        f.body,
        pad + '  ',
        bodyScope,
        fresh,
        ctx,
        nextScopeId,
        bodyScopeId,
        bodyPathScope,
      );
      // Closure declaration. The (as-name, iterScratchDir) parameters
      // arrive from the runtime helper: as-name is the absolute path to
      // iter-N/task.json (bound as $<as> for body items), iterScratchDir
      // is the iteration cwd (the runtime helper has already chdir'd
      // there). No type annotations — same posture as branch arm closures
      // (the .mjs runner rejects TS `: string` syntax).
      out.push(`${pad}const ${closureName} = async (${f.as}, iterScratchDir) => {`);
      out.push(...bodyEmit);
      out.push(`${pad}};`);
      // Roll the body's pathScope into the outer pathScope so collisions
      // with outer siblings (e.g. parallel-nested foreach + sibling step
      // writing the same path) fire — same discipline parallel + reviewer-
      // subflow apply.
      mergeChildIntoParent(bodyPathScope, pathScope);
      // The outer call site. dirName / closureName / onIterationFail are
      // all literal compile-time strings; `over` is a FILE PATH the runtime
      // helper opens with readFileSync, NOT an agent input — so it must NOT
      // flow through inputExprFor (which would wrap a `$ref` in the
      // `<agent> finished its work...` prompt template). For a `$`-prefixed
      // bind we emit the bare JS identifier (substituteBindRefs strips the
      // `$`); for a literal path we emit a JSON-stringified string literal.
      const bindRhs = f.bind !== undefined ? `const ${f.bind}` : `await`;
      // Bindless side-effect form needs different shape — `await foreach({...})`
      // without a `const <bind> =` prefix. Bound form gets the `const`.
      if (f.bind !== undefined) {
        out.push(`${pad}${bindRhs} = await foreach({`);
      } else {
        out.push(`${pad}${bindRhs} foreach({`);
      }
      const overExpr = f.over.startsWith('$')
        ? substituteBindRefs(f.over, scope)
        : JSON.stringify(f.over);
      out.push(`${pad}  over: ${overExpr},`);
      out.push(`${pad}  overLabel: ${JSON.stringify(f.over)},`);
      if (f.bind !== undefined) {
        out.push(`${pad}  bindName: ${JSON.stringify(f.bind)},`);
      }
      out.push(`${pad}  syntheticName: ${JSON.stringify(dirName)},`);
      out.push(`${pad}  onIterationFail: ${JSON.stringify(f.on_iteration_fail ?? 'abort')},`);
      out.push(`${pad}  body: ${closureName},`);
      out.push(`${pad}});`);
      // If the foreach has a bind, declare it in OUTER scope. List-bound;
      // not file-bound — checkConsume rejects $ref consumption with a
      // remedy pointing at retry_from / --resume-from. foreachBodyName lets
      // buildRetryBody re-invoke the same closure on retry; foreachSyntheticName
      // lets the retry callback reproduce the exact dir-name without recomputing
      // fresh().
      if (f.bind !== undefined) {
        declare(
          f.bind,
          {
            kind: 'foreach',
            fileBound: false,
            location: `foreach (bind '${f.bind}')`,
            fileField: '',
            agentName: `foreach (bind '${f.bind}')`,
            foreachBodyName: closureName,
            foreachSyntheticName: dirName,
          },
          scope,
          currentScopeId,
        );
      }
    }
  }
  return out;
}
