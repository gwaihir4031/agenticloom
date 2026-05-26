import {
  FlowItem,
  isStep,
  isReviewLoop,
  isParallel,
  isBranch,
  isAggregate,
  isForeach,
} from '../types.js';

/** Pre-synthesize fresh binds on an arm's terminal item (and recursively
 *  for nested-branch terminals) so `classifyArmTerminal` can read
 *  `last.bind` directly when constructing the `path` field. The walk
 *  mirrors what the main `emit()` would have done as it descended, but
 *  runs UP-FRONT so classification (which precedes emission) sees the
 *  same names.
 *
 *  Mutates the YAML AST in place — matches the existing pattern of
 *  `(child.bind ??= fresh())` in `resultNameFor` etc. The AST's typed-DU
 *  shape allows this mutation; the alternative (threading synthesized
 *  names through a side map) would duplicate state across two passes.
 *
 *  Idempotent — running twice on the same arm leaves it unchanged (every
 *  `bind === undefined` check has already been satisfied after the first
 *  pass). */
export function ensureTerminalBindForArm(arm: FlowItem[], fresh: () => string): void {
  if (arm.length === 0) return;
  const last = arm[arm.length - 1];
  if (isStep(last) && last.bind === undefined && last.produces !== undefined) {
    last.bind = fresh();
  } else if (isReviewLoop(last) && last.review_loop.bind === undefined) {
    last.review_loop.bind = fresh();
  } else if (isBranch(last)) {
    ensureTerminalBindForArm(last.branch.then, fresh);
    if (last.branch.else) ensureTerminalBindForArm(last.branch.else, fresh);
  }
}

/** `$foo` → bare identifier; otherwise quoted string. */
export function val(s: string | undefined): string {
  if (s === undefined) return '""';
  return s.startsWith('$') ? s.slice(1) : JSON.stringify(s);
}

/** Escape a free-form string so it is safe to embed verbatim inside an emitted
 *  JS template literal. agentName / YAML label strings flow into our emit via
 *  concatenation rather than JSON.stringify; without escaping, a stray backtick
 *  or `${` in the source string would produce malformed TS. No current pipeline
 *  trips this; defense-in-depth for future YAML that uses non-alphanumeric
 *  agent names or labels. */
export function escapeTplLit(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/** Per-compile fresh-name generator. `cli.ts` invokes `compile()` from
 *  both the `compile` and `run` subcommands within a single process; a
 *  module-level counter would carry state across invocations and emit
 *  colliding `_1`, `_2`, ... names on the second call. Each `compile()`
 *  call creates its own factory so the counter resets to 1 per pipeline. */
export function makeFresh(): () => string {
  let anon = 0;
  return () => `_${++anon}`;
}

/** Per-compile fresh scope-ID generator. Each call yields a unique integer
 *  identifying one lexical scope (top-level flow, a parallel child's body,
 *  a branch arm, a review_loop subflow). Used to tag every `ProducerInfo`
 *  with its `declarationScope` so `retry_from:` resolution can reject
 *  cross-scope targets — see the `declarationScope` field on `ProducerInfo`. */
export function makeNextScopeId(): () => number {
  let id = 0;
  return () => ++id;
}

/** Result-binding name for a parallel child. Mutates step/review_loop to set
 *  bind if missing, so the recursive emit reuses the same name we destructure. */
export function resultNameFor(child: FlowItem, fresh: () => string): string {
  if (isStep(child)) return (child.bind ??= fresh());
  if (isReviewLoop(child)) return (child.review_loop.bind ??= fresh());
  return fresh();
}

/** Extract the `bind:` name from any FlowItem kind, returning `undefined`
 *  when the item is unbound (or is a kind that doesn't carry a bind, like
 *  human_gate). Used by `emit()`'s on_fail zone-membership pre-pass to find
 *  the retry_from target's index, and to enumerate zone members between
 *  target and gate so their declarations get `let` instead of `const`. */
export function getBindName(item: FlowItem): string | undefined {
  if (isStep(item)) return item.bind;
  if (isReviewLoop(item)) return item.review_loop.bind;
  if (isAggregate(item)) return item.aggregate.bind;
  if (isParallel(item)) return item.bind;
  if (isBranch(item)) return item.branch.bind;
  if (isForeach(item)) return item.foreach.bind;
  return undefined;
}
